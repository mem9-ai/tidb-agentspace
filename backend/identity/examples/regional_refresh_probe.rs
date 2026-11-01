//! Isolated test fixture with a synthetic issuer, client key, clock and grant verifier.
//! This is not a public refresh endpoint or a production clock/grant implementation.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, EncodingKey};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap, future::Future, io::Write, os::unix::fs::OpenOptionsExt, path::Path,
    pin::Pin, sync::Arc,
};
use uuid::Uuid;
use workspace_contracts::Result;
use workspace_identity::{
    enrollment_ticket::{TicketIssuance, TicketSigner, TicketSigningConfig, TicketTrust},
    regional_key_policy::KeyPolicy,
    regional_refresh::{
        CeilingVerifier, FamilyBinding, IssuedRefresh, RefreshFamilies, RefreshRequest,
        RegionalClock,
    },
};
use workspace_meta_client::{ClientConfig, RemoteMetadata};

const PUBLIC: &str = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
const PRIVATE: &str = "MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v_VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g";
const THUMBPRINT: &str = "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k";
const ENROLL_URI: &str = "https://region.example/api/v1/workspaces/ws_agentlab/refresh-families";
const ROTATE_URI: &str = "https://region.example/api/v1/workspaces/ws_agentlab/token-issuances";

struct TestClock(i64);
impl RegionalClock for TestClock {
    fn now(&self) -> Result<i64> {
        Ok(self.0)
    }
}
struct TestCeiling;
impl CeilingVerifier for TestCeiling {
    fn check<'a>(
        &'a self,
        workspace: &'a str,
        region: &'a str,
        _key: &'a str,
        grant: &'a str,
        ceiling: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            if workspace == "ws_agentlab"
                && region == "region:other"
                && grant == "grant:existing"
                && ceiling == "ceiling:fixture"
            {
                Ok(())
            } else {
                Err(workspace_contracts::ServiceError::new(
                    403,
                    "CEILING_DENIED",
                ))
            }
        })
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Saved {
    secret: String,
    nonce: String,
    family_id: String,
    generation: u64,
    security_epoch: u64,
    expires_at: i64,
    ceiling_ref: String,
}
impl From<IssuedRefresh> for Saved {
    fn from(v: IssuedRefresh) -> Self {
        Self {
            secret: v.secret,
            nonce: v.nonce,
            family_id: v.family_id,
            generation: v.generation,
            security_epoch: v.security_epoch,
            expires_at: v.expires_at,
            ceiling_ref: v.ceiling_ref,
        }
    }
}

fn signed(header: &Value, claims: &Value) -> anyhow::Result<String> {
    let message = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header.to_string()),
        URL_SAFE_NO_PAD.encode(claims.to_string())
    );
    let private = URL_SAFE_NO_PAD.decode(PRIVATE)?;
    let signature = jsonwebtoken::crypto::sign(
        message.as_bytes(),
        &EncodingKey::from_ed_der(&private),
        Algorithm::EdDSA,
    )?;
    Ok(format!("{message}.{signature}"))
}
fn proof(uri: &str, nonce: &str, now: i64) -> anyhow::Result<String> {
    signed(
        &json!({"typ":"dpop+jwt","alg":"EdDSA","jwk":{"kty":"OKP","crv":"Ed25519","x":PUBLIC}}),
        &json!({"jti":Uuid::new_v4().to_string(),"htm":"POST","htu":uri,"iat":now,"nonce":nonce}),
    )
}
fn store(path: &Path, saved: &Saved, replace: bool) -> anyhow::Result<()> {
    let target = path.to_owned();
    let output = if replace {
        path.with_extension(format!("tmp-{}", Uuid::new_v4()))
    } else {
        target.clone()
    };
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&output)?;
    file.write_all(&serde_json::to_vec(saved)?)?;
    file.sync_all()?;
    if replace {
        std::fs::rename(output, target)?;
    }
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    anyhow::ensure!(args.len() == 6, "expected isolated fixture arguments");
    let config: ClientConfig = serde_json::from_slice(&std::fs::read(&args[1])?)?;
    let policy: KeyPolicy = serde_json::from_slice(&std::fs::read(&args[3])?)?;
    let now: i64 = args[5].parse()?;
    let trust = TicketTrust {
        issuer: "https://global.example".into(),
        audience: "region:other/enrollment".into(),
        environment: "test".into(),
        region_id: "region:other".into(),
        keys: BTreeMap::from([(
            "key-1".into(),
            URL_SAFE_NO_PAD
                .decode(PUBLIC)?
                .try_into()
                .map_err(|_| anyhow::anyhow!("invalid test key"))?,
        )]),
    };
    let metadata = Arc::new(RemoteMetadata::connect(config).await?);
    let service = RefreshFamilies::open(
        metadata,
        "region:other",
        trust,
        Arc::new(TestCeiling),
        Arc::new(TestClock(now)),
    )
    .await?;
    match args[2].as_str() {
        "enroll" => {
            let private = URL_SAFE_NO_PAD.decode(PRIVATE)?;
            let seed: [u8; 32] = private[private.len() - 32..].try_into()?;
            let signer = TicketSigner::new(
                TicketSigningConfig {
                    issuer: "https://global.example".into(),
                    audience: "region:other/enrollment".into(),
                    environment: "test".into(),
                    region_id: "region:other".into(),
                    key_id: "key-1".into(),
                },
                &seed,
            )?;
            let ticket = signer.sign(
                &TicketIssuance {
                    workspace_id: &policy.workspace_id,
                    key_id: &policy.key_id,
                    key_version: policy.key_version,
                    policy_generation: policy.policy_generation,
                    principal_id: &policy.principal_id,
                    grant_ref: &policy.grant_ref,
                    ceiling_ref: "ceiling:fixture",
                    client_thumbprint: THUMBPRINT,
                    key_expires_at: policy.expires_at,
                },
                now,
            )?;
            let proof = proof(ENROLL_URI, &ticket.nonce, now)?;
            let issued = service
                .enroll(
                    &policy.workspace_id,
                    &ticket.ticket,
                    &proof,
                    ENROLL_URI,
                    now,
                    false,
                )
                .await?;
            store(Path::new(&args[4]), &issued.into(), false)?;
        }
        "rotate" => {
            let saved: Saved = serde_json::from_slice(&std::fs::read(&args[4])?)?;
            let proof = proof(ROTATE_URI, &saved.nonce, now)?;
            let issued = service
                .rotate(RefreshRequest {
                    workspace: &policy.workspace_id,
                    key_id: &policy.key_id,
                    credential: &saved.secret,
                    proof: &proof,
                    target_uri: ROTATE_URI,
                    now,
                    allow_loopback_http: false,
                })
                .await?;
            store(Path::new(&args[4]), &issued.into(), true)?;
        }
        "check" => {
            let saved: Saved = serde_json::from_slice(&std::fs::read(&args[4])?)?;
            service
                .check_family(FamilyBinding {
                    workspace: &policy.workspace_id,
                    key_id: &policy.key_id,
                    family_id: &saved.family_id,
                    epoch: saved.security_epoch,
                    key_version: policy.key_version,
                    ceiling_ref: &saved.ceiling_ref,
                    now,
                })
                .await?;
        }
        _ => anyhow::bail!("unsupported fixture operation"),
    }
    Ok(())
}
