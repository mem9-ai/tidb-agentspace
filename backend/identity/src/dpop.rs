//! Local validation for an Ed25519 DPoP proof profile (RFC 9449 / RFC 7638).
//!
//! Proof of possession is not authentication or authorization. This module does not consume
//! nonces or replay IDs, issue credentials, or authorize a request. A caller must atomically
//! consume the proof ID and nonce with the relevant refresh-family state change before issuing
//! anything, and enforce current Key, grant, family and resource policy at effect boundaries.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use url::Url;
use uuid::Uuid;
use workspace_contracts::Result;

use crate::error;

const MAX_PROOF: usize = 8192;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Jwk {
    kty: String,
    crv: String,
    x: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    typ: String,
    alg: String,
    jwk: Jwk,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Claims {
    jti: String,
    htm: String,
    htu: String,
    iat: i64,
    nonce: Option<String>,
    ath: Option<String>,
}

/// Every expected value must come from trusted request routing and local family state, not
/// forwarded Host headers or proof claims. Loopback HTTP is for explicitly local tests only.
pub struct ProofContext<'a> {
    pub method: &'a str,
    pub target_uri: &'a str,
    pub expected_thumbprint: Option<&'a str>,
    pub expected_nonce: &'a str,
    pub access_token: Option<&'a str>,
    pub now: i64,
    pub allow_loopback_http: bool,
}

/// Opaque verified data. A replayed proof is still rejected only by the caller's durable
/// atomic replay/nonce store; verifying it twice here intentionally does not consume it.
pub struct VerifiedProof {
    thumbprint: String,
    proof_id: String,
    issued_at: i64,
}
impl VerifiedProof {
    pub fn thumbprint(&self) -> &str {
        &self.thumbprint
    }
    pub fn proof_id(&self) -> &str {
        &self.proof_id
    }
    pub fn issued_at(&self) -> i64 {
        self.issued_at
    }
}

fn denied() -> workspace_contracts::ServiceError {
    error(401, "INVALID_DPOP_PROOF")
}

fn valid_proof_id(value: &str) -> bool {
    if value.len() > 128 {
        return false;
    }
    if let Ok(id) = Uuid::parse_str(value) {
        return id.to_string() == value
            && id.get_version_num() == 4
            && id.get_variant() == uuid::Variant::RFC4122;
    }
    URL_SAFE_NO_PAD.decode(value).is_ok_and(|bytes| {
        (12..=64).contains(&bytes.len()) && URL_SAFE_NO_PAD.encode(bytes) == value
    })
}

fn valid_target(value: &str, local: bool) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    (url.scheme() == "https" || local && loopback && url.scheme() == "http")
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.as_str() == value
}

/// Verify one proof against trusted request context. This does not access Global or the network.
pub fn verify(proof: &str, context: &ProofContext<'_>) -> Result<VerifiedProof> {
    if proof.len() > MAX_PROOF
        || context.now <= 0
        || !valid_target(context.target_uri, context.allow_loopback_http)
        || context.method.is_empty()
        || context.method.len() > 16
        || !context.method.bytes().all(|b| b.is_ascii_uppercase())
        || context.expected_nonce.is_empty()
        || context.expected_nonce.len() > 256
        || context
            .access_token
            .is_some_and(|s| s.is_empty() || s.len() > 8192 || !s.is_ascii())
    {
        return Err(denied());
    }
    let mut segments = proof.split('.');
    let (Some(header_part), Some(payload_part), Some(signature_part), None) = (
        segments.next(),
        segments.next(),
        segments.next(),
        segments.next(),
    ) else {
        return Err(denied());
    };
    if header_part.is_empty() || payload_part.is_empty() || signature_part.is_empty() {
        return Err(denied());
    }
    let raw = URL_SAFE_NO_PAD.decode(header_part).map_err(|_| denied())?;
    if URL_SAFE_NO_PAD.encode(&raw) != header_part {
        return Err(denied());
    }
    let header: Header = serde_json::from_slice(&raw).map_err(|_| denied())?;
    if header.typ != "dpop+jwt"
        || header.alg != "EdDSA"
        || header.jwk.kty != "OKP"
        || header.jwk.crv != "Ed25519"
    {
        return Err(denied());
    }
    let public = URL_SAFE_NO_PAD
        .decode(&header.jwk.x)
        .map_err(|_| denied())?;
    let bytes: [u8; 32] = public.try_into().map_err(|_| denied())?;
    let key = VerifyingKey::from_bytes(&bytes).map_err(|_| denied())?;
    if URL_SAFE_NO_PAD.encode(bytes) != header.jwk.x || key.is_weak() {
        return Err(denied());
    }
    let canonical = format!(r#"{{"crv":"Ed25519","kty":"OKP","x":"{}"}}"#, header.jwk.x);
    let thumbprint = URL_SAFE_NO_PAD.encode(Sha256::digest(canonical.as_bytes()));
    if context
        .expected_thumbprint
        .is_some_and(|expected| !bool::from(expected.as_bytes().ct_eq(thumbprint.as_bytes())))
    {
        return Err(denied());
    }
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(signature_part)
        .map_err(|_| denied())?;
    if URL_SAFE_NO_PAD.encode(&signature_bytes) != signature_part {
        return Err(denied());
    }
    let signature = Signature::from_slice(&signature_bytes).map_err(|_| denied())?;
    key.verify_strict(
        format!("{header_part}.{payload_part}").as_bytes(),
        &signature,
    )
    .map_err(|_| denied())?;
    let payload = URL_SAFE_NO_PAD.decode(payload_part).map_err(|_| denied())?;
    if URL_SAFE_NO_PAD.encode(&payload) != payload_part {
        return Err(denied());
    }
    let claims: Claims = serde_json::from_slice(&payload).map_err(|_| denied())?;
    let earliest = context.now.checked_sub(60).ok_or_else(denied)?;
    let latest = context.now.checked_add(30).ok_or_else(denied)?;
    let nonce_valid = claims.nonce.as_deref().is_some_and(|actual| {
        bool::from(context.expected_nonce.as_bytes().ct_eq(actual.as_bytes()))
    });
    let access_valid = match (context.access_token, claims.ath.as_deref()) {
        (None, None) => true,
        (Some(token), Some(actual)) => bool::from(
            URL_SAFE_NO_PAD
                .encode(Sha256::digest(token.as_bytes()))
                .as_bytes()
                .ct_eq(actual.as_bytes()),
        ),
        _ => false,
    };
    if !valid_proof_id(&claims.jti)
        || claims.htm != context.method
        || claims.htu != context.target_uri
        || claims.iat < earliest
        || claims.iat > latest
        || !nonce_valid
        || !access_valid
    {
        return Err(denied());
    }
    Ok(VerifiedProof {
        thumbprint,
        proof_id: claims.jti,
        issued_at: claims.iat,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{Algorithm, EncodingKey};
    use serde_json::{Value, json};

    const PUBLIC: &str = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
    const PRIVATE: &str = "MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v_VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g";
    const URI: &str = "https://region.example/api/v1/workspaces/ws_agentlab/token-issuances";

    fn header() -> Value {
        json!({"typ":"dpop+jwt", "alg":"EdDSA", "jwk":{"kty":"OKP", "crv":"Ed25519", "x":PUBLIC}})
    }
    fn claims() -> Value {
        json!({"jti":"00000000-0000-4000-8000-000000000001", "htm":"POST", "htu":URI, "iat":1000, "nonce":"trusted-nonce"})
    }
    fn context<'a>() -> ProofContext<'a> {
        ProofContext {
            method: "POST",
            target_uri: URI,
            expected_thumbprint: None,
            expected_nonce: "trusted-nonce",
            access_token: None,
            now: 1000,
            allow_loopback_http: false,
        }
    }
    fn sign_raw(header: &str, payload: &str) -> String {
        let message = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header),
            URL_SAFE_NO_PAD.encode(payload)
        );
        let private = URL_SAFE_NO_PAD.decode(PRIVATE).unwrap();
        let sig = jsonwebtoken::crypto::sign(
            message.as_bytes(),
            &EncodingKey::from_ed_der(&private),
            Algorithm::EdDSA,
        )
        .unwrap();
        format!("{message}.{sig}")
    }
    fn sign(header: &Value, claims: &Value) -> String {
        sign_raw(&header.to_string(), &claims.to_string())
    }

    #[test]
    fn binds_a_valid_proof_to_client_key_method_uri_and_nonce() {
        let proof = sign(&header(), &claims());
        let verified = verify(&proof, &context()).unwrap();
        assert_eq!(
            verified.thumbprint(),
            "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k"
        );
        assert_eq!(verified.proof_id(), "00000000-0000-4000-8000-000000000001");
        assert_eq!(verified.issued_at(), 1000);
        let mut bound = context();
        bound.expected_thumbprint = Some(verified.thumbprint());
        assert!(verify(&proof, &bound).is_ok());
        bound.expected_thumbprint = Some("other");
        assert!(verify(&proof, &bound).is_err());
        bound.expected_thumbprint = None;
        bound.expected_nonce = "other";
        assert!(verify(&proof, &bound).is_err());
        bound.expected_nonce = "trusted-nonce";
        bound.method = "GET";
        assert!(verify(&proof, &bound).is_err());
        bound.method = "POST";
        bound.target_uri = "https://other.example/token-issuances";
        assert!(verify(&proof, &bound).is_err());
        bound.target_uri = "https://region.example/token-issuances?secret=x";
        assert!(verify(&proof, &bound).is_err());
    }

    #[test]
    fn binds_access_token_hash_and_enforces_time_and_replay_id_shape() {
        let mut value = claims();
        value["ath"] = json!(URL_SAFE_NO_PAD.encode(Sha256::digest(b"synthetic-access")));
        let proof = sign(&header(), &value);
        let mut c = context();
        c.access_token = Some("synthetic-access");
        assert!(verify(&proof, &c).is_ok());
        c.access_token = Some("different");
        assert!(verify(&proof, &c).is_err());
        c.access_token = None;
        assert!(verify(&proof, &c).is_err());
        let proof = sign(&header(), &claims());
        let mut c = context();
        c.now = 1060;
        assert!(verify(&proof, &c).is_ok());
        c.now = 1061;
        assert!(verify(&proof, &c).is_err());
        c.now = 969;
        assert!(verify(&proof, &c).is_err());
        let mut bad = claims();
        bad["jti"] = json!("too-short");
        assert!(verify(&sign(&header(), &bad), &context()).is_err());
        bad["jti"] = json!(URL_SAFE_NO_PAD.encode([42u8; 12]));
        assert!(verify(&sign(&header(), &bad), &context()).is_ok());
    }

    #[test]
    fn rejects_private_or_weak_jwks_tampering_and_duplicate_claims() {
        let mut bad = header();
        bad["jwk"]["d"] = json!("private-material");
        assert!(verify(&sign(&bad, &claims()), &context()).is_err());
        bad = header();
        bad["jwk"]["x"] = json!(URL_SAFE_NO_PAD.encode([0u8; 32]));
        assert!(verify(&sign(&bad, &claims()), &context()).is_err());
        bad = header();
        bad["jku"] = json!("https://attacker.example/keys");
        assert!(verify(&sign(&bad, &claims()), &context()).is_err());
        bad = header();
        bad["alg"] = json!("HS256");
        assert!(verify(&sign(&bad, &claims()), &context()).is_err());
        let payload = claims().to_string();
        let duplicate = format!("{},\"htm\":\"POST\"}}", &payload[..payload.len() - 1]);
        assert!(verify(&sign_raw(&header().to_string(), &duplicate), &context()).is_err());
        let proof = sign(&header(), &claims());
        let (prefix, _) = proof.rsplit_once('.').unwrap();
        assert!(
            verify(
                &format!("{prefix}.{}", URL_SAFE_NO_PAD.encode([0u8; 64])),
                &context()
            )
            .is_err()
        );
        assert!(verify(&"x".repeat(MAX_PROOF + 1), &context()).is_err());
    }
}
