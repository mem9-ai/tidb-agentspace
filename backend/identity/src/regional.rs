//! Inactive local Region policy primitives. Installation is an internal operation that must
//! only be exposed through an authenticated Global-initiated control channel. The module
//! does not authenticate HTTP callers, establish that channel, or access Global metadata.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use subtle::ConstantTimeEq;
use uuid::Uuid;
use workspace_contracts::{MetaRequest, Metadata, Result, Scope};

use crate::{error, now, valid_region, valid_text};

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum OwnerIdentity {
    Oidc {
        issuer: String,
        subject: String,
    },
    Guest {
        guest_id: String,
        verifier: String,
        created_at: i64,
        expires_at: i64,
    },
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub workspace_id: String,
    pub organization_id: String,
    pub principal_id: String,
    pub region_id: String,
    pub generation: u64,
    pub denied: bool,
    pub identity: OwnerIdentity,
}

/// OIDC fields must come from a cryptographically verified identity, not request parameters.
#[derive(Clone, Copy)]
pub enum Principal<'a> {
    Oidc { issuer: &'a str, subject: &'a str },
    Guest { guest_id: &'a str, secret: &'a str },
}

pub struct Policies {
    metadata: Arc<dyn Metadata>,
    authority: String,
}

fn uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}

pub(crate) fn validate(policy: &Policy, authority: &str) -> Result<()> {
    if !uuid(&policy.workspace_id)
        || !uuid(&policy.organization_id)
        || !uuid(&policy.principal_id)
        || policy.region_id != authority
        || policy.generation == 0
    {
        return Err(error(400, "INVALID_POLICY"));
    }
    let valid_identity = match &policy.identity {
        OwnerIdentity::Oidc { issuer, subject } => valid_text(issuer) && valid_text(subject),
        OwnerIdentity::Guest {
            guest_id,
            verifier,
            created_at,
            expires_at,
        } => {
            uuid(guest_id)
                && verifier.len() == 64
                && hex::decode(verifier).is_ok_and(|bytes| bytes.len() == 32)
                && created_at.checked_add(86_400) == Some(*expires_at)
        }
    };
    if !valid_identity {
        return Err(error(400, "INVALID_POLICY"));
    }
    Ok(())
}

impl Policies {
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

    pub(crate) fn scope(&self, workspace: &str) -> Result<Scope> {
        if !uuid(workspace) {
            return Err(error(404, "WORKSPACE_NOT_FOUND"));
        }
        Ok(Scope {
            authority_id: self.authority.clone(),
            owner_kind: "workspace".into(),
            owner_id: workspace.into(),
            family: "regional-policy".into(),
            partition_id: "primary".into(),
        })
    }

    pub(crate) async fn read(&self, scope: &Scope) -> Result<Option<(Policy, String)>> {
        let response = self
            .metadata
            .execute(MetaRequest::Get {
                scope: scope.clone(),
                guard: None,
                keys: vec!["owner-policy".into()],
            })
            .await?;
        let record = response["records"]
            .get("owner-policy")
            .ok_or_else(|| error(503, "POLICY_RECORD_CORRUPT"))?;
        if record.is_null() {
            return Ok(None);
        }
        let version = record["version"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| error(503, "POLICY_RECORD_CORRUPT"))?;
        let policy: Policy = serde_json::from_value(record["value"].clone())
            .map_err(|_| error(503, "POLICY_RECORD_CORRUPT"))?;
        validate(&policy, &self.authority).map_err(|_| error(503, "POLICY_RECORD_CORRUPT"))?;
        if policy.workspace_id != scope.owner_id {
            return Err(error(503, "POLICY_RECORD_CORRUPT"));
        }
        Ok(Some((policy, version.to_owned())))
    }

    /// Caller must authenticate the Global control plane and verify command/placement before
    /// invoking this internal method. New policies cannot change an existing owner identity.
    pub async fn install(&self, policy: &Policy, command_id: &str) -> Result<()> {
        validate(policy, &self.authority)?;
        if !uuid(command_id) {
            return Err(error(400, "INVALID_COMMAND"));
        }
        let scope = self.scope(&policy.workspace_id)?;
        for _ in 0..8 {
            let previous = self.read(&scope).await?;
            let version = if let Some((old, version)) = previous {
                if old.organization_id != policy.organization_id
                    || old.principal_id != policy.principal_id
                    || old.identity != policy.identity
                {
                    return Err(error(409, "POLICY_OWNER_MISMATCH"));
                }
                if old.generation > policy.generation {
                    return Err(error(409, "POLICY_STALE"));
                }
                if old.generation == policy.generation {
                    return if old == *policy {
                        Ok(())
                    } else {
                        Err(error(409, "POLICY_GENERATION_MISMATCH"))
                    };
                }
                Value::String(version)
            } else {
                if policy.generation != 1 {
                    return Err(error(409, "POLICY_INITIAL_GENERATION"));
                }
                Value::Null
            };
            let result = self
                .metadata
                .execute(MetaRequest::Commit {
                    scope: scope.clone(),
                    guard: None,
                    mutation_id: command_id.into(),
                    changes: vec![
                        json!({"key":"owner-policy","expectedVersion":version,"value":policy}),
                    ],
                })
                .await;
            match result {
                Ok(_) => return Ok(()),
                Err(e) if e.code == "META_CONFLICT" => continue,
                Err(e) if e.code == "META_COMMIT_UNKNOWN" => {
                    let receipt = self
                        .metadata
                        .execute(MetaRequest::Resolve {
                            scope: scope.clone(),
                            guard: None,
                            mutation_id: command_id.into(),
                        })
                        .await;
                    if receipt
                        .as_ref()
                        .is_ok_and(|value| value["outcome"] == "committed")
                    {
                        let current = self.read(&scope).await?;
                        return if current
                            .as_ref()
                            .is_some_and(|(installed, _)| installed == policy)
                        {
                            Ok(())
                        } else {
                            Err(error(503, "POLICY_COMMIT_INCONSISTENT"))
                        };
                    }
                    return Err(e);
                }
                Err(e) => return Err(e),
            }
        }
        Err(error(503, "POLICY_CONFLICT_UNRESOLVED"))
    }

    /// This checks only owner identity and locally installed policy. Resource/action grants,
    /// session authentication, Workspace readiness and provider authorization remain separate.
    pub async fn authorize_owner(&self, workspace: &str, principal: Principal<'_>) -> Result<()> {
        self.authorize_at(workspace, principal, now()?).await
    }

    pub(crate) async fn authorize_at(
        &self,
        workspace: &str,
        principal: Principal<'_>,
        current: i64,
    ) -> Result<()> {
        let scope = self.scope(workspace)?;
        let (policy, _) = self
            .read(&scope)
            .await?
            .ok_or_else(|| error(403, "POLICY_NOT_INSTALLED"))?;
        if policy.denied {
            return Err(error(403, "POLICY_DENIED"));
        }
        let authorized = match (&policy.identity, principal) {
            (
                OwnerIdentity::Oidc { issuer, subject },
                Principal::Oidc {
                    issuer: supplied_issuer,
                    subject: supplied_subject,
                },
            ) => issuer == supplied_issuer && subject == supplied_subject,
            (
                OwnerIdentity::Guest {
                    guest_id,
                    verifier,
                    expires_at,
                    ..
                },
                Principal::Guest {
                    guest_id: supplied_id,
                    secret,
                },
            ) => {
                let expected =
                    hex::decode(verifier).map_err(|_| error(503, "POLICY_RECORD_CORRUPT"))?;
                let bytes = hex::decode(secret)
                    .ok()
                    .filter(|bytes| bytes.len() == 32 && secret.len() == 64);
                guest_id == supplied_id
                    && current < *expires_at
                    && bytes.is_some_and(|bytes| {
                        Sha256::digest(bytes)
                            .as_slice()
                            .ct_eq(&expected)
                            .unwrap_u8()
                            == 1
                    })
            }
            _ => false,
        };
        if !authorized {
            return Err(error(403, "POLICY_DENIED"));
        }
        Ok(())
    }
}
