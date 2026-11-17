//! Region-local federation placement and generation floor. Call only behind the existing
//! authenticated Global control boundary; the API owns lease draining and rollback checks.
use super::{Workspace, error};
use crate::valid_region;
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;
use workspace_contracts::{MetaRequest, Metadata, Result, Scope};

const OWNERSHIP: &str = "ownership/federated";

pub struct RegionalFederation {
    metadata: Arc<dyn Metadata>,
    authority: String,
}
impl RegionalFederation {
    pub async fn open(metadata: Arc<dyn Metadata>, authority: &str) -> Result<Self> {
        let health = metadata.health().await?;
        if !valid_region(authority)
            || health["authorityId"] != authority
            || !health["capabilities"]
                .as_array()
                .is_some_and(|v| v.contains(&json!("recordsV1")))
        {
            return Err(error(503, "REGIONAL_METADATA_REQUIRED"));
        }
        Ok(Self {
            metadata,
            authority: authority.into(),
        })
    }
    fn scope(&self, workspace: &str, family: &str) -> Result<Scope> {
        if !Uuid::parse_str(workspace).is_ok_and(|id| id.to_string() == workspace) {
            return Err(error(400, "INVALID_WORKSPACE"));
        }
        Ok(Scope {
            authority_id: self.authority.clone(),
            owner_kind: "workspace".into(),
            owner_id: workspace.into(),
            family: family.into(),
            partition_id: "primary".into(),
        })
    }
    pub async fn current(&self, workspace: &str) -> Result<Option<Workspace>> {
        let response = self
            .metadata
            .execute(MetaRequest::Get {
                scope: self.scope(workspace, "federated-policy")?,
                guard: None,
                keys: vec!["workspace".into()],
            })
            .await?;
        let record = response["records"]
            .get("workspace")
            .ok_or_else(|| error(503, "FEDERATED_POLICY_CORRUPT"))?;
        if record.is_null() {
            return Ok(None);
        }
        let expected = workspace;
        let workspace: Workspace = serde_json::from_value(record["value"].clone())
            .map_err(|_| error(503, "FEDERATED_POLICY_CORRUPT"))?;
        if workspace.id != expected
            || workspace.region_id != self.authority
            || workspace.generation == 0
        {
            return Err(error(503, "FEDERATED_POLICY_CORRUPT"));
        }
        Ok(Some(workspace))
    }
    async fn initialize_workspace(&self, workspace: &Workspace) -> Result<()> {
        let scope = self.scope(&workspace.id, "workspace")?;
        let keys = [
            "state/workspace",
            "state/profile",
            "state/queryCount",
            OWNERSHIP,
            "ownership/onboarding",
            "system/writer",
        ];
        let marker = json!({"workspaceId":workspace.id,"regionId":self.authority,"serverId":workspace.server_id});
        for _ in 0..8 {
            // Borrow the current writer for observations only. Policy updates must also
            // validate Workspaces already opened by the native data service.
            let writer = self
                .metadata
                .execute(MetaRequest::Get {
                    scope: scope.clone(),
                    guard: None,
                    keys: vec!["system/writer".into()],
                })
                .await?;
            let guard = writer["records"]["system/writer"]["value"]["ownerId"]
                .as_str()
                .map(|id| workspace_contracts::WriterGuard {
                    owner_id: id.into(),
                });
            let response = self
                .metadata
                .execute(MetaRequest::Get {
                    scope: scope.clone(),
                    guard,
                    keys: keys.iter().map(|s| (*s).into()).collect(),
                })
                .await?;
            let records = &response["records"];
            if keys.iter().any(|s| records.get(*s).is_none()) {
                return Err(error(503, "FEDERATED_POLICY_CORRUPT"));
            }
            if !records["state/workspace"].is_null() {
                if records[OWNERSHIP]["value"] != marker
                    || !records["ownership/onboarding"].is_null()
                    || records["state/workspace"]["value"]["accessMode"] != "federated"
                    || records["state/workspace"]["value"]["id"] != workspace.id
                    || records["state/workspace"]["value"]["defaultRegionId"] != self.authority
                {
                    return Err(error(409, "WORKSPACE_MODE_CONFLICT"));
                }
                return Ok(());
            }
            if keys.iter().any(|s| !records[*s].is_null()) {
                return Err(error(409, "WORKSPACE_MODE_CONFLICT"));
            }
            let core = json!({"id":workspace.id,"name":workspace.name,"description":"","plan":"Free","defaultRegionId":self.authority,
                "accessMode":"federated","createdAt":chrono::Utc::now().to_rfc3339()});
            let result=self.metadata.execute(MetaRequest::Commit {scope:scope.clone(),guard:None,mutation_id:Uuid::new_v4().to_string(),changes:vec![
                json!({"key":"state/workspace","expectedVersion":null,"value":core}),
                json!({"key":"state/profile","expectedVersion":null,"value":{"name":"","email":"","role":""}}),
                json!({"key":"state/queryCount","expectedVersion":null,"value":0}),
                json!({"key":OWNERSHIP,"expectedVersion":null,"value":marker}),
                // Assert the absence of an old writer and legacy ownership atomically.
                json!({"key":"system/writer","expectedVersion":null,"delete":true}),
                json!({"key":"ownership/onboarding","expectedVersion":null,"delete":true}),
                workspace_contracts::initial_resource_index(),
            ]}).await;
            match result {
                Ok(_) => return Ok(()),
                Err(e) if e.code == "META_CONFLICT" => continue,
                Err(e) => return Err(e),
            }
        }
        Err(error(409, "WORKSPACE_BUSY"))
    }
    /// Persist monotonic policy after fencing local requests and validating the trusted
    /// control source. No data/credential deletion and no implicit provider provisioning.
    pub async fn install(&self, workspace: &Workspace) -> Result<()> {
        if workspace.region_id != self.authority
            || workspace.generation == 0
            || !Uuid::parse_str(&workspace.server_id)
                .is_ok_and(|id| id.to_string() == workspace.server_id)
        {
            return Err(error(400, "INVALID_FEDERATED_POLICY"));
        }
        let scope = self.scope(&workspace.id, "federated-policy")?;
        self.initialize_workspace(workspace).await?;
        for _ in 0..8 {
            let response = self
                .metadata
                .execute(MetaRequest::Get {
                    scope: scope.clone(),
                    guard: None,
                    keys: vec!["workspace".into()],
                })
                .await?;
            let record = response["records"]
                .get("workspace")
                .ok_or_else(|| error(503, "FEDERATED_POLICY_CORRUPT"))?;
            if !record.is_null() {
                let old: Workspace = serde_json::from_value(record["value"].clone())
                    .map_err(|_| error(503, "FEDERATED_POLICY_CORRUPT"))?;
                if old.id != workspace.id
                    || old.region_id != workspace.region_id
                    || old.server_id != workspace.server_id
                {
                    return Err(error(409, "WORKSPACE_MODE_CONFLICT"));
                }
                if workspace.generation < old.generation {
                    return Err(error(409, "POLICY_STALE"));
                }
                if workspace.generation == old.generation {
                    return if old == *workspace {
                        Ok(())
                    } else {
                        Err(error(409, "POLICY_VERSION_REUSED"))
                    };
                }
            } else if workspace.generation != 1 {
                return Err(error(409, "POLICY_INITIAL_GENERATION_REQUIRED"));
            }
            match self.metadata.execute(MetaRequest::Commit {scope:scope.clone(),guard:None,mutation_id:Uuid::new_v4().to_string(),changes:vec![
                json!({"key":"workspace","expectedVersion":record.get("version").unwrap_or(&Value::Null),"value":workspace})]}).await {
                Ok(_)=>return Ok(()),Err(e) if e.code=="META_CONFLICT"=>continue,Err(e)=>return Err(e),
            }
        }
        Err(error(409, "WORKSPACE_BUSY"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::MemoryMeta;
    #[tokio::test]
    async fn initialization_is_metadata_only_and_policy_cannot_roll_back_or_adopt_legacy() {
        let metadata = Arc::new(MemoryMeta {
            authority: Some("region:a".into()),
            ..Default::default()
        });
        let region = RegionalFederation::open(metadata.clone(), "region:a")
            .await
            .unwrap();
        let workspace = Workspace {
            id: Uuid::new_v4().to_string(),
            name: "private".into(),
            server_id: Uuid::new_v4().to_string(),
            region_id: "region:a".into(),
            generation: 1,
        };
        region.install(&workspace).await.unwrap();
        region.install(&workspace).await.unwrap();
        {
            let groups = metadata.groups.lock().unwrap();
            assert!(
                !groups
                    .values()
                    .flat_map(|g| g.keys())
                    .any(|k| k.starts_with("state/resources/") || k == "ownership/onboarding")
            );
        }
        let newer = Workspace {
            generation: 2,
            ..workspace.clone()
        };
        region.install(&newer).await.unwrap();
        let restarted = RegionalFederation::open(metadata.clone(), "region:a")
            .await
            .unwrap();
        assert_eq!(restarted.current(&workspace.id).await.unwrap(), Some(newer));
        assert_eq!(
            restarted.install(&workspace).await.unwrap_err().code,
            "POLICY_STALE"
        );
        let legacy = Uuid::new_v4().to_string();
        metadata
            .execute(MetaRequest::Commit {
                scope: region.scope(&legacy, "workspace").unwrap(),
                guard: None,
                mutation_id: Uuid::new_v4().to_string(),
                changes: vec![
                    json!({"key":"state/workspace","expectedVersion":null,"value":{"id":legacy}}),
                ],
            })
            .await
            .unwrap();
        assert_eq!(
            region
                .install(&Workspace {
                    id: legacy,
                    ..workspace
                })
                .await
                .unwrap_err()
                .code,
            "WORKSPACE_MODE_CONFLICT"
        );
    }
}
