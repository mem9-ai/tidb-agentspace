//! Region-local Guest browser credentials, mounted only when the hosted profile enables Guest.
//! The host must enforce trusted origins, rate limits, request/effect authorization and a
//! secure Global-initiated handoff before exposing it. No Region-to-Global call is made.

use axum::http::{HeaderMap, HeaderValue, header::COOKIE};
use std::sync::{Arc, atomic::AtomicBool};
use workspace_contracts::{Metadata, Result, ServiceError};
use workspace_domain::Credential;
use workspace_identity::sessions::Sessions;

const COOKIE_NAME: &str = "aw_guest";

pub struct RegionalGuest {
    sessions: Sessions,
    cookie_path: String,
}

/// Contains a secret Set-Cookie header; never log or persist this value in plaintext.
pub struct EstablishedGuest {
    pub workspace_id: String,
    pub set_cookie: HeaderValue,
}

#[derive(Clone)]
pub struct AuthorizedGuest {
    pub workspace_id: String,
    pub credential: Credential,
    pub actor_id: String,
}

fn unauthorized() -> ServiceError {
    ServiceError::new(401, "SESSION_UNAUTHORIZED")
}

fn valid_workspace(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}

fn parse(value: &str) -> Result<(&str, &str)> {
    let mut pieces = value.split('.');
    let (Some("g1"), Some(workspace), Some(secret), None) =
        (pieces.next(), pieces.next(), pieces.next(), pieces.next())
    else {
        return Err(unauthorized());
    };
    if !valid_workspace(workspace)
        || secret.len() != 64
        || !secret
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(unauthorized());
    }
    Ok((workspace, secret))
}

fn cookie(headers: &HeaderMap) -> Result<&str> {
    let mut result = None;
    for value in headers.get_all(COOKIE) {
        let value = value.to_str().map_err(|_| unauthorized())?;
        for part in value.split(';').map(str::trim) {
            if let Some((name, value)) = part.split_once('=')
                && name == COOKIE_NAME
                && result.replace(value).is_some()
            {
                return Err(unauthorized());
            }
        }
    }
    result.ok_or_else(unauthorized)
}

impl RegionalGuest {
    pub(crate) async fn local_guest_expiry(&self, workspace: &str) -> Result<Option<i64>> {
        self.sessions.local_guest_expiry(workspace).await
    }
    pub fn has_cookie(headers: &HeaderMap) -> bool {
        headers
            .get_all(COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .any(|value| {
                value.split(';').map(str::trim).any(|part| {
                    part.split_once('=')
                        .is_some_and(|(name, _)| name == COOKIE_NAME)
                })
            })
    }
    pub async fn open(
        metadata: Arc<dyn Metadata>,
        authority: &str,
        public_path: &str,
    ) -> Result<Self> {
        if !(public_path.is_empty()
            || public_path.starts_with('/')
                && public_path.split('/').skip(1).all(|s| {
                    !s.is_empty()
                        && s.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
                }))
        {
            return Err(ServiceError::new(400, "INVALID_PUBLIC_PATH"));
        }
        Ok(Self {
            sessions: Sessions::open(metadata, authority).await?,
            cookie_path: format!("{public_path}/"),
        })
    }

    /// This runs within the Region trust boundary after explicit Guest signup. The caller
    /// must deliver the resulting cookie from the Region origin over HTTPS, without exposing
    /// it in JSON or a URL. The original Guest secret is checked against local policy only.
    pub async fn establish(
        &self,
        workspace: &str,
        guest_id: &str,
        secret: &str,
    ) -> Result<EstablishedGuest> {
        if !valid_workspace(workspace) {
            return Err(unauthorized());
        }
        let credentials = self
            .sessions
            .issue_guest_browser(workspace, guest_id, secret)
            .await?;
        let access = self
            .sessions
            .authenticate_guest_credential(workspace, &credentials.token)
            .await?;
        let _remaining = access
            .expires_at
            .checked_sub(chrono::Utc::now().timestamp())
            .filter(|v| *v > 0 && *v <= 86_400)
            .ok_or_else(unauthorized)?;
        let expires = chrono::DateTime::from_timestamp(access.expires_at, 0)
            .ok_or_else(unauthorized)?
            .format("%a, %d %b %Y %H:%M:%S GMT");
        let mut set_cookie = HeaderValue::from_str(&format!(
            "{COOKIE_NAME}=g1.{workspace}.{}; HttpOnly; Secure; SameSite=Strict; Path={}; Expires={expires}",
            credentials.token, self.cookie_path,
        )).map_err(|_| unauthorized())?;
        set_cookie.set_sensitive(true);
        Ok(EstablishedGuest {
            workspace_id: workspace.into(),
            set_cookie,
        })
    }

    pub(crate) async fn csv_credential(
        &self,
        workspace: &str,
        key: &workspace_identity::CsvGuestKey,
    ) -> Result<Credential> {
        let policy = self.sessions.csv_guest_policy(workspace, key).await?;
        let workspace_identity::regional::OwnerIdentity::Guest { expires_at, .. } = policy.identity
        else {
            return Err(unauthorized());
        };
        Ok(Credential::SessionOwner {
            id: policy.user_id,
            actor: "CSV agent".into(),
            workspace_id: workspace.into(),
            policy_generation: Some(policy.generation),
            expires_at,
            revoked: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Rechecks the durable regional credential and installed policy on each request.
    /// The caller must resolve only this Workspace and use `Workspace::new_managed`.
    pub async fn authenticate(&self, headers: &HeaderMap) -> Result<AuthorizedGuest> {
        let (workspace, secret) = parse(cookie(headers)?)?;
        let access = self
            .sessions
            .authenticate_guest_credential(workspace, secret)
            .await?;
        Ok(AuthorizedGuest {
            workspace_id: workspace.into(),
            actor_id: format!("guest-session:{}", access.session_id),
            credential: Credential::SessionOwner {
                id: access.user_id,
                actor: "Guest".into(),
                workspace_id: workspace.into(),
                policy_generation: Some(access.generation),
                expires_at: access.expires_at,
                revoked: Arc::new(AtomicBool::new(false)),
            },
        })
    }

    pub fn clear_cookie(&self) -> Result<HeaderValue> {
        HeaderValue::from_str(&format!(
            "{COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path={}; Max-Age=0",
            self.cookie_path
        ))
        .map_err(|_| unauthorized())
    }

    /// End the authenticated Guest's Workspace access only after cleanup intent is durable.
    pub async fn request_logout_cleanup(
        &self,
        headers: &HeaderMap,
        queue: &workspace_identity::cleanup::Queue,
    ) -> Result<(HeaderValue, String)> {
        let (workspace, secret) = parse(cookie(headers)?)?;
        self.sessions
            .request_guest_logout(workspace, secret, queue)
            .await?;
        Ok((self.clear_cookie()?, workspace.to_owned()))
    }

    /// Revokes this credential locally; the host must also cancel/fence in-flight work.
    pub async fn revoke(&self, headers: &HeaderMap) -> Result<HeaderValue> {
        let (workspace, secret) = parse(cookie(headers)?)?;
        self.sessions
            .authenticate_guest_credential(workspace, secret)
            .await?;
        self.sessions.revoke(workspace, secret).await?;
        self.clear_cookie()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_parsing_rejects_ambiguous_or_noncanonical_credentials() {
        let workspace = uuid::Uuid::new_v4().to_string();
        let token = format!("g1.{workspace}.{}", "ab".repeat(32));
        assert_eq!(parse(&token).unwrap().0, workspace);
        assert!(parse(&format!("g1.{workspace}.{}", "AB".repeat(32))).is_err());
        assert!(parse(&format!("g1.{workspace}.{};path=/", "ab".repeat(32))).is_err());
        assert!(parse(&format!("g1.{workspace}.{}.extra", "ab".repeat(32))).is_err());
        let mut headers = HeaderMap::new();
        headers.append(
            COOKIE,
            HeaderValue::from_str(&format!("other=1; {COOKIE_NAME}={token}")).unwrap(),
        );
        assert_eq!(cookie(&headers).unwrap(), token);
        headers.append(
            COOKIE,
            HeaderValue::from_str(&format!("{COOKIE_NAME}={token}")).unwrap(),
        );
        assert!(cookie(&headers).is_err());
    }
}
