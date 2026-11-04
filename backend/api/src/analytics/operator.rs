//! Platform authorization is separate from personal Workspace ownership.
use crate::sso::VerifiedLogin;
use axum::http::{HeaderMap, HeaderValue};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use workspace_contracts::{Result, ServiceError};
use workspace_meta_client::private_file;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub pseudonym_key_file: PathBuf,
    pub operators_file: PathBuf,
    pub return_url: String,
    #[serde(default)]
    pub campaigns: Vec<String>,
    #[serde(default)]
    pub browser_enabled: bool,
}
#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Identity {
    issuer: String,
    subject: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Policy {
    subjects: Vec<Identity>,
    verified_email_domains: Vec<String>,
}
struct Session {
    identity: Identity,
    email: Option<String>,
    expires: Instant,
}
pub struct Operators {
    config: Config,
    sessions: Mutex<BTreeMap<String, Session>>,
    cookie_path: String,
    secure: bool,
}
fn denied(status: u16, code: &str) -> ServiceError {
    ServiceError::new(status, code)
}
pub fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut found = headers
        .get("cookie")?
        .to_str()
        .ok()?
        .split(';')
        .map(str::trim)
        .filter_map(|part| part.strip_prefix(name)?.strip_prefix('='));
    let value = found.next()?;
    if found.next().is_some() {
        None
    } else {
        Some(value)
    }
}
impl Config {
    pub fn validate(&self, origins: &[String], local: bool) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.pseudonym_key_file.is_absolute()
                && self.operators_file.is_absolute()
                && self.pseudonym_key_file != self.operators_file,
            "Private analytics files required"
        );
        let url = crate::sso::endpoint(&self.return_url, local)?;
        anyhow::ensure!(
            origins.contains(&url.origin().ascii_serialization())
                && url.query().is_none()
                && url.fragment().is_none(),
            "Trusted operator return URL required"
        );
        anyhow::ensure!(
            self.campaigns.len() <= 50
                && self.campaigns.iter().all(|s| !s.is_empty()
                    && s.len() <= 40
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))),
            "Invalid analytics campaigns"
        );
        Ok(())
    }
}
impl Operators {
    pub fn new(config: Config, path: &str, secure: bool) -> Result<Self> {
        let result = Self {
            config,
            sessions: Mutex::new(BTreeMap::new()),
            cookie_path: path.into(),
            secure,
        };
        result.members()?;
        Ok(result)
    }
    fn members(&self) -> Result<Policy> {
        let bytes = private_file(&self.config.operators_file)
            .map_err(|_| denied(503, "OPERATOR_POLICY_UNAVAILABLE"))?;
        if bytes.len() > 64 * 1024 {
            return Err(denied(503, "OPERATOR_POLICY_UNAVAILABLE"));
        }
        let members: Policy = serde_json::from_slice(&bytes)
            .map_err(|_| denied(503, "OPERATOR_POLICY_UNAVAILABLE"))?;
        if members.subjects.len() > 100
            || members.verified_email_domains.len() > 10
            || members.verified_email_domains.iter().any(|s| {
                !s.eq_ignore_ascii_case("pingcap.com")
                    || s.contains('@')
                    || !s
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
            })
            || members
                .subjects
                .iter()
                .any(|i| i.issuer.len() > 2048 || i.subject.is_empty() || i.subject.len() > 256)
        {
            return Err(denied(503, "OPERATOR_POLICY_UNAVAILABLE"));
        }
        Ok(members)
    }
    pub(crate) async fn establish(&self, login: &VerifiedLogin) -> Result<HeaderValue> {
        let (issuer, subject) = login.identity();
        self.issue(
            Identity {
                issuer: issuer.into(),
                subject: subject.into(),
            },
            login.verified_email().map(str::to_owned),
        )
        .await
    }
    fn allows(&self, identity: &Identity, email: Option<&str>) -> Result<bool> {
        let policy = self.members()?;
        let domain = email
            .and_then(|s| s.rsplit_once('@'))
            .filter(|(local, domain)| {
                !local.is_empty() && !local.contains('@') && !domain.is_empty()
            })
            .map(|(_, domain)| domain.to_ascii_lowercase());
        Ok(domain.as_deref() == Some("pingcap.com")
            && (policy.subjects.contains(identity)
                || domain.is_some_and(|d| {
                    policy
                        .verified_email_domains
                        .iter()
                        .any(|v| v.eq_ignore_ascii_case(&d))
                })))
    }
    async fn issue(&self, identity: Identity, email: Option<String>) -> Result<HeaderValue> {
        if !self.allows(&identity, email.as_deref())? {
            return Err(denied(403, "OPERATOR_REQUIRED"));
        }
        let secret = workspace_domain::secret(32)
            .map_err(|_| denied(503, "OPERATOR_SESSION_UNAVAILABLE"))?;
        let digest = format!("{:x}", Sha256::digest(secret.as_bytes()));
        let mut sessions = self.sessions.lock().await;
        sessions.retain(|_, s| s.expires > Instant::now());
        if sessions.len() >= 4096 {
            return Err(denied(429, "OPERATOR_CAPACITY"));
        }
        sessions.insert(
            digest,
            Session {
                identity,
                email,
                expires: Instant::now() + Duration::from_secs(3600),
            },
        );
        self.session_cookie(&secret, 3600)
    }
    pub async fn authorize(&self, headers: &HeaderMap) -> Result<()> {
        // Bearer/Workspace credentials can never be used as operator authorization.
        if headers.contains_key("authorization") {
            return Err(denied(403, "OPERATOR_REQUIRED"));
        }
        let secret = cookie(headers, "aw_operator")
            .filter(|s| s.len() <= 128)
            .ok_or_else(|| denied(401, "OPERATOR_SESSION_REQUIRED"))?;
        let digest = format!("{:x}", Sha256::digest(secret.as_bytes()));
        let mut sessions = self.sessions.lock().await;
        sessions.retain(|_, s| s.expires > Instant::now());
        let session = sessions
            .get(&digest)
            .ok_or_else(|| denied(401, "OPERATOR_SESSION_REQUIRED"))?;
        if !self.allows(&session.identity, session.email.as_deref())? {
            return Err(denied(403, "OPERATOR_REQUIRED"));
        }
        Ok(())
    }
    pub async fn logout(&self, headers: &HeaderMap) -> Result<HeaderValue> {
        if let Some(secret) = cookie(headers, "aw_operator") {
            self.sessions
                .lock()
                .await
                .remove(&format!("{:x}", Sha256::digest(secret.as_bytes())));
        }
        self.session_cookie("", 0)
    }
    pub fn return_url(&self) -> &str {
        &self.config.return_url
    }
    fn session_cookie(&self, secret: &str, age: u32) -> Result<HeaderValue> {
        let secure = if self.secure { " Secure;" } else { "" };
        let mut value = HeaderValue::from_str(&format!(
            "aw_operator={secret}; HttpOnly; SameSite=Strict;{secure} Path={}/; Max-Age={age}",
            self.cookie_path
        ))
        .map_err(|_| denied(503, "OPERATOR_SESSION_UNAVAILABLE"))?;
        value.set_sensitive(true);
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    fn policy_file() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("analytics-operators-{}.json", uuid::Uuid::new_v4()));
        std::fs::write(
            &path,
            r#"{"subjects":[],"verifiedEmailDomains":["pingcap.com"]}"#,
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        path
    }
    #[tokio::test]
    async fn pingcap_verified_email_sessions_recheck_policy_and_logout() {
        let file = policy_file();
        let operators = Operators::new(
            Config {
                pseudonym_key_file: file.with_extension("key"),
                operators_file: file.clone(),
                return_url: "https://example.test/admin".into(),
                campaigns: Vec::new(),
                browser_enabled: true,
            },
            "/studio",
            true,
        )
        .unwrap();
        let identity = Identity {
            issuer: "https://auth.tidbcloud.com".into(),
            subject: "stable-subject".into(),
        };
        for email in [
            None,
            Some("person@other.com"),
            Some("person@pingcap.com.evil.test"),
            Some("person@sub.pingcap.com"),
            Some("person@@pingcap.com"),
        ] {
            assert_eq!(
                operators
                    .issue(identity.clone(), email.map(str::to_owned))
                    .await
                    .unwrap_err()
                    .status,
                403
            );
        }
        let value = operators
            .issue(identity, Some("person@pingcap.com".into()))
            .await
            .unwrap();
        let cookie = value.to_str().unwrap().split(';').next().unwrap();
        assert!(
            value
                .to_str()
                .unwrap()
                .contains("HttpOnly; SameSite=Strict; Secure; Path=/studio/; Max-Age=3600")
        );
        let mut headers = HeaderMap::new();
        headers.insert("cookie", cookie.parse().unwrap());
        assert!(operators.authorize(&headers).await.is_ok());
        std::fs::write(&file, r#"{"subjects":[],"verifiedEmailDomains":[]}"#).unwrap();
        assert_eq!(operators.authorize(&headers).await.unwrap_err().status, 403);
        std::fs::write(
            &file,
            r#"{"subjects":[],"verifiedEmailDomains":["pingcap.com"]}"#,
        )
        .unwrap();
        headers.insert("authorization", "Bearer workspace-key".parse().unwrap());
        assert_eq!(operators.authorize(&headers).await.unwrap_err().status, 403);
        headers.remove("authorization");
        operators.logout(&headers).await.unwrap();
        assert_eq!(operators.authorize(&headers).await.unwrap_err().status, 401);
        std::fs::remove_file(file).unwrap();
    }
}
