//! One-time user delegation from Global Portal to its registered Region.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use workspace_contracts::{Result, ServiceError};

const TYPE: &str = "workspace-portal-exchange+jwt";
fn denied() -> ServiceError {
    ServiceError::new(401, "PORTAL_EXCHANGE_INVALID")
}
fn valid_text(value: &str) -> bool {
    !value.is_empty() && value.len() <= 2048 && !value.chars().any(char::is_control)
}
fn uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StrictHeader {
    alg: String,
    typ: String,
    kid: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Claims {
    pub iss: String,
    pub aud: String,
    pub environment: String,
    pub jti: String,
    pub workspace_id: String,
    pub identity_issuer: String,
    pub identity_subject: String,
    pub iat: i64,
    pub exp: i64,
}

pub struct Signer {
    key: EncodingKey,
    issuer: String,
    key_id: String,
    environment: String,
}
impl Signer {
    pub fn new(key: &[u8], issuer: String, key_id: String, environment: String) -> Result<Self> {
        if !valid_text(&issuer) || !valid_text(&key_id) || !valid_text(&environment) {
            return Err(denied());
        }
        let key = EncodingKey::from_ed_der(key);
        jsonwebtoken::crypto::sign(b"portal-exchange-self-check", &key, Algorithm::EdDSA)
            .map_err(|_| denied())?;
        Ok(Self {
            key,
            issuer,
            key_id,
            environment,
        })
    }
    pub fn issue(
        &self,
        region: &str,
        workspace: &str,
        identity_issuer: &str,
        identity_subject: &str,
        now: i64,
    ) -> Result<String> {
        if !region.starts_with("region:")
            || !uuid(workspace)
            || !valid_text(identity_issuer)
            || !valid_text(identity_subject)
            || now <= 0
        {
            return Err(denied());
        }
        let claims = Claims {
            iss: self.issuer.clone(),
            aud: format!("{region}/portal-exchange"),
            environment: self.environment.clone(),
            jti: Uuid::new_v4().to_string(),
            workspace_id: workspace.into(),
            identity_issuer: identity_issuer.into(),
            identity_subject: identity_subject.into(),
            iat: now,
            exp: now.checked_add(60).ok_or_else(denied)?,
        };
        let mut header = Header::new(Algorithm::EdDSA);
        header.typ = Some(TYPE.into());
        header.kid = Some(self.key_id.clone());
        encode(&header, &claims, &self.key).map_err(|_| denied())
    }
}

pub struct Verifier {
    issuer: String,
    region: String,
    key_id: String,
    environment: String,
    public: [u8; 32],
}
impl Verifier {
    pub fn new(
        issuer: String,
        region: String,
        key_id: String,
        environment: String,
        public: [u8; 32],
    ) -> Self {
        Self {
            issuer,
            region,
            key_id,
            environment,
            public,
        }
    }
    pub fn verify(&self, token: &str, now: i64) -> Result<Claims> {
        if token.len() > 8192 || now <= 0 {
            return Err(denied());
        }
        let mut segments = token.split('.');
        let (Some(header), Some(payload), Some(signature), None) = (
            segments.next(),
            segments.next(),
            segments.next(),
            segments.next(),
        ) else {
            return Err(denied());
        };
        if payload.is_empty() || signature.is_empty() {
            return Err(denied());
        }
        let header: StrictHeader =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header).map_err(|_| denied())?)
                .map_err(|_| denied())?;
        if header.alg != "EdDSA" || header.typ != TYPE || header.kid != self.key_id {
            return Err(denied());
        }
        let mut validation = Validation::new(Algorithm::EdDSA);
        validation.validate_exp = false;
        validation.validate_nbf = false;
        validation.validate_aud = false;
        validation.required_spec_claims.clear();
        let claims = decode::<Claims>(token, &DecodingKey::from_ed_der(&self.public), &validation)
            .map_err(|_| denied())?
            .claims;
        if claims.iss != self.issuer
            || claims.aud != format!("{}/portal-exchange", self.region)
            || claims.environment != self.environment
            || !uuid(&claims.jti)
            || !uuid(&claims.workspace_id)
            || !valid_text(&claims.identity_issuer)
            || !valid_text(&claims.identity_subject)
            || claims.iat <= 0
            || claims.iat > now
            || claims.exp <= now
            || claims
                .exp
                .checked_sub(claims.iat)
                .is_none_or(|duration| !(1..=60).contains(&duration))
        {
            return Err(denied());
        }
        Ok(claims)
    }
}
