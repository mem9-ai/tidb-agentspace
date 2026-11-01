//! Region-local browser grants for verified TiDB Account identities.
use axum::http::{HeaderMap, HeaderValue, header::COOKIE};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Weak,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::Mutex;
use workspace_contracts::{Metadata, Result, ServiceError};
use workspace_domain::Credential;
use workspace_identity::{regional::Principal, sessions::Sessions};

const NAME: &str = "aw_account";

pub struct RegionalAccount {
    sessions: Sessions,
    cookie_path: String,
    secure: bool,
    active: Mutex<BTreeMap<String, Weak<AtomicBool>>>,
}

#[derive(Clone)]
pub struct AuthorizedAccount {
    pub workspace_id: String,
    pub credential: Credential,
    pub actor_id: String,
}

fn unauthorized() -> ServiceError {
    ServiceError::new(401, "SESSION_UNAUTHORIZED")
}
fn cookie(headers: &HeaderMap) -> Result<&str> {
    let mut found = None;
    for value in headers.get_all(COOKIE) {
        for part in value
            .to_str()
            .map_err(|_| unauthorized())?
            .split(';')
            .map(str::trim)
        {
            if let Some((name, value)) = part.split_once('=')
                && name == NAME
                && found.replace(value).is_some()
            {
                return Err(unauthorized());
            }
        }
    }
    found.ok_or_else(unauthorized)
}
fn parse(value: &str) -> Result<(&str, &str)> {
    let mut parts = value.split('.');
    let (Some("a1"), Some(workspace), Some(secret), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(unauthorized());
    };
    if !uuid::Uuid::parse_str(workspace).is_ok_and(|id| id.to_string() == workspace)
        || secret.len() != 64
        || !secret
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(unauthorized());
    }
    Ok((workspace, secret))
}
impl RegionalAccount {
    // A hint only: Global authenticates its own credential before revoking anything.
    pub(crate) fn workspace_hint(headers: &HeaderMap) -> Result<&str> {
        Ok(parse(cookie(headers)?)?.0)
    }
    async fn flag(&self, workspace: &str, secret: &str) -> (String, Arc<AtomicBool>) {
        let key = format!(
            "{:x}",
            Sha256::digest(format!("{workspace}.{secret}").as_bytes())
        );
        let mut active = self.active.lock().await;
        active.retain(|_, flag| flag.strong_count() > 0);
        let flag = active.get(&key).and_then(Weak::upgrade).unwrap_or_else(|| {
            let flag = Arc::new(AtomicBool::new(false));
            active.insert(key.clone(), Arc::downgrade(&flag));
            flag
        });
        (key, flag)
    }
    pub async fn open(
        metadata: Arc<dyn Metadata>,
        authority: &str,
        path: &str,
        secure: bool,
    ) -> Result<Self> {
        Ok(Self {
            sessions: Sessions::open(metadata, authority).await?,
            cookie_path: format!("{path}/"),
            secure,
            active: Mutex::new(BTreeMap::new()),
        })
    }
    pub fn has_cookie(headers: &HeaderMap) -> bool {
        headers
            .get_all(COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .any(|v| {
                v.split(';')
                    .map(str::trim)
                    .any(|p| p.split_once('=').is_some_and(|(name, _)| name == NAME))
            })
    }
    pub async fn establish(
        &self,
        workspace: &str,
        issuer: &str,
        subject: &str,
    ) -> Result<HeaderValue> {
        let credentials = self
            .sessions
            .issue_owner(workspace, Principal::Oidc { issuer, subject })
            .await?;
        let mut header = HeaderValue::from_str(&format!(
            "{NAME}=a1.{workspace}.{}; HttpOnly; SameSite=Strict;{} Path={}",
            credentials.renewal,
            if self.secure { " Secure;" } else { "" },
            self.cookie_path
        ))
        .map_err(|_| unauthorized())?;
        header.set_sensitive(true);
        Ok(header)
    }
    pub async fn authenticate(&self, headers: &HeaderMap) -> Result<AuthorizedAccount> {
        let (workspace, secret) = parse(cookie(headers)?)?;
        let (_, revoked) = self.flag(workspace, secret).await;
        let access = self
            .sessions
            .authenticate_oidc_grant(workspace, secret)
            .await?;
        if revoked.load(Ordering::Acquire) {
            return Err(unauthorized());
        }
        Ok(AuthorizedAccount {
            workspace_id: workspace.into(),
            actor_id: format!("account-session:{}", access.session_id),
            credential: Credential::SessionOwner {
                id: access.user_id,
                actor: "TiDB Account".into(),
                workspace_id: workspace.into(),
                policy_generation: Some(access.generation),
                expires_at: access.expires_at,
                revoked,
            },
        })
    }
    pub fn clear_cookie(&self) -> Result<HeaderValue> {
        HeaderValue::from_str(&format!(
            "{NAME}=; HttpOnly; SameSite=Strict;{} Path={}; Max-Age=0",
            if self.secure { " Secure;" } else { "" },
            self.cookie_path
        ))
        .map_err(|_| unauthorized())
    }
    pub async fn revoke(&self, headers: &HeaderMap) -> Result<HeaderValue> {
        let (workspace, secret) = parse(cookie(headers)?)?;
        let (key, revoked) = self.flag(workspace, secret).await;
        self.sessions
            .authenticate_oidc_grant(workspace, secret)
            .await?;
        revoked.store(true, Ordering::Release);
        self.sessions.revoke(workspace, secret).await?;
        self.active.lock().await.remove(&key);
        self.clear_cookie()
    }
}
