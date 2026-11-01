//! Region-local Key version records. This module is not an HTTP authentication boundary.
//! Callers must authenticate Global control commands, verify token signatures/audience, and
//! enforce action and resource grants independently. No method contacts Global.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use uuid::Uuid;
use workspace_contracts::{MetaRequest, Metadata, Result, Scope};

use crate::{error, valid_region};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyPolicy {
    pub workspace_id: String,
    pub region_id: String,
    pub key_id: String,
    pub principal_id: String,
    pub key_version: u64,
    pub policy_generation: u64,
    pub grant_ref: String,
    pub expires_at: i64,
    pub revoked: bool,
}

/// Only values from a cryptographically verified, audience-validated token may be passed here.
/// This check alone never authorizes an action or resource.
pub struct VerifiedKeyBinding<'a> {
    pub workspace_id: &'a str,
    pub region_id: &'a str,
    pub key_id: &'a str,
    pub principal_id: &'a str,
    pub key_version: u64,
    pub policy_generation: u64,
    pub expires_at: i64,
    pub not_before: i64,
}

pub struct KeyPolicies {
    metadata: Arc<dyn Metadata>,
    authority: String,
}

fn uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|v| v.to_string() == value)
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.:".contains(&b))
}

fn validate(policy: &KeyPolicy, authority: &str) -> Result<()> {
    if !valid_id(&policy.workspace_id)
        || !uuid(&policy.key_id)
        || !valid_id(&policy.principal_id)
        || policy.region_id != authority
        || policy.key_version == 0
        || policy.policy_generation == 0
        || !valid_id(&policy.grant_ref)
        || policy.expires_at <= 0
    {
        return Err(error(400, "INVALID_KEY_POLICY"));
    }
    Ok(())
}

impl KeyPolicies {
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

    pub(crate) fn scope(&self, workspace: &str, key: &str) -> Result<Scope> {
        if !valid_id(workspace) || !uuid(key) {
            return Err(error(404, "NOT_FOUND"));
        }
        Ok(Scope {
            authority_id: self.authority.clone(),
            owner_kind: "workspace".into(),
            owner_id: workspace.into(),
            family: "regional-key-policy".into(),
            partition_id: key.into(),
        })
    }

    pub(crate) async fn read(&self, scope: &Scope) -> Result<Option<(KeyPolicy, Value)>> {
        let result = self
            .metadata
            .execute(MetaRequest::Get {
                scope: scope.clone(),
                guard: None,
                keys: vec!["policy".into()],
            })
            .await?;
        let record = result["records"]
            .get("policy")
            .ok_or_else(|| error(503, "KEY_POLICY_CORRUPT"))?;
        if record.is_null() {
            return Ok(None);
        }
        let version = record
            .get("version")
            .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
            .ok_or_else(|| error(503, "KEY_POLICY_CORRUPT"))?;
        let policy: KeyPolicy = serde_json::from_value(record["value"].clone())
            .map_err(|_| error(503, "KEY_POLICY_CORRUPT"))?;
        validate(&policy, &self.authority).map_err(|_| error(503, "KEY_POLICY_CORRUPT"))?;
        if policy.workspace_id != scope.owner_id || policy.key_id != scope.partition_id {
            return Err(error(503, "KEY_POLICY_CORRUPT"));
        }
        Ok(Some((policy, version.clone())))
    }

    /// Install only after authenticating Global and validating the signed command and placement.
    /// A missing generation cannot be skipped; a revoked Key cannot be reactivated.
    pub async fn install(&self, policy: &KeyPolicy, command_id: &str) -> Result<()> {
        validate(policy, &self.authority)?;
        if !uuid(command_id) {
            return Err(error(400, "INVALID_COMMAND"));
        }
        let scope = self.scope(&policy.workspace_id, &policy.key_id)?;
        let command_key = format!("commands/{command_id}");
        let fingerprint = hex::encode(Sha256::digest(
            serde_json::to_vec(policy).map_err(|_| error(503, "KEY_POLICY_CORRUPT"))?,
        ));
        for _ in 0..8 {
            let commands = self
                .metadata
                .execute(MetaRequest::Get {
                    scope: scope.clone(),
                    guard: None,
                    keys: vec![command_key.clone()],
                })
                .await?;
            let command = commands["records"]
                .get(&command_key)
                .ok_or_else(|| error(503, "KEY_POLICY_CORRUPT"))?;
            if !command.is_null() {
                return if command["value"]["fingerprint"] == fingerprint {
                    Ok(())
                } else {
                    Err(error(409, "KEY_POLICY_COMMAND_MISMATCH"))
                };
            }
            let prior = self.read(&scope).await?;
            let expected = match prior {
                None if policy.policy_generation == 1 && policy.key_version == 1 => Value::Null,
                None => return Err(error(409, "KEY_POLICY_GAP")),
                Some((old, version)) => {
                    if old.principal_id != policy.principal_id || (old.revoked && !policy.revoked) {
                        return Err(error(409, "KEY_POLICY_OWNER_OR_REVOKE_MISMATCH"));
                    }
                    if old.policy_generation.checked_add(1) != Some(policy.policy_generation)
                        || old.key_version.checked_add(1) != Some(policy.key_version)
                    {
                        return Err(error(409, "KEY_POLICY_GAP"));
                    }
                    version
                }
            };
            let result = self
                .metadata
                .execute(MetaRequest::Commit {
                    scope: scope.clone(),
                    guard: None,
                    mutation_id: command_id.into(),
                    changes: vec![
                        json!({"key":"policy","expectedVersion":expected,"value":policy}),
                        json!({"key":command_key,"expectedVersion":null,"value":{"fingerprint":fingerprint}}),
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
                    if receipt.as_ref().is_ok_and(|v| v["outcome"] == "committed") {
                        let replay = self
                            .metadata
                            .execute(MetaRequest::Get {
                                scope: scope.clone(),
                                guard: None,
                                keys: vec![command_key.clone()],
                            })
                            .await?;
                        return if replay["records"][&command_key]["value"]["fingerprint"]
                            == fingerprint
                        {
                            Ok(())
                        } else {
                            Err(error(503, "KEY_POLICY_COMMIT_INCONSISTENT"))
                        };
                    }
                    return Err(e);
                }
                Err(e) => return Err(e),
            }
        }
        Err(error(503, "KEY_POLICY_CONFLICT_UNRESOLVED"))
    }

    /// Check only a verified token's Key binding against locally durable policy.
    /// No Global call or policy-age expiration is performed.
    pub async fn check_token_key_binding(
        &self,
        token: &VerifiedKeyBinding<'_>,
        now: i64,
    ) -> Result<String> {
        let denied = || error(401, "INVALID_CREDENTIAL");
        let scope = self
            .scope(token.workspace_id, token.key_id)
            .map_err(|_| denied())?;
        let (policy, _) = self.read(&scope).await?.ok_or_else(denied)?;
        if now <= 0
            || token.policy_generation == 0
            || token.policy_generation > policy.policy_generation
            || policy.revoked
            || policy.region_id != token.region_id
            || policy.principal_id != token.principal_id
            || policy.key_version != token.key_version
            || token.not_before > now
            || token.expires_at <= now
            || policy.expires_at <= now
            || token.expires_at > policy.expires_at
        {
            return Err(denied());
        }
        Ok(policy.grant_ref)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::MemoryMeta;

    fn id() -> String {
        Uuid::new_v4().to_string()
    }

    #[tokio::test]
    async fn local_policy_enforces_version_expiry_identity_and_durable_denial() {
        let metadata = Arc::new(MemoryMeta {
            authority: Some("region:a".into()),
            ..Default::default()
        });
        let service = KeyPolicies::open(metadata.clone(), "region:a")
            .await
            .unwrap();
        let mut policy = KeyPolicy {
            workspace_id: "ws_agentlab".into(),
            region_id: "region:a".into(),
            key_id: id(),
            principal_id: "legacy-owner".into(),
            key_version: 1,
            policy_generation: 1,
            grant_ref: "grant:existing".into(),
            expires_at: 1000,
            revoked: false,
        };
        let command = id();
        service.install(&policy, &command).await.unwrap();
        service.install(&policy, &command).await.unwrap();
        let binding = |version, generation, expiry, not_before| VerifiedKeyBinding {
            workspace_id: &policy.workspace_id,
            region_id: &policy.region_id,
            key_id: &policy.key_id,
            principal_id: &policy.principal_id,
            key_version: version,
            policy_generation: generation,
            expires_at: expiry,
            not_before,
        };
        assert_eq!(
            service
                .check_token_key_binding(&binding(1, 1, 900, 1), 100)
                .await
                .unwrap(),
            "grant:existing"
        );
        for (version, generation, expiry, nbf, now) in [
            (2, 1, 900, 1, 100),
            (1, 2, 900, 1, 100),
            (1, 1, 1001, 1, 100),
            (1, 1, 100, 1, 100),
            (1, 1, 900, 101, 100),
            (1, 1, 900, 0, 0),
            (1, 1, 1000, 1, 1000),
        ] {
            assert_eq!(
                service
                    .check_token_key_binding(&binding(version, generation, expiry, nbf), now)
                    .await
                    .unwrap_err()
                    .code,
                "INVALID_CREDENTIAL"
            );
        }
        let mut wrong = binding(1, 1, 900, 1);
        wrong.workspace_id = "another_workspace";
        assert_eq!(
            service
                .check_token_key_binding(&wrong, 100)
                .await
                .unwrap_err()
                .code,
            "INVALID_CREDENTIAL"
        );
        wrong = binding(1, 1, 900, 1);
        wrong.region_id = "region:b";
        assert_eq!(
            service
                .check_token_key_binding(&wrong, 100)
                .await
                .unwrap_err()
                .code,
            "INVALID_CREDENTIAL"
        );
        wrong = binding(1, 1, 900, 1);
        wrong.principal_id = "other-owner";
        assert_eq!(
            service
                .check_token_key_binding(&wrong, 100)
                .await
                .unwrap_err()
                .code,
            "INVALID_CREDENTIAL"
        );

        let mut update = policy.clone();
        update.key_version = 2;
        update.policy_generation = 2;
        update.expires_at = 2000;
        assert_eq!(
            service.install(&update, &command).await.unwrap_err().code,
            "KEY_POLICY_COMMAND_MISMATCH"
        );
        let mut gap = update.clone();
        gap.policy_generation = 3;
        assert_eq!(
            service.install(&gap, &id()).await.unwrap_err().code,
            "KEY_POLICY_GAP"
        );
        service.install(&update, &id()).await.unwrap();
        assert_eq!(
            service
                .check_token_key_binding(&binding(1, 1, 900, 1), 100)
                .await
                .unwrap_err()
                .code,
            "INVALID_CREDENTIAL"
        );
        assert_eq!(
            service
                .check_token_key_binding(&binding(2, 2, 1900, 1), 100)
                .await
                .unwrap(),
            "grant:existing"
        );
        // A retry of the original command never rolls the current version back.
        service.install(&policy, &command).await.unwrap();
        let reopened = KeyPolicies::open(metadata, "region:a").await.unwrap();
        assert_eq!(
            reopened
                .check_token_key_binding(&binding(2, 2, 1900, 1), 100)
                .await
                .unwrap(),
            "grant:existing"
        );
        update.key_version = 3;
        update.policy_generation = 3;
        update.revoked = true;
        reopened.install(&update, &id()).await.unwrap();
        assert_eq!(
            reopened
                .check_token_key_binding(&binding(2, 2, 1900, 1), 100)
                .await
                .unwrap_err()
                .code,
            "INVALID_CREDENTIAL"
        );
        policy.key_version = 4;
        policy.policy_generation = 4;
        assert_eq!(
            reopened.install(&policy, &id()).await.unwrap_err().code,
            "KEY_POLICY_OWNER_OR_REVOKE_MISMATCH"
        );
    }
}
