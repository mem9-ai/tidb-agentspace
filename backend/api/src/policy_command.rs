//! Local verification and application of Global-signed Region Key-policy commands.
//!
//! This module does not establish a control transport. A deployment must authenticate the
//! Global service with pinned TLS 1.3 mTLS, prevent Region-to-Global calls, and fence stale
//! serving nodes before acknowledging a policy. Trust and a rollback-protected regional clock
//! must be installed independently. These primitives are not a public HTTP endpoint.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{
    Algorithm, DecodingKey, EncodingKey, Header as JwtHeader, Validation, decode, encode,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;
use workspace_contracts::{Result, ServiceError};
use workspace_identity::regional_key_policy::{KeyPolicies, KeyPolicy};

const COMMAND_TYPE: &str = "workspace-region-key-policy+jwt";
const MAX_COMMAND: usize = 16 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    alg: String,
    typ: String,
    kid: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Claims {
    iss: String,
    aud: String,
    environment: String,
    iat: i64,
    nbf: i64,
    exp: i64,
    jti: String,
    policy: KeyPolicy,
}

pub struct PolicyTrust {
    pub issuer: String,
    pub audience: String,
    pub environment: String,
    pub region_id: String,
    pub keys: BTreeMap<String, [u8; 32]>,
}

pub struct PolicyCommandVerifier {
    trust: PolicyTrust,
}

/// Evidence that one Region Meta durably stored a command. On replay a newer policy may
/// already supersede it. This does not prove current state or that revocation is effective.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyReceipt {
    pub command_id: String,
    pub workspace_id: String,
    pub region_id: String,
    pub key_id: String,
    pub key_version: u64,
    pub policy_generation: u64,
}

pub struct PolicySignerConfig {
    pub issuer: String,
    pub audience: String,
    pub environment: String,
    pub region_id: String,
    pub key_id: String,
}

/// Internal signing primitive. Global must authorize the Key, its exact policy and the
/// Region placement before signing, and obtain private material from protected storage.
/// This type does not perform delivery, persist intent or acknowledge regional application.
pub struct PolicyCommandSigner {
    config: PolicySignerConfig,
    private: EncodingKey,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.:".contains(&b))
}

fn denied() -> ServiceError {
    ServiceError::new(401, "INVALID_POLICY_COMMAND")
}

impl PolicyCommandSigner {
    pub fn new(config: PolicySignerConfig, private_der: &[u8]) -> Result<Self> {
        if config.issuer.is_empty()
            || config.issuer.len() > 512
            || config.audience.is_empty()
            || config.audience.len() > 512
            || !valid_id(&config.environment)
            || !valid_id(&config.region_id)
            || !config.region_id.starts_with("region:")
            || config.region_id.len() <= 7
            || !valid_id(&config.key_id)
            || private_der.len() > 4096
        {
            return Err(ServiceError::new(503, "POLICY_SIGNER_INVALID"));
        }
        let private = EncodingKey::from_ed_der(private_der);
        jsonwebtoken::crypto::sign(
            b"workspace-region-policy-key-check-v1",
            &private,
            Algorithm::EdDSA,
        )
        .map_err(|_| ServiceError::new(503, "POLICY_SIGNER_INVALID"))?;
        Ok(Self { config, private })
    }

    /// A retry may issue a fresh short-lived envelope for the same immutable command ID.
    /// Durable command receipts and conflict checks remain the Region's responsibility.
    pub fn sign(&self, policy: &KeyPolicy, command_id: &str, now: i64) -> Result<String> {
        let valid_jti = Uuid::parse_str(command_id).is_ok_and(|id| id.to_string() == command_id);
        let valid_key =
            Uuid::parse_str(&policy.key_id).is_ok_and(|id| id.to_string() == policy.key_id);
        if !valid_jti
            || !valid_key
            || now <= 0
            || policy.region_id != self.config.region_id
            || !valid_id(&policy.workspace_id)
            || !valid_id(&policy.principal_id)
            || !valid_id(&policy.grant_ref)
            || policy.key_version == 0
            || policy.policy_generation == 0
            || policy.expires_at <= 0
        {
            return Err(ServiceError::new(400, "INVALID_POLICY_COMMAND"));
        }
        let expires = now
            .checked_add(300)
            .ok_or_else(|| ServiceError::new(503, "CLOCK_UNAVAILABLE"))?;
        let claims = Claims {
            iss: self.config.issuer.clone(),
            aud: self.config.audience.clone(),
            environment: self.config.environment.clone(),
            iat: now,
            nbf: now,
            exp: expires,
            jti: command_id.into(),
            policy: policy.clone(),
        };
        let mut header = JwtHeader::new(Algorithm::EdDSA);
        header.typ = Some(COMMAND_TYPE.into());
        header.kid = Some(self.config.key_id.clone());
        let command = encode(&header, &claims, &self.private)
            .map_err(|_| ServiceError::new(503, "POLICY_SIGNING_UNAVAILABLE"))?;
        if command.len() > MAX_COMMAND {
            return Err(ServiceError::new(400, "INVALID_POLICY_COMMAND"));
        }
        Ok(command)
    }
}

impl PolicyCommandVerifier {
    pub fn new(trust: PolicyTrust) -> Result<Self> {
        if trust.issuer.is_empty()
            || trust.issuer.len() > 512
            || trust.audience.is_empty()
            || trust.audience.len() > 512
            || !valid_id(&trust.environment)
            || !valid_id(&trust.region_id)
            || !trust.region_id.starts_with("region:")
            || trust.region_id.len() <= 7
            || trust.keys.is_empty()
            || trust.keys.len() > 32
            || trust.keys.keys().any(|kid| !valid_id(kid))
            || trust.keys.values().any(|key| {
                !ed25519_dalek::VerifyingKey::from_bytes(key).is_ok_and(|key| !key.is_weak())
            })
        {
            return Err(ServiceError::new(503, "POLICY_TRUST_INVALID"));
        }
        Ok(Self { trust })
    }

    fn verify(&self, command: &str, now: i64) -> Result<Claims> {
        if command.len() > MAX_COMMAND || now <= 0 {
            return Err(denied());
        }
        let mut segments = command.split('.');
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
        let bytes = URL_SAFE_NO_PAD.decode(header).map_err(|_| denied())?;
        let header: Header = serde_json::from_slice(&bytes).map_err(|_| denied())?;
        if header.alg != "EdDSA" || header.typ != COMMAND_TYPE || !valid_id(&header.kid) {
            return Err(denied());
        }
        let key = self.trust.keys.get(&header.kid).ok_or_else(denied)?;
        let mut validation = Validation::new(Algorithm::EdDSA);
        validation.validate_exp = false;
        validation.validate_nbf = false;
        validation.validate_aud = false;
        validation.required_spec_claims.clear();
        let claims = decode::<Claims>(command, &DecodingKey::from_ed_der(key), &validation)
            .map_err(|_| denied())?
            .claims;
        let valid_jti = Uuid::parse_str(&claims.jti).is_ok_and(|id| id.to_string() == claims.jti);
        if claims.iss != self.trust.issuer
            || claims.aud != self.trust.audience
            || claims.environment != self.trust.environment
            || claims.policy.region_id != self.trust.region_id
            || !valid_jti
            || claims.iat <= 0
            || claims.iat > claims.nbf
            || claims.nbf > now
            || claims.exp <= now
            || claims.exp <= claims.iat
            || claims.exp.checked_sub(claims.iat).is_none_or(|v| v > 300)
        {
            return Err(denied());
        }
        Ok(claims)
    }

    /// The calling transport must first authenticate Global and its exact deployment identity,
    /// and bind any outer route's Workspace and Region to this signed command. A signed
    /// command alone is not authorization to expose this method publicly.
    pub async fn apply(
        &self,
        command: &str,
        now: i64,
        policies: &KeyPolicies,
    ) -> Result<PolicyReceipt> {
        let claims = self.verify(command, now)?;
        policies.install(&claims.policy, &claims.jti).await?;
        Ok(PolicyReceipt {
            command_id: claims.jti,
            workspace_id: claims.policy.workspace_id,
            region_id: claims.policy.region_id,
            key_id: claims.policy.key_id,
            key_version: claims.policy.key_version,
            policy_generation: claims.policy.policy_generation,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{EncodingKey, Header as JwtHeader, encode};
    use serde_json::{Value, json};
    use std::sync::{Arc, Mutex};
    use workspace_contracts::{Call, MetaRequest, Metadata};
    use workspace_identity::regional_key_policy::VerifiedKeyBinding;

    #[derive(Default)]
    struct TestMeta(Mutex<BTreeMap<String, Value>>);
    impl Metadata for TestMeta {
        fn health(&self) -> Call<'_> {
            Box::pin(async { Ok(json!({"authorityId":"region:a","capabilities":["recordsV1"]})) })
        }
        fn execute(&self, request: MetaRequest) -> Call<'_> {
            Box::pin(async move {
                let mut records = self.0.lock().unwrap();
                match request {
                    MetaRequest::Get { keys, .. } => {
                        let result: serde_json::Map<String, Value> = keys
                            .into_iter()
                            .map(|key| {
                                let value = records.get(&key).cloned().unwrap_or(Value::Null);
                                (key, value)
                            })
                            .collect();
                        Ok(json!({"records":result}))
                    }
                    MetaRequest::Commit { changes, .. } => {
                        for change in &changes {
                            let key = change["key"].as_str().unwrap();
                            let actual = records
                                .get(key)
                                .map(|v| v["version"].clone())
                                .unwrap_or(Value::Null);
                            if actual != change["expectedVersion"] {
                                return Err(ServiceError::new(409, "META_CONFLICT"));
                            }
                        }
                        for change in changes {
                            let key = change["key"].as_str().unwrap().to_owned();
                            records.insert(key, json!({"version":Uuid::new_v4().to_string(),"value":change["value"]}));
                        }
                        Ok(json!({"committed":true}))
                    }
                    _ => Err(ServiceError::new(400, "META_INVALID_REQUEST")),
                }
            })
        }
    }

    fn private_der() -> Vec<u8> {
        URL_SAFE_NO_PAD
            .decode("MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v_VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g")
            .unwrap()
    }
    fn private_key() -> EncodingKey {
        EncodingKey::from_ed_der(&private_der())
    }
    fn verifier() -> PolicyCommandVerifier {
        let bytes = URL_SAFE_NO_PAD
            .decode("11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo")
            .unwrap();
        PolicyCommandVerifier::new(PolicyTrust {
            issuer: "https://global.example".into(),
            audience: "region:a/control".into(),
            environment: "test".into(),
            region_id: "region:a".into(),
            keys: BTreeMap::from([("key-1".into(), bytes.try_into().unwrap())]),
        })
        .unwrap()
    }
    fn claims() -> Value {
        json!({"iss":"https://global.example", "aud":"region:a/control", "environment":"test", "iat":1000, "nbf":1000, "exp":1300, "jti":"00000000-0000-4000-8000-000000000001", "policy":{
            "workspaceId":"ws_agentlab", "regionId":"region:a", "keyId":"00000000-0000-4000-8000-000000000002", "principalId":"principal-1", "keyVersion":1, "policyGeneration":1, "grantRef":"grant-1", "expiresAt":2000, "revoked":false
        }})
    }
    fn sign(value: &Value, kid: &str, typ: &str) -> String {
        let mut header = JwtHeader::new(Algorithm::EdDSA);
        header.typ = Some(typ.into());
        header.kid = Some(kid.into());
        encode(&header, value, &private_key()).unwrap()
    }
    fn sign_raw(header: &str, payload: &str) -> String {
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
    fn global_signer_mints_short_lived_envelopes_bound_to_the_selected_region() {
        assert!(
            PolicyCommandVerifier::new(PolicyTrust {
                issuer: "https://global.example".into(),
                audience: "region:a/control".into(),
                environment: "test".into(),
                region_id: "region:a".into(),
                keys: BTreeMap::from([("key-1".into(), [0u8; 32])]),
            })
            .is_err()
        );
        let config = || PolicySignerConfig {
            issuer: "https://global.example".into(),
            audience: "region:a/control".into(),
            environment: "test".into(),
            region_id: "region:a".into(),
            key_id: "key-1".into(),
        };
        assert!(PolicyCommandSigner::new(config(), b"invalid private key").is_err());
        let signer = PolicyCommandSigner::new(config(), &private_der()).unwrap();
        let mut policy: KeyPolicy = serde_json::from_value(claims()["policy"].clone()).unwrap();
        let command = signer
            .sign(&policy, "00000000-0000-4000-8000-000000000001", 1000)
            .unwrap();
        assert!(verifier().verify(&command, 1000).is_ok());
        assert!(verifier().verify(&command, 1300).is_err());
        assert!(signer.sign(&policy, "invalid", 1000).is_err());
        assert!(
            signer
                .sign(&policy, "00000000-0000-4000-8000-000000000001", 0)
                .is_err()
        );
        policy.region_id = "region:b".into();
        assert!(
            signer
                .sign(&policy, "00000000-0000-4000-8000-000000000001", 1000)
                .is_err()
        );
    }

    #[test]
    fn rejects_wrong_issuer_region_environment_type_and_expiry() {
        let verifier = verifier();
        let good = sign(&claims(), "key-1", COMMAND_TYPE);
        assert!(verifier.verify(&good, 1000).is_ok());
        assert!(verifier.verify(&good, 999).is_err());
        assert!(verifier.verify(&good, 1300).is_err());
        assert!(
            verifier
                .verify(&sign(&claims(), "unknown", COMMAND_TYPE), 1000)
                .is_err()
        );
        assert!(
            verifier
                .verify(
                    &sign(&claims(), "key-1", "workspace-region-access+jwt"),
                    1000
                )
                .is_err()
        );
        for (field, value) in [
            ("iss", json!("https://attacker.example")),
            ("aud", json!("region:b/control")),
            ("environment", json!("production")),
            ("jti", json!("bad-id")),
            ("exp", json!(1301)),
        ] {
            let mut bad = claims();
            bad[field] = value;
            assert!(
                verifier
                    .verify(&sign(&bad, "key-1", COMMAND_TYPE), 1000)
                    .is_err(),
                "{field}"
            );
        }
        let mut bad = claims();
        bad["policy"]["regionId"] = json!("region:b");
        assert!(
            verifier
                .verify(&sign(&bad, "key-1", COMMAND_TYPE), 1000)
                .is_err()
        );
        let (prefix, _) = good.rsplit_once('.').unwrap();
        assert!(
            verifier
                .verify(
                    &format!("{prefix}.{}", URL_SAFE_NO_PAD.encode([0u8; 64])),
                    1000
                )
                .is_err()
        );
        assert!(verifier.verify(&"x".repeat(MAX_COMMAND + 1), 1000).is_err());
        let payload = serde_json::to_string(&claims()).unwrap();
        let duplicate = format!(
            "{},\"aud\":\"region:a/control\"}}",
            &payload[..payload.len() - 1]
        );
        let valid_header =
            r#"{"alg":"EdDSA","typ":"workspace-region-key-policy+jwt","kid":"key-1"}"#;
        let untrusted_header = r#"{"alg":"EdDSA","typ":"workspace-region-key-policy+jwt","kid":"key-1","jku":"https://attacker.example/keys"}"#;
        let wrong_algorithm =
            r#"{"alg":"HS256","typ":"workspace-region-key-policy+jwt","kid":"key-1"}"#;
        assert!(
            verifier
                .verify(&sign_raw(valid_header, &duplicate), 1000)
                .is_err()
        );
        assert!(
            verifier
                .verify(&sign_raw(untrusted_header, &payload), 1000)
                .is_err()
        );
        assert!(
            verifier
                .verify(&sign_raw(wrong_algorithm, &payload), 1000)
                .is_err()
        );
    }

    #[tokio::test]
    async fn only_valid_commands_install_and_replay_does_not_revert_local_floor() {
        let metadata = Arc::new(TestMeta::default());
        let policies = KeyPolicies::open(metadata.clone(), "region:a")
            .await
            .unwrap();
        let verifier = verifier();
        let mut first = claims();
        let first_token = sign(&first, "key-1", COMMAND_TYPE);
        let denied = sign(&first, "unknown", COMMAND_TYPE);
        assert!(verifier.apply(&denied, 1000, &policies).await.is_err());
        assert!(metadata.0.lock().unwrap().is_empty());
        verifier.apply(&first_token, 1000, &policies).await.unwrap();
        verifier.apply(&first_token, 1000, &policies).await.unwrap();
        first["policy"]["keyVersion"] = json!(2);
        first["policy"]["policyGeneration"] = json!(2);
        assert!(
            verifier
                .apply(&sign(&first, "key-1", COMMAND_TYPE), 1000, &policies)
                .await
                .is_err()
        );
        first["jti"] = json!("00000000-0000-4000-8000-000000000003");
        verifier
            .apply(&sign(&first, "key-1", COMMAND_TYPE), 1000, &policies)
            .await
            .unwrap();
        verifier.apply(&first_token, 1000, &policies).await.unwrap();
        let binding = |version| VerifiedKeyBinding {
            workspace_id: "ws_agentlab",
            region_id: "region:a",
            key_id: "00000000-0000-4000-8000-000000000002",
            principal_id: "principal-1",
            key_version: version,
            policy_generation: version,
            expires_at: 1900,
            not_before: 1000,
        };
        assert!(
            policies
                .check_token_key_binding(&binding(1), 1100)
                .await
                .is_err()
        );
        assert_eq!(
            policies
                .check_token_key_binding(&binding(2), 1100)
                .await
                .unwrap(),
            "grant-1"
        );
    }
}
