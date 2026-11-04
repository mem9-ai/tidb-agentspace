use super::{Batch, BrowserEvent};
use chrono::{NaiveDate, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::sync::{Mutex, mpsc};
use workspace_contracts::{MetaRequest, Metadata, Result, Scope, ServiceError};

const SHARDS: usize = 16;
const MAX_EVENTS: usize = 1024;
const DAY: i64 = 86400;

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub page_views: u64,
    pub try_clicks: u64,
    pub sign_in_clicks: u64,
    pub ready: u64,
    pub successes: u64,
    pub failures: u64,
    pub helpful: u64,
    pub votes: u64,
    pub events: BTreeMap<String, u64>,
    pub sources: BTreeMap<String, u64>,
    pub campaigns: BTreeMap<String, u64>,
    pub journeys: BTreeMap<String, u64>,
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Workspace {
    actor: String,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    campaign: Option<String>,
    ready: Option<i64>,
    useful: Option<i64>,
    api: bool,
}
#[derive(Clone, Serialize, Deserialize, Default)]
struct Projection {
    counts: Counts,
    sessions: BTreeSet<String>,
    #[serde(default)]
    session_sources: BTreeMap<String, (String, Option<String>)>,
    trials: BTreeSet<String>,
    workspaces: BTreeMap<String, Workspace>,
}
#[derive(Clone, Serialize, Deserialize)]
struct RawEvent {
    id: String,
    at: i64,
    subject: String,
    payload: Value,
}
#[derive(Clone)]
pub struct Store {
    metadata: Arc<dyn Metadata>,
    authority: String,
    key: Arc<Vec<u8>>,
    dropped: Arc<AtomicU64>,
    locks: Arc<Vec<Mutex<()>>>,
    sender: mpsc::Sender<Job>,
    cleanup_cursors: Arc<Mutex<BTreeMap<String, String>>>,
}
struct Job {
    id: String,
    workspace: String,
    actor: String,
    operation: String,
    success: bool,
    at: i64,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cohort {
    pub actor: String,
    pub ready: u64,
    pub eligible: u64,
    pub activated: u64,
    pub d1_eligible: u64,
    pub d1_returned: u64,
    pub d7_eligible: u64,
    pub d7_returned: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Summary {
    pub authority: String,
    pub from: String,
    pub to: String,
    pub timezone: String,
    pub counts: Counts,
    pub first_use_sources: BTreeMap<String, u64>,
    pub first_use_campaigns: BTreeMap<String, u64>,
    pub sessions: usize,
    pub trials: usize,
    pub active_workspaces: usize,
    pub api_workspaces: usize,
    pub cohorts: Vec<Cohort>,
    pub time_to_value_seconds: BTreeMap<u64, u64>,
    pub generated_at: i64,
    pub unconfirmed_events: u64,
    pub coverage: String,
}

fn failure(code: &str) -> ServiceError {
    ServiceError::new(503, code)
}
fn decode<T: serde::de::DeserializeOwned + Default>(record: &Value) -> Result<T> {
    if record.is_null() {
        Ok(T::default())
    } else {
        serde_json::from_value(record["value"].clone()).map_err(|_| failure("ANALYTICS_CORRUPT"))
    }
}
fn label<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}
fn increment(map: &mut BTreeMap<String, u64>, key: &str) {
    *map.entry(key.into()).or_default() += 1;
}

impl Store {
    pub fn new(metadata: Arc<dyn Metadata>, authority: &str, key: Vec<u8>) -> Result<Self> {
        if key.len() < 32 {
            return Err(failure("ANALYTICS_KEY_INVALID"));
        }
        let (sender, mut receiver) = mpsc::channel::<Job>(1000);
        let store = Self {
            metadata,
            authority: authority.into(),
            key: Arc::new(key),
            dropped: Arc::new(AtomicU64::new(0)),
            locks: Arc::new((0..SHARDS).map(|_| Mutex::new(())).collect()),
            sender,
            cleanup_cursors: Arc::new(Mutex::new(BTreeMap::new())),
        };
        let worker = store.clone();
        tokio::spawn(async move {
            while let Some(job) = receiver.recv().await {
                let result =
                    tokio::time::timeout(std::time::Duration::from_secs(2), worker.server(job))
                        .await;
                if !matches!(result, Ok(Ok(()))) {
                    worker.dropped.fetch_add(1, Ordering::Relaxed);
                }
            }
        });
        let cleaner = store.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                tick.tick().await;
                if cleaner.purge(Utc::now().timestamp()).await.is_err() {
                    cleaner.dropped.fetch_add(1, Ordering::Relaxed);
                }
            }
        });
        Ok(store)
    }
    pub fn mark_unconfirmed(&self) {
        self.dropped.fetch_add(1, Ordering::Relaxed);
    }
    pub fn authority(&self) -> &str {
        &self.authority
    }
    fn pseudonym(&self, value: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(self.key.as_slice())
            .expect("HMAC accepts the validated key length");
        mac.update(b"product-analytics-v1\0");
        mac.update(self.authority.as_bytes());
        mac.update(&[0]);
        mac.update(value.as_bytes());
        format!("{:x}", mac.finalize().into_bytes())
    }
    fn scope(&self, _day: &str) -> Scope {
        Scope::system(
            &self.authority,
            "product-analytics",
            "analytics-v1",
            "daily",
        )
    }
    fn shard(subject: &str) -> usize {
        usize::from(Sha256::digest(subject.as_bytes())[0]) % SHARDS
    }
    pub fn record(&self, id: &str, workspace: &str, actor: &str, operation: &str, success: bool) {
        let job = Job {
            id: id.into(),
            workspace: workspace.into(),
            actor: actor.into(),
            operation: operation.into(),
            success,
            at: Utc::now().timestamp(),
        };
        if self.sender.try_send(job).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
    async fn server(&self, job: Job) -> Result<()> {
        let subject = self.pseudonym(&job.workspace);
        let attribution_key = format!("attribution/{subject}");
        let attribution = self
            .metadata
            .execute(MetaRequest::Get {
                scope: self.scope(""),
                guard: None,
                keys: vec![attribution_key.clone()],
            })
            .await?;
        let attribution = serde_json::from_value::<super::Attribution>(
            attribution["records"][&attribution_key]["value"].clone(),
        )
        .ok()
        .filter(|a| a.at + 30 * DAY > job.at);
        let payload = json!({"operation":job.operation,"success":job.success,"actor":job.actor});
        self.append(
            RawEvent {
                id: job.id,
                at: job.at,
                subject: subject.clone(),
                payload,
            },
            move |p| {
                if job.operation == "trial" {
                    p.trials.insert(subject.clone());
                    return;
                }
                if job.operation == "sign_in_completed" {
                    increment(&mut p.counts.events, "sign_in_completed");
                    return;
                }
                let w = p.workspaces.entry(subject.clone()).or_default();
                if let Some(attribution) = &attribution {
                    w.source = Some(label(&attribution.source));
                    w.campaign = attribution.campaign.clone();
                }
                if job.actor != "api" || w.actor.is_empty() {
                    w.actor = job.actor.clone();
                }
                if job.operation == "workspace_ready" {
                    w.ready = Some(w.ready.map_or(job.at, |old| old.min(job.at)));
                    p.counts.ready += 1;
                } else {
                    increment(
                        &mut p.counts.events,
                        &format!(
                            "{}:{}",
                            job.operation,
                            if job.success { "success" } else { "failure" }
                        ),
                    );
                    if job.success {
                        p.counts.successes += 1;
                        if matches!(
                            job.operation.as_str(),
                            "query" | "analysis" | "preview" | "import" | "export" | "report_saved"
                        ) {
                            w.useful = Some(w.useful.map_or(job.at, |old| old.min(job.at)));
                            w.api |= job.actor == "api";
                        }
                    } else {
                        p.counts.failures += 1;
                    }
                }
            },
        )
        .await
    }
    pub async fn browser(&self, batch: Batch, at: i64) -> Result<()> {
        let subject = self.pseudonym(&batch.session_id);
        for input in batch.events {
            let event = input.event;
            let payload = serde_json::to_value(&event).map_err(|_| failure("ANALYTICS_INVALID"))?;
            let subject = subject.clone();
            self.append(
                RawEvent {
                    id: input.id,
                    at,
                    subject: subject.clone(),
                    payload,
                },
                move |p| match &event {
                    BrowserEvent::PublicPageView {
                        source, campaign, ..
                    } => {
                        p.counts.page_views += 1;
                        if p.sessions.insert(subject.clone()) {
                            p.session_sources
                                .insert(subject.clone(), (label(source), campaign.clone()));
                            increment(&mut p.counts.sources, &label(source));
                            if let Some(c) = campaign {
                                increment(&mut p.counts.campaigns, c);
                            }
                        }
                    }
                    BrowserEvent::TryClicked { .. } => p.counts.try_clicks += 1,
                    BrowserEvent::SignInClicked { .. } => p.counts.sign_in_clicks += 1,
                    BrowserEvent::JourneySelected { journey } => {
                        increment(&mut p.counts.journeys, &label(journey))
                    }
                    BrowserEvent::HelpfulVote { helpful } => {
                        p.counts.votes += 1;
                        if *helpful {
                            p.counts.helpful += 1;
                        }
                    }
                },
            )
            .await?;
        }
        Ok(())
    }
    async fn append(&self, event: RawEvent, apply: impl Fn(&mut Projection)) -> Result<()> {
        let day = chrono::DateTime::from_timestamp(event.at, 0)
            .ok_or_else(|| failure("ANALYTICS_TIME_INVALID"))?
            .date_naive()
            .to_string();
        let shard = Self::shard(&event.subject);
        let _lock = self.locks[shard].lock().await;
        let identity = format!("{}:{}", event.subject, event.id);
        let keys = [
            format!("day/{day}/raw/{shard:02}"),
            format!("day/{day}/projection/{shard:02}"),
            format!("day/{day}/aggregate/{shard:02}"),
            format!("dedup/{identity}"),
        ];
        for _ in 0..4 {
            let records = self
                .metadata
                .execute(MetaRequest::Get {
                    scope: self.scope(&day),
                    guard: None,
                    keys: keys.to_vec(),
                })
                .await?;
            let r = &records["records"];
            let mut raw: BTreeMap<String, RawEvent> = decode(&r[&keys[0]])?;
            let prior = &r[&keys[3]]["value"];
            if !prior.is_null()
                && prior["at"]
                    .as_i64()
                    .is_some_and(|at| at + 30 * DAY > event.at)
            {
                return if prior["payload"] == event.payload {
                    Ok(())
                } else {
                    Err(ServiceError::new(409, "ANALYTICS_EVENT_CONFLICT"))
                };
            }
            if raw.len() >= MAX_EVENTS {
                return Err(ServiceError::new(429, "ANALYTICS_CAPACITY"));
            }
            raw.insert(identity.clone(), event.clone());
            let mut projection: Projection = decode(&r[&keys[1]])?;
            apply(&mut projection);
            let values = [
                json!(raw),
                json!(projection),
                json!(projection.counts),
                json!({"at":event.at,"payload":event.payload}),
            ];
            let mut changes=keys.iter().zip(values).map(|(key,value)|json!({"key":key,"expectedVersion":r[key]["version"],"value":value})).collect::<Vec<_>>();
            changes.push(json!({"key":format!("expiry/{day}/{identity}"),"expectedVersion":null,"value":{"dedup":keys[3],"at":event.at}}));
            match self
                .metadata
                .execute(MetaRequest::Commit {
                    scope: self.scope(&day),
                    guard: None,
                    mutation_id: uuid::Uuid::new_v4().to_string(),
                    changes,
                })
                .await
            {
                Ok(_) => return Ok(()),
                Err(e) if e.status == 409 => continue,
                Err(e) => return Err(e),
            }
        }
        Err(failure("ANALYTICS_BUSY"))
    }
    pub async fn summary(&self, from: NaiveDate, to: NaiveDate, now: i64) -> Result<Summary> {
        let today = chrono::DateTime::from_timestamp(now, 0)
            .ok_or_else(|| failure("ANALYTICS_TIME_INVALID"))?
            .date_naive();
        if from >= to
            || (to - from).num_days() > 31
            || from < today - chrono::Duration::days(29)
            || to > today + chrono::Duration::days(1)
        {
            return Err(ServiceError::new(422, "INVALID_ANALYTICS_RANGE"));
        }
        let mut result = Summary {
            authority: self.authority.clone(),
            from: from.to_string(),
            to: to.to_string(),
            timezone: "UTC".into(),
            counts: Counts::default(),
            first_use_sources: BTreeMap::new(),
            first_use_campaigns: BTreeMap::new(),
            sessions: 0,
            trials: 0,
            active_workspaces: 0,
            api_workspaces: 0,
            cohorts: Vec::new(),
            time_to_value_seconds: BTreeMap::new(),
            generated_at: now,
            unconfirmed_events: self.dropped.load(Ordering::Relaxed),
            coverage: "best_effort_since_enablement; crash_loss_unknown".into(),
        };
        let mut sessions = BTreeSet::new();
        let mut attribution = BTreeMap::new();
        let mut trials = BTreeSet::new();
        let mut active = BTreeSet::new();
        let mut api = BTreeSet::new();
        let mut workspaces: BTreeMap<String, (Workspace, BTreeSet<NaiveDate>)> = BTreeMap::new();
        // Bounded analytic projections only; never enumerate customer Workspaces or raw events.
        for offset in 0..30 {
            let date = today - chrono::Duration::days(offset);
            let keys = (0..SHARDS)
                .map(|s| format!("day/{date}/projection/{s:02}"))
                .collect::<Vec<_>>();
            let records = self
                .metadata
                .execute(MetaRequest::Get {
                    scope: self.scope(&date.to_string()),
                    guard: None,
                    keys: keys.clone(),
                })
                .await?;
            for key in keys {
                let p: Projection = decode(&records["records"][key])?;
                let included = date >= from && date < to;
                if included {
                    attribution.extend(p.session_sources);
                    sessions.extend(p.sessions);
                    trials.extend(p.trials);
                    result.counts.add(&p.counts);
                }
                for (id, w) in p.workspaces {
                    if included && w.useful.is_some() {
                        active.insert(id.clone());
                        if w.api {
                            api.insert(id.clone());
                        }
                    }
                    let (total, days) = workspaces.entry(id).or_default();
                    total.actor = w.actor;
                    if w.source.is_some() {
                        total.source = w.source;
                        total.campaign = w.campaign;
                    }
                    if let Some(at) = w.ready {
                        total.ready = Some(total.ready.map_or(at, |old| old.min(at)));
                    }
                    if let Some(at) = w.useful {
                        total.useful = Some(total.useful.map_or(at, |old| old.min(at)));
                        days.insert(date);
                    }
                }
            }
        }
        let start = from
            .and_hms_opt(0, 0, 0)
            .expect("midnight")
            .and_utc()
            .timestamp();
        let end = to
            .and_hms_opt(0, 0, 0)
            .expect("midnight")
            .and_utc()
            .timestamp();
        let mut cohorts: BTreeMap<String, Cohort> = BTreeMap::new();
        for (w, days) in workspaces.values() {
            let actor = if w.actor == "guest" {
                "guest"
            } else {
                "account"
            };
            let c = cohorts.entry(actor.into()).or_insert_with(|| Cohort {
                actor: actor.into(),
                ..Default::default()
            });
            if let Some(ready) = w.ready
                && ready >= start
                && ready < end
            {
                c.ready += 1;
                if ready + DAY <= now {
                    c.eligible += 1;
                    if w.useful.is_some_and(|at| at >= ready && at <= ready + DAY) {
                        c.activated += 1;
                        let seconds = (w.useful.unwrap_or(ready) - ready) as u64;
                        let bucket = if seconds == 0 {
                            0
                        } else {
                            seconds.next_power_of_two()
                        };
                        *result.time_to_value_seconds.entry(bucket).or_default() += 1;
                    }
                }
            }
            if let Some(useful) = w.useful
                && w.ready.is_some()
                && useful >= start
                && useful < end
            {
                increment(
                    &mut result.first_use_sources,
                    w.source.as_deref().unwrap_or("unattributed"),
                );
                if let Some(campaign) = &w.campaign {
                    increment(&mut result.first_use_campaigns, campaign);
                }
                let day = chrono::DateTime::from_timestamp(useful, 0)
                    .expect("validated time")
                    .date_naive();
                if day + chrono::Duration::days(2) <= today {
                    c.d1_eligible += 1;
                    c.d1_returned += u64::from(days.contains(&(day + chrono::Duration::days(1))));
                }
                if day + chrono::Duration::days(8) <= today {
                    c.d7_eligible += 1;
                    c.d7_returned += u64::from(days.contains(&(day + chrono::Duration::days(7))));
                }
            }
        }
        result.counts.sources.clear();
        result.counts.campaigns.clear();
        for (source, campaign) in attribution.values() {
            increment(&mut result.counts.sources, source);
            if let Some(campaign) = campaign {
                increment(&mut result.counts.campaigns, campaign);
            }
        }
        result.sessions = sessions.len();
        result.trials = trials.intersection(&sessions).count();
        result.active_workspaces = active.len();
        result.api_workspaces = api.len();
        result.cohorts = cohorts.into_values().collect();

        Ok(result)
    }
    pub async fn attribute(&self, workspace: &str, attribution: super::Attribution) -> Result<()> {
        if workspace.is_empty()
            || workspace.len() > 128
            || attribution.campaign.as_ref().is_some_and(|v| {
                v.len() > 40
                    || !v
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            })
            || attribution.at > Utc::now().timestamp() + 60
            || attribution.at < Utc::now().timestamp() - 600
        {
            return Err(ServiceError::new(422, "INVALID_ANALYTICS_ATTRIBUTION"));
        }
        let key = format!("attribution/{}", self.pseudonym(workspace));
        let scope = self.scope("");
        let old = self
            .metadata
            .execute(MetaRequest::Get {
                scope: scope.clone(),
                guard: None,
                keys: vec![key.clone()],
            })
            .await?;
        if !old["records"][&key].is_null() {
            return Ok(());
        }
        let day = chrono::DateTime::from_timestamp(attribution.at, 0)
            .ok_or_else(|| failure("ANALYTICS_TIME_INVALID"))?
            .date_naive();
        self.metadata.execute(MetaRequest::Commit{scope,guard:None,mutation_id:uuid::Uuid::new_v4().to_string(),changes:vec![json!({"key":key,"expectedVersion":null,"value":attribution}),json!({"key":format!("expiry/{day}/attribution-{}",self.pseudonym(workspace)),"expectedVersion":null,"value":{"dedup":key,"at":attribution.at}})]}).await?;
        Ok(())
    }
    pub async fn purge(&self, now: i64) -> Result<()> {
        let day = chrono::DateTime::from_timestamp(now, 0)
            .ok_or_else(|| failure("ANALYTICS_TIME_INVALID"))?
            .date_naive();
        let scope = self.scope("");
        for prefix in ["expiry/", "day/"] {
            let page = self
                .metadata
                .execute(MetaRequest::List {
                    scope: scope.clone(),
                    guard: None,
                    prefix: prefix.into(),
                    after: self.cleanup_cursors.lock().await.get(prefix).cloned(),
                    limit: 100,
                })
                .await?;
            let Some(records) = page["records"].as_array() else {
                return Err(failure("ANALYTICS_CORRUPT"));
            };
            if records.len() == 100 {
                if let Some(last) = records.last().and_then(|v| v["key"].as_str()) {
                    self.cleanup_cursors
                        .lock()
                        .await
                        .insert(prefix.into(), last.into());
                }
            } else {
                self.cleanup_cursors.lock().await.remove(prefix);
            }
            let mut removals = Vec::new();
            for entry in records {
                let key = entry["key"]
                    .as_str()
                    .ok_or_else(|| failure("ANALYTICS_CORRUPT"))?;
                let Some(date) = key
                    .split('/')
                    .nth(1)
                    .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
                else {
                    continue;
                };
                let expired = if prefix == "expiry/" {
                    date <= day - chrono::Duration::days(30)
                } else if key.contains("/aggregate/") {
                    date <= day - chrono::Duration::days(90)
                } else {
                    date <= day - chrono::Duration::days(30)
                };
                if !expired {
                    continue;
                }
                let mut changes =
                    vec![json!({"key":key,"expectedVersion":entry["version"],"delete":true})];
                if prefix == "expiry/"
                    && let Some(dedup) = entry["value"]["dedup"].as_str()
                {
                    let old = self
                        .metadata
                        .execute(MetaRequest::Get {
                            scope: scope.clone(),
                            guard: None,
                            keys: vec![dedup.into()],
                        })
                        .await?;
                    if !old["records"][dedup].is_null()
                        && old["records"][dedup]["value"]["at"] == entry["value"]["at"]
                    {
                        changes.push(json!({"key":dedup,"expectedVersion":old["records"][dedup]["version"],"delete":true}));
                    }
                }
                removals.extend(changes);
            }
            if !removals.is_empty() {
                self.metadata
                    .execute(MetaRequest::Commit {
                        scope: scope.clone(),
                        guard: None,
                        mutation_id: uuid::Uuid::new_v4().to_string(),
                        changes: removals,
                    })
                    .await?;
            }
        }
        Ok(())
    }
}
impl Counts {
    fn add(&mut self, other: &Self) {
        self.page_views += other.page_views;
        self.try_clicks += other.try_clicks;
        self.sign_in_clicks += other.sign_in_clicks;
        self.ready += other.ready;
        self.successes += other.successes;
        self.failures += other.failures;
        self.helpful += other.helpful;
        self.votes += other.votes;
        for (target, source) in [
            (&mut self.events, &other.events),
            (&mut self.sources, &other.sources),
            (&mut self.campaigns, &other.campaigns),
            (&mut self.journeys, &other.journeys),
        ] {
            for (k, v) in source {
                *target.entry(k.clone()).or_default() += v;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use workspace_contracts::Call;
    #[derive(Default)]
    struct Memory {
        records: std::sync::Mutex<BTreeMap<String, Value>>,
        unavailable: std::sync::atomic::AtomicBool,
    }
    impl Metadata for Memory {
        fn health(&self) -> Call<'_> {
            Box::pin(async { Ok(json!({})) })
        }
        fn execute(&self, request: MetaRequest) -> Call<'_> {
            Box::pin(async move {
                if self.unavailable.load(Ordering::Relaxed) {
                    return Err(failure("UNAVAILABLE"));
                }
                let mut all = self.records.lock().unwrap();
                match request {
                    MetaRequest::Get { scope, keys, .. } => {
                        let prefix = format!("{}:{}:", scope.authority_id, scope.partition_id);
                        let records = keys
                            .into_iter()
                            .map(|key| {
                                let value = all
                                    .get(&(prefix.clone() + &key))
                                    .cloned()
                                    .unwrap_or(Value::Null);
                                (key, value)
                            })
                            .collect::<serde_json::Map<_, _>>();
                        Ok(json!({"records":records}))
                    }
                    MetaRequest::Commit { scope, changes, .. } => {
                        let prefix = format!("{}:{}:", scope.authority_id, scope.partition_id);
                        for change in &changes {
                            let key = prefix.clone() + change["key"].as_str().unwrap();
                            if all.get(&key).unwrap_or(&Value::Null)["version"]
                                != change["expectedVersion"]
                            {
                                return Err(ServiceError::new(409, "CONFLICT"));
                            }
                        }
                        for change in changes {
                            let key = prefix.clone() + change["key"].as_str().unwrap();
                            if change["delete"] == true {
                                all.remove(&key);
                            } else {
                                all.insert(key,json!({"version":uuid::Uuid::new_v4().to_string(),"value":change["value"]}));
                            }
                        }
                        Ok(json!({}))
                    }
                    MetaRequest::List {
                        scope,
                        prefix,
                        after,
                        limit,
                        ..
                    } => {
                        let base = format!("{}:{}:", scope.authority_id, scope.partition_id);
                        let records = all
                            .iter()
                            .filter_map(|(key, v)| {
                                let key = key.strip_prefix(&base)?;
                                if !key.starts_with(&prefix)
                                    || after.as_deref().is_some_and(|s| key <= s)
                                {
                                    return None;
                                }
                                Some(json!({"key":key,"version":v["version"],"value":v["value"]}))
                            })
                            .take(limit)
                            .collect::<Vec<_>>();
                        Ok(json!({"records":records}))
                    }
                    _ => panic!("unsupported operation"),
                }
            })
        }
    }
    fn at(day: &str) -> i64 {
        NaiveDate::parse_from_str(day, "%Y-%m-%d")
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp()
    }
    fn job(id: &str, ws: &str, operation: &str, when: i64) -> Job {
        Job {
            id: id.into(),
            workspace: ws.into(),
            actor: "guest".into(),
            operation: operation.into(),
            success: true,
            at: when,
        }
    }
    #[tokio::test]
    async fn durable_dedup_cohorts_isolation_redaction_and_expiry() {
        let memory = Arc::new(Memory::default());
        let store = Store::new(memory.clone(), "region:test", vec![7; 32]).unwrap();
        let now = at("2026-11-04");
        for i in 0..10 {
            let ws = format!("private-workspace-{i}");
            store
                .server(job(
                    &format!("ready-{i}"),
                    &ws,
                    "workspace_ready",
                    at("2026-11-01"),
                ))
                .await
                .unwrap();
            if i < 4 {
                store
                    .server(job(
                        &format!("query-{i}"),
                        &ws,
                        "query",
                        at("2026-11-01") + 10,
                    ))
                    .await
                    .unwrap();
            }
            if i < 2 {
                store
                    .server(job(
                        &format!("return-{i}"),
                        &ws,
                        "analysis",
                        at("2026-11-02") + 10,
                    ))
                    .await
                    .unwrap();
            }
        }
        store
            .server(job(
                "query-0",
                "private-workspace-0",
                "query",
                at("2026-11-02"),
            ))
            .await
            .unwrap();
        let summary = store
            .summary(
                NaiveDate::parse_from_str("2026-11-01", "%Y-%m-%d").unwrap(),
                NaiveDate::parse_from_str("2026-11-04", "%Y-%m-%d").unwrap(),
                now,
            )
            .await
            .unwrap();
        assert_eq!(summary.counts.ready, 10);
        assert_eq!(summary.counts.successes, 6);
        assert_eq!(summary.active_workspaces, 4);
        assert_eq!(summary.cohorts[0].eligible, 10);
        assert_eq!(summary.cohorts[0].activated, 4);
        assert_eq!(summary.cohorts[0].d1_eligible, 4);
        assert_eq!(summary.cohorts[0].d1_returned, 2);
        assert!(
            !serde_json::to_string(&*memory.records.lock().unwrap())
                .unwrap()
                .contains("private-workspace")
        );
        let other = Store::new(memory.clone(), "region:other", vec![7; 32]).unwrap();
        assert_eq!(
            other
                .summary(
                    NaiveDate::parse_from_str("2026-11-01", "%Y-%m-%d").unwrap(),
                    NaiveDate::parse_from_str("2026-11-04", "%Y-%m-%d").unwrap(),
                    now
                )
                .await
                .unwrap()
                .active_workspaces,
            0
        );
        for _ in 0..10 {
            store.purge(now + 35 * DAY).await.unwrap();
        }
        {
            let records = memory.records.lock().unwrap();
            assert!(records.keys().all(|k| !k.contains("/raw/")
                && !k.contains("/projection/")
                && !k.contains("dedup/")));
            assert!(records.keys().any(|k| k.contains("/aggregate/")));
        }
        for _ in 0..10 {
            store.purge(now + 95 * DAY).await.unwrap();
        }
        assert!(memory.records.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn collection_does_not_acknowledge_storage_failure_or_duplicate_conflict() {
        let memory = Arc::new(Memory::default());
        let store = Store::new(memory.clone(), "global", vec![2; 32]).unwrap();
        let batch = || Batch {
            version: 1,
            session_id: uuid::Uuid::nil().to_string(),
            events: vec![super::super::BrowserInput {
                id: uuid::Uuid::nil().to_string(),
                event: BrowserEvent::TryClicked {
                    page: super::super::Page::Home,
                },
            }],
        };
        let now = Utc::now().timestamp();
        store.browser(batch(), now).await.unwrap();
        store.browser(batch(), now + DAY).await.unwrap();
        let mut changed = batch();
        changed.events[0].event = BrowserEvent::HelpfulVote { helpful: true };
        assert_eq!(
            store.browser(changed, now + DAY).await.unwrap_err().status,
            409
        );
        memory.unavailable.store(true, Ordering::Relaxed);
        assert!(store.browser(batch(), now).await.is_err());
    }
}
