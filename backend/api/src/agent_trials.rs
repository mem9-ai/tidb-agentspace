//! An isolated 48-hour report over a single immutable public fixture. Trial credentials
//! cannot enter the Workspace, browser-session, provisioning or billing handlers.
use super::{ConnectInfo, Json, Method, Request, Response, SocketAddr, reject, to_bytes};
use axum::response::IntoResponse;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    net::IpAddr,
    sync::{Arc, LazyLock},
};
use tokio::sync::Mutex;
use uuid::Uuid;
use workspace_contracts::{MetaRequest, Metadata, Result, Scope};

const LIFETIME: i64 = 48 * 3600;
const SAMPLE: &str = include_str!("../../../specs/gh-150/fixtures/us-sales.csv");

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    id: String,
    expires_at: i64,
    revision: u8,
    #[serde(default)]
    sharing_revoked: bool,
}

// This immutable fixture and the ordered section selection fully specify the durable report.
struct SampleTotals {
    states: BTreeMap<&'static str, u64>,
    leading_state_products: BTreeMap<&'static str, u64>,
}
static TOTALS: LazyLock<SampleTotals> = LazyLock::new(|| {
    let mut states = BTreeMap::new();
    let mut products_by_state: BTreeMap<&str, BTreeMap<&str, u64>> = BTreeMap::new();
    for row in SAMPLE.lines().skip(1) {
        let fields: Vec<_> = row.split(',').collect();
        let amount = fields[5].parse::<u64>().expect("versioned USD fixture");
        *states.entry(fields[2]).or_default() += amount;
        *products_by_state
            .entry(fields[2])
            .or_default()
            .entry(fields[3])
            .or_default() += amount;
    }
    let leader = *states
        .iter()
        .max_by_key(|(_, amount)| *amount)
        .expect("public sales fixture")
        .0;
    SampleTotals {
        states,
        leading_state_products: products_by_state.remove(leader).expect("leader has sales"),
    }
});

#[derive(Clone, Copy)]
enum Mutation {
    Append(u8, u8),
    RevokeSharing,
}

fn money(amount: u64) -> String {
    let digits = amount.to_string();
    let mut result = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            result.push(',');
        }
        result.push(c);
    }
    format!("${result}.00")
}

impl Report {
    fn markdown(&self) -> Option<String> {
        if self.revision == 0 {
            return None;
        }
        let mut states: Vec<_> = TOTALS.states.iter().collect();
        states.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
        let total: u64 = states.iter().map(|(_, n)| **n).sum();
        let (leader, sales) = states[0];
        let mut text = format!(
            "# US sales report\n\nSample: us-sales-v1\nSource: us-sales.csv\n\n{leader} leads with {} ({:.1}% of sales).\nTotal: {} across {} orders.\n\nSummed sales_usd by state and sorted the totals in descending order.\n\n| State | Sales (USD) |\n| --- | ---: |\n",
            money(*sales),
            *sales as f64 * 100.0 / total as f64,
            money(total),
            SAMPLE.lines().count() - 1
        );
        for (name, amount) in &states {
            text.push_str(&format!("| {name} | {} |\n", money(**amount)));
        }
        let top_two = *states[0].1 + *states[1].1;
        text.push_str(&format!(
            "\n## Top two states\n\n{} ({}) + {} ({}) = {}.\n{} / {} = {:.1}% of total sales.\n",
            states[0].0,
            money(*states[0].1),
            states[1].0,
            money(*states[1].1),
            money(top_two),
            money(top_two),
            money(total),
            top_two as f64 * 100.0 / total as f64
        ));
        if self.revision >= 2 {
            let mut products: Vec<_> = TOTALS.leading_state_products.iter().collect();
            products.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
            let (product, revenue) = products[0];
            text.push_str(&format!("\n## Top product in {leader}\n\n{product} leads with {} ({:.1}% of state sales).\nFiltered orders to {leader} and summed sales_usd by product.\n", money(*revenue), *revenue as f64 * 100.0 / *sales as f64));
        }
        text.push_str(&format!(
            "\n<!-- tidb-agent-workspace report={} revision={} -->\n",
            self.id, self.revision
        ));
        Some(text)
    }

    fn view(&self) -> Value {
        json!({"id":self.id,"expiresAt":self.expires_at,"revision":self.revision,
        "sample":"us-sales-v1","markdown":self.markdown(),"sharingRevoked":self.sharing_revoked,"stateSales":(self.revision>=1).then_some(&TOTALS.states),
        "leadingStateProducts":(self.revision>=2).then_some(&TOTALS.leading_state_products)})
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Proof {
    public_key: String,
    challenge: String,
    signature: String,
    enroll: bool,
}

#[derive(Default)]
struct Admission {
    challenges: HashMap<String, i64>,
    sessions: HashMap<String, (String, String, i64)>,
    peers: HashMap<IpAddr, (i64, u32)>,
}

pub(super) struct Trials {
    metadata: Arc<dyn Metadata>,
    scope: Scope,
    admission: Mutex<Admission>,
}

async fn body<T: serde::de::DeserializeOwned>(request: Request) -> Result<T> {
    if request
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        != Some("application/json")
    {
        return Err(reject(415, "JSON_REQUIRED"));
    }
    let bytes = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        to_bytes(request.into_body(), 1024),
    )
    .await
    .map_err(|_| reject(408, "TRIAL_REQUEST_TIMEOUT"))?
    .map_err(|_| reject(413, "TRIAL_INPUT_TOO_LARGE"))?;
    serde_json::from_slice(&bytes).map_err(|_| reject(400, "INVALID_TRIAL_INPUT"))
}

fn valid_signature(public: &str, signature: &str, message: &str) -> bool {
    let Some(bytes) = B64.decode(public).ok().and_then(|b| b.try_into().ok()) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&bytes) else {
        return false;
    };
    let Some(sig) = B64
        .decode(signature)
        .ok()
        .and_then(|b| Signature::from_slice(&b).ok())
    else {
        return false;
    };
    !key.is_weak()
        && B64.encode(bytes) == public
        && key.verify_strict(message.as_bytes(), &sig).is_ok()
}

impl Trials {
    pub(super) fn new(metadata: Arc<dyn Metadata>, authority: &str) -> Self {
        Self {
            metadata,
            scope: Scope::system(authority, "agent-trials", "sample-reports", "v1"),
            admission: Mutex::default(),
        }
    }

    pub(super) async fn handle(&self, route: &str, request: Request) -> Result<Response> {
        let now = chrono::Utc::now().timestamp();
        if request.uri().query().is_some() || request.headers().contains_key("cookie") {
            return Err(reject(400, "INVALID_TRIAL_REQUEST"));
        }
        let peer = request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .ok_or_else(|| reject(403, "PEER_REQUIRED"))?
            .0
            .ip();
        {
            let mut a = self.admission.lock().await;
            a.peers.retain(|_, (until, _)| *until > now);
            if a.peers.len() >= 4096 && !a.peers.contains_key(&peer) {
                return Err(reject(429, "TRIAL_RATE_LIMIT"));
            }
            let rate = a.peers.entry(peer).or_insert((now + 60, 0));
            if rate.1 >= 180 {
                return Err(reject(429, "TRIAL_RATE_LIMIT"));
            }
            rate.1 += 1;
        }
        match (request.method().clone(), route) {
            (Method::GET, "us-sales-v1.csv") => {
                Ok(([("content-type", "text/csv; charset=utf-8")], SAMPLE).into_response())
            }
            (Method::POST, "challenges") => {
                let mut a = self.admission.lock().await;
                a.challenges.retain(|_, until| *until > now);
                if a.challenges.len() >= 2048 {
                    return Err(reject(429, "TRIAL_BUSY"));
                }
                let challenge = Uuid::new_v4().to_string();
                a.challenges.insert(challenge.clone(), now + 60);
                Ok(Json(json!({"challenge":challenge,"expiresAt":now+60})).into_response())
            }
            (Method::POST, "sessions") => {
                let proof: Proof = body(request).await?;
                let invalid = || reject(401, "INVALID_TRIAL_PROOF");
                let message = format!(
                    "drive9/trial/v1\n{}\n{}",
                    proof.challenge,
                    if proof.enroll { "start" } else { "resume" }
                );
                if !valid_signature(&proof.public_key, &proof.signature, &message) {
                    return Err(invalid());
                }
                let deadline = self
                    .admission
                    .lock()
                    .await
                    .challenges
                    .remove(&proof.challenge)
                    .ok_or_else(invalid)?;
                if deadline <= now {
                    return Err(invalid());
                }
                let report = self
                    .record(&proof.public_key, proof.enroll, None, None, now)
                    .await?;
                let mut a = self.admission.lock().await;
                a.sessions.retain(|_, (_, _, until)| *until > now);
                if a.sessions.len() >= 4096 {
                    return Err(reject(429, "TRIAL_BUSY"));
                }
                let token = Uuid::new_v4().to_string();
                a.sessions.insert(
                    token.clone(),
                    (
                        proof.public_key,
                        report.id.clone(),
                        report.expires_at.min(now + 300),
                    ),
                );
                Ok(Json(json!({"token":token,"report":report.view()})).into_response())
            }
            (Method::GET, "report-view") => self.read_view(request.headers(), now).await,
            (method @ (Method::GET | Method::PUT), "report")
            | (method @ Method::DELETE, "report-sharing") => {
                let token = request
                    .headers()
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.strip_prefix("Trial "))
                    .ok_or_else(|| reject(401, "TRIAL_SESSION_REQUIRED"))?;
                let (key, id, until) = self
                    .admission
                    .lock()
                    .await
                    .sessions
                    .get(token)
                    .cloned()
                    .ok_or_else(|| reject(401, "TRIAL_SESSION_REQUIRED"))?;
                if until <= now {
                    return Err(reject(401, "TRIAL_SESSION_EXPIRED"));
                }
                let update = if method == Method::PUT {
                    let version = request
                        .headers()
                        .get("if-match")
                        .and_then(|v| v.to_str().ok())
                        .ok_or_else(|| reject(428, "PRECONDITION_REQUIRED"))?;
                    let expected = match version {
                        "\"0\"" => 0,
                        "\"1\"" => 1,
                        "\"2\"" => 2,
                        _ => return Err(reject(412, "REPORT_VERSION_CHANGED")),
                    };
                    #[derive(Deserialize)]
                    #[serde(deny_unknown_fields)]
                    struct Update {
                        section: String,
                    }
                    let input: Update = body(request).await?;
                    let next = match input.section.as_str() {
                        "states" => 1,
                        "products" => 2,
                        _ => return Err(reject(400, "INVALID_REPORT_SECTION")),
                    };
                    Some(Mutation::Append(expected, next))
                } else if method == Method::DELETE {
                    Some(Mutation::RevokeSharing)
                } else {
                    None
                };
                let report = self.record(&key, false, Some(&id), update, now).await?;
                Ok((
                    [("etag", format!("\"{}\"", report.revision))],
                    Json(report.view()),
                )
                    .into_response())
            }
            _ => Err(reject(404, "NOT_FOUND")),
        }
    }

    async fn read_view(&self, headers: &axum::http::HeaderMap, now: i64) -> Result<Response> {
        let invalid = || reject(401, "INVALID_REPORT_VIEW");
        let grant = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("TrialView "))
            .ok_or_else(invalid)?;
        let mut fields = grant.split('.');
        let (Some("v1"), Some(public), Some(id), Some(deadline), Some(signature), None) = (
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
        ) else {
            return Err(invalid());
        };
        let expiry: i64 = deadline.parse().map_err(|_| invalid())?;
        if expiry <= 0
            || expiry.to_string() != deadline
            || Uuid::parse_str(id).map(|v| v.to_string()).as_deref() != Ok(id)
            || !valid_signature(
                public,
                signature,
                &format!("drive9/trial/report-view/v1\n{id}\n{deadline}"),
            )
        {
            return Err(invalid());
        }
        if expiry <= now {
            return Err(reject(410, "TRIAL_EXPIRED"));
        }
        let report = self.record(public, false, Some(id), None, now).await?;
        if report.expires_at != expiry {
            return Err(reject(403, "TRIAL_ACCESS_DENIED"));
        }
        if report.sharing_revoked {
            return Err(reject(410, "REPORT_SHARING_REVOKED"));
        }
        if report.revision == 0 {
            return Err(reject(404, "REPORT_NOT_SAVED"));
        }
        Ok(Json(report.view()).into_response())
    }

    // Fixed shard count and capacity bound durable report storage. Each compact report
    // is a revision of the immutable sample: 0 empty, 1 state totals, 2 plus products.
    async fn record(
        &self,
        public: &str,
        enroll: bool,
        id: Option<&str>,
        update: Option<Mutation>,
        now: i64,
    ) -> Result<Report> {
        let key = format!("reports/{:02x}", Sha256::digest(public.as_bytes())[0]);
        for _ in 0..4 {
            let result = self
                .metadata
                .execute(MetaRequest::Get {
                    scope: self.scope.clone(),
                    guard: None,
                    keys: vec![key.clone()],
                })
                .await?;
            let row = &result["records"][&key];
            let mut bucket: HashMap<String, Report> = if row.is_null() {
                HashMap::new()
            } else {
                serde_json::from_value(row["value"].clone())
                    .map_err(|_| reject(503, "TRIAL_STORE_UNAVAILABLE"))?
            };
            let report = if let Some(mut r) = bucket.get(public).cloned() {
                if r.expires_at <= now {
                    return Err(reject(410, "TRIAL_EXPIRED"));
                }
                if id.is_some_and(|id| r.id != id) {
                    return Err(reject(403, "TRIAL_ACCESS_DENIED"));
                }
                match update {
                    None => return Ok(r),
                    Some(Mutation::RevokeSharing) => {
                        if r.sharing_revoked {
                            return Ok(r);
                        }
                        r.sharing_revoked = true;
                    }
                    Some(Mutation::Append(expected, next)) => {
                        if r.revision != expected {
                            return Err(reject(412, "REPORT_VERSION_CHANGED"));
                        }
                        if next <= r.revision {
                            return Ok(r);
                        }
                        if next != r.revision + 1 {
                            return Err(reject(409, "STATE_REPORT_REQUIRED"));
                        }
                        r.revision = next;
                    }
                }
                r
            } else {
                if !enroll {
                    return Err(reject(404, "TRIAL_NOT_FOUND"));
                }
                Report {
                    id: Uuid::new_v4().to_string(),
                    expires_at: now + LIFETIME,
                    revision: 0,
                    sharing_revoked: false,
                }
            };
            bucket.retain(|_, r| r.expires_at > now);
            if bucket.len() >= 32 && !bucket.contains_key(public) {
                return Err(reject(429, "TRIAL_CAPACITY"));
            }
            bucket.insert(public.to_owned(), report.clone());
            match self
                .metadata
                .execute(MetaRequest::Commit {
                    scope: self.scope.clone(),
                    guard: None,
                    mutation_id: Uuid::new_v4().to_string(),
                    changes: vec![
                        json!({"key":key,"expectedVersion":row["version"],"value":bucket}),
                    ],
                })
                .await
            {
                Ok(_) => return Ok(report),
                Err(e) if e.code == "META_CONFLICT" => continue,
                Err(e) => return Err(e),
            }
        }
        Err(reject(409, "TRIAL_BUSY"))
    }
}
