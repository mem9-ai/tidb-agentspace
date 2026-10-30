//! Guest entry logic for a co-located Global/Region origin. Not mounted by the existing host.
//! Separate origins require a separately authenticated Global-to-Region handoff.

use crate::{global_login::GlobalGuest, regional_guest::RegionalGuest};
use axum::http::{HeaderMap, HeaderValue, header::ORIGIN};
use std::{
    collections::BTreeMap,
    net::IpAddr,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use workspace_contracts::{Result, ServiceError};

pub struct GuestEntryResult {
    pub workspace_id: String,
    /// A secret header, returned only for a newly enrolled Guest. Never log this value.
    pub set_cookie: Option<HeaderValue>,
}

pub struct GuestEntry {
    signup: Option<Arc<GlobalGuest>>,
    region: Arc<RegionalGuest>,
    trusted_origins: Vec<String>,
    attempts: Mutex<BTreeMap<IpAddr, (Instant, u32)>>,
}

impl GuestEntry {
    /// Origins must be verified deployment configuration. The HTTP host must additionally
    /// enforce Host, CORS, body-size and secure-transport policy before calling this service.
    pub fn new(
        signup: Option<Arc<GlobalGuest>>,
        region: Arc<RegionalGuest>,
        trusted_origins: Vec<String>,
    ) -> Result<Self> {
        if trusted_origins.is_empty()
            || trusted_origins.iter().any(|origin| {
                reqwest::Url::parse(origin).ok().is_none_or(|url| {
                    url.scheme() != "https"
                        || url.origin().ascii_serialization() != *origin
                        || !url.username().is_empty()
                        || url.password().is_some()
                })
            })
        {
            return Err(ServiceError::new(400, "INVALID_PUBLIC_ORIGIN"));
        }
        Ok(Self {
            signup,
            region,
            trusted_origins,
            attempts: Mutex::new(BTreeMap::new()),
        })
    }

    /// `peer` must be the actual socket peer, never a client-controlled forwarded header.
    /// A valid regional cookie resumes the same Guest without Global or a new expiry.
    pub async fn enter(&self, headers: &HeaderMap, peer: IpAddr) -> Result<GuestEntryResult> {
        let origin = headers
            .get(ORIGIN)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| ServiceError::new(403, "ORIGIN_DENIED"))?;
        if !self.trusted_origins.iter().any(|value| value == origin) {
            return Err(ServiceError::new(403, "ORIGIN_DENIED"));
        }
        match self.region.authenticate(headers).await {
            Ok(guest) => {
                return Ok(GuestEntryResult {
                    workspace_id: guest.workspace_id,
                    set_cookie: None,
                });
            }
            Err(error) if error.code == "SESSION_UNAUTHORIZED" || error.code == "POLICY_DENIED" => {
            }
            Err(error) => return Err(error),
        }
        let signup = self
            .signup
            .as_ref()
            .ok_or_else(|| ServiceError::new(503, "GUEST_SIGNUP_UNAVAILABLE"))?;
        let current = Instant::now();
        {
            let mut attempts = self.attempts.lock().await;
            attempts
                .retain(|_, (start, _)| current.duration_since(*start) < Duration::from_secs(60));
            if attempts.len() >= 4096 && !attempts.contains_key(&peer) {
                return Err(ServiceError::new(429, "GUEST_RATE_LIMITED"));
            }
            let attempt = attempts.entry(peer).or_insert((current, 0));
            if attempt.1 >= 5 {
                return Err(ServiceError::new(429, "GUEST_RATE_LIMITED"));
            }
            attempt.1 += 1;
        }
        let guest = signup.begin().await?;
        let registration = signup.finish(&guest).await?;
        let cookie = self
            .region
            .establish(&registration.workspace_id, &guest.guest_id, &guest.secret)
            .await?;
        Ok(GuestEntryResult {
            workspace_id: registration.workspace_id,
            set_cookie: Some(cookie.set_cookie),
        })
    }
}
