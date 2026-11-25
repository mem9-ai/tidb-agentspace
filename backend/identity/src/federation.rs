//! Federated login resolves an identity only. Admission, creation and resource access are
//! separate decisions; names, email, tags, provider roles and createdBy never grant access.
mod governance;
mod region;
pub use governance::{Enrollment, EnrollmentStatus, Workspace};
pub use region::RegionalFederation;

use crate::{error, valid_text};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use uuid::Uuid;
use workspace_contracts::{MetaRequest, Metadata, Result, Scope};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PrincipalKind {
    Human,
    Agent,
}

/// Supply only after verifying the configured provider, client, subject and Server.
/// Provider is a stable configuration ID, not an issuer inferred from caller input.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalIdentity {
    pub provider: String,
    pub server_id: String,
    pub subject: String,
    pub kind: PrincipalKind,
}
impl ExternalIdentity {
    pub fn validate(&self) -> Result<()> {
        if !valid_text(&self.provider)
            || self.provider.len() > 128
            || !valid_text(&self.subject)
            || !Uuid::parse_str(&self.server_id).is_ok_and(|id| id.to_string() == self.server_id)
        {
            return Err(error(401, "INVALID_EXTERNAL_IDENTITY"));
        }
        Ok(())
    }
    /// Bind a signed regional actor proof to the exact external identity, including kind.
    pub fn stamp_id(&self) -> Result<String> {
        let hash = Sha256::new()
            .chain_update(b"agentspace-actor-proof-v1\0")
            .chain_update(self.binding_id()?.as_bytes())
            .chain_update([match self.kind {
                PrincipalKind::Human => 0,
                PrincipalKind::Agent => 1,
            }])
            .finalize();
        Ok(Uuid::from_bytes(hash[..16].try_into().expect("16 bytes")).to_string())
    }
    fn binding_id(&self) -> Result<String> {
        self.validate()?;
        let mut hash = Sha256::new();
        hash.update(b"agentspace-external-identity-v1\0");
        // Kind is checked against the immutable binding, preventing silent role conversion.
        for part in [&self.provider, &self.server_id, &self.subject] {
            hash.update((part.len() as u64).to_be_bytes());
            hash.update(part.as_bytes());
        }
        Ok(hex::encode(hash.finalize()))
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FederatedPrincipal {
    pub id: String,
    pub identity: ExternalIdentity,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Membership {
    pub principal_id: String,
    pub kind: PrincipalKind,
    pub server_id: String,
    pub active: bool,
    pub governor: bool,
}
impl Membership {
    pub fn authorize(&self, principal: &FederatedPrincipal) -> Result<()> {
        if !self.active
            || self.principal_id != principal.id
            || self.kind != principal.identity.kind
            || self.server_id != principal.identity.server_id
        {
            return Err(error(403, "WORKSPACE_MEMBERSHIP_REQUIRED"));
        }
        Ok(())
    }
    pub fn govern(&self, principal: &FederatedPrincipal) -> Result<()> {
        self.authorize(principal)?;
        if principal.identity.kind != PrincipalKind::Human || !self.governor {
            return Err(error(403, "HUMAN_APPROVAL_REQUIRED"));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum ResourceAction {
    #[serde(rename = "resources:read")]
    Discover,
    #[serde(rename = "files:read")]
    ReadFiles,
    #[serde(rename = "files:write")]
    WriteFiles,
    #[serde(rename = "files:analyze")]
    AnalyzeFiles,
    #[serde(rename = "queries:read")]
    ReadQueries,
    #[serde(rename = "queries:execute")]
    ExecuteQueries,
    #[serde(rename = "usage:read")]
    ReadUsage,
    #[serde(rename = "tags:write")]
    EditTags,
}
impl ResourceAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Discover => "resources:read",
            Self::ReadFiles => "files:read",
            Self::WriteFiles => "files:write",
            Self::AnalyzeFiles => "files:analyze",
            Self::ReadQueries => "queries:read",
            Self::ExecuteQueries => "queries:execute",
            Self::ReadUsage => "usage:read",
            Self::EditTags => "tags:write",
        }
    }
    pub fn permits(self, requested: Self) -> bool {
        self == requested || self == Self::ExecuteQueries && requested == Self::ReadQueries
    }
}
/// One exact edge. Grant unions never cross resource or principal boundaries.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccessGrant {
    pub id: String,
    pub principal_id: String,
    pub resource_id: String,
    pub actions: Vec<ResourceAction>,
    pub revoked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}
impl AccessGrant {
    pub fn permits(
        &self,
        principal: &str,
        resource: &str,
        action: ResourceAction,
        now: i64,
    ) -> bool {
        !self.revoked
            && self.expires_at.is_none_or(|expiry| expiry > now)
            && self.principal_id == principal
            && self.resource_id == resource
            && self.actions.iter().any(|a| a.permits(action))
    }
}

pub struct EffectiveAccess {
    pub actions: Vec<ResourceAction>,
    pub expires_at: i64,
}

#[derive(Clone)]
pub struct Federation {
    metadata: Arc<dyn Metadata>,
}
impl Federation {
    pub async fn open(metadata: Arc<dyn Metadata>) -> Result<Self> {
        crate::Directory::open(metadata.clone()).await?;
        Ok(Self { metadata })
    }
    pub async fn resolve(&self, identity: ExternalIdentity) -> Result<FederatedPrincipal> {
        let binding = identity.binding_id()?;
        let scope = Scope::system("global", &binding, "federated-identity", "primary");
        for _ in 0..8 {
            let response = self
                .metadata
                .execute(MetaRequest::Get {
                    scope: scope.clone(),
                    guard: None,
                    keys: vec!["principal".into()],
                })
                .await?;
            let record = response["records"]
                .get("principal")
                .ok_or_else(|| error(503, "IDENTITY_RECORD_CORRUPT"))?;
            if !record.is_null() {
                let principal: FederatedPrincipal = serde_json::from_value(record["value"].clone())
                    .map_err(|_| error(503, "IDENTITY_RECORD_CORRUPT"))?;
                if principal.identity != identity {
                    return Err(error(401, "IDENTITY_KIND_MISMATCH"));
                }
                if Uuid::parse_str(&principal.id).is_err() {
                    return Err(error(503, "IDENTITY_RECORD_CORRUPT"));
                }
                self.index_principal(&principal, &binding).await?;
                return Ok(principal);
            }
            let principal = FederatedPrincipal {
                id: Uuid::new_v4().to_string(),
                identity: identity.clone(),
            };
            match self
                .metadata
                .execute(MetaRequest::Commit {
                    scope: scope.clone(),
                    guard: None,
                    mutation_id: Uuid::new_v4().to_string(),
                    changes: vec![
                        json!({"key":"principal","expectedVersion":null,"value":principal}),
                    ],
                })
                .await
            {
                Ok(_) => {
                    self.index_principal(&principal, &binding).await?;
                    return Ok(principal);
                }
                Err(e) if e.code == "META_CONFLICT" => continue,
                // A new login can resolve the same identity after an uncertain commit.
                Err(e) => return Err(e),
            }
        }
        Err(error(409, "IDENTITY_BUSY"))
    }
}

impl Federation {
    async fn index_principal(&self, principal: &FederatedPrincipal, binding: &str) -> Result<()> {
        let scope = Scope::system("global", &principal.id, "federated-principal", "primary");
        for _ in 0..8 {
            let response = self
                .metadata
                .execute(MetaRequest::Get {
                    scope: scope.clone(),
                    guard: None,
                    keys: vec!["binding".into()],
                })
                .await?;
            let record = &response["records"]["binding"];
            if !record.is_null() {
                return if record["value"]["binding"] == binding {
                    Ok(())
                } else {
                    Err(error(503, "IDENTITY_RECORD_CORRUPT"))
                };
            }
            match self
                .metadata
                .execute(MetaRequest::Commit {
                    scope: scope.clone(),
                    guard: None,
                    mutation_id: Uuid::new_v4().to_string(),
                    changes: vec![
                        json!({"key":"binding","expectedVersion":null,"value":{"binding":binding}}),
                    ],
                })
                .await
            {
                Ok(_) => return Ok(()),
                Err(e) if e.code == "META_CONFLICT" => continue,
                Err(e) => return Err(e),
            }
        }
        Err(error(409, "IDENTITY_BUSY"))
    }
    /// Exact verified-principal lookup for Human admission; never a public roster.
    pub async fn principal(&self, id: &str) -> Result<FederatedPrincipal> {
        if !Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id) {
            return Err(error(400, "INVALID_ID"));
        }
        let index = self
            .metadata
            .execute(MetaRequest::Get {
                scope: Scope::system("global", id, "federated-principal", "primary"),
                guard: None,
                keys: vec!["binding".into()],
            })
            .await?;
        let binding = index["records"]["binding"]["value"]["binding"]
            .as_str()
            .ok_or_else(|| error(404, "NOT_FOUND"))?;
        if binding.len() != 64 || !binding.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(error(503, "IDENTITY_RECORD_CORRUPT"));
        }
        let record = self
            .metadata
            .execute(MetaRequest::Get {
                scope: Scope::system("global", binding, "federated-identity", "primary"),
                guard: None,
                keys: vec!["principal".into()],
            })
            .await?;
        let principal: FederatedPrincipal =
            serde_json::from_value(record["records"]["principal"]["value"].clone())
                .map_err(|_| error(503, "IDENTITY_RECORD_CORRUPT"))?;
        if principal.id != id || principal.identity.binding_id()? != binding {
            return Err(error(503, "IDENTITY_RECORD_CORRUPT"));
        }
        Ok(principal)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn actor(kind: PrincipalKind) -> FederatedPrincipal {
        FederatedPrincipal {
            id: Uuid::new_v4().to_string(),
            identity: ExternalIdentity {
                provider: "raft".into(),
                server_id: Uuid::new_v4().to_string(),
                subject: "same-name".into(),
                kind,
            },
        }
    }
    #[test]
    fn binding_is_stable_scoped_and_detects_kind_conflicts() {
        let original = actor(PrincipalKind::Human).identity;
        let mut different = original.clone();
        different.kind = PrincipalKind::Agent;
        assert_eq!(
            original.binding_id().unwrap(),
            different.binding_id().unwrap()
        );
        different.server_id = Uuid::new_v4().to_string();
        assert_ne!(
            original.binding_id().unwrap(),
            different.binding_id().unwrap()
        );
        different = original.clone();
        different.provider = "cloud".into();
        assert_ne!(
            original.binding_id().unwrap(),
            different.binding_id().unwrap()
        );
        different.server_id = "caller-selected".into();
        assert!(different.validate().is_err());
    }
    #[test]
    fn admission_does_not_grant_agent_governance() {
        let agent = actor(PrincipalKind::Agent);
        let mut member = Membership {
            principal_id: agent.id.clone(),
            kind: PrincipalKind::Agent,
            server_id: agent.identity.server_id.clone(),
            active: true,
            governor: true,
        };
        assert!(member.authorize(&agent).is_ok());
        assert_eq!(
            member.govern(&agent).unwrap_err().code,
            "HUMAN_APPROVAL_REQUIRED"
        );
        member.active = false;
        assert!(member.authorize(&agent).is_err());
        member.active = true;
        member.server_id = Uuid::new_v4().to_string();
        assert!(member.authorize(&agent).is_err());
    }
    #[test]
    fn exact_grants_do_not_form_cross_resource_action_products() {
        let mut writer = AccessGrant {
            id: "one".into(),
            principal_id: "a".into(),
            resource_id: "db1".into(),
            actions: vec![ResourceAction::ExecuteQueries],
            revoked: false,
            expires_at: None,
        };
        let reader = AccessGrant {
            id: "two".into(),
            resource_id: "db2".into(),
            actions: vec![ResourceAction::ReadQueries],
            ..writer.clone()
        };
        let permitted = |resource, action| {
            [&writer, &reader]
                .iter()
                .any(|g| g.permits("a", resource, action, 0))
        };
        assert!(permitted("db1", ResourceAction::ExecuteQueries));
        assert!(permitted("db1", ResourceAction::ReadQueries));
        assert!(permitted("db2", ResourceAction::ReadQueries));
        assert!(!permitted("db2", ResourceAction::ExecuteQueries));
        assert!(!permitted("same-tag", ResourceAction::ReadQueries));
        assert!(!reader.permits("b", "db2", ResourceAction::ReadQueries, 0));
        writer.revoked = true;
        assert!(!writer.permits("a", "db1", ResourceAction::ExecuteQueries, 0));
        assert!(reader.permits("a", "db2", ResourceAction::ReadQueries, 0));
        writer.revoked = false;
        writer.expires_at = Some(10);
        assert!(writer.permits("a", "db1", ResourceAction::ExecuteQueries, 9));
        assert!(!writer.permits("a", "db1", ResourceAction::ExecuteQueries, 10));
    }
}
