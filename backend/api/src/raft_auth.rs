//! Login with Raft adapter. Raft is an external provider; only its public OIDC and
//! userinfo contracts are used. This module never assigns Workspace or resource rights.
use crate::sso;
use anyhow::{Result, ensure};
use axum::http::HeaderValue;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};
use uuid::Uuid;
use workspace_contracts::{MetaRequest, Metadata, Scope, ServiceError};
use workspace_domain::secret;
use workspace_identity::federation::{
    ExternalIdentity, FederatedPrincipal, Federation, PrincipalKind,
};
use workspace_meta_client::private_file;

// Operators must keep each authority clock within five seconds of UTC. Reserving
// both clock errors keeps disconnected admission within sixty real seconds.
pub(crate) const CLOCK_UNCERTAINTY_SECONDS: i64 = 5;
pub(crate) const ADMISSION_SECONDS: i64 = 60 - 2 * CLOCK_UNCERTAINTY_SECONDS;

type AuthResult<T> = workspace_contracts::Result<T>;
fn reject(status: u16, code: &str) -> ServiceError {
    ServiceError::new(status, code)
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Trust {
    pub issuer: String,
    pub client_id: String,
    pub allowed_server_ids: Vec<String>,
    #[serde(default)]
    pub allow_loopback_http: bool,
}
impl Trust {
    pub fn validate(&self, local: bool) -> Result<()> {
        ensure!(
            local || !self.allow_loopback_http,
            "Raft fixture transport is loopback-only"
        );
        let issuer = sso::endpoint(&self.issuer, self.allow_loopback_http)?;
        ensure!(issuer.query().is_none(), "Raft issuer query is not allowed");
        ensure!(
            !self.client_id.is_empty()
                && self.client_id.len() <= 64
                && self
                    .client_id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-'),
            "Raft client required"
        );
        ensure!(
            !self.allowed_server_ids.is_empty()
                && self.allowed_server_ids.len() <= 64
                && self
                    .allowed_server_ids
                    .iter()
                    .all(|s| Uuid::parse_str(s).is_ok_and(|id| id.to_string() == *s)),
            "Explicit Raft Servers required"
        );
        Ok(())
    }
}
pub(crate) struct Verifier {
    config: Trust,
    client: Client,
}
impl Verifier {
    pub fn new(config: Trust) -> Result<Self> {
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(3))
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .build()?;
        Ok(Self { config, client })
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub issuer: String,
    pub client_id: String,
    pub client_secret_file: PathBuf,
    pub redirect_uri: String,
    pub post_login_url: String,
    pub allowed_server_ids: Vec<String>,
    #[serde(default)]
    pub allow_loopback_http: bool,
}
impl Config {
    pub fn trust(&self) -> Trust {
        Trust {
            issuer: self.issuer.clone(),
            client_id: self.client_id.clone(),
            allowed_server_ids: self.allowed_server_ids.clone(),
            allow_loopback_http: self.allow_loopback_http,
        }
    }
    pub fn validate(&self, origin: &str, local: bool) -> Result<()> {
        ensure!(
            local || !self.allow_loopback_http,
            "Raft fixture transport is loopback-only"
        );
        let issuer = sso::endpoint(&self.issuer, self.allow_loopback_http)?;
        ensure!(issuer.query().is_none(), "Raft issuer query is not allowed");
        let callback = sso::endpoint(&self.redirect_uri, local)?;
        let landing = sso::endpoint(&self.post_login_url, local)?;
        ensure!(
            callback.origin().ascii_serialization() == origin
                && callback.path().ends_with("/auth/raft/callback")
                && callback.query().is_none()
                && callback.fragment().is_none()
                && landing.origin() == callback.origin(),
            "Exact same-origin Raft callback required"
        );
        ensure!(
            !self.client_id.is_empty()
                && self.client_id.len() <= 64
                && self
                    .client_id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-'),
            "Invalid Raft client ID"
        );
        ensure!(
            self.client_secret_file.is_absolute(),
            "Private Raft client-secret file required"
        );
        ensure!(
            !self.allowed_server_ids.is_empty()
                && self.allowed_server_ids.len() <= 64
                && self
                    .allowed_server_ids
                    .iter()
                    .all(|s| Uuid::parse_str(s).is_ok_and(|id| id.to_string() == *s)),
            "Explicit Raft Server allowlist required"
        );
        Ok(())
    }
    fn oidc(&self) -> sso::Config {
        sso::Config {
            issuer: self.issuer.clone(),
            client_id: self.client_id.clone(),
            redirect_uri: self.redirect_uri.clone(),
            authorize_url: None,
            token_url: None,
            jwks_url: None,
            scopes: "openid profile".into(),
            owner_subjects: vec![],
            owner_email_rules: vec![],
            allowed_orgs: vec![],
            org_claim: "org_id".into(),
            post_login_url: Some(self.post_login_url.clone()),
            allow_loopback_http: self.allow_loopback_http,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionRecord {
    principal: FederatedPrincipal,
    access_token: String,
    expires_at: i64,
    revoked: bool,
    #[serde(default)]
    authenticated_at: i64,
}
/// Server-internal only. The upstream credential must never enter a public response or log.
pub(crate) struct Authenticated {
    pub principal: FederatedPrincipal,
    pub access_token: String,
    pub expires_at: i64,
    session_scope: Scope,
    authenticated_at: i64,
}
impl Authenticated {
    pub fn recent_human(&self, now: i64) -> AuthResult<()> {
        if self.principal.identity.kind != PrincipalKind::Human {
            return Err(reject(403, "HUMAN_APPROVAL_REQUIRED"));
        }
        if self.authenticated_at > now || now.saturating_sub(self.authenticated_at) > 600 {
            return Err(reject(401, "HUMAN_REAUTHENTICATION_REQUIRED"));
        }
        Ok(())
    }
}
pub(crate) struct LoginResult {
    pub cookie: HeaderValue,
    pub kind: PrincipalKind,
}
pub(crate) struct Runtime {
    pub config: Config,
    oidc: sso::Runtime,
    verifier: Verifier,
    pub(super) client: Client,
    client_secret: String,
    metadata: Arc<dyn Metadata>,
    directory: Federation,
}
fn session_scope(value: &str) -> AuthResult<Scope> {
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(reject(401, "UNAUTHENTICATED"));
    }
    let id = hex_digest(value.as_bytes());
    Ok(Scope::system("global", &id, "federated-session", "primary"))
}
fn hex_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

impl Runtime {
    pub async fn open(config: Config, metadata: Arc<dyn Metadata>) -> Result<Self> {
        let bytes = private_file(&config.client_secret_file)?;
        let client_secret = String::from_utf8(bytes)?.trim().to_owned();
        ensure!(
            !client_secret.is_empty() && client_secret.len() <= 4096,
            "Invalid Raft client secret"
        );
        let oidc = sso::Runtime::new(config.oidc())?;
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(3))
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let directory = Federation::open(metadata.clone()).await?;
        let verifier = Verifier::new(config.trust())?;
        Ok(Self {
            config,
            oidc,
            verifier,
            client,
            client_secret,
            metadata,
            directory,
        })
    }
    pub fn directory(&self) -> &Federation {
        &self.directory
    }
    pub async fn login(&self, source: &str) -> AuthResult<(String, HeaderValue)> {
        let (url, flow) = self.oidc.login(source).await?;
        Ok((url, self.cookie("aw_raft_flow", &flow, 600)?))
    }
    pub fn cookie(&self, name: &str, value: &str, age: i64) -> AuthResult<HeaderValue> {
        let secure = if self.config.redirect_uri.starts_with("https:") {
            "; Secure"
        } else {
            ""
        };
        let mut cookie = HeaderValue::from_str(&format!(
            "{name}={value}; HttpOnly; SameSite=Lax; Path=/; Max-Age={age}{secure}"
        ))
        .map_err(|_| reject(503, "SESSION_UNAVAILABLE"))?;
        cookie.set_sensitive(true);
        Ok(cookie)
    }
    pub async fn callback(
        &self,
        flow_cookie: Option<&str>,
        query: &BTreeMap<String, String>,
        now: i64,
    ) -> AuthResult<LoginResult> {
        // A present but bad Human transaction must never downgrade to Agent login.
        let flow = if let Some(cookie) = flow_cookie {
            Some(self.oidc.take_flow(cookie, query).await?)
        } else {
            if query.contains_key("state") || query.contains_key("error") {
                return Err(reject(400, "RAFT_STATE_INVALID"));
            }
            None
        };
        let code = query
            .get("code")
            .filter(|v| !v.is_empty() && v.len() <= 8192)
            .ok_or_else(|| reject(400, "RAFT_CODE_REQUIRED"))?;
        let discovery = self.verifier.discovery().await?;
        let endpoint = self.verifier.endpoint(&discovery, "token_endpoint")?;
        let mut form = vec![
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", &self.config.redirect_uri),
        ];
        if let Some((_, pending)) = &flow {
            form.push(("code_verifier", &pending.verifier));
        }
        let response = self
            .client
            .post(endpoint)
            .basic_auth(&self.config.client_id, Some(&self.client_secret))
            .form(&form)
            .send()
            .await
            .map_err(|_| reject(503, "RAFT_EXCHANGE_UNKNOWN"))?;
        if !response.status().is_success() {
            return Err(match response.status().as_u16() {
                400 | 409 => reject(409, "RAFT_LOGIN_REQUIRED"),
                401 => reject(503, "RAFT_APP_UNAVAILABLE"),
                403 => reject(403, "RAFT_LOGIN_DENIED"),
                _ => reject(503, "RAFT_UNAVAILABLE"),
            });
        }
        let tokens = self.verifier.json(response).await?;
        let access_token = tokens["access_token"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 16384)
            .ok_or_else(|| reject(401, "RAFT_IDENTITY_INVALID"))?;
        if !tokens["token_type"]
            .as_str()
            .is_some_and(|s| s.eq_ignore_ascii_case("bearer"))
        {
            return Err(reject(401, "RAFT_IDENTITY_INVALID"));
        }
        let lifetime = tokens["expires_in"]
            .as_i64()
            .filter(|n| *n > 0)
            .ok_or_else(|| reject(401, "RAFT_IDENTITY_INVALID"))?
            .min(3600);
        let identity = self.verifier.current_identity(access_token).await?;
        if let Some((_, pending)) = &flow {
            let token = tokens["id_token"]
                .as_str()
                .ok_or_else(|| reject(401, "RAFT_IDENTITY_INVALID"))?;
            let verified = self
                .oidc
                .verify_id_token(token, &pending.nonce)
                .await
                .map_err(|_| reject(401, "RAFT_IDENTITY_INVALID"))?;
            if identity.kind != PrincipalKind::Human
                || verified.identity().1 != identity.subject
                || verified.claims()["server_id"] != identity.server_id
            {
                return Err(reject(401, "RAFT_IDENTITY_INVALID"));
            }
        } else if identity.kind != PrincipalKind::Agent {
            return Err(reject(400, "RAFT_STATE_REQUIRED"));
        }
        let principal = self.directory.resolve(identity.clone()).await?;
        let session = secret(32)?;
        self.metadata.execute(MetaRequest::Commit {
            scope: session_scope(&session)?, guard: None, mutation_id: Uuid::new_v4().to_string(),
            changes: vec![json!({"key":"session","expectedVersion":null,"value":SessionRecord {
                principal, access_token: access_token.into(), expires_at: now + lifetime, revoked: false,authenticated_at:now,
            }})],
        }).await?;
        Ok(LoginResult {
            cookie: self.cookie("aw_raft_session", &session, lifetime)?,
            kind: identity.kind,
        })
    }
    pub async fn authenticate(&self, session: &str, now: i64) -> AuthResult<Authenticated> {
        let result = self
            .metadata
            .execute(MetaRequest::Get {
                scope: session_scope(session)?,
                guard: None,
                keys: vec!["session".into()],
            })
            .await?;
        let record: SessionRecord =
            serde_json::from_value(result["records"]["session"]["value"].clone())
                .map_err(|_| reject(401, "UNAUTHENTICATED"))?;
        if record.revoked || record.expires_at <= now {
            return Err(reject(401, "UNAUTHENTICATED"));
        }
        let current = self.verifier.current_identity(&record.access_token).await?;
        if current != record.principal.identity {
            return Err(reject(401, "UNAUTHENTICATED"));
        }
        Ok(Authenticated {
            principal: record.principal,
            access_token: record.access_token,
            expires_at: record.expires_at,
            session_scope: session_scope(session)?,
            authenticated_at: record.authenticated_at,
        })
    }
    pub async fn revalidate(&self, actor: &Authenticated, now: i64) -> AuthResult<()> {
        let record = self
            .metadata
            .execute(MetaRequest::Get {
                scope: actor.session_scope.clone(),
                guard: None,
                keys: vec!["session".into()],
            })
            .await?;
        let record: SessionRecord =
            serde_json::from_value(record["records"]["session"]["value"].clone())
                .map_err(|_| reject(401, "UNAUTHENTICATED"))?;
        if record.revoked || record.expires_at <= now || record.principal != actor.principal {
            return Err(reject(401, "UNAUTHENTICATED"));
        }
        if self.verifier.current_identity(&actor.access_token).await? != actor.principal.identity {
            return Err(reject(401, "UNAUTHENTICATED"));
        }
        Ok(())
    }
    pub async fn logout(&self, session: &str) -> AuthResult<HeaderValue> {
        let scope = session_scope(session)?;
        for _ in 0..8 {
            let result = self
                .metadata
                .execute(MetaRequest::Get {
                    scope: scope.clone(),
                    guard: None,
                    keys: vec!["session".into()],
                })
                .await?;
            let stored = &result["records"]["session"];
            if stored.is_null() || stored["value"]["revoked"] == true {
                return self.cookie("aw_raft_session", "", 0);
            }
            let mut value = stored["value"].clone();
            value["revoked"] = json!(true);
            match self
                .metadata
                .execute(MetaRequest::Commit {
                    scope: scope.clone(),
                    guard: None,
                    mutation_id: Uuid::new_v4().to_string(),
                    changes: vec![
                        json!({"key":"session","expectedVersion":stored["version"],"value":value}),
                    ],
                })
                .await
            {
                Ok(_) => return self.cookie("aw_raft_session", "", 0),
                Err(e) if e.code == "META_CONFLICT" => continue,
                Err(e) => return Err(e),
            }
        }
        Err(reject(409, "SESSION_BUSY"))
    }
}

impl Verifier {
    async fn json(&self, response: reqwest::Response) -> AuthResult<Value> {
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| reject(503, "RAFT_UNAVAILABLE"))?
        {
            if bytes.len() + chunk.len() > 64 * 1024 {
                return Err(reject(503, "RAFT_INVALID_RESPONSE"));
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| reject(503, "RAFT_INVALID_RESPONSE"))
    }
    async fn discovery(&self) -> AuthResult<Value> {
        let url = format!(
            "{}/.well-known/openid-configuration",
            self.config.issuer.trim_end_matches('/')
        );
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|_| reject(503, "RAFT_UNAVAILABLE"))?;
        if !response.status().is_success() {
            return Err(reject(503, "RAFT_UNAVAILABLE"));
        }
        let discovery = self.json(response).await?;
        if discovery["issuer"] != self.config.issuer {
            return Err(reject(503, "RAFT_INVALID_RESPONSE"));
        }
        Ok(discovery)
    }
    fn endpoint(&self, discovery: &Value, name: &str) -> AuthResult<String> {
        let value = discovery[name]
            .as_str()
            .ok_or_else(|| reject(503, "RAFT_INVALID_RESPONSE"))?;
        sso::endpoint(value, self.config.allow_loopback_http)
            .map_err(|_| reject(503, "RAFT_INVALID_RESPONSE"))?;
        Ok(value.into())
    }
    fn identity(&self, profile: &Value) -> AuthResult<ExternalIdentity> {
        let field = |name: &str| {
            profile[name]
                .as_str()
                .ok_or_else(|| reject(401, "RAFT_IDENTITY_INVALID"))
        };
        let identity = ExternalIdentity {
            provider: "raft".into(),
            server_id: field("server_id")?.into(),
            subject: field("sub")?.into(),
            kind: match field("type")? {
                "human" => PrincipalKind::Human,
                "agent" => PrincipalKind::Agent,
                _ => return Err(reject(401, "RAFT_IDENTITY_INVALID")),
            },
        };
        identity.validate()?;
        if field("client_id")? != self.config.client_id
            || !self.config.allowed_server_ids.contains(&identity.server_id)
            || !["openid", "profile"].iter().all(|required| {
                profile["scope"]
                    .as_str()
                    .is_some_and(|s| s.split_whitespace().any(|v| v == *required))
            })
        {
            return Err(reject(401, "RAFT_IDENTITY_INVALID"));
        }
        Ok(identity)
    }
    pub async fn current_identity(&self, access_token: &str) -> AuthResult<ExternalIdentity> {
        let discovery = self.discovery().await?;
        let endpoint = self.endpoint(&discovery, "userinfo_endpoint")?;
        let response = self
            .client
            .get(endpoint)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|_| reject(503, "RAFT_UNAVAILABLE"))?;
        if matches!(response.status().as_u16(), 401 | 403) {
            return Err(reject(401, "UNAUTHENTICATED"));
        }
        if !response.status().is_success() {
            return Err(reject(503, "RAFT_UNAVAILABLE"));
        }
        self.identity(&self.json(response).await?)
    }
}

#[cfg(test)]
mod freshness_tests {
    use super::*;
    #[test]
    fn governance_requires_a_recent_human_without_refreshing_login_age() {
        let mut actor = Authenticated {
            principal: FederatedPrincipal {
                id: Uuid::new_v4().to_string(),
                identity: ExternalIdentity {
                    provider: "raft".into(),
                    server_id: Uuid::new_v4().to_string(),
                    subject: "verified".into(),
                    kind: PrincipalKind::Human,
                },
            },
            access_token: "fixture".into(),
            expires_at: 5000,
            session_scope: Scope::system("global", "fixture", "federated-session", "primary"),
            authenticated_at: 1000,
        };
        assert!(actor.recent_human(1600).is_ok());
        assert_eq!(
            actor.recent_human(1601).unwrap_err().code,
            "HUMAN_REAUTHENTICATION_REQUIRED"
        );
        assert!(actor.recent_human(999).is_err());
        actor.principal.identity.kind = PrincipalKind::Agent;
        assert_eq!(
            actor.recent_human(1001).unwrap_err().code,
            "HUMAN_APPROVAL_REQUIRED"
        );
    }
}
