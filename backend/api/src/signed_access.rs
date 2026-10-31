//! Strict local verification for an asymmetric access-token profile.
//!
//! This module does not expose an endpoint or authorize a data operation. A caller must also
//! enforce current durable Key, grant, resource, token-denial and family policy before I/O.
//! It deliberately performs no key discovery or network request.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::Deserialize;
use std::collections::BTreeMap;
use uuid::Uuid;
use workspace_contracts::{Result, ServiceError};

const MAX_TOKEN_BYTES: usize = 8192;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StrictHeader {
    alg: String,
    typ: String,
    kid: String,
}

/// Claims are an immutable permission ceiling, not proof of current authorization.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AccessClaims {
    iss: String,
    aud: String,
    sub: String,
    jti: String,
    iat: i64,
    nbf: i64,
    exp: i64,
    environment: String,
    workspace_id: String,
    region_id: Option<String>,
    key_id: String,
    key_version: u64,
    policy_generation: u64,
    grant_ref: String,
    scopes: Vec<String>,
    family_id: Option<String>,
    family_epoch: Option<u64>,
}

/// A cryptographically verified bearer, not an authorization decision. It cannot be
/// deserialized or constructed by a transport caller. Recheck regional policy, grant,
/// family/deny state and clock at every documented effect boundary.
pub struct VerifiedAccess {
    claims: AccessClaims,
}

impl VerifiedAccess {
    pub fn workspace_id(&self) -> &str {
        &self.claims.workspace_id
    }
    pub fn region_id(&self) -> Option<&str> {
        self.claims.region_id.as_deref()
    }
    pub fn principal_id(&self) -> &str {
        &self.claims.sub
    }
    pub fn key_id(&self) -> &str {
        &self.claims.key_id
    }
    pub fn key_version(&self) -> u64 {
        self.claims.key_version
    }
    pub fn policy_generation(&self) -> u64 {
        self.claims.policy_generation
    }
    pub fn grant_ref(&self) -> &str {
        &self.claims.grant_ref
    }
    pub fn scopes(&self) -> &[String] {
        &self.claims.scopes
    }
    pub fn token_id(&self) -> &str {
        &self.claims.jti
    }
    pub fn expires_at(&self) -> i64 {
        self.claims.exp
    }
    pub fn not_before(&self) -> i64 {
        self.claims.nbf
    }
    pub fn family_id(&self) -> Option<&str> {
        self.claims.family_id.as_deref()
    }
    pub fn family_epoch(&self) -> Option<u64> {
        self.claims.family_epoch
    }
}

/// Explicitly configured trust for exactly one issuer, audience and token type.
/// Regional and Global profiles must be separate; keys are loaded locally, never from a JWT.
pub struct AccessVerifier {
    issuer: String,
    audience: String,
    token_type: String,
    environment: String,
    region: Option<String>,
    max_lifetime: i64,
    keys: BTreeMap<String, [u8; 32]>,
    issuer_kind: IssuerKind,
}

/// Region signers cannot issue Global tokens. Only Region signers issue family-bound tokens.
#[derive(Clone, Copy)]
pub enum IssuerKind {
    Global,
    Region,
}

pub struct AccessTrust {
    pub issuer: String,
    pub audience: String,
    pub environment: String,
    pub region: Option<String>,
    pub max_lifetime: i64,
    pub issuer_kind: IssuerKind,
    pub keys: BTreeMap<String, [u8; 32]>,
}

fn denied() -> ServiceError {
    ServiceError::new(401, "INVALID_CREDENTIAL")
}

fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.:".contains(&b))
}

fn uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|parsed| parsed.to_string() == value)
}

impl AccessVerifier {
    pub fn new(trust: AccessTrust) -> Result<Self> {
        let AccessTrust {
            issuer,
            audience,
            environment,
            region,
            max_lifetime,
            issuer_kind,
            keys,
        } = trust;
        if issuer.is_empty()
            || issuer.len() > 512
            || audience.is_empty()
            || audience.len() > 512
            || !id(&environment)
            || region
                .as_ref()
                .is_some_and(|r| !id(r) || !r.starts_with("region:") || r.len() <= 7)
            || matches!(issuer_kind, IssuerKind::Region) && region.is_none()
            || !(1..=3600).contains(&max_lifetime)
            || keys.is_empty()
            || keys.len() > 32
            || keys.keys().any(|kid| !id(kid))
            || keys.values().any(|key| {
                !ed25519_dalek::VerifyingKey::from_bytes(key).is_ok_and(|key| !key.is_weak())
            })
        {
            return Err(ServiceError::new(503, "TOKEN_TRUST_INVALID"));
        }
        Ok(Self {
            issuer,
            audience,
            token_type: if region.is_some() {
                "workspace-region-access+jwt"
            } else {
                "workspace-global-access+jwt"
            }
            .into(),
            environment,
            region,
            max_lifetime,
            keys,
            issuer_kind,
        })
    }

    /// Validates locally with a caller-supplied trusted regional clock. No policy-age lease is
    /// applied. The caller must enforce a durable anti-rollback time floor before invoking this.
    pub fn verify(&self, token: &str, now: i64) -> Result<VerifiedAccess> {
        if token.len() > MAX_TOKEN_BYTES || now <= 0 {
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
        if header.is_empty() || payload.is_empty() || signature.is_empty() {
            return Err(denied());
        }
        let raw_header = URL_SAFE_NO_PAD.decode(header).map_err(|_| denied())?;
        let strict: StrictHeader = serde_json::from_slice(&raw_header).map_err(|_| denied())?;
        if strict.alg != "EdDSA" || strict.typ != self.token_type || !id(&strict.kid) {
            return Err(denied());
        }
        let key = self.keys.get(&strict.kid).ok_or_else(denied)?;
        let mut validation = Validation::new(Algorithm::EdDSA);
        validation.validate_exp = false;
        validation.validate_nbf = false;
        validation.validate_aud = false;
        validation.required_spec_claims.clear();
        // Decode into a strict struct: unknown and duplicate claims are rejected by serde.
        let claims = decode::<AccessClaims>(token, &DecodingKey::from_ed_der(key), &validation)
            .map_err(|_| denied())?
            .claims;
        if claims.iss != self.issuer
            || claims.aud != self.audience
            || claims.environment != self.environment
            || claims.region_id != self.region
            || !id(&claims.sub)
            || !id(&claims.workspace_id)
            || !id(&claims.grant_ref)
            || !uuid(&claims.jti)
            || !uuid(&claims.key_id)
            || claims.key_version == 0
            || claims.policy_generation == 0
            || claims.iat <= 0
            || claims.iat > claims.nbf
            || claims.nbf > now
            || claims.exp <= now
            || claims.exp <= claims.iat
            || claims
                .exp
                .checked_sub(claims.iat)
                .is_none_or(|ttl| ttl > self.max_lifetime)
            || claims.scopes.is_empty()
            || claims.scopes.len() > 64
            || claims.scopes.iter().any(|scope| scope != "*" && !id(scope))
            || match (self.issuer_kind, &claims.family_id, claims.family_epoch) {
                (IssuerKind::Global, None, None) => false,
                (IssuerKind::Region, Some(family), Some(epoch)) => !uuid(family) || epoch == 0,
                _ => true,
            }
        {
            return Err(denied());
        }
        Ok(VerifiedAccess { claims })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{EncodingKey, Header, encode};
    use serde_json::{Value, json};

    // RFC 8032 public test vector. This key is synthetic and never used outside tests.
    fn private_key() -> EncodingKey {
        let bytes = URL_SAFE_NO_PAD
            .decode("MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v_VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g")
            .unwrap();
        EncodingKey::from_ed_der(&bytes)
    }

    fn verifier() -> AccessVerifier {
        let bytes = URL_SAFE_NO_PAD
            .decode("11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo")
            .unwrap();
        AccessVerifier::new(AccessTrust {
            issuer: "https://global.example".into(),
            audience: "region:a/audience".into(),
            environment: "test".into(),
            region: Some("region:a".into()),
            max_lifetime: 900,
            issuer_kind: IssuerKind::Global,
            keys: BTreeMap::from([("key-1".into(), bytes.try_into().unwrap())]),
        })
        .unwrap()
    }

    fn claims() -> Value {
        json!({"iss":"https://global.example","aud":"region:a/audience", "sub":"principal-1",
            "jti":"00000000-0000-4000-8000-000000000001", "iat":1000, "nbf":1000,
            "exp":1900, "environment":"test", "workspaceId":"ws_agentlab", "regionId":"region:a",
            "keyId":"00000000-0000-4000-8000-000000000002", "keyVersion":1,
            "policyGeneration":1, "grantRef":"grant-1", "scopes":["resources:read"],
            "familyId":null,"familyEpoch":null})
    }

    fn token(value: &Value, kid: &str, typ: &str) -> String {
        let mut header = Header::new(Algorithm::EdDSA);
        header.kid = Some(kid.into());
        header.typ = Some(typ.into());
        encode(&header, value, &private_key()).unwrap()
    }

    fn signed_raw(header: &str, payload: &str) -> String {
        let message = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header),
            URL_SAFE_NO_PAD.encode(payload)
        );
        let signature =
            jsonwebtoken::crypto::sign(message.as_bytes(), &private_key(), Algorithm::EdDSA)
                .unwrap();
        format!("{message}.{signature}")
    }

    #[test]
    fn authenticates_only_the_exact_local_profile_and_valid_interval() {
        let verifier = verifier();
        let good = token(&claims(), "key-1", "workspace-region-access+jwt");
        assert_eq!(
            verifier.verify(&good, 1000).unwrap().workspace_id(),
            "ws_agentlab"
        );
        assert!(verifier.verify(&good, 999).is_err());
        assert!(verifier.verify(&good, 1900).is_err());
        assert!(verifier.verify(&good, 0).is_err());
        for (field, value) in [
            ("iss", json!("https://other.example")),
            ("aud", json!("region:b/audience")),
            ("environment", json!("production")),
            ("regionId", json!("region:b")),
            ("keyVersion", json!(0)),
            ("policyGeneration", json!(0)),
            ("exp", json!(1901)),
            ("jti", json!("not-a-uuid")),
            ("familyEpoch", json!(1)),
            ("scopes", json!([])),
        ] {
            let mut bad = claims();
            bad[field] = value;
            assert!(
                verifier
                    .verify(&token(&bad, "key-1", "workspace-region-access+jwt"), 1000)
                    .is_err(),
                "{field}"
            );
        }
        assert!(
            verifier
                .verify(
                    &token(&claims(), "key-2", "workspace-region-access+jwt"),
                    1000
                )
                .is_err()
        );
        assert!(
            verifier
                .verify(
                    &token(&claims(), "key-1", "workspace-global-access+jwt"),
                    1000
                )
                .is_err()
        );
    }

    #[test]
    fn rejects_duplicate_claims_untrusted_headers_and_tampering() {
        let verifier = verifier();
        let base = serde_json::to_string(&claims()).unwrap();
        let duplicate = format!(
            "{},\"aud\":\"region:a/audience\"}}",
            &base[..base.len() - 1]
        );
        let header = r#"{"alg":"EdDSA","typ":"workspace-region-access+jwt","kid":"key-1"}"#;
        assert!(
            verifier
                .verify(&signed_raw(header, &duplicate), 1000)
                .is_err()
        );
        let untrusted = r#"{"alg":"EdDSA","typ":"workspace-region-access+jwt","kid":"key-1","jku":"https://attacker.example/jwks"}"#;
        assert!(
            verifier
                .verify(&signed_raw(untrusted, &base), 1000)
                .is_err()
        );
        let wrong_algorithm =
            r#"{"alg":"HS256","typ":"workspace-region-access+jwt","kid":"key-1"}"#;
        assert!(
            verifier
                .verify(&signed_raw(wrong_algorithm, &base), 1000)
                .is_err()
        );
        let none = r#"{"alg":"none","typ":"workspace-region-access+jwt","kid":"key-1"}"#;
        assert!(verifier.verify(&signed_raw(none, &base), 1000).is_err());
        let duplicate_header =
            r#"{"alg":"EdDSA","alg":"EdDSA","typ":"workspace-region-access+jwt","kid":"key-1"}"#;
        assert!(
            verifier
                .verify(&signed_raw(duplicate_header, &base), 1000)
                .is_err()
        );
        let unknown = format!("{},\"newClaim\":true}}", &base[..base.len() - 1]);
        assert!(
            verifier
                .verify(&signed_raw(header, &unknown), 1000)
                .is_err()
        );
        let good = token(&claims(), "key-1", "workspace-region-access+jwt");
        let (prefix, _) = good.rsplit_once('.').unwrap();
        assert!(
            verifier
                .verify(
                    &format!("{prefix}.{}", URL_SAFE_NO_PAD.encode([0u8; 64])),
                    1000
                )
                .is_err()
        );
        assert!(
            verifier
                .verify(&"x".repeat(MAX_TOKEN_BYTES + 1), 1000)
                .is_err()
        );
    }

    #[test]
    fn region_signer_can_only_issue_family_bound_region_tokens() {
        assert!(
            AccessVerifier::new(AccessTrust {
                issuer: "https://region-a.example".into(),
                audience: "region:a/audience".into(),
                environment: "test".into(),
                region: Some("region:a".into()),
                max_lifetime: 900,
                issuer_kind: IssuerKind::Region,
                keys: BTreeMap::from([("key-1".into(), [0u8; 32])]),
            })
            .is_err()
        );
        let public = URL_SAFE_NO_PAD
            .decode("11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo")
            .unwrap();
        let region = AccessVerifier::new(AccessTrust {
            issuer: "https://region-a.example".into(),
            audience: "region:a/audience".into(),
            environment: "test".into(),
            region: Some("region:a".into()),
            max_lifetime: 900,
            issuer_kind: IssuerKind::Region,
            keys: BTreeMap::from([("key-1".into(), public.try_into().unwrap())]),
        })
        .unwrap();
        let mut value = claims();
        value["iss"] = json!("https://region-a.example");
        assert!(
            region
                .verify(&token(&value, "key-1", "workspace-region-access+jwt"), 1000)
                .is_err()
        );
        value["familyId"] = json!("00000000-0000-4000-8000-000000000003");
        value["familyEpoch"] = json!(1);
        assert!(
            region
                .verify(&token(&value, "key-1", "workspace-region-access+jwt"), 1000)
                .is_ok()
        );
        value["iss"] = json!("https://global.example");
        assert!(
            verifier()
                .verify(&token(&value, "key-1", "workspace-region-access+jwt"), 1000)
                .is_err()
        );
        assert!(
            AccessVerifier::new(AccessTrust {
                issuer: "https://region-a.example".into(),
                audience: "global".into(),
                environment: "test".into(),
                region: None,
                max_lifetime: 900,
                issuer_kind: IssuerKind::Region,
                keys: BTreeMap::from([("key-1".into(), [7u8; 32])]),
            })
            .is_err()
        );
    }
}
