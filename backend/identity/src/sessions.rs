//! Region-only session primitives. These do not implement HTTP authentication, TLS, cookies,
//! an onboarding channel, resource grants, or safe provider execution. Callers must validate
//! OIDC identities cryptographically before issuance and reauthorize at each effect boundary.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use uuid::Uuid;
use workspace_contracts::{MetaRequest, Metadata, Result, Scope};

use crate::{
    error, now,
    regional::{OwnerIdentity, Policies, Policy, Principal},
};

const ACCESS_LIFETIME: i64 = 8 * 60 * 60;

/// Values are returned only after durable storage. They are credentials: never log them.
pub struct Credentials {
    pub access: String,
    pub renewal: String,
    pub access_expires_at: i64,
}

pub struct Access {
    pub token: String,
    pub expires_at: i64,
}

/// Verified Region-local Guest authorization. Contains no bearer credential.
pub struct GuestAccess {
    pub user_id: String,
    pub generation: u64,
    pub expires_at: i64,
}

/// Returned only after durable storage; `token` is a bearer credential.
pub struct GuestCredential {
    pub token: String,
    pub expires_at: i64,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum GrantKind {
    #[default]
    Continuity,
    GuestBrowser,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Grant {
    user_id: String,
    generation: u64,
    revoked: bool,
    #[serde(default)]
    kind: GrantKind,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Session {
    user_id: String,
    generation: u64,
    grant_digest: String,
    expires_at: i64,
}

pub struct Sessions {
    metadata: Arc<dyn Metadata>,
    policies: Policies,
}

fn token() -> Result<(String, String)> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| error(503, "RANDOM_UNAVAILABLE"))?;
    Ok((hex::encode(bytes), hex::encode(Sha256::digest(bytes))))
}

fn digest(input: &str) -> Result<String> {
    if input.len() != 64 {
        return Err(error(401, "SESSION_UNAUTHORIZED"));
    }
    let bytes = hex::decode(input).map_err(|_| error(401, "SESSION_UNAUTHORIZED"))?;
    if bytes.len() != 32 {
        return Err(error(401, "SESSION_UNAUTHORIZED"));
    }
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn session_expiry(policy: &Policy, current: i64) -> Result<i64> {
    let maximum = current
        .checked_add(ACCESS_LIFETIME)
        .ok_or_else(|| error(503, "CLOCK_UNAVAILABLE"))?;
    match &policy.identity {
        OwnerIdentity::Guest { expires_at, .. } => Ok(maximum.min(*expires_at)),
        OwnerIdentity::Oidc { .. } => Ok(maximum),
    }
}

impl Sessions {
    pub async fn open(metadata: Arc<dyn Metadata>, authority: &str) -> Result<Self> {
        let policies = Policies::open(metadata.clone(), authority).await?;
        Ok(Self { metadata, policies })
    }

    fn scope(&self, workspace: &str) -> Result<Scope> {
        let mut scope = self.policies.scope(workspace)?;
        scope.family = "regional-session".into();
        Ok(scope)
    }

    async fn get(&self, scope: &Scope, key: &str) -> Result<Option<(Value, String)>> {
        let response = self
            .metadata
            .execute(MetaRequest::Get {
                scope: scope.clone(),
                guard: None,
                keys: vec![key.into()],
            })
            .await?;
        let record = response["records"]
            .get(key)
            .ok_or_else(|| error(503, "SESSION_RECORD_CORRUPT"))?;
        if record.is_null() {
            return Ok(None);
        }
        let version = record["version"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| error(503, "SESSION_RECORD_CORRUPT"))?;
        let value = record
            .get("value")
            .ok_or_else(|| error(503, "SESSION_RECORD_CORRUPT"))?;
        Ok(Some((value.clone(), version.into())))
    }

    async fn policy(&self, workspace: &str) -> Result<Policy> {
        let scope = self.policies.scope(workspace)?;
        let (policy, _) = self
            .policies
            .read(&scope)
            .await?
            .ok_or_else(|| error(403, "POLICY_NOT_INSTALLED"))?;
        if policy.denied {
            return Err(error(403, "POLICY_DENIED"));
        }
        Ok(policy)
    }

    fn matches(policy: &Policy, user_id: &str, generation: u64, current: i64) -> Result<()> {
        let expired = matches!(&policy.identity, OwnerIdentity::Guest { expires_at, .. } if current >= *expires_at);
        if policy.user_id != user_id || policy.generation != generation || policy.denied || expired
        {
            return Err(error(401, "SESSION_UNAUTHORIZED"));
        }
        Ok(())
    }

    async fn commit(&self, scope: &Scope, mutation_id: &str, changes: Vec<Value>) -> Result<()> {
        let result = self
            .metadata
            .execute(MetaRequest::Commit {
                scope: scope.clone(),
                guard: None,
                mutation_id: mutation_id.into(),
                changes,
            })
            .await;
        match result {
            Ok(_) => Ok(()),
            Err(e) if e.code == "META_COMMIT_UNKNOWN" => {
                let receipt = self
                    .metadata
                    .execute(MetaRequest::Resolve {
                        scope: scope.clone(),
                        guard: None,
                        mutation_id: mutation_id.into(),
                    })
                    .await;
                if receipt
                    .as_ref()
                    .is_ok_and(|value| value["outcome"] == "committed")
                {
                    Ok(())
                } else {
                    Err(e)
                }
            }
            Err(e) => Err(e),
        }
    }

    /// Creates a durable regional continuity grant and an eight-hour access credential. Only
    /// the authenticated onboarding workflow may call this; the caller must have verified the
    /// OIDC principal or the Guest secret and obtained the owner's explicit authorization for
    /// continuity. A grant lasts until revoked or its Guest expires. This primitive does not
    /// implement or verify the consent interaction.
    pub async fn issue_owner(
        &self,
        workspace: &str,
        principal: Principal<'_>,
    ) -> Result<Credentials> {
        self.issue_at(workspace, principal, now()?).await
    }

    async fn issue_at(
        &self,
        workspace: &str,
        principal: Principal<'_>,
        current: i64,
    ) -> Result<Credentials> {
        self.policies
            .authorize_at(workspace, principal, current)
            .await?;
        let policy = self.policy(workspace).await?;
        let expires_at = session_expiry(&policy, current)?;
        if expires_at <= current {
            return Err(error(401, "SESSION_UNAUTHORIZED"));
        }
        let (access, access_digest) = token()?;
        let (renewal, grant_digest) = token()?;
        let grant = Grant {
            user_id: policy.user_id.clone(),
            generation: policy.generation,
            revoked: false,
            kind: GrantKind::Continuity,
        };
        let session = Session {
            user_id: policy.user_id.clone(),
            generation: policy.generation,
            grant_digest: grant_digest.clone(),
            expires_at,
        };
        let scope = self.scope(workspace)?;
        self.commit(&scope, &Uuid::new_v4().to_string(), vec![
            json!({"key":format!("grant/{grant_digest}"),"expectedVersion":null,"value":grant}),
            json!({"key":format!("session/{access_digest}"),"expectedVersion":null,"value":session}),
        ]).await?;
        let latest = self.policy(workspace).await?;
        Self::matches(&latest, &policy.user_id, policy.generation, current)?;
        Ok(Credentials {
            access,
            renewal,
            access_expires_at: expires_at,
        })
    }

    async fn grant(&self, scope: &Scope, renewal: &str) -> Result<(Grant, String, String)> {
        let grant_digest = digest(renewal)?;
        let (value, version) = self
            .get(scope, &format!("grant/{grant_digest}"))
            .await?
            .ok_or_else(|| error(401, "SESSION_UNAUTHORIZED"))?;
        let grant: Grant =
            serde_json::from_value(value).map_err(|_| error(503, "SESSION_RECORD_CORRUPT"))?;
        if grant.revoked {
            return Err(error(401, "SESSION_UNAUTHORIZED"));
        }
        Ok((grant, version, grant_digest))
    }

    /// Issue a region-only fixed-lifetime Guest credential distinct from access and refresh
    /// tokens. It is valid only for this Workspace and cannot outlive Guest expiry.
    pub async fn issue_guest_browser(
        &self,
        workspace: &str,
        guest_id: &str,
        secret: &str,
    ) -> Result<GuestCredential> {
        self.issue_guest_at(workspace, guest_id, secret, now()?)
            .await
    }

    async fn issue_guest_at(
        &self,
        workspace: &str,
        guest_id: &str,
        secret: &str,
        current: i64,
    ) -> Result<GuestCredential> {
        self.policies
            .authorize_at(workspace, Principal::Guest { guest_id, secret }, current)
            .await?;
        let policy = self.policy(workspace).await?;
        let expires_at = match &policy.identity {
            OwnerIdentity::Guest { expires_at, .. } if *expires_at > current => *expires_at,
            _ => return Err(error(401, "SESSION_UNAUTHORIZED")),
        };
        let (token, token_digest) = token()?;
        let grant = Grant {
            user_id: policy.user_id.clone(),
            generation: policy.generation,
            revoked: false,
            kind: GrantKind::GuestBrowser,
        };
        let scope = self.scope(workspace)?;
        self.commit(
            &scope,
            &Uuid::new_v4().to_string(),
            vec![
                json!({"key":format!("grant/{token_digest}"),"expectedVersion":null,"value":grant}),
            ],
        )
        .await?;
        let latest = self.policy(workspace).await?;
        Self::matches(&latest, &policy.user_id, policy.generation, current)?;
        Ok(GuestCredential { token, expires_at })
    }

    /// Authenticate a Guest's fixed-lifetime regional browser credential without Global.
    /// It is not an access-token refresh: every request rechecks the durable grant and local
    /// policy, and the Guest's absolute expiry cannot be extended. Callers must additionally
    /// check resource/action permissions and reauthorize at external effect boundaries.
    pub async fn authenticate_guest_credential(
        &self,
        workspace: &str,
        credential: &str,
    ) -> Result<GuestAccess> {
        self.guest_credential_at(workspace, credential, now()?)
            .await
    }

    async fn guest_credential_at(
        &self,
        workspace: &str,
        credential: &str,
        current: i64,
    ) -> Result<GuestAccess> {
        let scope = self.scope(workspace)?;
        let (grant, _, _) = self.grant(&scope, credential).await?;
        if grant.kind != GrantKind::GuestBrowser {
            return Err(error(401, "SESSION_UNAUTHORIZED"));
        }
        let policy = self.policy(workspace).await?;
        Self::matches(&policy, &grant.user_id, grant.generation, current)?;
        let expires_at = match policy.identity {
            OwnerIdentity::Guest { expires_at, .. } => expires_at,
            _ => return Err(error(401, "SESSION_UNAUTHORIZED")),
        };
        Ok(GuestAccess {
            user_id: grant.user_id,
            generation: grant.generation,
            expires_at,
        })
    }

    /// Region renews access from its own durable grant and installed policy; no Global call.
    pub async fn renew(&self, workspace: &str, renewal: &str) -> Result<Access> {
        self.renew_at(workspace, renewal, now()?).await
    }

    async fn renew_at(&self, workspace: &str, renewal: &str, current: i64) -> Result<Access> {
        let scope = self.scope(workspace)?;
        let (grant, _, grant_digest) = self.grant(&scope, renewal).await?;
        if grant.kind != GrantKind::Continuity {
            return Err(error(401, "SESSION_UNAUTHORIZED"));
        }
        let policy = self.policy(workspace).await?;
        Self::matches(&policy, &grant.user_id, grant.generation, current)?;
        let expires_at = session_expiry(&policy, current)?;
        if expires_at <= current {
            return Err(error(401, "SESSION_UNAUTHORIZED"));
        }
        let (token, access_digest) = token()?;
        let session = Session {
            user_id: grant.user_id,
            generation: grant.generation,
            grant_digest,
            expires_at,
        };
        self.commit(&scope, &Uuid::new_v4().to_string(), vec![json!({"key":format!("session/{access_digest}"),"expectedVersion":null,"value":session})]).await?;
        // Revocation or a new policy during the write must not produce a usable credential.
        self.grant(&scope, renewal).await?;
        let latest = self.policy(workspace).await?;
        Self::matches(&latest, &session.user_id, session.generation, current)?;
        Ok(Access { token, expires_at })
    }

    /// Checks the access record, its current grant and the current locally installed policy.
    /// The product must also check action/resource permissions immediately before provider I/O.
    pub async fn authorize(&self, workspace: &str, access: &str) -> Result<()> {
        self.authorize_at(workspace, access, now()?).await
    }

    async fn authorize_at(&self, workspace: &str, access: &str, current: i64) -> Result<()> {
        let scope = self.scope(workspace)?;
        let access_digest = digest(access)?;
        let (value, _) = self
            .get(&scope, &format!("session/{access_digest}"))
            .await?
            .ok_or_else(|| error(401, "SESSION_UNAUTHORIZED"))?;
        let session: Session =
            serde_json::from_value(value).map_err(|_| error(503, "SESSION_RECORD_CORRUPT"))?;
        if current >= session.expires_at
            || session.grant_digest.len() != 64
            || hex::decode(&session.grant_digest).is_err()
        {
            return Err(error(401, "SESSION_UNAUTHORIZED"));
        }
        let (value, _) = self
            .get(&scope, &format!("grant/{}", session.grant_digest))
            .await?
            .ok_or_else(|| error(401, "SESSION_UNAUTHORIZED"))?;
        let grant: Grant =
            serde_json::from_value(value).map_err(|_| error(503, "SESSION_RECORD_CORRUPT"))?;
        if grant.revoked
            || grant.kind != GrantKind::Continuity
            || grant.user_id != session.user_id
            || grant.generation != session.generation
        {
            return Err(error(401, "SESSION_UNAUTHORIZED"));
        }
        let policy = self.policy(workspace).await?;
        Self::matches(&policy, &session.user_id, session.generation, current)
    }

    /// A holder can revoke its own renewal grant; every access check also consults that grant.
    pub async fn revoke(&self, workspace: &str, renewal: &str) -> Result<()> {
        let scope = self.scope(workspace)?;
        for _ in 0..8 {
            let (mut grant, version, grant_digest) = self.grant(&scope, renewal).await?;
            grant.revoked = true;
            let result = self.commit(&scope, &Uuid::new_v4().to_string(), vec![json!({"key":format!("grant/{grant_digest}"),"expectedVersion":version,"value":grant})]).await;
            match result {
                Ok(()) => return Ok(()),
                Err(e) if e.code == "META_CONFLICT" => continue,
                Err(e) => return Err(e),
            }
        }
        Err(error(503, "SESSION_CONFLICT_UNRESOLVED"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        regional::{OwnerIdentity, Policy, Principal},
        tests::MemoryMeta,
    };

    fn region() -> Arc<MemoryMeta> {
        Arc::new(MemoryMeta {
            authority: Some("region:a".into()),
            ..Default::default()
        })
    }
    fn oidc_policy() -> Policy {
        Policy {
            workspace_id: Uuid::new_v4().to_string(),
            organization_id: Uuid::new_v4().to_string(),
            user_id: Uuid::new_v4().to_string(),
            region_id: "region:a".into(),
            generation: 1,
            denied: false,
            identity: OwnerIdentity::Oidc {
                issuer: "https://issuer.example".into(),
                subject: "alice".into(),
            },
        }
    }
    fn alice() -> Principal<'static> {
        Principal::Oidc {
            issuer: "https://issuer.example",
            subject: "alice",
        }
    }

    #[tokio::test]
    async fn regional_sessions_renew_across_restart_and_reject_other_workspaces_and_revocation() {
        let metadata = region();
        let policy = oidc_policy();
        let sessions = Sessions::open(metadata.clone(), "region:a").await.unwrap();
        sessions
            .policies
            .install(&policy, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        let credentials = sessions
            .issue_at(&policy.workspace_id, alice(), 100)
            .await
            .unwrap();
        assert!(
            sessions
                .guest_credential_at(&policy.workspace_id, &credentials.renewal, 101)
                .await
                .is_err()
        );
        assert_eq!(credentials.access_expires_at, 28_900);
        sessions
            .authorize_at(&policy.workspace_id, &credentials.access, 28_899)
            .await
            .unwrap();
        assert_eq!(
            sessions
                .authorize_at(&policy.workspace_id, &credentials.access, 28_900)
                .await
                .err()
                .unwrap()
                .code,
            "SESSION_UNAUTHORIZED"
        );
        assert_eq!(
            sessions
                .authorize_at(&Uuid::new_v4().to_string(), &credentials.access, 101)
                .await
                .err()
                .unwrap()
                .code,
            "SESSION_UNAUTHORIZED"
        );
        let restarted = Sessions::open(metadata.clone(), "region:a").await.unwrap();
        let renewed = restarted
            .renew_at(&policy.workspace_id, &credentials.renewal, 30_000)
            .await
            .unwrap();
        restarted
            .authorize_at(&policy.workspace_id, &renewed.token, 30_001)
            .await
            .unwrap();
        let records = serde_json::to_string(&*metadata.groups.lock().unwrap()).unwrap();
        assert!(!records.contains(&credentials.access));
        assert!(!records.contains(&credentials.renewal));
        assert!(!records.contains(&renewed.token));
        restarted
            .revoke(&policy.workspace_id, &credentials.renewal)
            .await
            .unwrap();
        assert_eq!(
            restarted
                .renew_at(&policy.workspace_id, &credentials.renewal, 30_002)
                .await
                .err()
                .unwrap()
                .code,
            "SESSION_UNAUTHORIZED"
        );
        assert_eq!(
            restarted
                .authorize_at(&policy.workspace_id, &renewed.token, 30_002)
                .await
                .err()
                .unwrap()
                .code,
            "SESSION_UNAUTHORIZED"
        );
    }

    #[tokio::test]
    async fn policy_denial_or_new_generation_invalidates_existing_grants() {
        let metadata = region();
        let sessions = Sessions::open(metadata, "region:a").await.unwrap();
        let mut policy = oidc_policy();
        sessions
            .policies
            .install(&policy, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        assert!(
            sessions
                .issue_at(
                    &policy.workspace_id,
                    Principal::Oidc {
                        issuer: "https://issuer.example",
                        subject: "bob"
                    },
                    100
                )
                .await
                .is_err()
        );
        let credentials = sessions
            .issue_at(&policy.workspace_id, alice(), 100)
            .await
            .unwrap();
        policy.generation = 2;
        policy.denied = true;
        sessions
            .policies
            .install(&policy, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        assert!(
            sessions
                .authorize_at(&policy.workspace_id, &credentials.access, 101)
                .await
                .is_err()
        );
        assert!(
            sessions
                .renew_at(&policy.workspace_id, &credentials.renewal, 101)
                .await
                .is_err()
        );
        policy.generation = 3;
        policy.denied = false;
        sessions
            .policies
            .install(&policy, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        assert!(
            sessions
                .renew_at(&policy.workspace_id, &credentials.renewal, 101)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn guest_session_and_regional_renewal_cannot_outlive_guest_expiry() {
        let metadata = region();
        let sessions = Sessions::open(metadata, "region:a").await.unwrap();
        let mut policy = oidc_policy();
        let guest_id = Uuid::new_v4().to_string();
        let secret_bytes = [23u8; 32];
        let secret = hex::encode(secret_bytes);
        policy.identity = OwnerIdentity::Guest {
            guest_id: guest_id.clone(),
            verifier: hex::encode(Sha256::digest(secret_bytes)),
            created_at: 100,
            expires_at: 86_500,
        };
        sessions
            .policies
            .install(&policy, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        let credentials = sessions
            .issue_at(
                &policy.workspace_id,
                Principal::Guest {
                    guest_id: &guest_id,
                    secret: &secret,
                },
                86_000,
            )
            .await
            .unwrap();
        assert_eq!(credentials.access_expires_at, 86_500);
        let browser = sessions
            .issue_guest_at(&policy.workspace_id, &guest_id, &secret, 86_000)
            .await
            .unwrap();
        assert_eq!(browser.expires_at, 86_500);
        assert!(
            sessions
                .guest_credential_at(&policy.workspace_id, &credentials.renewal, 86_499)
                .await
                .is_err()
        );
        assert!(
            sessions
                .renew_at(&policy.workspace_id, &browser.token, 86_499)
                .await
                .is_err()
        );
        let access = sessions
            .guest_credential_at(&policy.workspace_id, &browser.token, 86_499)
            .await
            .unwrap();
        assert_eq!(access.user_id, policy.user_id);
        assert_eq!(access.generation, policy.generation);
        assert_eq!(access.expires_at, 86_500);
        assert!(
            sessions
                .guest_credential_at(&Uuid::new_v4().to_string(), &browser.token, 86_499)
                .await
                .is_err()
        );
        assert!(
            sessions
                .guest_credential_at(&policy.workspace_id, &browser.token, 86_500)
                .await
                .is_err()
        );
        sessions
            .authorize_at(&policy.workspace_id, &credentials.access, 86_499)
            .await
            .unwrap();
        assert!(
            sessions
                .authorize_at(&policy.workspace_id, &credentials.access, 86_500)
                .await
                .is_err()
        );
        assert!(
            sessions
                .renew_at(&policy.workspace_id, &credentials.renewal, 86_500)
                .await
                .is_err()
        );
        sessions
            .revoke(&policy.workspace_id, &browser.token)
            .await
            .unwrap();
        assert!(
            sessions
                .guest_credential_at(&policy.workspace_id, &browser.token, 86_499)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn unknown_issuance_does_not_return_credentials() {
        use std::sync::atomic::Ordering;
        let metadata = region();
        let sessions = Sessions::open(metadata.clone(), "region:a").await.unwrap();
        let policy = oidc_policy();
        sessions
            .policies
            .install(&policy, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        metadata.lose_reply.store(true, Ordering::SeqCst);
        assert_eq!(
            sessions
                .issue_at(&policy.workspace_id, alice(), 100)
                .await
                .err()
                .unwrap()
                .code,
            "META_COMMIT_UNKNOWN"
        );
    }
}
