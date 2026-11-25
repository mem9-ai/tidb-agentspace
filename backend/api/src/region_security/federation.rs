//! Regional actor proofs reuse the native Global signer and regional request leases.
//! They are backend-only, exact-resource ceilings with a maximum 60-second admission window.
use super::*;
use workspace_identity::federation::ExternalIdentity;

struct FederatedAuthorization {
    runtime: Arc<Runtime>,
    token: VerifiedAccess,
    identity: ExternalIdentity,
    access_token: String,
    principal: Principal,
    _lease: OwnedRwLockReadGuard<()>,
}
impl Runtime {
    pub(crate) async fn authenticate_federated(
        self: &Arc<Self>,
        workspace: &str,
        proof: &str,
        access_token: &str,
        method: &str,
        route: &str,
        creation: Option<&str>,
    ) -> Result<Credential> {
        self.allow_workspace(workspace)?;
        let now = self.clock.now().await?;
        let token = self.global.verify_federated(proof, now)?;
        if token.workspace_id() != workspace
            || token.family_id().is_some()
            || token.key_version() != 1
            || token.expires_at() - token.not_before() > crate::raft_auth::ADMISSION_SECONDS
            || !token.grant_ref().starts_with("federated:")
        {
            return Err(error(401, "INVALID_CREDENTIAL"));
        }
        let target = token.grant_ref();
        if target == "federated:governance"
            && (method != "GET"
                || !matches!(
                    route.split('/').collect::<Vec<_>>().as_slice(),
                    ["resources"] | ["resources", _]
                ))
        {
            return Err(error(403, "FORBIDDEN"));
        }
        if let Some(kind) = target.strip_prefix("federated:create-")
            && (method != "POST" || route != "resources" || creation != Some(kind))
        {
            return Err(error(403, "FORBIDDEN"));
        }
        let verifier = self
            .raft
            .as_ref()
            .ok_or_else(|| error(503, "RAFT_UNAVAILABLE"))?;
        let identity = verifier.current_identity(access_token).await?;
        if identity.stamp_id()? != token.key_id() {
            return Err(error(401, "INVALID_CREDENTIAL"));
        }
        let lease = self.gate(workspace).read_owned().await;
        let principal = self.federated_principal(&token, &identity).await?;
        Ok(Credential::Scoped(Arc::new(FederatedAuthorization {
            runtime: self.clone(),
            token,
            identity,
            access_token: access_token.into(),
            principal,
            _lease: lease,
        })))
    }
    async fn federated_principal(
        &self,
        token: &VerifiedAccess,
        identity: &ExternalIdentity,
    ) -> Result<Principal> {
        let now = self.clock.now().await?;
        if token.expires_at() <= now
            || token.region_id() != Some(&self.region)
            || identity.stamp_id()? != token.key_id()
        {
            return Err(error(401, "INVALID_CREDENTIAL"));
        }
        let current = self
            .federation
            .current(token.workspace_id())
            .await?
            .ok_or_else(|| error(403, "POLICY_UNAVAILABLE"))?;
        self.check_floor(&federation_floor(&current)).await?;
        if current.server_id != identity.server_id
            || current.generation != token.policy_generation()
        {
            return Err(error(403, "POLICY_CHANGED"));
        }
        let resource = token
            .grant_ref()
            .strip_prefix("federated:")
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 100
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            })
            .ok_or_else(|| error(401, "INVALID_CREDENTIAL"))?;
        let special = match resource {
            "governance" => Some("resources:read"),
            "create-filesystem" | "create-postgresql" => Some("resources:write"),
            _ => None,
        };
        if let Some(required) = special {
            if identity.kind != workspace_identity::federation::PrincipalKind::Human
                || token.scopes() != [required]
            {
                return Err(error(403, "HUMAN_APPROVAL_REQUIRED"));
            }
        } else {
            let valid = [
                "resources:read",
                "files:read",
                "files:write",
                "files:analyze",
                "queries:read",
                "queries:execute",
                "usage:read",
            ];
            if token.scopes().iter().any(|s| !valid.contains(&s.as_str())) {
                return Err(error(403, "INSUFFICIENT_SCOPE"));
            }
        }
        Ok(Principal {
            owner: false,
            actor: match identity.kind {
                workspace_identity::federation::PrincipalKind::Human => "Human",
                workspace_identity::federation::PrincipalKind::Agent => "Agent",
            }
            .into(),
            id: token.principal_id().into(),
            scopes: token.scopes().into(),
            resource_ids: vec![if special.is_some() {
                "*".into()
            } else {
                resource.into()
            }],
            resource_types: vec![],
            expires_at: chrono::DateTime::from_timestamp(token.expires_at(), 0)
                .map(|t| t.to_rfc3339()),
        })
    }
}
impl ScopedAuthorization for FederatedAuthorization {
    fn workspace_id(&self) -> &str {
        self.token.workspace_id()
    }
    fn federated(&self) -> bool {
        true
    }
    fn history_actor(&self) -> Option<workspace_domain::HistoryActor> {
        use workspace_domain::observability::ActorKind;
        Some(workspace_domain::HistoryActor {
            id: self.token.principal_id().into(),
            kind: match self.identity.kind {
                workspace_identity::federation::PrincipalKind::Human => ActorKind::Human,
                workspace_identity::federation::PrincipalKind::Agent => ActorKind::Agent,
            },
        })
    }
    fn prepare_snapshot(&self) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async { self.check().await.map(|_| ()) })
    }
    fn snapshot(&self) -> Result<Principal> {
        if self.token.expires_at() <= self.runtime.clock.snapshot()? {
            return Err(error(401, "CREDENTIAL_EXPIRED"));
        }
        Ok(self.principal.clone())
    }
    fn check(&self) -> Pin<Box<dyn Future<Output = Result<Principal>> + Send + '_>> {
        Box::pin(async {
            let identity = self
                .runtime
                .raft
                .as_ref()
                .ok_or_else(|| error(503, "RAFT_UNAVAILABLE"))?
                .current_identity(&self.access_token)
                .await?;
            if identity != self.identity {
                return Err(error(401, "UNAUTHENTICATED"));
            }
            self.runtime
                .federated_principal(&self.token, &identity)
                .await
        })
    }
}
