use super::*;
impl Product {
    pub(super) async fn agent_context(&self, p: &Principal) -> Result<Value> {
        let id = self.workspace.repository().workspace_id().to_owned();
        let base = format!("/api/v1/workspaces/{id}");
        let mut scopes = p.scopes.clone();
        if scopes.iter().any(|s| s == "queries:execute")
            && !scopes.iter().any(|s| s == "queries:read")
        {
            scopes.push("queries:read".into());
        }
        Ok(
            json!({"workspaceId":id,"principal":{"id":p.id,"kind":if p.owner{"owner"}else{"workspaceKey"},"scopes":scopes,"resourceIds":p.resource_ids,"expiresAt":p.expires_at},"links":{"self":format!("{base}/context"),"resources":format!("{base}/resources"),"queries":format!("{base}/queries"),"files":format!("{base}/files")},"capabilities":self.capabilities(),"limits":{"sqlBytes":65536,"queryRows":1000,"queryResultBytes":1048576,"fileUploadBytes":1048576,"sqlTimeoutSeconds":15,"readOnlySqlTokens":1024,"readOnlySqlNesting":32},"permissions":{"manageKeys":p.owner,"createResources":p.scope("resources:write").is_ok()&&p.has("*")}}),
        )
    }
    fn resource_view(&self, mut r: Value, p: &Principal) -> Value {
        let supported = r["provider"] != ZERO;
        r["capabilities"] = json!({"delete":supported,"deletionCompletion":if !live(&r){"synchronous"}else if r["provider"]==DB9{"operatorReconciliation"}else if supported{"providerStatus"}else{"unsupported"},"readOnlyQueries":r["kind"]!="filesystem","conditionalFileWrites":r["kind"]=="filesystem"});
        let available = r["status"] != "deleting" && r["status"] != "deleted";
        let actions = [
            "resources:read",
            "resources:write",
            "queries:read",
            "queries:execute",
            "files:read",
            "files:write",
            "files:analyze",
            "usage:read",
        ];
        r["allowedActions"] = json!(
            actions
                .into_iter()
                .filter(|s| p.scope(s).is_ok()
                    && (!s.starts_with("files:") || r["kind"] == "filesystem")
                    && (!s.starts_with("queries:") || r["kind"] != "filesystem")
                    && (available || s.starts_with("resources:")))
                .collect::<Vec<_>>()
        );
        r
    }
    pub(super) async fn resource_request(
        &self,
        credential: &Credential,
        method: &str,
        id: &str,
    ) -> Result<(u16, Reply)> {
        let p = self.workspace.authenticate(credential).await?;
        p.scope(if method == "DELETE" {
            "resources:write"
        } else {
            "resources:read"
        })?;
        let r = self.workspace.repository().resource(id).await?;
        let r = p.resource(&json!({"resources":[r]}), id, None)?;
        if method == "GET" {
            // Observations never retry external deletion or resurrect a tombstone.
            let mut r = self.update_resource(r, false).await?;
            if r["deletion"]["phase"] == "provider-accepted"
                && [DRIVE9, DUCKDB].contains(&r["provider"].as_str().unwrap_or(""))
            {
                let storage = if r["provider"] == DUCKDB {
                    self.providers.binding("duckdb", id).await?["storageId"]
                        .as_str()
                        .unwrap_or("")
                        .to_owned()
                } else {
                    id.to_owned()
                };
                if let Ok(status) = self.providers.file_status(&storage).await
                    && status["status"] == "deleted"
                {
                    r = self
                        .finish_deletion(credential, id, "deleted", "completed")
                        .await?;
                }
            }
            return Ok((200, Reply::Json(json!({"data":self.resource_view(r,&p)}))));
        }
        if !r["deletion"].is_null() {
            return Ok((
                if r["status"] == "deleted" { 200 } else { 202 },
                Reply::Json(json!({"data":self.resource_view(r,&p)})),
            ));
        }
        if r["provider"] == ZERO {
            return Err(err(405, "RESOURCE_DELETE_UNSUPPORTED"));
        }
        // Validate all private targets before persisting a deletion intent. No account creation.
        if live(&r) {
            self.providers.validate_deletion(&r).await?;
        }
        self.workspace
            .repository()
            .workspace_transaction(vec![id.to_owned()], false, false, false, |state| {
                let p = principal(state, credential)?;
                p.scope("resources:write")?;
                p.resource(state, id, None)?;
                let r = state["resources"]
                    .as_array_mut()
                    .expect("resources")
                    .iter_mut()
                    .find(|r| r["id"] == id)
                    .ok_or_else(|| err(404, "NOT_FOUND"))?;
                r["status"] = json!("deleting");
                r["deletion"] = json!({"phase":"outcome-unknown","requestedAt":timestamp()});
                event(state, "resource.deletion-requested", id, &p.actor, Some(id));
                Ok(((), true))
            })
            .await?;
        let (status, phase) = if !live(&r) {
            ("deleted", "completed")
        } else {
            match self.providers.delete_resource(&r).await {
                Ok(()) => ("deleting", "provider-accepted"),
                Err(_) => ("deleting", "outcome-unknown"),
            }
        };
        let r = self.finish_deletion(credential, id, status, phase).await?;
        Ok((
            if status == "deleted" { 200 } else { 202 },
            Reply::Json(json!({"data":self.resource_view(r,&p)})),
        ))
    }
    async fn finish_deletion(
        &self,
        credential: &Credential,
        id: &str,
        status: &str,
        phase: &str,
    ) -> Result<Value> {
        self.workspace
            .repository()
            .workspace_transaction(
                vec![id.to_owned()],
                false,
                status == "deleted",
                false,
                |state| {
                    let p = principal(state, credential)?;
                    let r = state["resources"]
                        .as_array_mut()
                        .expect("resources")
                        .iter_mut()
                        .find(|r| r["id"] == id)
                        .ok_or_else(|| err(404, "NOT_FOUND"))?;
                    r["status"] = json!(status);
                    r["deletion"]["phase"] = json!(phase);
                    let result = r.clone();
                    if status == "deleted" {
                        state["files"]
                            .as_array_mut()
                            .expect("files")
                            .retain(|f| f["resourceId"] != id);
                    }
                    event(state, "resource.deletion-observed", id, &p.actor, Some(id));
                    Ok((result, true))
                },
            )
            .await
    }
}
