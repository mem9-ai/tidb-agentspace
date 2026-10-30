//! Global-initiated personal Workspace onboarding after a verified TiDB Account login.
//!
//! This application service does not expose HTTP routes or issue Region sessions. A host must
//! protect the flow handle in a browser-bound cookie, enforce trusted origins and secure
//! transport, and route established Region access without consulting Global. Separately
//! deployed Regions require an authenticated control transport, not direct Meta access.

use std::{collections::BTreeMap, sync::Arc};
use workspace_contracts::Result;
use workspace_identity::{
    Directory, Registration, VerifiedIdentity,
    onboarding::{Onboarding, RegionControl},
};

pub use crate::sso::Config as SsoConfig;
use crate::sso::Runtime;

pub struct GlobalLogin {
    sso: Runtime,
    onboarding: Onboarding,
    region: String,
}

impl GlobalLogin {
    /// `local` may be true only for an actual loopback test/development listener.
    pub fn new(
        config: SsoConfig,
        public_path: &str,
        local: bool,
        directory: Directory,
        region_control: Arc<dyn RegionControl>,
        region: String,
    ) -> anyhow::Result<Self> {
        config.validate(public_path, local)?;
        anyhow::ensure!(
            config.owner_subjects.is_empty()
                && config.owner_email_rules.is_empty()
                && config.allowed_orgs.is_empty(),
            "Personal onboarding needs its own SSO configuration without shared-owner grants or organization filters"
        );
        anyhow::ensure!(
            region.starts_with("region:"),
            "A regional authority is required"
        );
        Ok(Self {
            sso: Runtime::new(config)?,
            onboarding: Onboarding::new(directory, region_control),
            region,
        })
    }

    /// Return an authorization URL and opaque flow handle. The handle is a secret and must
    /// be kept in an HttpOnly browser-bound cookie, never in URLs, logs or durable metadata.
    pub async fn begin(&self, source: &str) -> Result<(String, String)> {
        self.sso.login(source).await
    }

    /// Verify the entire OIDC flow first, then reserve by the verified issuer and subject.
    /// A successful response proves regional initialization, not a Region API session.
    pub async fn finish(
        &self,
        flow: &str,
        query: &BTreeMap<String, String>,
    ) -> Result<Registration> {
        let login = self.sso.callback(flow, query).await?;
        let (issuer, subject) = login.identity();
        self.onboarding
            .personal(VerifiedIdentity { issuer, subject }, &self.region)
            .await
    }
}
