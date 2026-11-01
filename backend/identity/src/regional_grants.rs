//! Canonical immutable grant snapshots shared by Global intent and local Region admission.
use crate::{regional_key_policy::KeyPolicies, regional_refresh::CeilingVerifier};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{future::Future, pin::Pin};
use workspace_contracts::{MetaRequest, Result, ServiceError};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Grant {
    pub scopes: Vec<String>,
    pub resource_ids: Vec<String>,
    pub region_id: String,
}
const ACTIONS: &[&str] = &[
    "resources:read",
    "resources:write",
    "queries:read",
    "queries:execute",
    "files:read",
    "files:write",
    "files:analyze",
    "usage:read",
];
fn id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s != "."
        && s != ".."
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.:".contains(&b))
}
impl Grant {
    pub fn validate(&self) -> Result<()> {
        let ordered = |values: &[String]| values.windows(2).all(|pair| pair[0] < pair[1]);
        if self.scopes.is_empty()
            || self.scopes.len() > 8
            || !ordered(&self.scopes)
            || self
                .scopes
                .iter()
                .any(|s| s != "*" && !ACTIONS.contains(&s.as_str()))
            || self.scopes.len() > 1 && self.scopes.iter().any(|s| s == "*")
            || self.resource_ids.is_empty()
            || self.resource_ids.len() > 1024
            || !ordered(&self.resource_ids)
            || self.resource_ids.iter().any(|s| s != "*" && !id(s))
            || self.resource_ids.len() > 1 && self.resource_ids.iter().any(|s| s == "*")
            || !self.region_id.starts_with("region:")
            || !id(&self.region_id)
        {
            return Err(ServiceError::new(400, "INVALID_GRANT"));
        }
        Ok(())
    }
    pub fn reference(&self) -> Result<String> {
        self.validate()?;
        let value =
            serde_json::to_value(self).map_err(|_| ServiceError::new(503, "GRANT_UNAVAILABLE"))?;
        Ok(format!(
            "grant-{:x}",
            Sha256::digest(
                serde_json::to_vec(&value)
                    .map_err(|_| ServiceError::new(503, "GRANT_UNAVAILABLE"))?
            )
        ))
    }
    pub fn permits_action(&self, action: &str) -> bool {
        self.scopes
            .iter()
            .any(|s| s == "*" || s == action || action == "queries:read" && s == "queries:execute")
    }
    pub fn subset_of(&self, other: &Self) -> bool {
        self.region_id == other.region_id
            && self.scopes.iter().all(|s| other.permits_action(s))
            && self
                .resource_ids
                .iter()
                .all(|r| other.resource_ids.iter().any(|p| p == "*" || p == r))
    }
    pub fn intersection(&self, other: &Self) -> Result<Self> {
        self.validate()?;
        other.validate()?;
        let scopes = ACTIONS
            .iter()
            .filter(|a| self.permits_action(a) && other.permits_action(a))
            .map(|a| a.to_string())
            .collect::<Vec<_>>();
        let resource_ids = if self.resource_ids == ["*"] {
            other.resource_ids.clone()
        } else if other.resource_ids == ["*"] {
            self.resource_ids.clone()
        } else {
            self.resource_ids
                .iter()
                .filter(|r| other.resource_ids.contains(r))
                .cloned()
                .collect()
        };
        let mut value = Self {
            scopes,
            resource_ids,
            region_id: self.region_id.clone(),
        };
        value.scopes.sort();
        if self.region_id != other.region_id {
            return Err(ServiceError::new(403, "CEILING_DENIED"));
        }
        value
            .validate()
            .map_err(|_| ServiceError::new(403, "CEILING_DENIED"))?;
        Ok(value)
    }
}
impl KeyPolicies {
    pub async fn grant(&self, workspace: &str, key: &str, reference: &str) -> Result<Grant> {
        if !id(reference) {
            return Err(ServiceError::new(403, "CEILING_DENIED"));
        }
        let path = format!("grants/{reference}");
        let response = self
            .metadata_port()
            .execute(MetaRequest::Get {
                scope: self.scope(workspace, key)?,
                guard: None,
                keys: vec![path.clone()],
            })
            .await?;
        let record = &response["records"][&path];
        if record.is_null() {
            return Err(ServiceError::new(403, "CEILING_DENIED"));
        }
        let grant: Grant = serde_json::from_value(record["value"].clone())
            .map_err(|_| ServiceError::new(503, "GRANT_CORRUPT"))?;
        if grant
            .reference()
            .map_err(|_| ServiceError::new(503, "GRANT_CORRUPT"))?
            != reference
        {
            return Err(ServiceError::new(503, "GRANT_CORRUPT"));
        }
        Ok(grant)
    }
}
impl CeilingVerifier for KeyPolicies {
    fn check<'a>(
        &'a self,
        workspace: &'a str,
        region: &'a str,
        key: &'a str,
        grant: &'a str,
        ceiling: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            let active = self.grant(workspace, key, grant).await?;
            let ceiling = self.grant(workspace, key, ceiling).await?;
            if active.region_id != region || !ceiling.subset_of(&active) {
                return Err(ServiceError::new(403, "CEILING_DENIED"));
            }
            Ok(())
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn intersections_never_expand_actions_resources_or_region() {
        let a = Grant {
            region_id: "region:a".into(),
            scopes: vec!["files:read".into(), "queries:execute".into()],
            resource_ids: vec!["db1".into(), "fs1".into()],
        };
        let b = Grant {
            region_id: "region:a".into(),
            scopes: vec!["queries:read".into()],
            resource_ids: vec!["db1".into()],
        };
        let c = a.intersection(&b).unwrap();
        assert!(c.subset_of(&a) && c.subset_of(&b));
        assert_eq!(c.scopes, ["queries:read"]);
        assert_eq!(c.resource_ids, ["db1"]);
        let mut wrong = b.clone();
        wrong.region_id = "region:b".into();
        assert!(a.intersection(&wrong).is_err());
        wrong = b;
        wrong.resource_ids = vec!["another".into()];
        assert!(a.intersection(&wrong).is_err());
    }
    #[tokio::test]
    async fn grant_snapshot_and_policy_install_together_and_reject_tampered_bindings() {
        use crate::{regional_key_policy::KeyPolicy, tests::MemoryMeta};
        use std::sync::Arc;
        let metadata = Arc::new(MemoryMeta {
            authority: Some("region:a".into()),
            ..Default::default()
        });
        let policies = KeyPolicies::open(metadata, "region:a").await.unwrap();
        let grant = Grant {
            region_id: "region:a".into(),
            scopes: vec!["files:read".into()],
            resource_ids: vec!["fs1".into()],
        };
        let policy = KeyPolicy {
            workspace_id: "ws_test".into(),
            region_id: "region:a".into(),
            key_id: uuid::Uuid::new_v4().to_string(),
            principal_id: "principal".into(),
            key_version: 1,
            policy_generation: 1,
            grant_ref: grant.reference().unwrap(),
            expires_at: 1000,
            revoked: false,
        };
        let operation = uuid::Uuid::new_v4().to_string();
        policies
            .install_granted(&policy, &operation, Some(&grant))
            .await
            .unwrap();
        policies
            .check(
                "ws_test",
                "region:a",
                &policy.key_id,
                &policy.grant_ref,
                &policy.grant_ref,
            )
            .await
            .unwrap();
        assert_eq!(
            policies
                .grant("ws_test", &policy.key_id, &policy.grant_ref)
                .await
                .unwrap(),
            grant
        );
        assert!(
            policies
                .grant("ws_other", &policy.key_id, &policy.grant_ref)
                .await
                .is_err()
        );
        let mut forged = grant.clone();
        forged.resource_ids = vec!["*".into()];
        assert!(
            policies
                .install_granted(&policy, &operation, Some(&forged))
                .await
                .is_err()
        );
        let mut wrong = policy.clone();
        wrong.grant_ref = "grant-missing".into();
        assert!(
            policies
                .install_granted(&wrong, &uuid::Uuid::new_v4().to_string(), Some(&grant))
                .await
                .is_err()
        );
    }
}
