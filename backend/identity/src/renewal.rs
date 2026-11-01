//! Explicit same-secret expiry-renewal evidence. A new expiry alone never establishes it.
use crate::regional_key_policy::KeyPolicy;
use serde::{Deserialize, Serialize};
use workspace_contracts::{Result, ServiceError};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SameKeyRenewal {
    pub from_version: u64,
    pub from_expires_at: i64,
    /// Global observed its completed durable renewal while the prior Key remained valid.
    pub global_observed_at: i64,
}
impl SameKeyRenewal {
    pub fn validate(&self, prior: &KeyPolicy, next: &KeyPolicy) -> Result<()> {
        if prior.revoked
            || next.revoked
            || prior.key_version != self.from_version
            || prior.expires_at != self.from_expires_at
            || prior.key_version.checked_add(1) != Some(next.key_version)
            || prior.policy_generation.checked_add(1) != Some(next.policy_generation)
            || next.expires_at <= prior.expires_at
            || self.global_observed_at <= 0
            || self.global_observed_at >= prior.expires_at
            || prior.workspace_id != next.workspace_id
            || prior.region_id != next.region_id
            || prior.key_id != next.key_id
            || prior.principal_id != next.principal_id
            || prior.grant_ref != next.grant_ref
        {
            return Err(ServiceError::new(409, "INVALID_RENEWAL_TRANSITION"));
        }
        Ok(())
    }
}
