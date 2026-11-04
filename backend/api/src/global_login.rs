//! Global-initiated personal Workspace onboarding after a verified TiDB Account login.
//!
//! This application service does not expose HTTP routes or issue Region sessions. A host must
//! protect the flow handle in a browser-bound cookie, enforce trusted origins and secure
//! transport, and route established Region access without consulting Global. Separately
//! deployed Regions require an authenticated control transport, not direct Meta access.

use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Arc};
use uuid::Uuid;
use workspace_contracts::Result;
use workspace_identity::{
    Directory, GuestRegistration, RegionAssignment, Registration, VerifiedIdentity,
    global_owner_sessions::{IssuedOwnerSession, OwnerSessions},
    onboarding::{Onboarding, RegionControl},
};

pub use crate::sso::Config as SsoConfig;
use crate::sso::Runtime;

pub struct GlobalLogin {
    sso: Runtime,
    onboarding: Onboarding,
    directory: Directory,
    region: String,
}

/// Guest registration is deliberately two-stage: the caller first retains the private
/// credential in a secure browser-bound channel, then initializes the Region. If a Region
/// reply is lost, the same Guest credential and operation can be retried without adopting
/// another Workspace. HTTP, rate limits and abuse controls are the host's responsibility.
pub struct GlobalGuest {
    directory: Directory,
    onboarding: Onboarding,
    region: String,
}

impl GlobalGuest {
    pub fn new(
        directory: Directory,
        region_control: Arc<dyn RegionControl>,
        region: String,
    ) -> Self {
        Self {
            onboarding: Onboarding::new(directory.clone(), region_control),
            directory,
            region,
        }
    }

    /// The returned secret is a credential: never log it or persist it in plaintext.
    pub async fn begin(&self) -> Result<GuestRegistration> {
        self.directory.create_guest(&self.region).await
    }

    /// A successful result means regional policy and expiry intent were durably installed.
    /// A usable regional session and provider cleanup executor require separate integration.
    pub async fn finish(&self, guest: &GuestRegistration) -> Result<Registration> {
        self.onboarding.guest(guest).await
    }

    /// The identity is supplied exclusively by the verified OIDC callback.
    pub(crate) async fn personal_with_creation(
        &self,
        issuer: &str,
        subject: &str,
    ) -> Result<(Registration, bool)> {
        let existing = self
            .directory
            .status(VerifiedIdentity { issuer, subject })
            .await?;
        let fresh =
            existing.is_none_or(|(_, state)| state != workspace_identity::Provisioning::Ready);
        let registration = self.personal(issuer, subject).await?;
        Ok((registration, fresh))
    }
    pub(crate) async fn personal(&self, issuer: &str, subject: &str) -> Result<Registration> {
        self.onboarding
            .personal(VerifiedIdentity { issuer, subject }, &self.region)
            .await
    }
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
            onboarding: Onboarding::new(directory.clone(), region_control),
            directory,
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

    /// Resolve an existing ready Workspace only after consuming a verified OIDC flow.
    /// Unlike onboarding, discovery never creates an identity or invokes Region control.
    pub async fn finish_discovery(
        &self,
        flow: &str,
        query: &BTreeMap<String, String>,
        workspace_id: &str,
    ) -> Result<RegionAssignment> {
        let login = self.sso.callback(flow, query).await?;
        let (issuer, subject) = login.identity();
        self.directory
            .region_assignment(VerifiedIdentity { issuer, subject }, workspace_id)
            .await
    }

    /// Consume a verified, single-use OIDC callback before issuing a Global owner session.
    /// The caller must deliver it via a protected host-only cookie and enforce CSRF/Origin.
    /// This does not expose HTTP or grant a regional session.
    pub async fn finish_owner_session(
        &self,
        sessions: &OwnerSessions,
        flow: &str,
        query: &BTreeMap<String, String>,
        workspace_id: &str,
    ) -> Result<IssuedOwnerSession> {
        if !sessions.bound_to(&self.directory) {
            return Err(workspace_contracts::ServiceError::new(
                503,
                "GLOBAL_IDENTITY_STORE_MISMATCH",
            ));
        }
        let login = self.sso.callback(flow, query).await?;
        let (issuer, subject) = login.identity();
        let mut hash = Sha256::new();
        hash.update(b"workspace-global-owner-session\0oidc-flow\0v1\0");
        hash.update(flow.as_bytes());
        let digest = hash.finalize();
        let mut bytes = [0; 16];
        bytes.copy_from_slice(&digest[..16]);
        sessions
            .issue(
                VerifiedIdentity { issuer, subject },
                workspace_id,
                &Uuid::from_bytes(bytes).to_string(),
            )
            .await
    }
}
