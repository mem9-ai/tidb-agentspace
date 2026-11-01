//! Region-local, proof-bound refresh-family persistence.
//!
//! This module is not an HTTP service or access-token issuer. The caller must supply a trusted
//! Region clock and exact externally configured request URI, authenticate the transport and
//! enforce authorization before data effects. In particular, no Global callback is performed.
//! Production use requires a durable anti-rollback checkpoint, immutable local grant ceilings,
//! serving-node fences, history retention/cleanup, and a verified lost-response protocol.
//! Same-secret Key renewal transitions are not implemented by this module.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{future::Future, pin::Pin, sync::Arc};
use subtle::ConstantTimeEq;
use uuid::Uuid;
use workspace_contracts::{MetaRequest, Metadata, Result, Scope};

use crate::{
    dpop::{self, ProofContext},
    enrollment_ticket::{TicketTrust, TicketVerifier, VerifiedTicket},
    error,
    regional_key_policy::{KeyPolicies, KeyPolicy},
};

const RETRY_WINDOW: i64 = 10;

/// Must provide monotonic, rollback-protected regional time across restart. A bare wall
/// clock is not sufficient for production use.
pub trait RegionalClock: Send + Sync {
    fn now(&self) -> Result<i64>;
}

/// The provider must validate a durable immutable ceiling for this exact binding locally.
/// Grant changes must advance the Key policy version so its CAS fences an in-flight refresh.
pub trait CeilingVerifier: Send + Sync {
    fn check<'a>(
        &'a self,
        workspace: &'a str,
        region: &'a str,
        key: &'a str,
        grant: &'a str,
        ceiling: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>>;
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Family {
    workspace_id: String,
    region_id: String,
    key_id: String,
    principal_id: String,
    key_version: u64,
    policy_generation: u64,
    grant_ref: String,
    ceiling_ref: String,
    client_thumbprint: String,
    family_id: String,
    generation: u64,
    security_epoch: u64,
    expires_at: i64,
    nonce: String,
    verifier: String,
    revoked: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct History {
    generation: u64,
    verifier: String,
    nonce: String,
    rotated_at: i64,
}

struct VerifiedEnrollment<'a> {
    ticket: &'a VerifiedTicket,
    proof_id: &'a str,
    proof_issued: i64,
    observed: i64,
}

/// Returned only for the successfully persisted generation. Never log or store `secret` in URLs.
pub struct IssuedRefresh {
    pub secret: String,
    pub nonce: String,
    pub family_id: String,
    pub generation: u64,
    pub security_epoch: u64,
    pub expires_at: i64,
    pub ceiling_ref: String,
}

pub struct RefreshRequest<'a> {
    pub workspace: &'a str,
    pub key_id: &'a str,
    pub credential: &'a str,
    pub proof: &'a str,
    pub target_uri: &'a str,
    pub now: i64,
    pub allow_loopback_http: bool,
}

/// Values must come from an already signature-verified access token and trusted clock.
pub struct FamilyBinding<'a> {
    pub workspace: &'a str,
    pub key_id: &'a str,
    pub family_id: &'a str,
    pub epoch: u64,
    pub key_version: u64,
    pub ceiling_ref: &'a str,
    pub now: i64,
}

pub struct RefreshFamilies {
    metadata: Arc<dyn Metadata>,
    policies: KeyPolicies,
    tickets: TicketVerifier,
    ceilings: Arc<dyn CeilingVerifier>,
    clock: Arc<dyn RegionalClock>,
    authority: String,
}

fn denied() -> workspace_contracts::ServiceError {
    error(401, "INVALID_REFRESH_CREDENTIAL")
}
fn conflict() -> workspace_contracts::ServiceError {
    error(409, "REFRESH_OUTCOME_UNKNOWN")
}
fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|v| v.to_string() == value)
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

fn random_bytes() -> Result<[u8; 32]> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| error(503, "RANDOM_UNAVAILABLE"))?;
    Ok(bytes)
}
fn secret(family: &str, generation: u64) -> Result<String> {
    Ok(format!(
        "wrr_{family}_{generation}_{}",
        hex::encode(random_bytes()?)
    ))
}
fn nonce() -> Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(random_bytes()?))
}
fn mutation(domain: &[u8], family: &str, proof: &str) -> String {
    let mut h = Sha256::new();
    h.update(b"workspace-region-refresh\0v1\0");
    h.update(domain);
    h.update(family.as_bytes());
    h.update(b"\0");
    h.update(proof.as_bytes());
    let digest = h.finalize();
    let mut bytes = [0; 16];
    bytes.copy_from_slice(&digest[..16]);
    Uuid::from_bytes(bytes).to_string()
}
fn parse(secret: &str) -> Result<(&str, u64)> {
    let mut parts = secret.split('_');
    let (Some("wrr"), Some(family), Some(generation), Some(random), None) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) else {
        return Err(denied());
    };
    let number: u64 = generation.parse().map_err(|_| denied())?;
    if !uuid(family)
        || number == 0
        || number.to_string() != generation
        || random.len() != 64
        || !random
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(denied());
    }
    Ok((family, number))
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64 && hex::decode(value).is_ok_and(|v| v.len() == 32)
}
fn valid_nonce(value: &str) -> bool {
    URL_SAFE_NO_PAD
        .decode(value)
        .is_ok_and(|v| v.len() == 32 && URL_SAFE_NO_PAD.encode(v) == value)
}
fn valid_family(f: &Family, scope: &Scope, id: &str) -> bool {
    f.workspace_id == scope.owner_id
        && f.region_id == scope.authority_id
        && f.key_id == scope.partition_id
        && f.family_id == id
        && uuid(id)
        && f.key_version > 0
        && f.policy_generation > 0
        && f.generation > 0
        && f.generation <= 9_007_199_254_740_991
        && f.security_epoch > 0
        && f.security_epoch <= 9_007_199_254_740_991
        && f.expires_at > 0
        && valid_id(&f.principal_id)
        && valid_id(&f.grant_ref)
        && valid_id(&f.ceiling_ref)
        && valid_nonce(&f.nonce)
        && valid_nonce(&f.client_thumbprint)
        && valid_digest(&f.verifier)
}

impl RefreshFamilies {
    pub async fn open(
        metadata: Arc<dyn Metadata>,
        authority: &str,
        trust: TicketTrust,
        ceilings: Arc<dyn CeilingVerifier>,
        clock: Arc<dyn RegionalClock>,
    ) -> Result<Self> {
        if trust.region_id != authority {
            return Err(error(503, "REFRESH_TRUST_MISMATCH"));
        }
        let policies = KeyPolicies::open(metadata.clone(), authority).await?;
        Ok(Self {
            metadata,
            policies,
            tickets: TicketVerifier::new(trust)?,
            ceilings,
            clock,
            authority: authority.into(),
        })
    }

    async fn record(&self, scope: &Scope, key: &str) -> Result<Option<(Value, Value)>> {
        let response = self
            .metadata
            .execute(MetaRequest::Get {
                scope: scope.clone(),
                guard: None,
                keys: vec![key.into()],
            })
            .await?;
        let record = response["records"]
            .get(key)
            .ok_or_else(|| error(503, "REFRESH_RECORD_CORRUPT"))?;
        if record.is_null() {
            return Ok(None);
        }
        let version = record
            .get("version")
            .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
            .ok_or_else(|| error(503, "REFRESH_RECORD_CORRUPT"))?;
        let value = record
            .get("value")
            .ok_or_else(|| error(503, "REFRESH_RECORD_CORRUPT"))?;
        Ok(Some((value.clone(), version.clone())))
    }

    async fn family(&self, scope: &Scope, id: &str) -> Result<Option<(Family, Value)>> {
        let Some((value, version)) = self.record(scope, &format!("families/{id}")).await? else {
            return Ok(None);
        };
        let family: Family =
            serde_json::from_value(value).map_err(|_| error(503, "REFRESH_RECORD_CORRUPT"))?;
        if !valid_family(&family, scope, id) {
            return Err(error(503, "REFRESH_RECORD_CORRUPT"));
        }
        Ok(Some((family, version)))
    }

    fn policy_matches(policy: &KeyPolicy, family: &Family, now: i64) -> bool {
        now > 0
            && !policy.revoked
            && policy.expires_at > now
            && !family.revoked
            && family.expires_at > now
            && policy.workspace_id == family.workspace_id
            && policy.region_id == family.region_id
            && policy.key_id == family.key_id
            && policy.principal_id == family.principal_id
            && policy.key_version == family.key_version
            && policy.policy_generation == family.policy_generation
            && policy.grant_ref == family.grant_ref
            && family.expires_at <= policy.expires_at
    }

    async fn ceiling(&self, family: &Family) -> Result<()> {
        self.ceilings
            .check(
                &family.workspace_id,
                &family.region_id,
                &family.key_id,
                &family.grant_ref,
                &family.ceiling_ref,
            )
            .await
    }

    fn fresh(&self, observed: i64, proof_issued: i64, expires_at: i64) -> Result<i64> {
        let current = self.clock.now()?;
        if current <= 0 || current < observed {
            return Err(error(503, "CLOCK_ROLLBACK"));
        }
        if current >= expires_at
            || proof_issued > current.saturating_add(30)
            || proof_issued < current.saturating_sub(60)
        {
            return Err(denied());
        }
        Ok(current)
    }

    /// The signed ticket is region/client-bound; the supplied target URI must come from trusted
    /// routing. This consumes the ticket and proof with family creation in one Meta transaction.
    /// A lost response is uncertain; this profile does not return the same plaintext twice.
    pub async fn enroll(
        &self,
        workspace: &str,
        ticket: &str,
        proof: &str,
        target_uri: &str,
        now: i64,
        allow_loopback_http: bool,
    ) -> Result<IssuedRefresh> {
        let ticket = self.tickets.verify(ticket, now)?;
        if ticket.workspace_id() != workspace || ticket.region_id() != self.authority {
            return Err(denied());
        }
        let scope = self
            .policies
            .scope(workspace, ticket.key_id())
            .map_err(|_| denied())?;
        let (policy, policy_version) = self.policies.read(&scope).await?.ok_or_else(denied)?;
        if policy.revoked
            || policy.expires_at <= now
            || policy.expires_at != ticket.key_expires_at()
            || policy.workspace_id != workspace
            || policy.region_id != ticket.region_id()
            || policy.key_id != ticket.key_id()
            || policy.principal_id != ticket.principal_id()
            || policy.key_version != ticket.key_version()
            || policy.policy_generation != ticket.policy_generation()
            || policy.grant_ref != ticket.grant_ref()
        {
            return Err(denied());
        }
        let verified = dpop::verify(
            proof,
            &ProofContext {
                method: "POST",
                target_uri,
                expected_thumbprint: Some(ticket.client_thumbprint()),
                expected_nonce: ticket.nonce(),
                access_token: None,
                now,
                allow_loopback_http,
            },
        )
        .map_err(|_| denied())?;
        self.enroll_verified(
            &scope,
            policy,
            policy_version,
            VerifiedEnrollment {
                ticket: &ticket,
                proof_id: verified.proof_id(),
                proof_issued: verified.issued_at(),
                observed: now,
            },
        )
        .await
    }

    async fn enroll_verified(
        &self,
        scope: &Scope,
        policy: KeyPolicy,
        policy_version: Value,
        verified: VerifiedEnrollment<'_>,
    ) -> Result<IssuedRefresh> {
        let VerifiedEnrollment {
            ticket,
            proof_id,
            proof_issued,
            observed: now,
        } = verified;
        let family_id = ticket.ticket_id();
        let credential = secret(family_id, 1)?;
        let next_nonce = nonce()?;
        let family = Family {
            workspace_id: ticket.workspace_id().into(),
            region_id: ticket.region_id().into(),
            key_id: ticket.key_id().into(),
            principal_id: ticket.principal_id().into(),
            key_version: ticket.key_version(),
            policy_generation: ticket.policy_generation(),
            grant_ref: ticket.grant_ref().into(),
            ceiling_ref: ticket.ceiling_ref().into(),
            client_thumbprint: ticket.client_thumbprint().into(),
            family_id: family_id.into(),
            generation: 1,
            security_epoch: 1,
            expires_at: ticket.key_expires_at(),
            nonce: next_nonce.clone(),
            verifier: hash(&credential),
            revoked: false,
        };
        self.ceiling(&family).await?;
        if self.family(scope, family_id).await?.is_some() {
            return Err(error(409, "ENROLLMENT_ALREADY_CONSUMED"));
        }
        let commit_time = self.fresh(
            now,
            proof_issued,
            family.expires_at.min(ticket.expires_at()),
        )?;
        let proof_key = format!("proofs/{family_id}/{}", hash(proof_id));
        let result = self.metadata.execute(MetaRequest::Commit { scope:scope.clone(), guard:None, mutation_id:mutation(b"enroll\0",family_id,proof_id), changes:vec![
            json!({"key":"policy","expectedVersion":policy_version,"value":policy}),
            json!({"key":format!("families/{family_id}"),"expectedVersion":null,"value":family}),
            json!({"key":proof_key,"expectedVersion":null,"value":{"consumedAt":commit_time}}),
        ] }).await;
        match result {
            Ok(_) => {}
            Err(e) if e.code == "META_CONFLICT" => {
                return Err(if self.family(scope, family_id).await?.is_some() {
                    error(409, "ENROLLMENT_ALREADY_CONSUMED")
                } else {
                    error(409, "ENROLLMENT_CONFLICT")
                });
            }
            Err(e) if e.code == "META_COMMIT_UNKNOWN" => {
                let current = self.family(scope, family_id).await?;
                if !current.is_some_and(|(r, _)| {
                    !r.revoked
                        && r.verifier
                            .as_bytes()
                            .ct_eq(family.verifier.as_bytes())
                            .into()
                }) {
                    return Err(e);
                }
            }
            Err(e) => return Err(e),
        }
        let current = self.family(scope, family_id).await?;
        if !current.is_some_and(|(r, _)| {
            !r.revoked
                && r.verifier
                    .as_bytes()
                    .ct_eq(family.verifier.as_bytes())
                    .into()
        }) {
            return Err(error(409, "ENROLLMENT_ALREADY_CONSUMED"));
        }
        self.fresh(commit_time, proof_issued, family.expires_at)
            .map_err(|_| conflict())?;
        Ok(IssuedRefresh {
            secret: credential,
            nonce: next_nonce,
            family_id: family_id.into(),
            generation: 1,
            security_epoch: 1,
            expires_at: family.expires_at,
            ceiling_ref: family.ceiling_ref,
        })
    }

    /// Rotate one family generation locally. The caller must not retry an unknown outcome
    /// automatically. A verified old credential within the ten-second retry window returns an
    /// unknown outcome; outside that window an authenticated replay revokes only this family.
    pub async fn rotate(&self, request: RefreshRequest<'_>) -> Result<IssuedRefresh> {
        let RefreshRequest {
            workspace,
            key_id,
            credential,
            proof,
            target_uri,
            now,
            allow_loopback_http,
        } = request;
        let (family_id, generation) = parse(credential)?;
        let scope = self
            .policies
            .scope(workspace, key_id)
            .map_err(|_| denied())?;
        for _ in 0..4 {
            let (policy, policy_version) = self.policies.read(&scope).await?.ok_or_else(denied)?;
            let (mut family, family_version) =
                self.family(&scope, family_id).await?.ok_or_else(denied)?;
            if !Self::policy_matches(&policy, &family, now) {
                return Err(denied());
            }
            if generation > family.generation {
                return Err(denied());
            }
            if generation < family.generation {
                let history_key = format!("history/{family_id}/{generation}");
                let (value, _) = self
                    .record(&scope, &history_key)
                    .await?
                    .ok_or_else(denied)?;
                let history: History = serde_json::from_value(value)
                    .map_err(|_| error(503, "REFRESH_RECORD_CORRUPT"))?;
                if history.generation != generation
                    || !valid_nonce(&history.nonce)
                    || !valid_digest(&history.verifier)
                    || history.rotated_at <= 0
                {
                    return Err(error(503, "REFRESH_RECORD_CORRUPT"));
                }
                if !bool::from(
                    history
                        .verifier
                        .as_bytes()
                        .ct_eq(hash(credential).as_bytes()),
                ) {
                    return Err(denied());
                }
                let verified = dpop::verify(
                    proof,
                    &ProofContext {
                        method: "POST",
                        target_uri,
                        expected_thumbprint: Some(&family.client_thumbprint),
                        expected_nonce: &history.nonce,
                        access_token: None,
                        now,
                        allow_loopback_http,
                    },
                )
                .map_err(|_| denied())?;
                self.ceiling(&family).await?;
                let current = self.fresh(
                    now,
                    verified.issued_at(),
                    family.expires_at.min(policy.expires_at),
                )?;
                let elapsed = current
                    .checked_sub(history.rotated_at)
                    .filter(|v| *v >= 0)
                    .ok_or_else(|| error(503, "CLOCK_ROLLBACK"))?;
                if elapsed <= RETRY_WINDOW {
                    return Err(conflict());
                }
                family.revoked = true;
                family.security_epoch = family
                    .security_epoch
                    .checked_add(1)
                    .filter(|v| *v <= 9_007_199_254_740_991)
                    .ok_or_else(|| error(503, "REFRESH_VERSION_EXHAUSTED"))?;
                let result = self.metadata.execute(MetaRequest::Commit { scope:scope.clone(), guard:None, mutation_id:mutation(b"replay\0",family_id,verified.proof_id()), changes:vec![
                    json!({"key":"policy","expectedVersion":policy_version,"value":policy}),
                    json!({"key":format!("families/{family_id}"),"expectedVersion":family_version,"value":family}),
                ] }).await;
                match result {
                    Ok(_) => return Err(denied()),
                    Err(e) if e.code == "META_CONFLICT" => continue,
                    Err(e) if e.code == "META_COMMIT_UNKNOWN" => return Err(conflict()),
                    Err(e) => return Err(e),
                }
            }
            if !bool::from(
                family
                    .verifier
                    .as_bytes()
                    .ct_eq(hash(credential).as_bytes()),
            ) {
                return Err(denied());
            }
            let verified = dpop::verify(
                proof,
                &ProofContext {
                    method: "POST",
                    target_uri,
                    expected_thumbprint: Some(&family.client_thumbprint),
                    expected_nonce: &family.nonce,
                    access_token: None,
                    now,
                    allow_loopback_http,
                },
            )
            .map_err(|_| denied())?;
            self.ceiling(&family).await?;
            let mut history = History {
                generation: family.generation,
                verifier: family.verifier.clone(),
                nonce: family.nonce.clone(),
                rotated_at: now,
            };
            let next_generation = family
                .generation
                .checked_add(1)
                .filter(|v| *v <= 9_007_199_254_740_991)
                .ok_or_else(|| error(503, "REFRESH_VERSION_EXHAUSTED"))?;
            let next_secret = secret(family_id, next_generation)?;
            let next_nonce = nonce()?;
            family.generation = next_generation;
            family.nonce = next_nonce.clone();
            family.verifier = hash(&next_secret);
            let proof_key = format!("proofs/{family_id}/{}", hash(verified.proof_id()));
            if self.record(&scope, &proof_key).await?.is_some() {
                return Err(error(409, "DPOP_REPLAY"));
            }
            let commit_time = self.fresh(
                now,
                verified.issued_at(),
                family.expires_at.min(policy.expires_at),
            )?;
            history.rotated_at = commit_time;
            let result = self.metadata.execute(MetaRequest::Commit { scope:scope.clone(), guard:None, mutation_id:mutation(b"rotate\0",family_id,verified.proof_id()), changes:vec![
                json!({"key":"policy","expectedVersion":policy_version,"value":policy}),
                json!({"key":format!("families/{family_id}"),"expectedVersion":family_version,"value":family}),
                json!({"key":format!("history/{family_id}/{generation}"),"expectedVersion":null,"value":history}),
                json!({"key":proof_key,"expectedVersion":null,"value":{"consumedAt":commit_time}}),
            ] }).await;
            match result {
                Ok(_) => {}
                Err(e) if e.code == "META_CONFLICT" => continue,
                Err(e) if e.code == "META_COMMIT_UNKNOWN" => {
                    let current = self.family(&scope, family_id).await?;
                    if !current.is_some_and(|(r, _)| {
                        !r.revoked
                            && r.verifier
                                .as_bytes()
                                .ct_eq(family.verifier.as_bytes())
                                .into()
                    }) {
                        return Err(conflict());
                    }
                }
                Err(e) => return Err(e),
            }
            let current = self.family(&scope, family_id).await?;
            if !current.is_some_and(|(r, _)| {
                !r.revoked
                    && r.verifier
                        .as_bytes()
                        .ct_eq(family.verifier.as_bytes())
                        .into()
            }) {
                return Err(conflict());
            }
            self.fresh(commit_time, verified.issued_at(), family.expires_at)
                .map_err(|_| conflict())?;
            return Ok(IssuedRefresh {
                secret: next_secret,
                nonce: next_nonce,
                family_id: family_id.into(),
                generation: next_generation,
                security_epoch: family.security_epoch,
                expires_at: family.expires_at,
                ceiling_ref: family.ceiling_ref,
            });
        }
        Err(error(503, "REFRESH_CONFLICT_UNRESOLVED"))
    }

    pub async fn family_status(&self, binding: FamilyBinding<'_>) -> Result<Value> {
        self.check_family(FamilyBinding {
            workspace: binding.workspace,
            key_id: binding.key_id,
            family_id: binding.family_id,
            epoch: binding.epoch,
            key_version: binding.key_version,
            ceiling_ref: binding.ceiling_ref,
            now: binding.now,
        })
        .await?;
        let scope = self.policies.scope(binding.workspace, binding.key_id)?;
        let (family, _) = self
            .family(&scope, binding.family_id)
            .await?
            .ok_or_else(denied)?;
        Ok(
            json!({"id":family.family_id,"keyId":family.key_id,"keyVersion":family.key_version,"generation":family.generation,"securityEpoch":family.security_epoch,"expiresAt":family.expires_at,"revoked":family.revoked}),
        )
    }
    /// Requires an already locally verified token belonging to this exact family. The host
    /// drains request leases before calling, so return means old family tokens are fenced.
    pub async fn revoke_family(&self, binding: FamilyBinding<'_>) -> Result<()> {
        self.check_family(FamilyBinding {
            workspace: binding.workspace,
            key_id: binding.key_id,
            family_id: binding.family_id,
            epoch: binding.epoch,
            key_version: binding.key_version,
            ceiling_ref: binding.ceiling_ref,
            now: binding.now,
        })
        .await?;
        let scope = self.policies.scope(binding.workspace, binding.key_id)?;
        let (policy, version) = self.policies.read(&scope).await?.ok_or_else(denied)?;
        let (mut family, family_version) = self
            .family(&scope, binding.family_id)
            .await?
            .ok_or_else(denied)?;
        if !Self::policy_matches(&policy, &family, self.clock.now()?)
            || family.security_epoch != binding.epoch
        {
            return Err(denied());
        }
        family.revoked = true;
        family.security_epoch = family
            .security_epoch
            .checked_add(1)
            .ok_or_else(|| error(503, "REFRESH_VERSION_EXHAUSTED"))?;
        self.metadata.execute(MetaRequest::Commit{scope,guard:None,mutation_id:Uuid::new_v4().to_string(),changes:vec![
            json!({"key":"policy","expectedVersion":version,"value":policy}),
            json!({"key":format!("families/{}",binding.family_id),"expectedVersion":family_version,"value":family}),
        ]}).await?;
        Ok(())
    }

    /// Validate the local family epoch of an already signature-verified access token. This
    /// is only one admission check; the caller still enforces token ceiling and resource grants.
    pub async fn check_family(&self, binding: FamilyBinding<'_>) -> Result<()> {
        let FamilyBinding {
            workspace,
            key_id,
            family_id,
            epoch,
            key_version,
            ceiling_ref,
            now,
        } = binding;
        if !uuid(family_id) || epoch == 0 {
            return Err(denied());
        }
        let scope = self
            .policies
            .scope(workspace, key_id)
            .map_err(|_| denied())?;
        let (policy, _) = self.policies.read(&scope).await?.ok_or_else(denied)?;
        let (family, _) = self.family(&scope, family_id).await?.ok_or_else(denied)?;
        if !Self::policy_matches(&policy, &family, now)
            || family.security_epoch != epoch
            || family.key_version != key_version
            || family.ceiling_ref != ceiling_ref
        {
            return Err(denied());
        }
        self.ceiling(&family).await?;
        self.fresh(now, now, family.expires_at.min(policy.expires_at))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::MemoryMeta;
    use jsonwebtoken::{Algorithm, EncodingKey};
    use serde_json::json;
    use std::{
        collections::BTreeMap,
        sync::atomic::{AtomicBool, AtomicI64, Ordering},
    };

    const PUBLIC: &str = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
    const PRIVATE: &str = "MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v_VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g";
    const THUMBPRINT: &str = "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k";
    const ENROLL_URI: &str =
        "https://region.example/api/v1/workspaces/ws_agentlab/refresh-families";
    const ROTATE_URI: &str = "https://region.example/api/v1/workspaces/ws_agentlab/token-issuances";

    struct Ceiling(AtomicBool);
    struct Clock(AtomicI64);
    impl RegionalClock for Clock {
        fn now(&self) -> Result<i64> {
            Ok(self.0.load(Ordering::SeqCst))
        }
    }
    struct AdvanceClock(Arc<Clock>);
    impl CeilingVerifier for AdvanceClock {
        fn check<'a>(
            &'a self,
            _workspace: &'a str,
            _region: &'a str,
            _key: &'a str,
            _grant: &'a str,
            _ceiling: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
            Box::pin(async move {
                self.0.0.store(1300, Ordering::SeqCst);
                Ok(())
            })
        }
    }
    struct RevokeDuringCeiling {
        metadata: Arc<MemoryMeta>,
        policy: KeyPolicy,
        invoked: AtomicBool,
    }
    impl CeilingVerifier for RevokeDuringCeiling {
        fn check<'a>(
            &'a self,
            _workspace: &'a str,
            _region: &'a str,
            _key: &'a str,
            _grant: &'a str,
            _ceiling: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
            Box::pin(async move {
                if !self.invoked.swap(true, Ordering::SeqCst) {
                    KeyPolicies::open(self.metadata.clone(), "region:a")
                        .await?
                        .install(&self.policy, &Uuid::new_v4().to_string())
                        .await?;
                }
                Ok(())
            })
        }
    }
    impl CeilingVerifier for Ceiling {
        fn check<'a>(
            &'a self,
            workspace: &'a str,
            region: &'a str,
            _key: &'a str,
            grant: &'a str,
            ceiling: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
            Box::pin(async move {
                if self.0.load(Ordering::SeqCst)
                    && workspace == "ws_agentlab"
                    && region == "region:a"
                    && grant == "grant-1"
                    && ceiling == "ceiling-1"
                {
                    Ok(())
                } else {
                    Err(error(403, "CEILING_DENIED"))
                }
            })
        }
    }
    fn signer(header: &Value, claims: &Value) -> String {
        let message = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header.to_string()),
            URL_SAFE_NO_PAD.encode(claims.to_string())
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
    fn proof(uri: &str, nonce: &str, proof_id: &str, now: i64) -> String {
        signer(
            &json!({"typ":"dpop+jwt","alg":"EdDSA","jwk":{"kty":"OKP","crv":"Ed25519","x":PUBLIC}}),
            &json!({"jti":proof_id,"htm":"POST","htu":uri,"iat":now,"nonce":nonce}),
        )
    }
    fn ticket(policy: &KeyPolicy, ticket_id: &str, enrollment_nonce: &str) -> String {
        signer(
            &json!({"typ":"workspace-region-enrollment+jwt","alg":"EdDSA","kid":"key-1"}),
            &json!({
                "iss":"https://global.example","aud":"region:a/enrollment","environment":"test","iat":1000,"nbf":1000,"exp":1300,"jti":ticket_id,
                "workspaceId":policy.workspace_id,"regionId":policy.region_id,"keyId":policy.key_id,"keyVersion":policy.key_version,
                "policyGeneration":policy.policy_generation,"principalId":policy.principal_id,"grantRef":policy.grant_ref,
                "ceilingRef":"ceiling-1","clientThumbprint":THUMBPRINT,"nonce":enrollment_nonce,"keyExpiresAt":policy.expires_at,
            }),
        )
    }
    async fn setup() -> (
        Arc<MemoryMeta>,
        RefreshFamilies,
        KeyPolicy,
        Arc<Ceiling>,
        Arc<Clock>,
    ) {
        let metadata = Arc::new(MemoryMeta {
            authority: Some("region:a".into()),
            ..Default::default()
        });
        let policies = KeyPolicies::open(metadata.clone(), "region:a")
            .await
            .unwrap();
        let policy = KeyPolicy {
            workspace_id: "ws_agentlab".into(),
            region_id: "region:a".into(),
            key_id: Uuid::new_v4().to_string(),
            principal_id: "principal-1".into(),
            key_version: 1,
            policy_generation: 1,
            grant_ref: "grant-1".into(),
            expires_at: 4000,
            revoked: false,
        };
        policies
            .install(&policy, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        let trust = TicketTrust {
            issuer: "https://global.example".into(),
            audience: "region:a/enrollment".into(),
            environment: "test".into(),
            region_id: "region:a".into(),
            keys: BTreeMap::from([(
                "key-1".into(),
                URL_SAFE_NO_PAD.decode(PUBLIC).unwrap().try_into().unwrap(),
            )]),
        };
        let ceiling = Arc::new(Ceiling(AtomicBool::new(true)));
        let clock = Arc::new(Clock(AtomicI64::new(1000)));
        let service = RefreshFamilies::open(
            metadata.clone(),
            "region:a",
            trust,
            ceiling.clone(),
            clock.clone(),
        )
        .await
        .unwrap();
        (metadata, service, policy, ceiling, clock)
    }
    async fn enrolled(
        service: &RefreshFamilies,
        policy: &KeyPolicy,
    ) -> (IssuedRefresh, String, String) {
        let ticket_id = Uuid::new_v4().to_string();
        let n = URL_SAFE_NO_PAD.encode([9u8; 32]);
        let ticket = ticket(policy, &ticket_id, &n);
        let proof = proof(ENROLL_URI, &n, &Uuid::new_v4().to_string(), 1000);
        let result = service
            .enroll(
                &policy.workspace_id,
                &ticket,
                &proof,
                ENROLL_URI,
                1000,
                false,
            )
            .await
            .unwrap();
        (result, ticket, proof)
    }

    #[tokio::test]
    async fn enrollment_and_rotation_are_bound_durable_and_single_use() {
        let (metadata, service, policy, ceiling, clock) = setup().await;
        let (first, ticket, enrollment_proof) = enrolled(&service, &policy).await;
        assert!(
            service
                .enroll(
                    &policy.workspace_id,
                    &ticket,
                    &enrollment_proof,
                    ENROLL_URI,
                    1000,
                    false
                )
                .await
                .is_err()
        );
        assert!(
            service
                .enroll(
                    "ws_other",
                    &ticket,
                    &enrollment_proof,
                    ENROLL_URI,
                    1000,
                    false
                )
                .await
                .is_err()
        );
        let proof_id = Uuid::new_v4().to_string();
        let rotate_proof = proof(ROTATE_URI, &first.nonce, &proof_id, 1010);
        clock.0.store(1010, Ordering::SeqCst);
        let next = service
            .rotate(RefreshRequest {
                workspace: &policy.workspace_id,
                key_id: &policy.key_id,
                credential: &first.secret,
                proof: &rotate_proof,
                target_uri: ROTATE_URI,
                now: 1010,
                allow_loopback_http: false,
            })
            .await
            .unwrap();
        assert_eq!(next.generation, 2);
        assert_eq!(next.security_epoch, 1);
        assert_ne!(next.secret, first.secret);
        assert!(
            service
                .check_family(FamilyBinding {
                    workspace: &policy.workspace_id,
                    key_id: &policy.key_id,
                    family_id: &next.family_id,
                    epoch: 1,
                    key_version: 1,
                    ceiling_ref: "ceiling-1",
                    now: 1010
                })
                .await
                .is_ok()
        );
        let replay_id = proof(ROTATE_URI, &next.nonce, &proof_id, 1011);
        clock.0.store(1011, Ordering::SeqCst);
        assert!(
            service
                .rotate(RefreshRequest {
                    workspace: &policy.workspace_id,
                    key_id: &policy.key_id,
                    credential: &next.secret,
                    proof: &replay_id,
                    target_uri: ROTATE_URI,
                    now: 1011,
                    allow_loopback_http: false
                })
                .await
                .is_err()
        );
        assert_eq!(
            service
                .rotate(RefreshRequest {
                    workspace: &policy.workspace_id,
                    key_id: &policy.key_id,
                    credential: &first.secret,
                    proof: &rotate_proof,
                    target_uri: ROTATE_URI,
                    now: 1011,
                    allow_loopback_http: false
                })
                .await
                .err()
                .unwrap()
                .code,
            "REFRESH_OUTCOME_UNKNOWN"
        );
        let tampered = format!("{rotate_proof}x");
        clock.0.store(1021, Ordering::SeqCst);
        assert!(
            service
                .rotate(RefreshRequest {
                    workspace: &policy.workspace_id,
                    key_id: &policy.key_id,
                    credential: &first.secret,
                    proof: &tampered,
                    target_uri: ROTATE_URI,
                    now: 1021,
                    allow_loopback_http: false
                })
                .await
                .is_err()
        );
        assert!(
            service
                .check_family(FamilyBinding {
                    workspace: &policy.workspace_id,
                    key_id: &policy.key_id,
                    family_id: &next.family_id,
                    epoch: 1,
                    key_version: 1,
                    ceiling_ref: "ceiling-1",
                    now: 1021
                })
                .await
                .is_ok()
        );
        assert!(
            service
                .rotate(RefreshRequest {
                    workspace: &policy.workspace_id,
                    key_id: &policy.key_id,
                    credential: &first.secret,
                    proof: &rotate_proof,
                    target_uri: ROTATE_URI,
                    now: 1011,
                    allow_loopback_http: false
                })
                .await
                .is_err()
        );
        assert!(
            service
                .check_family(FamilyBinding {
                    workspace: &policy.workspace_id,
                    key_id: &policy.key_id,
                    family_id: &next.family_id,
                    epoch: 1,
                    key_version: 1,
                    ceiling_ref: "ceiling-1",
                    now: 1021
                })
                .await
                .is_err()
        );
        let raw = serde_json::to_string(&*metadata.groups.lock().unwrap()).unwrap();
        assert!(!raw.contains(&first.secret));
        assert!(!raw.contains(&next.secret));
        ceiling.0.store(false, Ordering::SeqCst);
    }

    #[tokio::test]
    async fn key_change_expiry_and_missing_ceiling_fail_closed() {
        let (_metadata, service, mut policy, ceiling, clock) = setup().await;
        let (first, _, _) = enrolled(&service, &policy).await;
        let rotate_proof = proof(ROTATE_URI, &first.nonce, &Uuid::new_v4().to_string(), 1010);
        clock.0.store(1010, Ordering::SeqCst);
        ceiling.0.store(false, Ordering::SeqCst);
        assert!(
            service
                .rotate(RefreshRequest {
                    workspace: &policy.workspace_id,
                    key_id: &policy.key_id,
                    credential: &first.secret,
                    proof: &rotate_proof,
                    target_uri: ROTATE_URI,
                    now: 1010,
                    allow_loopback_http: false
                })
                .await
                .is_err()
        );
        ceiling.0.store(true, Ordering::SeqCst);
        assert!(
            service
                .check_family(FamilyBinding {
                    workspace: &policy.workspace_id,
                    key_id: &policy.key_id,
                    family_id: &first.family_id,
                    epoch: 1,
                    key_version: 1,
                    ceiling_ref: "ceiling-1",
                    now: 4000
                })
                .await
                .is_err()
        );
        policy.key_version = 2;
        policy.policy_generation = 2;
        service
            .policies
            .install(&policy, &Uuid::new_v4().to_string())
            .await
            .unwrap();
        assert!(
            service
                .rotate(RefreshRequest {
                    workspace: &policy.workspace_id,
                    key_id: &policy.key_id,
                    credential: &first.secret,
                    proof: &rotate_proof,
                    target_uri: ROTATE_URI,
                    now: 1010,
                    allow_loopback_http: false
                })
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn unknown_enrollment_commit_never_creates_a_second_secret() {
        let (metadata, service, policy, _, clock) = setup().await;
        let ticket_id = Uuid::new_v4().to_string();
        let n = URL_SAFE_NO_PAD.encode([9u8; 32]);
        let ticket = ticket(&policy, &ticket_id, &n);
        let proof = proof(ENROLL_URI, &n, &Uuid::new_v4().to_string(), 1000);
        metadata.lose_reply.store(true, Ordering::SeqCst);
        let issued = service
            .enroll(
                &policy.workspace_id,
                &ticket,
                &proof,
                ENROLL_URI,
                1000,
                false,
            )
            .await
            .unwrap();
        assert!(
            service
                .enroll(
                    &policy.workspace_id,
                    &ticket,
                    &proof,
                    ENROLL_URI,
                    1000,
                    false
                )
                .await
                .is_err()
        );
        clock.0.store(1001, Ordering::SeqCst);
        assert!(
            service
                .check_family(FamilyBinding {
                    workspace: &policy.workspace_id,
                    key_id: &policy.key_id,
                    family_id: &issued.family_id,
                    epoch: 1,
                    key_version: 1,
                    ceiling_ref: "ceiling-1",
                    now: 1001
                })
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn expiry_or_policy_change_during_ceiling_check_never_creates_family() {
        let (_metadata, mut service, policy, _, clock) = setup().await;
        let ticket_id = Uuid::new_v4().to_string();
        let n = URL_SAFE_NO_PAD.encode([9u8; 32]);
        let signed = ticket(&policy, &ticket_id, &n);
        let first_proof = proof(ENROLL_URI, &n, &Uuid::new_v4().to_string(), 1000);
        service.ceilings = Arc::new(AdvanceClock(clock));
        assert!(
            service
                .enroll(
                    &policy.workspace_id,
                    &signed,
                    &first_proof,
                    ENROLL_URI,
                    1000,
                    false
                )
                .await
                .is_err()
        );
        let scope = service
            .policies
            .scope(&policy.workspace_id, &policy.key_id)
            .unwrap();
        assert!(service.family(&scope, &ticket_id).await.unwrap().is_none());

        let (metadata, mut service, policy, _, _) = setup().await;
        let ticket_id = Uuid::new_v4().to_string();
        let n = URL_SAFE_NO_PAD.encode([9u8; 32]);
        let signed = ticket(&policy, &ticket_id, &n);
        let second_proof = proof(ENROLL_URI, &n, &Uuid::new_v4().to_string(), 1000);
        let mut revoked = policy.clone();
        revoked.key_version = 2;
        revoked.policy_generation = 2;
        revoked.revoked = true;
        service.ceilings = Arc::new(RevokeDuringCeiling {
            metadata,
            policy: revoked,
            invoked: AtomicBool::new(false),
        });
        let result = service
            .enroll(
                &policy.workspace_id,
                &signed,
                &second_proof,
                ENROLL_URI,
                1000,
                false,
            )
            .await;
        assert_eq!(result.err().unwrap().code, "ENROLLMENT_CONFLICT");
        let scope = service
            .policies
            .scope(&policy.workspace_id, &policy.key_id)
            .unwrap();
        assert!(service.family(&scope, &ticket_id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn rollback_clock_and_concurrent_rotation_fail_closed() {
        let (_metadata, service, policy, _, clock) = setup().await;
        let ticket_id = Uuid::new_v4().to_string();
        let nonce = URL_SAFE_NO_PAD.encode([9u8; 32]);
        let ticket = ticket(&policy, &ticket_id, &nonce);
        let enrollment_proof = proof(ENROLL_URI, &nonce, &Uuid::new_v4().to_string(), 1000);
        clock.0.store(999, Ordering::SeqCst);
        let result = service
            .enroll(
                &policy.workspace_id,
                &ticket,
                &enrollment_proof,
                ENROLL_URI,
                1000,
                false,
            )
            .await;
        assert_eq!(result.err().unwrap().code, "CLOCK_ROLLBACK");
        let scope = service
            .policies
            .scope(&policy.workspace_id, &policy.key_id)
            .unwrap();
        assert!(service.family(&scope, &ticket_id).await.unwrap().is_none());

        clock.0.store(1000, Ordering::SeqCst);
        let (first, _, _) = enrolled(&service, &policy).await;
        clock.0.store(1010, Ordering::SeqCst);
        let proof_a = proof(ROTATE_URI, &first.nonce, &Uuid::new_v4().to_string(), 1010);
        let proof_b = proof(ROTATE_URI, &first.nonce, &Uuid::new_v4().to_string(), 1010);
        let request = |proof| RefreshRequest {
            workspace: &policy.workspace_id,
            key_id: &policy.key_id,
            credential: &first.secret,
            proof,
            target_uri: ROTATE_URI,
            now: 1010,
            allow_loopback_http: false,
        };
        let (a, b) = tokio::join!(
            service.rotate(request(&proof_a)),
            service.rotate(request(&proof_b))
        );
        assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
        let error = if a.is_err() {
            a.err().unwrap()
        } else {
            b.err().unwrap()
        };
        assert_eq!(error.code, "REFRESH_OUTCOME_UNKNOWN");
    }

    #[tokio::test]
    async fn lost_rotation_reply_is_reconciled_without_reusing_a_secret() {
        let (metadata, service, policy, _, clock) = setup().await;
        let (first, _, _) = enrolled(&service, &policy).await;
        clock.0.store(1010, Ordering::SeqCst);
        let signed = proof(ROTATE_URI, &first.nonce, &Uuid::new_v4().to_string(), 1010);
        metadata.lose_reply.store(true, Ordering::SeqCst);
        let request = || RefreshRequest {
            workspace: &policy.workspace_id,
            key_id: &policy.key_id,
            credential: &first.secret,
            proof: &signed,
            target_uri: ROTATE_URI,
            now: 1010,
            allow_loopback_http: false,
        };
        let next = service.rotate(request()).await.unwrap();
        assert_ne!(first.secret, next.secret);
        assert_eq!(
            service.rotate(request()).await.err().unwrap().code,
            "REFRESH_OUTCOME_UNKNOWN"
        );
        assert!(
            service
                .check_family(FamilyBinding {
                    workspace: &policy.workspace_id,
                    key_id: &policy.key_id,
                    family_id: &next.family_id,
                    epoch: 1,
                    key_version: 1,
                    ceiling_ref: "ceiling-1",
                    now: 1010
                })
                .await
                .is_ok()
        );
    }
}
