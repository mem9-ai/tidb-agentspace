//! Global-only owner-session storage. This is not an HTTP authentication boundary: callers
//! must verify the OIDC flow and protect browser cookies, CSRF and transport independently.
//! Workspace membership is rechecked against the Global directory on every authentication.
//! Expired records are not yet garbage-collected. Clock rollback protection and production
//! time monitoring must be provided before this primitive can be used by a public service.
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use subtle::ConstantTimeEq;
use uuid::Uuid;
use workspace_contracts::{MetaRequest, Metadata, Result, Scope};

use crate::{Directory, RegionAssignment, VerifiedIdentity, error, now};

const SESSION_LIFETIME: i64 = 8 * 60 * 60;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    workspace_id: String,
    session_id: String,
    issuer: String,
    subject: String,
    verifier: String,
    expires_at: i64,
    revoked: bool,
}

/// This secret is shown once and must not be logged or placed in a URL.
pub struct IssuedOwnerSession {
    pub secret: String,
    pub expires_at: i64,
    pub assignment: RegionAssignment,
}

/// Authentication alone does not authorize an effect; recheck before sensitive writes.
pub struct OwnerSession {
    workspace_id: String,
    session_id: String,
    issuer: String,
    subject: String,
    expires_at: i64,
    assignment: RegionAssignment,
}

impl OwnerSession {
    pub fn workspace_id(&self) -> &str {
        &self.workspace_id
    }
    pub fn session_id(&self) -> &str {
        &self.session_id
    }
    pub fn issuer(&self) -> &str {
        &self.issuer
    }
    pub fn subject(&self) -> &str {
        &self.subject
    }
    pub fn expires_at(&self) -> i64 {
        self.expires_at
    }
    pub fn assignment(&self) -> &RegionAssignment {
        &self.assignment
    }
}

pub struct OwnerSessions {
    metadata: Arc<dyn Metadata>,
    directory: Directory,
}

fn uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}

fn scope(workspace: &str, session: &str) -> Result<Scope> {
    if workspace.is_empty()
        || workspace.len() > 128
        || [".", ".."].contains(&workspace)
        || !workspace
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.:".contains(&b))
        || !uuid(session)
    {
        return Err(error(401, "UNAUTHENTICATED"));
    }
    Ok(Scope {
        authority_id: "global".into(),
        owner_kind: "workspace".into(),
        owner_id: workspace.into(),
        family: "global-owner-session".into(),
        partition_id: session.into(),
    })
}

fn digest(secret: &str) -> String {
    hex::encode(Sha256::digest(secret.as_bytes()))
}

fn parse(secret: &str) -> Result<&str> {
    let (id, random) = secret
        .strip_prefix("gos_")
        .and_then(|v| v.split_once('_'))
        .ok_or_else(|| error(401, "UNAUTHENTICATED"))?;
    if !uuid(id)
        || random.len() != 64
        || !random
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(error(401, "UNAUTHENTICATED"));
    }
    Ok(id)
}

impl OwnerSessions {
    /// Require the exact shared Global metadata client used by the login directory.
    pub fn bound_to(&self, directory: &Directory) -> bool {
        self.directory.same_store(directory)
    }

    pub async fn open(metadata: Arc<dyn Metadata>) -> Result<Self> {
        let directory = Directory::open(metadata.clone()).await?;
        Ok(Self {
            metadata,
            directory,
        })
    }

    async fn read(&self, scope: &Scope) -> Result<Option<(Record, String)>> {
        let response = self
            .metadata
            .execute(MetaRequest::Get {
                scope: scope.clone(),
                guard: None,
                keys: vec!["session".into()],
            })
            .await?;
        let stored = response["records"]
            .get("session")
            .ok_or_else(|| error(503, "OWNER_SESSION_CORRUPT"))?;
        if stored.is_null() {
            return Ok(None);
        }
        let version = stored["version"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| error(503, "OWNER_SESSION_CORRUPT"))?;
        let record: Record = serde_json::from_value(stored["value"].clone())
            .map_err(|_| error(503, "OWNER_SESSION_CORRUPT"))?;
        if record.workspace_id != scope.owner_id
            || record.session_id != scope.partition_id
            || record.issuer.is_empty()
            || record.subject.is_empty()
            || record.expires_at <= 0
            || record.verifier.len() != 64
            || !hex::decode(&record.verifier).is_ok_and(|v| v.len() == 32)
        {
            return Err(error(503, "OWNER_SESSION_CORRUPT"));
        }
        Ok(Some((record, version.into())))
    }

    /// `identity` and the unique, single-use flow ID must come from the verified OIDC flow.
    /// A repeated flow never returns another secret or creates a second session.
    pub async fn issue(
        &self,
        identity: VerifiedIdentity<'_>,
        workspace: &str,
        flow_id: &str,
    ) -> Result<IssuedOwnerSession> {
        self.issue_at(identity, workspace, flow_id, now()?).await
    }

    async fn issue_at(
        &self,
        identity: VerifiedIdentity<'_>,
        workspace: &str,
        flow_id: &str,
        current: i64,
    ) -> Result<IssuedOwnerSession> {
        let scope = scope(workspace, flow_id)?;
        let expiry = current
            .checked_add(SESSION_LIFETIME)
            .filter(|_| current > 0)
            .ok_or_else(|| error(503, "CLOCK_UNAVAILABLE"))?;
        let assignment = self
            .directory
            .region_assignment(
                VerifiedIdentity {
                    issuer: identity.issuer,
                    subject: identity.subject,
                },
                workspace,
            )
            .await?;
        let mut random = [0u8; 32];
        getrandom::fill(&mut random).map_err(|_| error(503, "RANDOM_UNAVAILABLE"))?;
        let secret = format!("gos_{flow_id}_{}", hex::encode(random));
        let record = Record {
            workspace_id: workspace.into(),
            session_id: flow_id.into(),
            issuer: identity.issuer.into(),
            subject: identity.subject.into(),
            verifier: digest(&secret),
            expires_at: expiry,
            revoked: false,
        };
        let result = self
            .metadata
            .execute(MetaRequest::Commit {
                scope: scope.clone(),
                guard: None,
                mutation_id: flow_id.into(),
                changes: vec![json!({"key":"session","expectedVersion":null,"value":record})],
            })
            .await;
        match result {
            Ok(_) => {}
            Err(e) if e.code == "META_CONFLICT" => {
                return Err(error(409, "OWNER_SESSION_ALREADY_ISSUED"));
            }
            Err(e) if e.code == "META_COMMIT_UNKNOWN" => {
                let existing = self.read(&scope).await?;
                if !existing.is_some_and(|(r, _)| {
                    !r.revoked
                        && r.verifier
                            .as_bytes()
                            .ct_eq(record.verifier.as_bytes())
                            .into()
                }) {
                    return Err(e);
                }
            }
            Err(e) => return Err(e),
        }
        // A metadata mutation receipt may be a replay of this flow ID. Do not return a
        // freshly generated secret unless its exact verifier is the one durably stored.
        let existing = self.read(&scope).await?;
        if !existing.is_some_and(|(r, _)| {
            !r.revoked
                && r.verifier
                    .as_bytes()
                    .ct_eq(record.verifier.as_bytes())
                    .into()
        }) {
            return Err(error(409, "OWNER_SESSION_ALREADY_ISSUED"));
        }
        Ok(IssuedOwnerSession {
            secret,
            expires_at: expiry,
            assignment,
        })
    }

    pub async fn authenticate(&self, workspace: &str, secret: &str) -> Result<OwnerSession> {
        self.authenticate_at(workspace, secret, now()?).await
    }

    async fn authenticate_at(
        &self,
        workspace: &str,
        secret: &str,
        current: i64,
    ) -> Result<OwnerSession> {
        let id = parse(secret)?;
        let scope = scope(workspace, id)?;
        let (record, _) = self
            .read(&scope)
            .await?
            .ok_or_else(|| error(401, "UNAUTHENTICATED"))?;
        let equal: bool = record
            .verifier
            .as_bytes()
            .ct_eq(digest(secret).as_bytes())
            .into();
        if !equal || record.revoked || current <= 0 || record.expires_at <= current {
            return Err(error(401, "UNAUTHENTICATED"));
        }
        let assignment = self
            .directory
            .region_assignment(
                VerifiedIdentity {
                    issuer: &record.issuer,
                    subject: &record.subject,
                },
                workspace,
            )
            .await
            .map_err(|e| {
                if e.status == 404 {
                    error(401, "UNAUTHENTICATED")
                } else {
                    e
                }
            })?;
        Ok(OwnerSession {
            workspace_id: record.workspace_id,
            session_id: record.session_id,
            issuer: record.issuer,
            subject: record.subject,
            expires_at: record.expires_at,
            assignment,
        })
    }

    /// Durably revoke the authenticated session. Unknown commit outcomes must be reconciled.
    pub async fn revoke(&self, workspace: &str, secret: &str, mutation_id: &str) -> Result<()> {
        if !uuid(mutation_id) {
            return Err(error(400, "INVALID_MUTATION"));
        }
        let authenticated = self.authenticate(workspace, secret).await?;
        let scope = scope(workspace, &authenticated.session_id)?;
        let (mut record, version) = self
            .read(&scope)
            .await?
            .ok_or_else(|| error(401, "UNAUTHENTICATED"))?;
        let equal: bool = record
            .verifier
            .as_bytes()
            .ct_eq(digest(secret).as_bytes())
            .into();
        if !equal || record.revoked || record.expires_at <= now()? {
            return Err(error(401, "UNAUTHENTICATED"));
        }
        record.revoked = true;
        self.metadata
            .execute(MetaRequest::Commit {
                scope,
                guard: None,
                mutation_id: mutation_id.into(),
                changes: vec![json!({"key":"session","expectedVersion":version,"value":record})],
            })
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::MemoryMeta;
    use std::sync::atomic::Ordering;

    async fn ready() -> (Arc<MemoryMeta>, Directory, String) {
        let metadata = Arc::new(MemoryMeta::default());
        let directory = Directory::open(metadata.clone()).await.unwrap();
        let identity = || VerifiedIdentity {
            issuer: "https://issuer.example",
            subject: "alice",
        };
        let registration = directory.reserve(identity(), "region:a").await.unwrap();
        directory
            .record_region_ready(identity(), &registration, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        (metadata, directory, registration.workspace_id)
    }

    #[tokio::test]
    async fn sessions_are_owner_workspace_scoped_expiring_and_revocable_across_restart() {
        let (metadata, directory, workspace) = ready().await;
        let sessions = OwnerSessions::open(metadata.clone()).await.unwrap();
        assert!(sessions.bound_to(&directory));
        let other = Directory::open(Arc::new(MemoryMeta::default()))
            .await
            .unwrap();
        assert!(!sessions.bound_to(&other));
        let identity = || VerifiedIdentity {
            issuer: "https://issuer.example",
            subject: "alice",
        };
        let flow = Uuid::new_v4().to_string();
        let current = now().unwrap();
        let issued = sessions
            .issue_at(identity(), &workspace, &flow, current)
            .await
            .unwrap();
        assert_eq!(issued.assignment.region_id, "region:a");
        assert_eq!(issued.expires_at, current + SESSION_LIFETIME);
        assert!(
            sessions
                .issue_at(identity(), &workspace, &flow, current)
                .await
                .is_err()
        );
        assert_eq!(
            sessions
                .authenticate_at(&workspace, &issued.secret, current)
                .await
                .unwrap()
                .subject,
            "alice"
        );
        assert!(
            sessions
                .authenticate_at(&workspace, &issued.secret, issued.expires_at)
                .await
                .is_err()
        );
        assert!(
            sessions
                .authenticate_at(&Uuid::new_v4().to_string(), &issued.secret, current)
                .await
                .is_err()
        );
        assert!(
            sessions
                .authenticate_at(&workspace, &(issued.secret.clone() + "0"), current)
                .await
                .is_err()
        );
        let serialized = serde_json::to_string(&*metadata.groups.lock().unwrap()).unwrap();
        assert!(!serialized.contains(&issued.secret));
        let reopened = OwnerSessions::open(metadata.clone()).await.unwrap();
        assert!(
            reopened
                .authenticate_at(&workspace, &issued.secret, current)
                .await
                .is_ok()
        );
        reopened
            .revoke(&workspace, &issued.secret, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        assert!(
            sessions
                .authenticate_at(&workspace, &issued.secret, current)
                .await
                .is_err()
        );
        assert!(
            OwnerSessions::open(metadata)
                .await
                .unwrap()
                .authenticate_at(&workspace, &issued.secret, current)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn only_ready_owner_can_issue_and_lost_commit_does_not_create_another_session() {
        let (metadata, _, workspace) = ready().await;
        let sessions = OwnerSessions::open(metadata.clone()).await.unwrap();
        let current = now().unwrap();
        let flow = Uuid::new_v4().to_string();
        let wrong = VerifiedIdentity {
            issuer: "https://issuer.example",
            subject: "mallory",
        };
        assert!(
            sessions
                .issue_at(wrong, &workspace, &flow, current)
                .await
                .is_err()
        );
        metadata.lose_reply.store(true, Ordering::SeqCst);
        let alice = || VerifiedIdentity {
            issuer: "https://issuer.example",
            subject: "alice",
        };
        let issued = sessions
            .issue_at(alice(), &workspace, &flow, current)
            .await
            .unwrap();
        assert!(
            sessions
                .issue_at(alice(), &workspace, &flow, current)
                .await
                .is_err()
        );
        assert!(
            sessions
                .authenticate_at(&workspace, &issued.secret, current)
                .await
                .is_ok()
        );
    }
}
