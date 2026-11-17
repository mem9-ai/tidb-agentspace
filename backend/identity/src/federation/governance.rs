//! Global governance records. Each member, enrollment and exact grant is a separate record.
//! A versioned governance read fences concurrent removal of the Human making a change.
mod audit;
mod invitations;
use super::*;
use crate::valid_region;
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub server_id: String,
    pub region_id: String,
    pub generation: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Enrollment {
    pub principal: FederatedPrincipal,
    pub status: EnrollmentStatus,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EnrollmentStatus {
    Pending,
    Approved,
    Denied,
    Removed,
}

fn uuid(value: &str) -> Result<()> {
    if !Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value) {
        return Err(error(400, "INVALID_ID"));
    }
    Ok(())
}
fn workspace_scope(workspace: &str) -> Result<Scope> {
    uuid(workspace)?;
    Ok(Scope {
        authority_id: "global".into(),
        owner_kind: "workspace".into(),
        owner_id: workspace.into(),
        family: "federated-governance".into(),
        partition_id: "primary".into(),
    })
}
fn index_scope(principal: &str) -> Result<Scope> {
    uuid(principal)?;
    Ok(Scope::system(
        "global",
        principal,
        "federated-memberships",
        "primary",
    ))
}
fn decode<T: serde::de::DeserializeOwned>(record: &Value) -> Result<T> {
    serde_json::from_value(record["value"].clone())
        .map_err(|_| error(503, "FEDERATED_RECORD_CORRUPT"))
}
fn change(key: &str, record: &Value, value: Value) -> Value {
    json!({"key":key,"expectedVersion":record.get("version").unwrap_or(&Value::Null),"value":value})
}
fn valid_resource(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id != "."
        && id != ".."
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}

impl Federation {
    async fn records(&self, scope: &Scope, keys: Vec<String>) -> Result<Value> {
        let keys = keys
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let response = self
            .metadata
            .execute(MetaRequest::Get {
                scope: scope.clone(),
                guard: None,
                keys: keys.clone(),
            })
            .await?;
        let records = &response["records"];
        if !records.is_object() || keys.iter().any(|key| records.get(key).is_none()) {
            return Err(error(503, "FEDERATED_RECORD_CORRUPT"));
        }
        Ok(records.clone())
    }
    async fn commit(&self, scope: &Scope, changes: Vec<Value>) -> Result<()> {
        self.metadata
            .execute(MetaRequest::Commit {
                scope: scope.clone(),
                guard: None,
                mutation_id: Uuid::new_v4().to_string(),
                changes,
            })
            .await?;
        Ok(())
    }
    async fn index_membership(&self, principal: &str, workspace: &str) -> Result<()> {
        let scope = index_scope(principal)?;
        let key = format!("workspaces/{workspace}");
        let records = self.records(&scope, vec![key.clone()]).await?;
        if !records[&key].is_null() {
            return Ok(());
        }
        match self
            .commit(
                &scope,
                vec![change(&key, &Value::Null, json!({"workspaceId":workspace}))],
            )
            .await
        {
            Err(e) if e.code == "META_CONFLICT" => Ok(()),
            result => result,
        }
    }
    /// Explicit metadata-only creation. The caller retains requestId; a retry resolves
    /// the original Workspace and repairs its discovery index without creating resources.
    pub async fn create_workspace(
        &self,
        actor: &FederatedPrincipal,
        request_id: &str,
        name: &str,
        region: &str,
    ) -> Result<Workspace> {
        actor.identity.validate()?;
        uuid(&actor.id)?;
        uuid(request_id)?;
        if actor.identity.kind != PrincipalKind::Human {
            return Err(error(403, "HUMAN_APPROVAL_REQUIRED"));
        }
        if !valid_text(name)
            || name.chars().count() > 100
            || name.trim() != name
            || !valid_region(region)
        {
            return Err(error(400, "INVALID_WORKSPACE"));
        }
        let hash = Sha256::digest(
            format!("federated-workspace-v1\0{}\0{request_id}", actor.id).as_bytes(),
        );
        let id = Uuid::from_bytes(hash[..16].try_into().expect("16 bytes")).to_string();
        let scope = workspace_scope(&id)?;
        let member_key = format!("members/{}", actor.id);
        let workspace = Workspace {
            id: id.clone(),
            name: name.into(),
            server_id: actor.identity.server_id.clone(),
            region_id: region.into(),
            generation: 1,
        };
        for _ in 0..8 {
            let records = self
                .records(&scope, vec!["workspace".into(), member_key.clone()])
                .await?;
            if !records["workspace"].is_null() {
                let existing: Workspace = decode(&records["workspace"])?;
                if existing.name != name
                    || existing.region_id != region
                    || existing.server_id != workspace.server_id
                {
                    return Err(error(409, "REQUEST_ID_REUSED"));
                }
                // Discovery is only a hint; current membership is always checked on reads.
                self.membership(actor, &id).await?;
                self.index_membership(&actor.id, &id).await?;
                return Ok(existing);
            }
            let member = Membership {
                principal_id: actor.id.clone(),
                kind: PrincipalKind::Human,
                server_id: actor.identity.server_id.clone(),
                active: true,
                governor: true,
            };
            match self
                .commit_audited(
                    &scope,
                    actor,
                    "workspace.created",
                    json!({"requestId":request_id}),
                    vec![
                        change("workspace", &records["workspace"], json!(workspace)),
                        change("placement", &Value::Null, json!(workspace)),
                        change(&member_key, &records[&member_key], json!(member)),
                    ],
                )
                .await
            {
                Ok(()) => {
                    self.index_membership(&actor.id, &id).await?;
                    return Ok(workspace);
                }
                Err(e) if e.code == "META_CONFLICT" => continue,
                Err(e) => return Err(e),
            }
        }
        Err(error(409, "WORKSPACE_BUSY"))
    }
    pub async fn membership(
        &self,
        actor: &FederatedPrincipal,
        workspace: &str,
    ) -> Result<(Workspace, Membership)> {
        let key = format!("members/{}", actor.id);
        let records = self
            .records(
                &workspace_scope(workspace)?,
                vec!["workspace".into(), key.clone()],
            )
            .await?;
        if records["workspace"].is_null() || records[&key].is_null() {
            return Err(error(404, "NOT_FOUND"));
        }
        let workspace: Workspace = decode(&records["workspace"])?;
        let membership: Membership = decode(&records[&key])?;
        membership.authorize(actor)?;
        if workspace.server_id != actor.identity.server_id {
            return Err(error(404, "NOT_FOUND"));
        }
        Ok((workspace, membership))
    }
    /// Bounded discovery returns no total and rechecks live membership for each index hit.
    pub async fn workspaces(
        &self,
        actor: &FederatedPrincipal,
        after: Option<String>,
    ) -> Result<Value> {
        if after
            .as_ref()
            .is_some_and(|s| !s.starts_with("workspaces/") || s.len() > 64)
        {
            return Err(error(400, "INVALID_PAGE_CURSOR"));
        }
        let page = self
            .metadata
            .execute(MetaRequest::List {
                scope: index_scope(&actor.id)?,
                guard: None,
                prefix: "workspaces/".into(),
                after,
                limit: 100,
            })
            .await?;
        let records = page["records"]
            .as_array()
            .ok_or_else(|| error(503, "FEDERATED_RECORD_CORRUPT"))?;
        let mut data = Vec::new();
        for record in records {
            let id = record["value"]["workspaceId"]
                .as_str()
                .ok_or_else(|| error(503, "FEDERATED_RECORD_CORRUPT"))?;
            match self.membership(actor, id).await {
                Ok((workspace, member)) => {
                    let mut value = json!(workspace);
                    value["canManage"] =
                        json!(member.governor && actor.identity.kind == PrincipalKind::Human);
                    data.push(value);
                }
                Err(e) if matches!(e.status, 403 | 404) => {}
                Err(e) => return Err(e),
            }
        }
        Ok(json!({"data":data,"nextCursor":page["nextCursor"]}))
    }
    pub async fn request_enrollment(
        &self,
        actor: &FederatedPrincipal,
        workspace: &str,
    ) -> Result<Enrollment> {
        let scope = workspace_scope(workspace)?;
        let key = format!("enrollments/{}", actor.id);
        for _ in 0..8 {
            let records = self
                .records(&scope, vec!["workspace".into(), key.clone()])
                .await?;
            if records["workspace"].is_null() {
                return Err(error(404, "NOT_FOUND"));
            }
            let target: Workspace = decode(&records["workspace"])?;
            if target.server_id != actor.identity.server_id {
                return Err(error(404, "NOT_FOUND"));
            }
            if !records[&key].is_null() {
                return decode(&records[&key]);
            }
            let enrollment = Enrollment {
                principal: actor.clone(),
                status: EnrollmentStatus::Pending,
            };
            match self
                .commit_audited(
                    &scope,
                    actor,
                    "enrollment.requested",
                    json!({"principalId":actor.id}),
                    vec![
                        change(&key, &records[&key], json!(enrollment)),
                        change("workspace", &records["workspace"], json!(target)),
                    ],
                )
                .await
            {
                Ok(()) => return Ok(enrollment),
                Err(e) if e.code == "META_CONFLICT" => continue,
                Err(e) => return Err(e),
            }
        }
        Err(error(409, "ENROLLMENT_BUSY"))
    }
    pub async fn enrollment(
        &self,
        actor: &FederatedPrincipal,
        workspace: &str,
    ) -> Result<Enrollment> {
        let key = format!("enrollments/{}", actor.id);
        let records = self
            .records(&workspace_scope(workspace)?, vec![key.clone()])
            .await?;
        if records[&key].is_null() {
            return Err(error(404, "NOT_FOUND"));
        }
        let enrollment: Enrollment = decode(&records[&key])?;
        if enrollment.principal != *actor {
            return Err(error(404, "NOT_FOUND"));
        }
        Ok(enrollment)
    }
    /// Approval establishes membership only. It grants neither data nor creation rights.
    pub async fn decide_enrollment(
        &self,
        actor: &FederatedPrincipal,
        workspace: &str,
        principal: &str,
        approve: bool,
        expected_generation: Option<u64>,
    ) -> Result<Enrollment> {
        uuid(principal)?;
        let scope = workspace_scope(workspace)?;
        let governor_key = format!("members/{}", actor.id);
        let target_key = format!("members/{principal}");
        let enrollment_key = format!("enrollments/{principal}");
        for _ in 0..8 {
            let records = self
                .records(
                    &scope,
                    vec![
                        "workspace".into(),
                        governor_key.clone(),
                        target_key.clone(),
                        enrollment_key.clone(),
                    ],
                )
                .await?;
            let mut workspace: Workspace = decode(&records["workspace"])?;
            let governor: Membership = decode(&records[&governor_key])
                .map_err(|_| error(403, "HUMAN_APPROVAL_REQUIRED"))?;
            governor.govern(actor)?;
            if principal == actor.id {
                return Err(error(409, "SELF_ENROLLMENT_DECISION_DENIED"));
            }
            if records[&enrollment_key].is_null() {
                return Err(error(404, "NOT_FOUND"));
            }
            let mut enrollment: Enrollment = decode(&records[&enrollment_key])?;
            if enrollment.principal.id != principal
                || enrollment.principal.identity.server_id != workspace.server_id
            {
                return Err(error(503, "FEDERATED_RECORD_CORRUPT"));
            }
            // An enrollment decision is single-use; reinstatement is a distinct governance action.
            let desired = if approve {
                EnrollmentStatus::Approved
            } else {
                EnrollmentStatus::Denied
            };
            if enrollment.status != EnrollmentStatus::Pending {
                if enrollment.status != desired {
                    return Err(error(409, "ENROLLMENT_DECIDED"));
                }
                if approve {
                    self.index_membership(principal, &workspace.id).await?;
                }
                return Ok(enrollment);
            }
            require_generation(&workspace, expected_generation)?;
            enrollment.status = desired;
            workspace.generation = workspace
                .generation
                .checked_add(1)
                .ok_or_else(|| error(503, "POLICY_EXHAUSTED"))?;
            let member = Membership {
                principal_id: principal.into(),
                kind: enrollment.principal.identity.kind,
                server_id: workspace.server_id.clone(),
                active: approve,
                governor: false,
            };
            match self
                .commit_audited(
                    &scope,
                    actor,
                    if approve {
                        "enrollment.approved"
                    } else {
                        "enrollment.denied"
                    },
                    json!({"principalId":principal}),
                    vec![
                        change("workspace", &records["workspace"], json!(workspace)),
                        change(
                            &governor_key,
                            &records[&governor_key],
                            records[&governor_key]["value"].clone(),
                        ),
                        change(&target_key, &records[&target_key], json!(member)),
                        change(
                            &enrollment_key,
                            &records[&enrollment_key],
                            json!(enrollment),
                        ),
                    ],
                )
                .await
            {
                Ok(()) => {
                    if approve {
                        self.index_membership(principal, &workspace.id).await?;
                    }
                    return Ok(enrollment);
                }
                Err(e) if e.code == "META_CONFLICT" => continue,
                Err(e) => return Err(e),
            }
        }
        Err(error(409, "WORKSPACE_BUSY"))
    }
    /// Caller must verify this exact resource belongs to the Workspace before granting.
    /// No selector, wildcard, tag expression or future-resource inheritance is accepted.
    pub async fn put_grant(
        &self,
        actor: &FederatedPrincipal,
        workspace: &str,
        grant: AccessGrant,
        expected_generation: Option<u64>,
    ) -> Result<Workspace> {
        uuid(&grant.id)?;
        uuid(&grant.principal_id)?;
        if !valid_resource(&grant.resource_id)
            || grant.actions.is_empty()
            || grant.actions.len() > 8
        {
            return Err(error(400, "INVALID_GRANT"));
        }
        let scope = workspace_scope(workspace)?;
        let governor_key = format!("members/{}", actor.id);
        let target_key = format!("members/{}", grant.principal_id);
        let key = format!(
            "grants/{}/{}/{}",
            grant.principal_id, grant.resource_id, grant.id
        );
        let resource_key = format!(
            "resource-grants/{}/{}/{}",
            grant.resource_id, grant.principal_id, grant.id
        );
        let index_key = format!("access-index/{}/{}", grant.principal_id, grant.resource_id);
        for _ in 0..8 {
            let records = self
                .records(
                    &scope,
                    vec![
                        "workspace".into(),
                        governor_key.clone(),
                        target_key.clone(),
                        key.clone(),
                        index_key.clone(),
                        resource_key.clone(),
                    ],
                )
                .await?;
            let mut workspace: Workspace = decode(&records["workspace"])?;
            let governor: Membership = decode(&records[&governor_key])
                .map_err(|_| error(403, "HUMAN_APPROVAL_REQUIRED"))?;
            governor.govern(actor)?;
            let target: Membership =
                decode(&records[&target_key]).map_err(|_| error(404, "NOT_FOUND"))?;
            if (!target.active && !grant.revoked) || target.server_id != workspace.server_id {
                return Err(error(404, "NOT_FOUND"));
            }
            if !records[&key].is_null() {
                let current: AccessGrant = decode(&records[&key])?;
                if current == grant {
                    return Ok(workspace);
                }
                // A grant ID names one immutable intent; revocation may only narrow it.
                if current.actions != grant.actions
                    || current.principal_id != grant.principal_id
                    || current.resource_id != grant.resource_id
                    || current.expires_at != grant.expires_at
                    || current.revoked
                    || !grant.revoked
                {
                    return Err(error(409, "GRANT_ID_REUSED"));
                }
            }
            require_generation(&workspace, expected_generation)?;
            workspace.generation = workspace
                .generation
                .checked_add(1)
                .ok_or_else(|| error(503, "POLICY_EXHAUSTED"))?;
            let mut changes = vec![
                change("workspace", &records["workspace"], json!(workspace)),
                change(&key, &records[&key], json!(grant)),
                change(&resource_key, &records[&resource_key], json!(grant)),
                change(
                    &index_key,
                    &records[&index_key],
                    json!({"resourceId":grant.resource_id}),
                ),
                change(
                    &governor_key,
                    &records[&governor_key],
                    records[&governor_key]["value"].clone(),
                ),
            ];
            if target_key != governor_key {
                changes.push(change(
                    &target_key,
                    &records[&target_key],
                    records[&target_key]["value"].clone(),
                ));
            }
            match self
                .commit_audited(
                    &scope,
                    actor,
                    if grant.revoked {
                        "grant.revoked"
                    } else {
                        "grant.created"
                    },
                    json!(grant),
                    changes,
                )
                .await
            {
                Ok(()) => return Ok(workspace),
                Err(e) if e.code == "META_CONFLICT" => continue,
                Err(e) => return Err(e),
            }
        }
        Err(error(409, "WORKSPACE_BUSY"))
    }
    pub async fn grants(
        &self,
        actor: &FederatedPrincipal,
        workspace: &str,
        resource: Option<&str>,
        after: Option<String>,
    ) -> Result<Value> {
        self.membership(actor, workspace).await?;
        if resource.is_some_and(|r| !valid_resource(r)) {
            return Err(error(400, "INVALID_RESOURCE"));
        }
        let prefix = match resource {
            Some(id) => format!("grants/{}/{id}/", actor.id),
            None => format!("grants/{}/", actor.id),
        };
        if after
            .as_ref()
            .is_some_and(|s| !s.starts_with(&prefix) || s.len() > 256)
        {
            return Err(error(400, "INVALID_PAGE_CURSOR"));
        }
        let page = self
            .metadata
            .execute(MetaRequest::List {
                scope: workspace_scope(workspace)?,
                guard: None,
                prefix,
                after,
                limit: 100,
            })
            .await?;
        // Recheck after metadata I/O so a removed member cannot read old grants.
        self.membership(actor, workspace).await?;
        Ok(page)
    }
}

impl Federation {
    pub async fn suspend_member(
        &self,
        actor: &FederatedPrincipal,
        workspace: &str,
        principal: &str,
        expected_generation: Option<u64>,
    ) -> Result<Workspace> {
        uuid(principal)?;
        let scope = workspace_scope(workspace)?;
        let governor_key = format!("members/{}", actor.id);
        let target_key = format!("members/{principal}");
        let enrollment_key = format!("enrollments/{principal}");
        for _ in 0..8 {
            let records = self
                .records(
                    &scope,
                    vec![
                        "workspace".into(),
                        governor_key.clone(),
                        target_key.clone(),
                        enrollment_key.clone(),
                    ],
                )
                .await?;
            let governor: Membership = decode(&records[&governor_key])
                .map_err(|_| error(403, "HUMAN_APPROVAL_REQUIRED"))?;
            governor.govern(actor)?;
            let mut target: Membership =
                decode(&records[&target_key]).map_err(|_| error(404, "NOT_FOUND"))?;
            let mut workspace: Workspace = decode(&records["workspace"])?;
            // This initial governance flow has one Human owner; never leave it ownerless.
            if target.governor {
                return Err(error(409, "LAST_HUMAN_OWNER"));
            }
            if !target.active {
                return Ok(workspace);
            }
            require_generation(&workspace, expected_generation)?;
            target.active = false;
            let mut enrollment: Enrollment = decode(&records[&enrollment_key])?;
            enrollment.status = EnrollmentStatus::Removed;
            workspace.generation = workspace
                .generation
                .checked_add(1)
                .ok_or_else(|| error(503, "POLICY_EXHAUSTED"))?;
            match self
                .commit_audited(
                    &scope,
                    actor,
                    "membership.removed",
                    json!({"principalId":principal}),
                    vec![
                        change("workspace", &records["workspace"], json!(workspace)),
                        change(
                            &governor_key,
                            &records[&governor_key],
                            records[&governor_key]["value"].clone(),
                        ),
                        change(&target_key, &records[&target_key], json!(target)),
                        change(
                            &enrollment_key,
                            &records[&enrollment_key],
                            json!(enrollment),
                        ),
                    ],
                )
                .await
            {
                Ok(()) => return Ok(workspace),
                Err(e) if e.code == "META_CONFLICT" => continue,
                Err(e) => return Err(e),
            }
        }
        Err(error(409, "WORKSPACE_BUSY"))
    }
    pub async fn enrollments(
        &self,
        actor: &FederatedPrincipal,
        workspace: &str,
        after: Option<String>,
    ) -> Result<Value> {
        self.membership(actor, workspace).await?.1.govern(actor)?;
        if after
            .as_ref()
            .is_some_and(|s| !s.starts_with("enrollments/") || s.len() > 64)
        {
            return Err(error(400, "INVALID_PAGE_CURSOR"));
        }
        let page = self
            .metadata
            .execute(MetaRequest::List {
                scope: workspace_scope(workspace)?,
                guard: None,
                prefix: "enrollments/".into(),
                after,
                limit: 100,
            })
            .await?;
        self.membership(actor, workspace).await?.1.govern(actor)?;
        Ok(page)
    }
    /// Return only the effective actions on this exact resource, preserving grant unions.
    pub async fn resource_actions(
        &self,
        actor: &FederatedPrincipal,
        workspace: &str,
        resource: &str,
        now: i64,
    ) -> Result<Vec<ResourceAction>> {
        Ok(self
            .resource_access(actor, workspace, resource, now)
            .await?
            .actions)
    }
    pub async fn resource_access(
        &self,
        actor: &FederatedPrincipal,
        workspace: &str,
        resource: &str,
        now: i64,
    ) -> Result<EffectiveAccess> {
        let mut actions = std::collections::BTreeSet::new();
        let mut expires_at = i64::MAX;
        let mut cursor = None;
        for _ in 0..100 {
            let page = self
                .grants(actor, workspace, Some(resource), cursor)
                .await?;
            let rows = page["records"]
                .as_array()
                .ok_or_else(|| error(503, "FEDERATED_RECORD_CORRUPT"))?;
            for row in rows {
                let grant: AccessGrant = decode(row)?;
                if grant.revoked || grant.expires_at.is_some_and(|expiry| expiry <= now) {
                    continue;
                }
                expires_at = expires_at.min(grant.expires_at.unwrap_or(i64::MAX));
                for action in &grant.actions {
                    if grant.permits(&actor.id, resource, *action, now) {
                        actions.insert(*action);
                    }
                }
            }
            cursor = page["nextCursor"].as_str().map(str::to_owned);
            if cursor.is_none() {
                return Ok(EffectiveAccess {
                    actions: actions.into_iter().collect(),
                    expires_at,
                });
            }
        }
        Err(error(503, "POLICY_LIMIT_EXCEEDED"))
    }
}

impl Federation {
    /// The initial placement remains immutable while later policy generations advance.
    pub async fn pending_placement(&self, workspace: &str) -> Result<Option<Workspace>> {
        let records = self
            .records(
                &workspace_scope(workspace)?,
                vec!["placement".into(), "region-ready".into()],
            )
            .await?;
        let placement: Workspace = decode(&records["placement"])?;
        if records["region-ready"].is_null() {
            return Ok(Some(placement));
        }
        if records["region-ready"]["value"] != json!(placement) {
            return Err(error(503, "PLACEMENT_RECORD_CORRUPT"));
        }
        Ok(None)
    }
    /// Call only after the authenticated Region acknowledged this exact initial placement.
    pub async fn confirm_placement(&self, placement: &Workspace) -> Result<()> {
        let scope = workspace_scope(&placement.id)?;
        let records = self
            .records(&scope, vec!["placement".into(), "region-ready".into()])
            .await?;
        if records["placement"]["value"] != json!(placement) {
            return Err(error(409, "PLACEMENT_MISMATCH"));
        }
        if !records["region-ready"].is_null() {
            return if records["region-ready"]["value"] == json!(placement) {
                Ok(())
            } else {
                Err(error(503, "PLACEMENT_RECORD_CORRUPT"))
            };
        }
        self.commit(
            &scope,
            vec![change(
                "region-ready",
                &records["region-ready"],
                json!(placement),
            )],
        )
        .await
    }
}

impl Federation {
    pub async fn resource_grants(
        &self,
        actor: &FederatedPrincipal,
        workspace: &str,
        resource: &str,
        after: Option<String>,
    ) -> Result<Value> {
        self.membership(actor, workspace).await?.1.govern(actor)?;
        if !valid_resource(resource) {
            return Err(error(400, "INVALID_RESOURCE"));
        }
        let prefix = format!("resource-grants/{resource}/");
        if after
            .as_ref()
            .is_some_and(|v| !v.starts_with(&prefix) || v.len() > 256)
        {
            return Err(error(400, "INVALID_PAGE_CURSOR"));
        }
        let page = self
            .metadata
            .execute(MetaRequest::List {
                scope: workspace_scope(workspace)?,
                guard: None,
                prefix,
                after,
                limit: 100,
            })
            .await?;
        self.membership(actor, workspace).await?.1.govern(actor)?;
        Ok(page)
    }
}

impl Federation {
    /// This is a discovery hint only. Every returned resource needs a current exact grant.
    pub async fn resource_index(
        &self,
        actor: &FederatedPrincipal,
        workspace: &str,
        after: Option<String>,
    ) -> Result<Value> {
        self.membership(actor, workspace).await?;
        let prefix = format!("access-index/{}/", actor.id);
        if after
            .as_ref()
            .is_some_and(|s| !s.starts_with(&prefix) || s.len() > 256)
        {
            return Err(error(400, "INVALID_PAGE_CURSOR"));
        }
        let page = self
            .metadata
            .execute(MetaRequest::List {
                scope: workspace_scope(workspace)?,
                guard: None,
                prefix,
                after,
                limit: 20,
            })
            .await?;
        self.membership(actor, workspace).await?;
        Ok(page)
    }
    pub async fn tags(
        &self,
        actor: &FederatedPrincipal,
        workspace: &str,
        resource: &str,
        now: i64,
    ) -> Result<Value> {
        if !self
            .resource_actions(actor, workspace, resource, now)
            .await?
            .contains(&ResourceAction::Discover)
        {
            return Err(error(404, "NOT_FOUND"));
        }
        let key = format!("tags/{resource}");
        let records = self
            .records(&workspace_scope(workspace)?, vec![key.clone()])
            .await?;
        Ok(if records[&key].is_null() {
            json!({"version":0,"values":{}})
        } else {
            records[&key]["value"].clone()
        })
    }
    /// Tag permission is independent of data writes. Fence the exact grant observation
    /// against concurrent revocation; tags never participate in authorization.
    pub async fn set_tags(
        &self,
        actor: &FederatedPrincipal,
        workspace: &str,
        resource: &str,
        expected: u64,
        tags: std::collections::BTreeMap<String, String>,
        now: i64,
    ) -> Result<Value> {
        if tags.len() > 20
            || tags.iter().any(|(k, v)| {
                k.is_empty()
                    || k.len() > 64
                    || v.len() > 256
                    || !k
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
                    || v.chars().any(char::is_control)
            })
        {
            return Err(error(400, "INVALID_TAGS"));
        }
        let scope = workspace_scope(workspace)?;
        let key = format!("tags/{resource}");
        let before = self.membership(actor, workspace).await?.0;
        let actions = self
            .resource_actions(actor, workspace, resource, now)
            .await?;
        if !actions.contains(&ResourceAction::Discover)
            || !actions.contains(&ResourceAction::EditTags)
        {
            return Err(error(403, "FORBIDDEN"));
        }
        let records = self
            .records(&scope, vec!["workspace".into(), key.clone()])
            .await?;
        let mut current: Workspace = decode(&records["workspace"])?;
        if current.generation != before.generation {
            return Err(error(409, "POLICY_CHANGED"));
        }
        let version = if records[&key].is_null() {
            0
        } else {
            records[&key]["value"]["version"]
                .as_u64()
                .ok_or_else(|| error(503, "FEDERATED_RECORD_CORRUPT"))?
        };
        if expected != version {
            return Err(error(412, "TAG_VERSION_CONFLICT"));
        }
        let result = json!({"version":version.checked_add(1).ok_or_else(||error(503,"TAG_VERSION_EXHAUSTED"))?,"values":tags});
        current.generation = current
            .generation
            .checked_add(1)
            .ok_or_else(|| error(503, "POLICY_EXHAUSTED"))?;
        self.commit_audited(
            &scope,actor,"resource.tags.changed",json!({"resourceId":resource,"expectedVersion":expected,"tagKeys":tags.keys().collect::<Vec<_>>()}),
            vec![
                change("workspace", &records["workspace"], json!(current)),
                change(&key, &records[&key], result.clone()),
            ],
        )
        .await
        .map_err(|e| {
            if e.code == "META_CONFLICT" {
                error(412, "TAG_VERSION_CONFLICT")
            } else {
                e
            }
        })?;
        Ok(result)
    }
}

impl Federation {
    /// Persist the reviewed exact target set before any edge is written. Retrying cannot
    /// grow the set, and a tag change never adds a target. Individual edges may be partial.
    pub async fn prepare_share_batch(
        &self,
        actor: &FederatedPrincipal,
        workspace: &str,
        request: &str,
        intent: Value,
        expected_generation: Option<u64>,
    ) -> Result<()> {
        uuid(request)?;
        let scope = workspace_scope(workspace)?;
        let key = format!("share-batches/{request}");
        let governor = format!("members/{}", actor.id);
        for _ in 0..8 {
            let records = self
                .records(
                    &scope,
                    vec!["workspace".into(), governor.clone(), key.clone()],
                )
                .await?;
            let member: Membership =
                decode(&records[&governor]).map_err(|_| error(403, "HUMAN_APPROVAL_REQUIRED"))?;
            member.govern(actor)?;
            let intent = json!({"actorId":actor.id,"intent":intent});
            if !records[&key].is_null() {
                return if records[&key]["value"] == intent {
                    Ok(())
                } else {
                    Err(error(409, "REQUEST_ID_REUSED"))
                };
            }
            let workspace: Workspace = decode(&records["workspace"])?;
            require_generation(&workspace, expected_generation)?;
            match self
                .commit_audited(
                    &scope,
                    actor,
                    "sharing.prepared",
                    json!({"requestId":request,"intent":intent}),
                    vec![
                        change(
                            &governor,
                            &records[&governor],
                            records[&governor]["value"].clone(),
                        ),
                        change(
                            "workspace",
                            &records["workspace"],
                            records["workspace"]["value"].clone(),
                        ),
                        change(&key, &Value::Null, intent),
                    ],
                )
                .await
            {
                Ok(()) => return Ok(()),
                Err(e) if e.code == "META_CONFLICT" => continue,
                Err(e) => return Err(e),
            }
        }
        Err(error(409, "WORKSPACE_BUSY"))
    }
}

fn require_generation(workspace: &Workspace, expected: Option<u64>) -> Result<()> {
    if expected.is_some_and(|generation| generation != workspace.generation) {
        return Err(error(412, "POLICY_VERSION_CONFLICT"));
    }
    Ok(())
}
