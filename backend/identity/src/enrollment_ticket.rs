//! Local verification of short-lived, Global-signed Region refresh-enrollment tickets.
//!
//! A verified ticket alone grants no access and is not consumed here. Region must atomically
//! consume its ID and a matching client proof with family creation, enforce the installed
//! Key and immutable grant ceiling, and retain replay evidence before returning a credential.
//! Trust material and a rollback-protected clock are regional dependencies, not Global calls.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;
use workspace_contracts::{Result, ServiceError};

const TYPE: &str = "workspace-region-enrollment+jwt";
const MAX_TICKET: usize = 16 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Header {
    typ: String,
    alg: String,
    kid: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Claims {
    iss: String,
    aud: String,
    environment: String,
    iat: i64,
    nbf: i64,
    exp: i64,
    jti: String,
    workspace_id: String,
    region_id: String,
    key_id: String,
    key_version: u64,
    policy_generation: u64,
    principal_id: String,
    grant_ref: String,
    ceiling_ref: String,
    client_thumbprint: String,
    nonce: String,
    key_expires_at: i64,
}

pub struct TicketTrust {
    pub issuer: String,
    pub audience: String,
    pub environment: String,
    pub region_id: String,
    pub keys: BTreeMap<String, [u8; 32]>,
}

pub struct TicketVerifier {
    trust: TicketTrust,
}

/// Configuration is fixed per Region, environment and audience. The private seed must come
/// from protected Global signer storage; it is never supplied by a customer.
pub struct TicketSigningConfig {
    pub issuer: String,
    pub audience: String,
    pub environment: String,
    pub region_id: String,
    pub key_id: String,
}

pub struct TicketSigner {
    config: TicketSigningConfig,
    key: SigningKey,
}

/// The caller must authorize the Key and prove the exact policy and grant generation are
/// already applied in the Region before requesting a ticket. These fields are not proof.
pub struct TicketIssuance<'a> {
    pub workspace_id: &'a str,
    pub key_id: &'a str,
    pub key_version: u64,
    pub policy_generation: u64,
    pub principal_id: &'a str,
    pub grant_ref: &'a str,
    pub ceiling_ref: &'a str,
    pub client_thumbprint: &'a str,
    pub key_expires_at: i64,
}

/// Short-lived secret for one Region and client proof; never log or place in a URL.
pub struct IssuedTicket {
    pub ticket: String,
    pub nonce: String,
    pub ticket_id: String,
    pub expires_at: i64,
}

/// This value can only be obtained after signature and binding verification. It does not
/// imply a consumed ticket, a valid client proof, current policy, or authorization.
pub struct VerifiedTicket {
    claims: Claims,
}

impl VerifiedTicket {
    pub fn ticket_id(&self) -> &str {
        &self.claims.jti
    }
    pub fn workspace_id(&self) -> &str {
        &self.claims.workspace_id
    }
    pub fn region_id(&self) -> &str {
        &self.claims.region_id
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
    pub fn principal_id(&self) -> &str {
        &self.claims.principal_id
    }
    pub fn grant_ref(&self) -> &str {
        &self.claims.grant_ref
    }
    pub fn ceiling_ref(&self) -> &str {
        &self.claims.ceiling_ref
    }
    pub fn client_thumbprint(&self) -> &str {
        &self.claims.client_thumbprint
    }
    pub fn nonce(&self) -> &str {
        &self.claims.nonce
    }
    pub fn issued_at(&self) -> i64 {
        self.claims.iat
    }
    pub fn not_before(&self) -> i64 {
        self.claims.nbf
    }
    pub fn expires_at(&self) -> i64 {
        self.claims.exp
    }
    pub fn key_expires_at(&self) -> i64 {
        self.claims.key_expires_at
    }
}

fn denied() -> ServiceError {
    ServiceError::new(401, "INVALID_ENROLLMENT_TICKET")
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
    Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}
fn digest_string(value: &str) -> bool {
    URL_SAFE_NO_PAD
        .decode(value)
        .is_ok_and(|bytes| bytes.len() == 32 && URL_SAFE_NO_PAD.encode(bytes) == value)
}

impl TicketSigner {
    pub fn from_pkcs8(config: TicketSigningConfig, der: &[u8]) -> Result<Self> {
        use ed25519_dalek::pkcs8::DecodePrivateKey;
        let key = SigningKey::from_pkcs8_der(der)
            .map_err(|_| ServiceError::new(503, "TICKET_SIGNER_INVALID"))?;
        Self::new(config, &key.to_bytes())
    }
    pub fn new(config: TicketSigningConfig, seed: &[u8; 32]) -> Result<Self> {
        if config.issuer.is_empty()
            || config.issuer.len() > 512
            || config.audience.is_empty()
            || config.audience.len() > 512
            || !id(&config.environment)
            || !id(&config.region_id)
            || !config.region_id.starts_with("region:")
            || config.region_id.len() <= 7
            || !id(&config.key_id)
        {
            return Err(ServiceError::new(503, "TICKET_SIGNER_INVALID"));
        }
        Ok(Self {
            config,
            key: SigningKey::from_bytes(seed),
        })
    }

    /// No online Region lookup is made here. A caller must use trusted time and a durable,
    /// current Region-applied receipt before invoking this signing primitive.
    pub fn sign(&self, request: &TicketIssuance<'_>, now: i64) -> Result<IssuedTicket> {
        let invalid = || ServiceError::new(400, "INVALID_TICKET_ISSUANCE");
        if now <= 0
            || !id(request.workspace_id)
            || !uuid(request.key_id)
            || request.key_version == 0
            || request.policy_generation == 0
            || !id(request.principal_id)
            || !id(request.grant_ref)
            || !id(request.ceiling_ref)
            || !digest_string(request.client_thumbprint)
        {
            return Err(invalid());
        }
        let expires_at = now
            .checked_add(300)
            .ok_or_else(invalid)?
            .min(request.key_expires_at);
        if expires_at <= now {
            return Err(invalid());
        }
        let mut nonce = [0; 32];
        getrandom::fill(&mut nonce).map_err(|_| ServiceError::new(503, "RANDOM_UNAVAILABLE"))?;
        let nonce = URL_SAFE_NO_PAD.encode(nonce);
        let ticket_id = Uuid::new_v4().to_string();
        let header = Header {
            typ: TYPE.into(),
            alg: "EdDSA".into(),
            kid: self.config.key_id.clone(),
        };
        let claims = Claims {
            iss: self.config.issuer.clone(),
            aud: self.config.audience.clone(),
            environment: self.config.environment.clone(),
            iat: now,
            nbf: now,
            exp: expires_at,
            jti: ticket_id.clone(),
            workspace_id: request.workspace_id.into(),
            region_id: self.config.region_id.clone(),
            key_id: request.key_id.into(),
            key_version: request.key_version,
            policy_generation: request.policy_generation,
            principal_id: request.principal_id.into(),
            grant_ref: request.grant_ref.into(),
            ceiling_ref: request.ceiling_ref.into(),
            client_thumbprint: request.client_thumbprint.into(),
            nonce: nonce.clone(),
            key_expires_at: request.key_expires_at,
        };
        let header = serde_json::to_vec(&header).map_err(|_| invalid())?;
        let payload = serde_json::to_vec(&claims).map_err(|_| invalid())?;
        let message = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header),
            URL_SAFE_NO_PAD.encode(payload)
        );
        let signature = self.key.sign(message.as_bytes());
        let ticket = format!("{message}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()));
        if ticket.len() > MAX_TICKET {
            return Err(invalid());
        }
        Ok(IssuedTicket {
            ticket,
            nonce,
            ticket_id,
            expires_at,
        })
    }
}

impl TicketVerifier {
    pub fn new(trust: TicketTrust) -> Result<Self> {
        if trust.issuer.is_empty()
            || trust.issuer.len() > 512
            || trust.audience.is_empty()
            || trust.audience.len() > 512
            || !id(&trust.environment)
            || !id(&trust.region_id)
            || !trust.region_id.starts_with("region:")
            || trust.region_id.len() <= 7
            || trust.keys.is_empty()
            || trust.keys.len() > 32
            || trust.keys.keys().any(|key| !id(key))
            || trust
                .keys
                .values()
                .any(|key| !VerifyingKey::from_bytes(key).is_ok_and(|key| !key.is_weak()))
        {
            return Err(ServiceError::new(503, "TICKET_TRUST_INVALID"));
        }
        Ok(Self { trust })
    }

    /// `now` must come from a trusted regional clock with independent rollback protection.
    pub fn verify(&self, ticket: &str, now: i64) -> Result<VerifiedTicket> {
        if ticket.len() > MAX_TICKET || now <= 0 {
            return Err(denied());
        }
        let mut segments = ticket.split('.');
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
        let header_bytes = URL_SAFE_NO_PAD.decode(header_part).map_err(|_| denied())?;
        if URL_SAFE_NO_PAD.encode(&header_bytes) != header_part {
            return Err(denied());
        }
        let header: Header = serde_json::from_slice(&header_bytes).map_err(|_| denied())?;
        if header.typ != TYPE || header.alg != "EdDSA" || !id(&header.kid) {
            return Err(denied());
        }
        let bytes = self.trust.keys.get(&header.kid).ok_or_else(denied)?;
        let key = VerifyingKey::from_bytes(bytes).map_err(|_| denied())?;
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
        if claims.iss != self.trust.issuer
            || claims.aud != self.trust.audience
            || claims.environment != self.trust.environment
            || claims.region_id != self.trust.region_id
            || !uuid(&claims.jti)
            || !uuid(&claims.key_id)
            || !id(&claims.workspace_id)
            || !id(&claims.principal_id)
            || !id(&claims.grant_ref)
            || !id(&claims.ceiling_ref)
            || claims.key_version == 0
            || claims.policy_generation == 0
            || !digest_string(&claims.client_thumbprint)
            || !digest_string(&claims.nonce)
            || claims.iat <= 0
            || claims.iat > claims.nbf
            || claims.nbf > now
            || claims.exp <= now
            || claims.exp <= claims.iat
            || claims.exp > claims.key_expires_at
            || claims.exp.checked_sub(claims.iat).is_none_or(|v| v > 300)
        {
            return Err(denied());
        }
        Ok(VerifiedTicket { claims })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{Algorithm, EncodingKey};
    use serde_json::{Value, json};

    const PRIVATE: &str = "MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v_VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g";
    const PUBLIC: &str = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";

    fn trust() -> TicketTrust {
        TicketTrust {
            issuer: "https://global.example".into(),
            audience: "region:a/enrollment".into(),
            environment: "test".into(),
            region_id: "region:a".into(),
            keys: BTreeMap::from([(
                "key-1".into(),
                URL_SAFE_NO_PAD.decode(PUBLIC).unwrap().try_into().unwrap(),
            )]),
        }
    }
    fn header() -> Value {
        json!({"typ":TYPE,"alg":"EdDSA","kid":"key-1"})
    }
    fn claims() -> Value {
        json!({"iss":"https://global.example", "aud":"region:a/enrollment", "environment":"test", "iat":1000,"nbf":1000,"exp":1300,
            "jti":"00000000-0000-4000-8000-000000000001", "workspaceId":"ws_agentlab", "regionId":"region:a",
            "keyId":"00000000-0000-4000-8000-000000000002", "keyVersion":1, "policyGeneration":1,
            "principalId":"principal-1", "grantRef":"grant-1", "ceilingRef":"ceiling-1", "clientThumbprint":"kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k",
            "nonce":URL_SAFE_NO_PAD.encode([9u8;32]), "keyExpiresAt":2000})
    }
    fn sign_raw(header: &str, payload: &str) -> String {
        let message = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header),
            URL_SAFE_NO_PAD.encode(payload)
        );
        let private = URL_SAFE_NO_PAD.decode(PRIVATE).unwrap();
        let signature = jsonwebtoken::crypto::sign(
            message.as_bytes(),
            &EncodingKey::from_ed_der(&private),
            Algorithm::EdDSA,
        )
        .unwrap();
        format!("{message}.{signature}")
    }
    fn sign(header: &Value, claims: &Value) -> String {
        sign_raw(&header.to_string(), &claims.to_string())
    }

    #[test]
    fn signed_enrollment_is_bound_to_region_client_and_key_lifetime() {
        let private = URL_SAFE_NO_PAD.decode(PRIVATE).unwrap();
        let seed: [u8; 32] = private[private.len() - 32..].try_into().unwrap();
        let signer = TicketSigner::new(
            TicketSigningConfig {
                issuer: "https://global.example".into(),
                audience: "region:a/enrollment".into(),
                environment: "test".into(),
                region_id: "region:a".into(),
                key_id: "key-1".into(),
            },
            &seed,
        )
        .unwrap();
        let mut input = TicketIssuance {
            workspace_id: "ws_agentlab",
            key_id: "00000000-0000-4000-8000-000000000002",
            key_version: 1,
            policy_generation: 1,
            principal_id: "principal-1",
            grant_ref: "grant-1",
            ceiling_ref: "ceiling-1",
            client_thumbprint: "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k",
            key_expires_at: 1100,
        };
        let issued = signer.sign(&input, 1000).unwrap();
        assert_eq!(issued.expires_at, 1100);
        let verifier = TicketVerifier::new(trust()).unwrap();
        let verified = verifier.verify(&issued.ticket, 1000).unwrap();
        assert_eq!(verified.ticket_id(), issued.ticket_id);
        assert_eq!(verified.nonce(), issued.nonce);
        assert_eq!(verified.client_thumbprint(), input.client_thumbprint);
        assert!(verifier.verify(&issued.ticket, 1100).is_err());
        let another = signer.sign(&input, 1000).unwrap();
        assert_ne!(issued.nonce, another.nonce);
        assert_ne!(issued.ticket_id, another.ticket_id);
        input.key_expires_at = 1000;
        assert!(signer.sign(&input, 1000).is_err());
        input.key_expires_at = 2000;
        input.client_thumbprint = "unbound-client";
        assert!(signer.sign(&input, 1000).is_err());
    }

    #[test]
    fn ticket_is_bound_to_global_issuer_region_key_and_client() {
        let verifier = TicketVerifier::new(trust()).unwrap();
        let good = sign(&header(), &claims());
        let ticket = verifier.verify(&good, 1000).unwrap();
        assert_eq!(ticket.workspace_id(), "ws_agentlab");
        assert_eq!(ticket.region_id(), "region:a");
        assert_eq!(ticket.key_version(), 1);
        assert_eq!(
            ticket.client_thumbprint(),
            "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k"
        );
        assert!(verifier.verify(&good, 999).is_err());
        assert!(verifier.verify(&good, 1300).is_err());
        for (field, value) in [
            ("iss", json!("https://other.example")),
            ("aud", json!("region:b/enrollment")),
            ("regionId", json!("region:b")),
            ("environment", json!("production")),
            ("workspaceId", json!("../foreign")),
            ("keyId", json!("bad")),
            ("keyVersion", json!(0)),
            ("policyGeneration", json!(0)),
            ("clientThumbprint", json!("bad")),
            ("nonce", json!("bad")),
            ("exp", json!(1301)),
            ("keyExpiresAt", json!(1299)),
        ] {
            let mut bad = claims();
            bad[field] = value;
            assert!(
                verifier.verify(&sign(&header(), &bad), 1000).is_err(),
                "{field}"
            );
        }
    }

    #[test]
    fn rejects_weak_trust_untrusted_headers_duplicates_and_signature_changes() {
        let mut weak = trust();
        weak.keys.insert("bad".into(), [0u8; 32]);
        assert!(TicketVerifier::new(weak).is_err());
        let verifier = TicketVerifier::new(trust()).unwrap();
        let mut untrusted = header();
        untrusted["jku"] = json!("https://attacker.example/keys");
        assert!(verifier.verify(&sign(&untrusted, &claims()), 1000).is_err());
        let mut algorithm = header();
        algorithm["alg"] = json!("HS256");
        assert!(verifier.verify(&sign(&algorithm, &claims()), 1000).is_err());
        let payload = claims().to_string();
        let duplicate = format!(
            "{},\"aud\":\"region:a/enrollment\"}}",
            &payload[..payload.len() - 1]
        );
        assert!(
            verifier
                .verify(&sign_raw(&header().to_string(), &duplicate), 1000)
                .is_err()
        );
        let good = sign(&header(), &claims());
        let (prefix, _) = good.rsplit_once('.').unwrap();
        assert!(
            verifier
                .verify(
                    &format!("{prefix}.{}", URL_SAFE_NO_PAD.encode([0u8; 64])),
                    1000
                )
                .is_err()
        );
        assert!(verifier.verify(&"x".repeat(MAX_TICKET + 1), 1000).is_err());
    }
}
