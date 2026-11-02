//! Durable registration for the Region-local history maintenance worker.
//!
//! A persistent Workspace job is registered before the first history write. Keeping a
//! recurring job, rather than deleting it after an empty scan, avoids losing cleanup work
//! when a writer and a scan race across different metadata scopes.
use super::*;

const SHARDS: u8 = 64;
const JOBS: &str = "jobs/";
const DUE: &str = "due/";

fn shard_scope(authority: &str, shard: u8) -> Scope {
    Scope::system(
        authority,
        "history-maintenance",
        "history-maintenance",
        &format!("shard-{shard:02}"),
    )
}
fn system_scope(authority: &str, workspace: &str) -> Scope {
    shard_scope(authority, Sha256::digest(workspace.as_bytes())[0] % SHARDS)
}
fn job_key(workspace: &str) -> String {
    format!("{JOBS}{workspace}")
}
fn due_key(workspace: &str, due: u64) -> String {
    format!("{DUE}{due:020}/{workspace}")
}

pub struct HistoryMaintenance {
    metadata: Arc<dyn Metadata>,
    authority: String,
}

pub struct HistoryJob {
    pub workspace_id: String,
    pub due_at: u64,
    shard: u8,
    job_version: String,
    due_version: String,
}

pub struct HistoryMaintenancePage {
    pub jobs: Vec<HistoryJob>,
    pub next_cursor: Option<String>,
}

impl HistoryMaintenance {
    pub fn new(metadata: Arc<dyn Metadata>, authority: &str) -> Result<Self> {
        if !authority
            .strip_prefix("region:")
            .is_some_and(|region| safe_id(region) && region != "." && region != "..")
            || !safe_id(authority)
        {
            return Err(ServiceError::new(
                400,
                "HISTORY_MAINTENANCE_INVALID_AUTHORITY",
            ));
        }
        Ok(Self {
            metadata,
            authority: authority.into(),
        })
    }

    pub fn shard_count() -> u8 {
        SHARDS
    }

    /// This is an internal Region queue, never a customer-supplied Workspace selector.
    pub async fn due(
        &self,
        shard: u8,
        now: u64,
        after: Option<&str>,
        limit: usize,
    ) -> Result<HistoryMaintenancePage> {
        if shard >= SHARDS
            || !(1..=128).contains(&limit)
            || after.is_some_and(|cursor| {
                cursor.len() > 512
                    || !cursor.starts_with(DUE)
                    || !cursor
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"/_-.:".contains(&byte))
            })
        {
            return Err(ServiceError::new(400, "HISTORY_MAINTENANCE_INVALID_CURSOR"));
        }
        let scope = shard_scope(&self.authority, shard);
        let page = self
            .metadata
            .execute(MetaRequest::List {
                scope: scope.clone(),
                guard: None,
                prefix: DUE.into(),
                after: after.map(str::to_owned),
                limit,
            })
            .await?;
        let entries = page["records"]
            .as_array()
            .ok_or_else(|| error("HISTORY_MAINTENANCE_CORRUPT"))?;
        let mut selected = Vec::new();
        let mut future = false;
        for entry in entries {
            let workspace = entry["value"]["workspaceId"]
                .as_str()
                .filter(|value| safe_id(value) && *value != "." && *value != "..")
                .ok_or_else(|| error("HISTORY_MAINTENANCE_CORRUPT"))?;
            let due = entry["value"]["dueAt"]
                .as_u64()
                .ok_or_else(|| error("HISTORY_MAINTENANCE_CORRUPT"))?;
            if system_scope(&self.authority, workspace).partition_id != scope.partition_id
                || entry["key"] != due_key(workspace, due)
            {
                return Err(error("HISTORY_MAINTENANCE_CORRUPT"));
            }
            if due > now {
                future = true;
                break;
            }
            let version = entry["version"]
                .as_str()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| error("HISTORY_MAINTENANCE_CORRUPT"))?;
            selected.push((workspace.to_owned(), due, version.to_owned()));
        }
        if selected.is_empty() {
            return Ok(HistoryMaintenancePage {
                jobs: Vec::new(),
                next_cursor: None,
            });
        }
        let keys = selected
            .iter()
            .map(|(workspace, _, _)| job_key(workspace))
            .collect();
        let states = self
            .metadata
            .execute(MetaRequest::Get {
                scope,
                guard: None,
                keys,
            })
            .await?["records"]
            .clone();
        let mut jobs = Vec::with_capacity(selected.len());
        for (workspace, due, due_version) in selected {
            let record = &states[&job_key(&workspace)];
            let version = record["version"]
                .as_str()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| error("HISTORY_MAINTENANCE_CHANGED"))?;
            if record["value"]["workspaceId"] != workspace || record["value"]["dueAt"] != due {
                return Err(error("HISTORY_MAINTENANCE_CHANGED"));
            }
            jobs.push(HistoryJob {
                workspace_id: workspace,
                due_at: due,
                shard,
                job_version: version.into(),
                due_version,
            });
        }
        let next_cursor = if future {
            None
        } else {
            page["nextCursor"].as_str().map(str::to_owned)
        };
        Ok(HistoryMaintenancePage { jobs, next_cursor })
    }

    /// Advance a recurring job only if neither its identity nor its due index changed.
    pub async fn reschedule(&self, job: &HistoryJob, next: u64) -> Result<()> {
        if next <= job.due_at
            || job.shard >= SHARDS
            || system_scope(&self.authority, &job.workspace_id).partition_id
                != shard_scope(&self.authority, job.shard).partition_id
        {
            return Err(ServiceError::new(400, "HISTORY_MAINTENANCE_INVALID_JOB"));
        }
        let scope = shard_scope(&self.authority, job.shard);
        let mutation_id = Uuid::new_v4().to_string();
        let value = json!({"workspaceId":job.workspace_id,"dueAt":next});
        let result=self.metadata.execute(MetaRequest::Commit {scope:scope.clone(),guard:None,mutation_id:mutation_id.clone(),changes:vec![
            json!({"key":job_key(&job.workspace_id),"expectedVersion":job.job_version,"value":value}),
            json!({"key":due_key(&job.workspace_id,job.due_at),"expectedVersion":job.due_version,"delete":true}),
            json!({"key":due_key(&job.workspace_id,next),"expectedVersion":null,"value":value}),
        ]}).await;
        match result {
            Ok(_) => Ok(()),
            Err(failure) if failure.code == "META_COMMIT_UNKNOWN" => {
                let receipt = self
                    .metadata
                    .execute(MetaRequest::Resolve {
                        scope,
                        guard: None,
                        mutation_id,
                    })
                    .await;
                if receipt.is_ok_and(|value| value["outcome"] == "committed") {
                    Ok(())
                } else {
                    Err(failure)
                }
            }
            Err(failure) => Err(failure),
        }
    }
}

impl Repository {
    pub(super) async fn ensure_history_maintenance(&self) -> Result<()> {
        self.history_maintenance
            .get_or_try_init(|| async {
                let workspace = self.workspace_id();
                if !safe_id(workspace) || workspace == "." || workspace == ".." {
                    return Err(error("HISTORY_MAINTENANCE_INVALID_WORKSPACE"));
                }
                let scope = system_scope(self.authority_id(), workspace);
                let job_key = job_key(workspace);
                for attempt in 0..8 {
                    let existing = self
                        .call(MetaRequest::Get {
                            scope: scope.clone(),
                            guard: None,
                            keys: vec![job_key.clone()],
                        })
                        .await?["records"][&job_key]
                        .clone();
                    if !existing.is_null() {
                        let due = existing["value"]["dueAt"]
                            .as_u64()
                            .ok_or_else(|| error("HISTORY_MAINTENANCE_CORRUPT"))?;
                        if existing["value"]["workspaceId"] != workspace {
                            return Err(error("HISTORY_MAINTENANCE_CORRUPT"));
                        }
                        let due_key = due_key(workspace, due);
                        let index = self
                            .call(MetaRequest::Get {
                                scope: scope.clone(),
                                guard: None,
                                keys: vec![due_key.clone()],
                            })
                            .await?["records"][&due_key]
                            .clone();
                        if index["value"]["workspaceId"] == workspace
                            && index["value"]["dueAt"] == due
                        {
                            return Ok(());
                        }
                        if attempt < 7 {
                            continue;
                        }
                        return Err(error("HISTORY_MAINTENANCE_CORRUPT"));
                    }
                    let due = u64::try_from(chrono::Utc::now().timestamp())
                        .map_err(|_| error("HISTORY_MAINTENANCE_CLOCK"))?;
                    let due_key = due_key(workspace, due);
                    let mutation_id = Uuid::new_v4().to_string();
                    let value = json!({"workspaceId":workspace,"dueAt":due});
                    match self
                        .call(MetaRequest::Commit {
                            scope: scope.clone(),
                            guard: None,
                            mutation_id: mutation_id.clone(),
                            changes: vec![
                                json!({"key":job_key,"expectedVersion":null,"value":value}),
                                json!({"key":due_key,"expectedVersion":null,"value":value}),
                            ],
                        })
                        .await
                    {
                        Ok(_) => return Ok(()),
                        Err(failure) if failure.code == "META_CONFLICT" && attempt < 7 => continue,
                        Err(failure) if failure.code == "META_COMMIT_UNKNOWN" => {
                            let receipt = self
                                .call(MetaRequest::Resolve {
                                    scope: scope.clone(),
                                    guard: None,
                                    mutation_id,
                                })
                                .await;
                            if receipt.is_ok_and(|value| value["outcome"] == "committed") {
                                return Ok(());
                            }
                            return Err(failure);
                        }
                        Err(failure) => return Err(failure),
                    }
                }
                Err(error("HISTORY_MAINTENANCE_UNAVAILABLE"))
            })
            .await
            .map(|_| ())
    }
}
