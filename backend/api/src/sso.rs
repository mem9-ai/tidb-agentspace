use anyhow::{Result, bail, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use reqwest::{Client, Url};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use workspace_contracts::ServiceError;
use workspace_domain::{Credential, secret};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub issuer: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub authorize_url: Option<String>,
    pub token_url: Option<String>,
    pub jwks_url: Option<String>,
    #[serde(default = "default_scopes")]
    pub scopes: String,
    #[serde(default)]
    pub owner_subjects: Vec<String>,
    #[serde(default)]
    pub owner_email_rules: Vec<String>,
    #[serde(default)]
    pub allowed_orgs: Vec<String>,
    #[serde(default = "default_org")]
    pub org_claim: String,
    pub post_login_url: Option<String>,
    // Only a local API may enable this for an isolated fake provider or local development.
    #[serde(default)]
    pub allow_loopback_http: bool,
}
fn default_scopes() -> String {
    "openid profile email".into()
}
fn default_org() -> String {
    "org_id".into()
}
fn env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(|v| v.trim().to_owned())
}
fn csv(name: &str) -> Vec<String> {
    env(name)
        .map(|s| s.split(',').map(|v| v.trim().to_owned()).collect())
        .unwrap_or_default()
}
impl Config {
    pub fn environment() -> Result<Option<Self>> {
        if [
            "TIDB_SSO_ISSUER",
            "TIDB_SSO_CLIENT_ID",
            "TIDB_SSO_REDIRECT_URI",
            "TIDB_SSO_AUTHORIZE_URL",
            "TIDB_SSO_TOKEN_URL",
            "TIDB_SSO_JWKS_URL",
        ]
        .iter()
        .all(|n| env(n).is_none())
        {
            return Ok(None);
        }
        let required =
            |n| env(n).ok_or_else(|| anyhow::anyhow!("Required SSO configuration is missing"));
        Ok(Some(Self {
            issuer: required("TIDB_SSO_ISSUER")?,
            client_id: required("TIDB_SSO_CLIENT_ID")?,
            redirect_uri: required("TIDB_SSO_REDIRECT_URI")?,
            authorize_url: env("TIDB_SSO_AUTHORIZE_URL"),
            token_url: env("TIDB_SSO_TOKEN_URL"),
            jwks_url: env("TIDB_SSO_JWKS_URL"),
            scopes: env("TIDB_SSO_SCOPES").unwrap_or_else(default_scopes),
            owner_subjects: csv("TIDB_SSO_OWNER_SUBJECTS"),
            owner_email_rules: csv("TIDB_SSO_OWNER_EMAIL_RULES"),
            allowed_orgs: csv("TIDB_SSO_ALLOWED_ORGS"),
            org_claim: env("TIDB_SSO_ORG_CLAIM").unwrap_or_else(default_org),
            post_login_url: env("TIDB_SSO_POST_LOGIN_URL"),
            allow_loopback_http: false,
        }))
    }
    pub fn validate(&self, path: &str, local: bool) -> Result<()> {
        ensure!(
            !self.client_id.trim().is_empty(),
            "SSO client ID is required"
        );
        ensure!(
            local || !self.allow_loopback_http,
            "Fake-provider transport is local only"
        );
        endpoint(&self.issuer, self.allow_loopback_http)?;
        for value in [&self.authorize_url, &self.token_url, &self.jwks_url]
            .into_iter()
            .flatten()
        {
            endpoint(value, self.allow_loopback_http)?;
        }
        let redirect = endpoint(&self.redirect_uri, local)?;
        ensure!(
            redirect.path() == format!("{path}/api/auth/tidbcloud/callback")
                && redirect.query().is_none()
                && redirect.fragment().is_none(),
            "SSO callback must match the public path exactly"
        );
        let post = endpoint(&self.post_login(path), local)?;
        ensure!(
            post.origin() == redirect.origin()
                && (path.is_empty()
                    || post.path() == path
                    || post.path().starts_with(&format!("{path}/"))),
            "Post-login URL must stay inside the callback origin and path"
        );
        for rule in &self.owner_email_rules {
            ensure!(valid_rule(rule), "Invalid owner email rule");
        }
        Ok(())
    }
    pub fn secure(&self) -> bool {
        self.redirect_uri.starts_with("https://")
    }
    pub fn post_login(&self, path: &str) -> String {
        self.post_login_url.clone().unwrap_or_else(|| {
            format!(
                "{}{path}/",
                Url::parse(&self.redirect_uri)
                    .expect("validated redirect")
                    .origin()
                    .ascii_serialization()
            )
        })
    }
}
pub fn endpoint(value: &str, local: bool) -> Result<Url> {
    let u = Url::parse(value)?;
    ensure!(
        u.username().is_empty() && u.password().is_none() && u.fragment().is_none(),
        "Endpoint credentials/fragments are not allowed"
    );
    let loopback = matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    ensure!(
        u.scheme() == "https" || (local && loopback && u.scheme() == "http"),
        "HTTPS endpoint required"
    );
    Ok(u)
}
fn email(value: &str) -> Option<String> {
    let expression = regex::Regex::new(
        r"(?i)^[a-z0-9!#$%&'+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'+/=?^_`{|}~-]+)*@([a-z0-9.-]+)$",
    )
    .expect("email pattern");
    let domain = expression.captures(value)?.get(1)?.as_str();
    if !valid_domain(domain) {
        return None;
    }
    Some(value.to_ascii_lowercase())
}
fn valid_domain(domain: &str) -> bool {
    domain.len() <= 253
        && domain.contains('.')
        && domain.split('.').all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && l.as_bytes()[0].is_ascii_alphanumeric()
                && l.as_bytes()[l.len() - 1].is_ascii_alphanumeric()
                && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}
fn valid_rule(rule: &str) -> bool {
    rule.strip_prefix("*@")
        .map(valid_domain)
        .unwrap_or_else(|| email(rule).is_some())
}
/// Constructed only after signature, issuer, audience, expiry, nonce and PKCE validation.
/// The issuer and subject are the identity used by onboarding; email is not an identity key.
pub(crate) struct VerifiedLogin {
    issuer: String,
    subject: String,
    claims: Value,
}
impl VerifiedLogin {
    pub(crate) fn verified_email(&self) -> Option<&str> {
        if self.claims["email_verified"] == true {
            self.claims["email"]
                .as_str()
                .filter(|value| email(value).is_some())
        } else {
            None
        }
    }
    pub(crate) fn identity(&self) -> (&str, &str) {
        (&self.issuer, &self.subject)
    }
}

pub(crate) fn shared_workspace_owner(
    config: &Config,
    login: &VerifiedLogin,
    workspace_id: &str,
) -> Result<Credential, ServiceError> {
    let claims = &login.claims;
    let (issuer, sub) = login.identity();
    let org = &claims[&config.org_claim];
    let org_allowed = config.allowed_orgs.is_empty()
        || config.allowed_orgs.iter().any(|expected| {
            org.as_str() == Some(expected)
                || org
                    .as_array()
                    .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(expected)))
        });
    let verified = claims["email_verified"] == true
        && claims["email"].as_str().and_then(email).is_some_and(|e| {
            config.owner_email_rules.iter().any(|r| {
                let r = r.to_ascii_lowercase();
                r == e
                    || e.split_once('@')
                        .is_some_and(|(_, d)| r == format!("*@{d}"))
            })
        });
    if !org_allowed || !(config.owner_subjects.iter().any(|s| s == sub) || verified) {
        return Err(failure(403, "SSO_NOT_AUTHORIZED"));
    }
    Ok(Credential::SessionOwner {
        id: format!("sso:{issuer}:{sub}"),
        actor: format!("tidb:{sub}"),
        workspace_id: workspace_id.into(),
        policy_generation: None,
        expires_at: chrono::Utc::now().timestamp() + 28800,
        revoked: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
    })
}
#[derive(Clone)]
struct Endpoints {
    authorize: String,
    token: String,
    jwks: String,
}
struct Flow {
    state: String,
    nonce: String,
    verifier: String,
    expires: Instant,
}
pub struct Runtime {
    pub config: Config,
    client: Client,
    endpoints: Mutex<Option<Endpoints>>,
    flows: Mutex<BTreeMap<String, Flow>>,
    attempts: Mutex<BTreeMap<String, (Instant, u32)>>,
}
pub fn failure(status: u16, code: &str) -> ServiceError {
    ServiceError::new(status, code)
}
impl Runtime {
    pub fn new(config: Config) -> Result<Self> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        Ok(Self {
            config,
            client: Client::builder()
                .timeout(Duration::from_secs(10))
                .connect_timeout(Duration::from_secs(3))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            endpoints: Mutex::new(None),
            flows: Mutex::new(BTreeMap::new()),
            attempts: Mutex::new(BTreeMap::new()),
        })
    }
    async fn json(&self, response: reqwest::Response) -> Result<Value> {
        ensure!(response.status().is_success(), "Provider request failed");
        let mut stream = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.chunk().await? {
            ensure!(
                bytes.len() + chunk.len() <= 256 * 1024,
                "Provider response too large"
            );
            bytes.extend_from_slice(&chunk);
        }
        Ok(serde_json::from_slice(&bytes)?)
    }
    async fn endpoints(&self) -> Result<Endpoints> {
        let mut cached = self.endpoints.lock().await;
        if let Some(e) = cached.as_ref() {
            return Ok(e.clone());
        }
        let c = &self.config;
        let mut discovered = json!({});
        if c.authorize_url.is_none() || c.token_url.is_none() || c.jwks_url.is_none() {
            let url = format!(
                "{}/.well-known/openid-configuration",
                c.issuer.trim_end_matches('/')
            );
            discovered = self.json(self.client.get(url).send().await?).await?;
            ensure!(
                discovered["issuer"] == c.issuer,
                "Discovery issuer mismatch"
            );
        }
        let choose = |explicit: &Option<String>, name: &str| -> Result<String> {
            let value = explicit
                .clone()
                .or_else(|| discovered[name].as_str().map(str::to_owned))
                .ok_or_else(|| anyhow::anyhow!("Missing endpoint"))?;
            endpoint(&value, c.allow_loopback_http)?;
            Ok(value)
        };
        let e = Endpoints {
            authorize: choose(&c.authorize_url, "authorization_endpoint")?,
            token: choose(&c.token_url, "token_endpoint")?,
            jwks: choose(&c.jwks_url, "jwks_uri")?,
        };
        *cached = Some(e.clone());
        Ok(e)
    }
    pub async fn login(&self, source: &str) -> Result<(String, String), ServiceError> {
        let now = Instant::now();
        let mut attempts = self.attempts.lock().await;
        attempts.retain(|_, (at, _)| now.duration_since(*at) < Duration::from_secs(60));
        if attempts.len() >= 4096 && !attempts.contains_key(source) {
            return Err(failure(429, "SSO_RATE_LIMITED"));
        }
        let entry = attempts.entry(source.to_owned()).or_insert((now, 0));
        if entry.1 >= 20 {
            return Err(failure(429, "SSO_RATE_LIMITED"));
        }
        entry.1 += 1;
        drop(attempts);
        let e = self
            .endpoints()
            .await
            .map_err(|_| failure(503, "SSO_UNAVAILABLE"))?;
        let verifier = secret(32)?;
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let state = secret(32)?;
        let nonce = secret(32)?;
        let flow = secret(32)?;
        let mut url = Url::parse(&e.authorize).map_err(|_| failure(503, "SSO_UNAVAILABLE"))?;
        let reserved = [
            "response_type",
            "client_id",
            "redirect_uri",
            "scope",
            "state",
            "nonce",
            "code_challenge",
            "code_challenge_method",
        ];
        let preserved = url
            .query_pairs()
            .filter(|(k, _)| !reserved.contains(&k.as_ref()))
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect::<Vec<_>>();
        url.set_query(None);
        url.query_pairs_mut().extend_pairs(preserved);
        url.query_pairs_mut().extend_pairs([
            ("response_type", "code"),
            ("client_id", &self.config.client_id),
            ("redirect_uri", &self.config.redirect_uri),
            ("scope", &self.config.scopes),
            ("state", &state),
            ("nonce", &nonce),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
        ]);
        let mut flows = self.flows.lock().await;
        flows.retain(|_, f| f.expires > now);
        if flows.len() >= 4096 {
            return Err(failure(429, "SSO_RATE_LIMITED"));
        }
        flows.insert(
            flow.clone(),
            Flow {
                state,
                nonce,
                verifier,
                expires: now + Duration::from_secs(600),
            },
        );
        Ok((url.into(), flow))
    }
    pub async fn callback(
        &self,
        flow: &str,
        query: &BTreeMap<String, String>,
    ) -> Result<VerifiedLogin, ServiceError> {
        let flow = self
            .flows
            .lock()
            .await
            .remove(flow)
            .filter(|f| f.expires > Instant::now())
            .ok_or_else(|| failure(400, "SSO_STATE_INVALID"))?;
        if query.contains_key("error") {
            return Err(failure(400, "SSO_PROVIDER_ERROR"));
        }
        if query.get("state") != Some(&flow.state) {
            return Err(failure(400, "SSO_STATE_MISMATCH"));
        }
        let code = query
            .get("code")
            .filter(|s| !s.is_empty())
            .ok_or_else(|| failure(400, "SSO_CODE_MISSING"))?;
        self.verify(code, &flow)
            .await
            .map_err(|_| failure(401, "SSO_VERIFICATION_FAILED"))
    }
    async fn verify(&self, code: &str, flow: &Flow) -> Result<VerifiedLogin> {
        let e = self.endpoints().await?;
        let c = &self.config;
        let form = [
            ("grant_type", "authorization_code"),
            ("code", code),
            ("client_id", &c.client_id),
            ("redirect_uri", &c.redirect_uri),
            ("code_verifier", &flow.verifier),
        ];
        let tokens = self
            .json(self.client.post(&e.token).form(&form).send().await?)
            .await?;
        let token = tokens["id_token"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing ID token"))?;
        let header = decode_header(token)?;
        // Only asymmetric signing; the public JWK can never become an HMAC secret.
        ensure!(
            matches!(
                header.alg,
                Algorithm::RS256
                    | Algorithm::RS384
                    | Algorithm::RS512
                    | Algorithm::ES256
                    | Algorithm::ES384
                    | Algorithm::EdDSA
            ),
            "Unsupported signature algorithm"
        );
        let kid = header
            .kid
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("Missing key ID"))?;
        let keys = self.json(self.client.get(&e.jwks).send().await?).await?;
        let matching = keys["keys"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Invalid JWKS"))?
            .iter()
            .filter(|k| k["kid"].as_str() == Some(kid))
            .collect::<Vec<_>>();
        ensure!(matching.len() == 1, "Ambiguous signing key");
        let key = matching[0];
        ensure!(key["use"].is_null() || key["use"] == "sig", "Wrong key use");
        ensure!(
            key["alg"].is_null() || key["alg"] == serde_json::to_value(header.alg)?,
            "Wrong key algorithm"
        );
        if let Some(ops) = key["key_ops"].as_array() {
            ensure!(ops.iter().any(|v| v == "verify"), "Key cannot verify");
        }
        let jwks: JwkSet = serde_json::from_value(json!({"keys":[key]}))?;
        let decoding = DecodingKey::from_jwk(&jwks.keys[0])?;
        let mut validation = Validation::new(header.alg);
        validation.leeway = 0;
        validation.validate_nbf = true;
        validation.set_issuer(&[&c.issuer]);
        validation.set_audience(&[&c.client_id]);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
        let claims = decode::<Value>(token, &decoding, &validation)?.claims;
        ensure!(claims["nonce"].as_str() == Some(&flow.nonce), "Wrong nonce");
        if claims["aud"].as_array().is_some_and(|a| a.len() > 1) {
            ensure!(claims["azp"] == c.client_id, "Wrong authorized party");
        }
        if !claims["azp"].is_null() {
            ensure!(claims["azp"] == c.client_id, "Wrong authorized party");
        }
        if claims["iat"]
            .as_i64()
            .is_some_and(|t| t > chrono::Utc::now().timestamp() + 30)
        {
            bail!("Future token")
        }
        let subject = claims["sub"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| anyhow::anyhow!("Invalid subject"))?
            .to_owned();
        Ok(VerifiedLogin {
            issuer: c.issuer.clone(),
            subject,
            claims,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        serde_json::from_value(json!({"issuer":"https://issuer.example/","clientId":"client","redirectUri":"https://studio.example/studio/api/auth/tidbcloud/callback","ownerEmailRules":["*@example.org"]})).unwrap()
    }
    fn identity(config: &Config, claims: &Value) -> Result<Credential, ServiceError> {
        let subject = claims["sub"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| failure(401, "SSO_VERIFICATION_FAILED"))?;
        shared_workspace_owner(
            config,
            &VerifiedLogin {
                issuer: config.issuer.clone(),
                subject: subject.into(),
                claims: claims.clone(),
            },
            "ws_test",
        )
    }
    #[test]
    fn configuration_and_identity_fail_closed() {
        let mut c = config();
        assert!(c.validate("/studio", false).is_ok());
        c.post_login_url = Some("https://evil.example/studio/".into());
        assert!(c.validate("/studio", false).is_err());
        c.post_login_url = Some("https://studio.example/studio-evil/".into());
        assert!(c.validate("/studio", false).is_err());
        c.post_login_url = None;
        c.owner_email_rules = vec!["*@org".into()];
        assert!(c.validate("/studio", false).is_err());
        c = config();
        for claim in [
            json!({"sub":"bob","email":"bob@example.org","email_verified":"true"}),
            json!({"sub":"bob","email":"bob@sub.example.org","email_verified":true}),
            json!({"sub":[],"email":"bob@example.org","email_verified":true}),
        ] {
            assert!(identity(&c, &claim).is_err());
        }
        let owner = identity(
            &c,
            &json!({"sub":"immutable-bob","email":"Bob@Example.org","email_verified":true}),
        )
        .unwrap();
        match owner {
            Credential::SessionOwner { id, actor, .. } => {
                assert_eq!(id, "sso:https://issuer.example/:immutable-bob");
                assert_eq!(actor, "tidb:immutable-bob");
            }
            _ => panic!("Expected distinct SSO identity"),
        }
    }
    #[tokio::test]
    async fn authorize_parameters_cannot_be_overridden_by_endpoint_query() {
        let mut c = config();
        c.authorize_url = Some(
            "https://issuer.example/authorize?client_id=wrong&state=wrong&organization=org-a"
                .into(),
        );
        c.token_url = Some("https://issuer.example/token".into());
        c.jwks_url = Some("https://issuer.example/jwks".into());
        let r = Runtime::new(c).unwrap();
        let (url, _) = r.login("fixture").await.unwrap();
        let parsed = Url::parse(&url).unwrap();
        let pairs = parsed.query_pairs().collect::<Vec<_>>();
        assert_eq!(pairs.iter().filter(|(k, _)| k == "client_id").count(), 1);
        assert_eq!(
            pairs.iter().find(|(k, _)| k == "client_id").unwrap().1,
            "client"
        );
        assert_eq!(pairs.iter().filter(|(k, _)| k == "state").count(), 1);
        assert_eq!(
            pairs.iter().find(|(k, _)| k == "organization").unwrap().1,
            "org-a"
        );
    }
    #[tokio::test]
    async fn expired_flow_is_consumed() {
        let r = Runtime::new(config()).unwrap();
        r.flows.lock().await.insert(
            "old".into(),
            Flow {
                state: "s".into(),
                nonce: "n".into(),
                verifier: "v".into(),
                expires: Instant::now() - Duration::from_secs(1),
            },
        );
        assert!(r.callback("old", &BTreeMap::new()).await.is_err());
        assert!(r.flows.lock().await.is_empty());
    }
}
