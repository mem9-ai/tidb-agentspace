//! Internal access-token signing. This is not an issuance endpoint or an authorization check.
//!
//! A trusted caller must first authenticate the principal, resolve the exact immutable grant
//! ceiling, verify installed policy and family state, enforce a rollback-protected clock, and
//! durably record issuance and replay outcomes. This module never contacts Global or Region.

use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use serde::Serialize;
use std::collections::BTreeSet;
use uuid::Uuid;
use workspace_contracts::{Result, ServiceError};

use crate::signed_access::IssuerKind;

const MAX_TOKEN_BYTES: usize = 8192;

pub struct SigningConfig {
    pub issuer: String,
    pub audience: String,
    pub environment: String,
    pub region: Option<String>,
    pub key_id: String,
    pub max_lifetime: i64,
    pub issuer_kind: IssuerKind,
}

/// The fields come only from already authenticated and locally authorized state. Scopes are
/// the immutable intersection selected by the caller, not untrusted requested permissions.
pub struct Issuance<'a> {
    pub workspace_id: &'a str,
    pub principal_id: &'a str,
    pub key_id: &'a str,
    pub key_version: u64,
    pub policy_generation: u64,
    pub grant_ref: &'a str,
    pub scopes: &'a [String],
    pub key_expires_at: i64,
    pub grant_expires_at: i64,
    pub family: Option<Family<'a>>,
}

pub struct Family<'a> {
    pub id: &'a str,
    pub epoch: u64,
    pub expires_at: i64,
}

/// A secret response. Do not log it or put it in URLs, audit records, or durable metadata.
pub struct IssuedAccess {
    pub token: String,
    pub token_id: String,
    pub expires_at: i64,
}

pub struct AccessSigner {
    config: SigningConfig,
    private: EncodingKey,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Claims<'a> {
    iss: &'a str,
    aud: &'a str,
    sub: &'a str,
    jti: &'a str,
    iat: i64,
    nbf: i64,
    exp: i64,
    environment: &'a str,
    workspace_id: &'a str,
    region_id: Option<&'a str>,
    key_id: &'a str,
    key_version: u64,
    policy_generation: u64,
    grant_ref: &'a str,
    scopes: &'a [String],
    family_id: Option<&'a str>,
    family_epoch: Option<u64>,
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

fn uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}

impl AccessSigner {
    /// Private bytes must be loaded from protected signer storage, not customer input.
    pub fn new(config: SigningConfig, private_der: &[u8]) -> Result<Self> {
        if config.issuer.is_empty()
            || config.issuer.len() > 512
            || config.audience.is_empty()
            || config.audience.len() > 512
            || !valid_id(&config.environment)
            || !valid_id(&config.key_id)
            || config.region.as_ref().is_some_and(|region| {
                !valid_id(region) || !region.starts_with("region:") || region.len() <= 7
            })
            || matches!(config.issuer_kind, IssuerKind::Region) && config.region.is_none()
            || !(1..=3600).contains(&config.max_lifetime)
            || private_der.len() > 4096
        {
            return Err(ServiceError::new(503, "ACCESS_SIGNER_INVALID"));
        }
        let private = EncodingKey::from_ed_der(private_der);
        jsonwebtoken::crypto::sign(
            b"workspace-access-signer-check-v1",
            &private,
            Algorithm::EdDSA,
        )
        .map_err(|_| ServiceError::new(503, "ACCESS_SIGNER_INVALID"))?;
        Ok(Self { config, private })
    }

    /// `now` must be provided by the same trusted clock used to enforce the Key and grant.
    /// The resulting credential is usable only after all other admission checks succeed.
    pub fn sign(&self, issuance: &Issuance<'_>, now: i64) -> Result<IssuedAccess> {
        let invalid = || ServiceError::new(400, "INVALID_ACCESS_ISSUANCE");
        let scopes: BTreeSet<_> = issuance.scopes.iter().collect();
        if now <= 0
            || !valid_id(issuance.workspace_id)
            || !valid_id(issuance.principal_id)
            || !uuid(issuance.key_id)
            || issuance.key_version == 0
            || issuance.policy_generation == 0
            || !valid_id(issuance.grant_ref)
            || issuance.scopes.is_empty()
            || issuance.scopes.len() > 64
            || scopes.len() != issuance.scopes.len()
            || issuance.scopes.iter().any(|s| s != "*" && !valid_id(s))
            || match (self.config.issuer_kind, &issuance.family) {
                (IssuerKind::Global, None) => false,
                (IssuerKind::Region, Some(family)) => !uuid(family.id) || family.epoch == 0,
                _ => true,
            }
        {
            return Err(invalid());
        }
        let mut expires_at = now
            .checked_add(self.config.max_lifetime)
            .ok_or_else(invalid)?
            .min(issuance.key_expires_at)
            .min(issuance.grant_expires_at);
        if let Some(family) = &issuance.family {
            expires_at = expires_at.min(family.expires_at);
        }
        if expires_at <= now {
            return Err(invalid());
        }
        let token_id = Uuid::new_v4().to_string();
        let claims = Claims {
            iss: &self.config.issuer,
            aud: &self.config.audience,
            sub: issuance.principal_id,
            jti: &token_id,
            iat: now,
            nbf: now,
            exp: expires_at,
            environment: &self.config.environment,
            workspace_id: issuance.workspace_id,
            region_id: self.config.region.as_deref(),
            key_id: issuance.key_id,
            key_version: issuance.key_version,
            policy_generation: issuance.policy_generation,
            grant_ref: issuance.grant_ref,
            scopes: issuance.scopes,
            family_id: issuance.family.as_ref().map(|family| family.id),
            family_epoch: issuance.family.as_ref().map(|family| family.epoch),
        };
        let mut header = Header::new(Algorithm::EdDSA);
        header.typ = Some(
            if self.config.region.is_some() {
                "workspace-region-access+jwt"
            } else {
                "workspace-global-access+jwt"
            }
            .into(),
        );
        header.kid = Some(self.config.key_id.clone());
        let token = encode(&header, &claims, &self.private)
            .map_err(|_| ServiceError::new(503, "ACCESS_SIGNING_UNAVAILABLE"))?;
        if token.len() > MAX_TOKEN_BYTES {
            return Err(invalid());
        }
        Ok(IssuedAccess {
            token,
            token_id,
            expires_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signed_access::{AccessTrust, AccessVerifier};
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use std::collections::BTreeMap;

    const PRIVATE: &str = "MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v_VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g";
    const PUBLIC: &str = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";

    fn config(issuer_kind: IssuerKind) -> SigningConfig {
        SigningConfig {
            issuer: "https://issuer.example".into(),
            audience: "region:a/audience".into(),
            environment: "test".into(),
            region: Some("region:a".into()),
            key_id: "signer-1".into(),
            max_lifetime: 900,
            issuer_kind,
        }
    }

    fn signer(issuer_kind: IssuerKind) -> AccessSigner {
        AccessSigner::new(
            config(issuer_kind),
            &URL_SAFE_NO_PAD.decode(PRIVATE).unwrap(),
        )
        .unwrap()
    }

    fn verifier(issuer_kind: IssuerKind) -> AccessVerifier {
        AccessVerifier::new(AccessTrust {
            issuer: "https://issuer.example".into(),
            audience: "region:a/audience".into(),
            environment: "test".into(),
            region: Some("region:a".into()),
            max_lifetime: 900,
            issuer_kind,
            keys: BTreeMap::from([(
                "signer-1".into(),
                URL_SAFE_NO_PAD.decode(PUBLIC).unwrap().try_into().unwrap(),
            )]),
        })
        .unwrap()
    }

    fn issuance(scopes: &[String]) -> Issuance<'_> {
        Issuance {
            workspace_id: "ws_test",
            principal_id: "principal-1",
            key_id: "00000000-0000-4000-8000-000000000002",
            key_version: 3,
            policy_generation: 4,
            grant_ref: "grant-1",
            scopes,
            key_expires_at: 2000,
            grant_expires_at: 1800,
            family: None,
        }
    }

    #[test]
    fn global_signing_is_scoped_and_limited_by_grant_and_key_expiry() {
        let scopes = vec!["files:read".into()];
        let mut issuance = issuance(&scopes);
        let token = signer(IssuerKind::Global).sign(&issuance, 1000).unwrap();
        assert_eq!(token.expires_at, 1800);
        let verified = verifier(IssuerKind::Global)
            .verify(&token.token, 1000)
            .unwrap();
        assert_eq!(verified.workspace_id(), "ws_test");
        assert_eq!(verified.key_version(), 3);
        assert_eq!(verified.scopes(), scopes);
        assert_eq!(verified.token_id(), token.token_id);
        assert!(
            verifier(IssuerKind::Global)
                .verify(&token.token, 1800)
                .is_err()
        );
        issuance.key_expires_at = 1000;
        assert!(signer(IssuerKind::Global).sign(&issuance, 1000).is_err());
        issuance.key_expires_at = 1500;
        assert_eq!(
            signer(IssuerKind::Global)
                .sign(&issuance, 1000)
                .unwrap()
                .expires_at,
            1500
        );
    }

    #[test]
    fn regional_signer_requires_family_and_never_outlives_it() {
        let scopes = vec!["files:read".into()];
        let mut issuance = issuance(&scopes);
        assert!(signer(IssuerKind::Region).sign(&issuance, 1000).is_err());
        issuance.family = Some(Family {
            id: "00000000-0000-4000-8000-000000000003",
            epoch: 7,
            expires_at: 1200,
        });
        assert!(signer(IssuerKind::Global).sign(&issuance, 1000).is_err());
        let token = signer(IssuerKind::Region).sign(&issuance, 1000).unwrap();
        assert_eq!(token.expires_at, 1200);
        let verified = verifier(IssuerKind::Region)
            .verify(&token.token, 1000)
            .unwrap();
        assert_eq!(verified.family_id(), issuance.family.as_ref().map(|f| f.id));
        assert_eq!(verified.family_epoch(), Some(7));
        assert!(
            verifier(IssuerKind::Global)
                .verify(&token.token, 1000)
                .is_err()
        );
        issuance.family.as_mut().unwrap().expires_at = 1000;
        assert!(signer(IssuerKind::Region).sign(&issuance, 1000).is_err());
    }

    #[test]
    fn malformed_signer_configuration_and_scope_sets_fail_closed() {
        assert!(AccessSigner::new(config(IssuerKind::Global), &[]).is_err());
        let mut wrong = config(IssuerKind::Region);
        wrong.region = None;
        assert!(AccessSigner::new(wrong, &URL_SAFE_NO_PAD.decode(PRIVATE).unwrap()).is_err());
        for scopes in [
            vec![],
            vec!["bad scope".into()],
            vec!["files:read".into(), "files:read".into()],
        ] {
            assert!(
                signer(IssuerKind::Global)
                    .sign(&issuance(&scopes), 1000)
                    .is_err()
            );
        }
    }

    #[test]
    fn global_token_is_rejected_by_a_regional_audience() {
        let mut signing = config(IssuerKind::Global);
        signing.audience = "global".into();
        signing.region = None;
        let signer = AccessSigner::new(signing, &URL_SAFE_NO_PAD.decode(PRIVATE).unwrap()).unwrap();
        let scopes = vec!["resources:read".into()];
        let token = signer.sign(&issuance(&scopes), 1000).unwrap();
        let global = AccessVerifier::new(AccessTrust {
            issuer: "https://issuer.example".into(),
            audience: "global".into(),
            environment: "test".into(),
            region: None,
            max_lifetime: 900,
            issuer_kind: IssuerKind::Global,
            keys: BTreeMap::from([(
                "signer-1".into(),
                URL_SAFE_NO_PAD.decode(PUBLIC).unwrap().try_into().unwrap(),
            )]),
        })
        .unwrap();
        assert!(global.verify(&token.token, 1000).is_ok());
        assert!(
            verifier(IssuerKind::Global)
                .verify(&token.token, 1000)
                .is_err()
        );
    }
}
