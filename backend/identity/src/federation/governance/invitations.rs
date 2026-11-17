//! A Human can admit the verified principal reported by an Agent's context action.
//! The five data actions need no membership-administration or raw-cookie escape hatch.
use super::*;
impl Federation {
    pub async fn admission_candidate(
        &self,
        actor: &FederatedPrincipal,
        workspace: &str,
        principal: &str,
    ) -> Result<FederatedPrincipal> {
        let (workspace, member) = self.membership(actor, workspace).await?;
        member.govern(actor)?;
        let target = self.principal(principal).await?;
        if target.identity.server_id != workspace.server_id {
            return Err(error(404, "NOT_FOUND"));
        }
        self.membership(actor, &workspace.id)
            .await?
            .1
            .govern(actor)?;
        Ok(target)
    }
    pub async fn invite(
        &self,
        actor: &FederatedPrincipal,
        workspace: &str,
        principal: &str,
        request: &str,
        generation: u64,
    ) -> Result<Enrollment> {
        uuid(request)?;
        let target = self
            .admission_candidate(actor, workspace, principal)
            .await?;
        let scope = workspace_scope(workspace)?;
        let governor = format!("members/{}", actor.id);
        let member_key = format!("members/{principal}");
        let enrollment_key = format!("enrollments/{principal}");
        let intent_key = format!("invitations/{request}");
        for _ in 0..8 {
            let records = self
                .records(
                    &scope,
                    vec![
                        "workspace".into(),
                        governor.clone(),
                        member_key.clone(),
                        enrollment_key.clone(),
                        intent_key.clone(),
                    ],
                )
                .await?;
            let member: Membership =
                decode(&records[&governor]).map_err(|_| error(403, "HUMAN_APPROVAL_REQUIRED"))?;
            member.govern(actor)?;
            let mut workspace: Workspace = decode(&records["workspace"])?;
            if !records[&intent_key].is_null() {
                if records[&intent_key]["value"]
                    != json!({"actorId":actor.id,"principalId":principal})
                {
                    return Err(error(409, "REQUEST_ID_REUSED"));
                }
                let enrollment: Enrollment = decode(&records[&enrollment_key])?;
                if enrollment.status == EnrollmentStatus::Approved {
                    self.index_membership(principal, &workspace.id).await?;
                }
                return Ok(enrollment);
            }
            if !records[&member_key].is_null() {
                return Err(error(409, "MEMBERSHIP_EXISTS"));
            }
            require_generation(&workspace, Some(generation))?;
            let membership = Membership {
                principal_id: principal.into(),
                kind: target.identity.kind,
                server_id: target.identity.server_id.clone(),
                active: true,
                governor: false,
            };
            let enrollment = Enrollment {
                principal: target.clone(),
                status: EnrollmentStatus::Approved,
            };
            workspace.generation = workspace
                .generation
                .checked_add(1)
                .ok_or_else(|| error(503, "POLICY_EXHAUSTED"))?;
            match self
                .commit_audited(
                    &scope,
                    actor,
                    "membership.admitted",
                    json!({"requestId":request,"principalId":principal}),
                    vec![
                        change("workspace", &records["workspace"], json!(workspace)),
                        change(
                            &governor,
                            &records[&governor],
                            records[&governor]["value"].clone(),
                        ),
                        change(&member_key, &records[&member_key], json!(membership)),
                        change(
                            &enrollment_key,
                            &records[&enrollment_key],
                            json!(enrollment),
                        ),
                        change(
                            &intent_key,
                            &Value::Null,
                            json!({"actorId":actor.id,"principalId":principal}),
                        ),
                    ],
                )
                .await
            {
                Ok(()) => {
                    self.index_membership(principal, &workspace.id).await?;
                    return Ok(enrollment);
                }
                Err(e) if e.code == "META_CONFLICT" => continue,
                Err(e) => return Err(e),
            }
        }
        Err(error(409, "WORKSPACE_BUSY"))
    }
}

impl Federation {
    pub async fn invitation(
        &self,
        actor: &FederatedPrincipal,
        workspace: &str,
        request: &str,
    ) -> Result<Enrollment> {
        uuid(request)?;
        let key = format!("invitations/{request}");
        let records = self
            .records(
                &workspace_scope(workspace)?,
                vec!["workspace".into(), key.clone()],
            )
            .await?;
        if records[&key].is_null() {
            return Err(error(404, "NOT_FOUND"));
        }
        let principal = records[&key]["value"]["principalId"]
            .as_str()
            .ok_or_else(|| error(503, "FEDERATED_RECORD_CORRUPT"))?;
        let current: Workspace = decode(&records["workspace"])?;
        if current.server_id != actor.identity.server_id {
            return Err(error(404, "NOT_FOUND"));
        }
        if principal != actor.id {
            self.membership(actor, workspace).await?.1.govern(actor)?;
        }
        let key = format!("enrollments/{principal}");
        let result = self
            .records(&workspace_scope(workspace)?, vec![key.clone()])
            .await?;
        decode(&result[&key])
    }
}
