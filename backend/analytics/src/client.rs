use crate::config::private_file;
use crate::{Attribution, Batch, ClientConfig, Job, Summary};
use chrono::{NaiveDate, Utc};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::mpsc;
use workspace_contracts::{Result, ServiceError};

#[derive(Clone)]
pub struct Client {
    transport: Arc<Transport>,
    sender: mpsc::Sender<Job>,
    pending: Arc<AtomicU64>,
    unconfirmed: Arc<AtomicU64>,
}
struct Transport {
    http: reqwest::Client,
    endpoint: String,
    token: Arc<String>,
    authority: String,
}
fn unavailable() -> ServiceError {
    ServiceError::new(503, "ANALYTICS_UNAVAILABLE")
}
impl Client {
    /// Static configuration only: an unavailable analytics process never blocks API startup.
    pub fn new(config: &ClientConfig, authority: &str) -> Result<Self> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        config
            .validate(config.insecure_loopback)
            .map_err(|_| unavailable())?;
        let token = crate::config::token(&config.token_file).map_err(|_| unavailable())?;
        let mut builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy();
        if let Some(tls) = &config.tls {
            let ca = std::fs::read(&tls.ca_file).map_err(|_| unavailable())?;
            let mut identity = std::fs::read(&tls.certificate_file).map_err(|_| unavailable())?;
            identity.push(b'\n');
            identity.extend_from_slice(
                &private_file(&tls.private_key_file).map_err(|_| unavailable())?,
            );
            builder = builder
                .tls_certs_only(
                    reqwest::Certificate::from_pem_bundle(&ca).map_err(|_| unavailable())?,
                )
                .identity(reqwest::Identity::from_pem(&identity).map_err(|_| unavailable())?)
                .tls_version_min(reqwest::tls::Version::TLS_1_3)
                .tls_version_max(reqwest::tls::Version::TLS_1_3);
        }
        let (sender, mut receiver) = mpsc::channel(1000);
        let transport = Arc::new(Transport {
            http: builder.build().map_err(|_| unavailable())?,
            endpoint: config.endpoint.clone(),
            token: Arc::new(token),
            authority: authority.into(),
        });
        let pending = Arc::new(AtomicU64::new(0));
        let unconfirmed = Arc::new(AtomicU64::new(0));
        let client = Self {
            transport: transport.clone(),
            sender,
            pending: pending.clone(),
            unconfirmed: unconfirmed.clone(),
        };
        let worker = transport;
        tokio::spawn(async move {
            while let Some(job) = receiver.recv().await {
                let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
                let mut jobs = vec![job];
                while jobs.len() < 64 {
                    match tokio::time::timeout_at(deadline, receiver.recv()).await {
                        Ok(Some(job)) => jobs.push(job),
                        _ => break,
                    }
                }
                let count = jobs.len() as u64;
                let value = json!({"jobs":jobs});
                let mut accepted = false;
                for attempt in 0..3 {
                    match worker.post("/native", &value).await {
                        Ok(_) => {
                            accepted = true;
                            break;
                        }
                        Err(error) if error.status < 500 && error.status != 429 => break,
                        Err(_) => {}
                    }
                    if attempt < 2 {
                        tokio::time::sleep(Duration::from_millis(250 << attempt)).await;
                    }
                }
                if accepted {
                    unconfirmed.fetch_sub(count, Ordering::Relaxed);
                }
                pending.fetch_sub(count, Ordering::Relaxed);
            }
        });
        Ok(client)
    }
    async fn post(&self, path: &str, body: &Value) -> Result<Value> {
        self.transport.post(path, body).await
    }
    pub fn authority(&self) -> &str {
        &self.transport.authority
    }
    pub fn mark_unconfirmed(&self) {
        self.unconfirmed.fetch_add(1, Ordering::Relaxed);
    }
    pub fn record(&self, id: &str, workspace: &str, actor: &str, operation: &str, success: bool) {
        self.unconfirmed.fetch_add(1, Ordering::Relaxed);
        let job = Job {
            id: id.into(),
            workspace: workspace.into(),
            actor: actor.into(),
            operation: operation.into(),
            success,
            at: Utc::now().timestamp(),
        };
        if job.validate().is_err() {
            return;
        }
        if self
            .pending
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                (n < 1000).then_some(n + 1)
            })
            .is_err()
        {
            return;
        }
        if self.sender.try_send(job).is_err() {
            self.pending.fetch_sub(1, Ordering::Relaxed);
        }
    }
    pub async fn browser(&self, batch: Batch, _at: i64) -> Result<()> {
        self.post(
            "/browser",
            &serde_json::to_value(batch).map_err(|_| unavailable())?,
        )
        .await?;
        Ok(())
    }
    pub async fn attribute(&self, workspace: &str, attribution: Attribution) -> Result<()> {
        self.post(
            "/attribution",
            &json!({"workspace":workspace,"attribution":attribution}),
        )
        .await?;
        Ok(())
    }
    pub async fn summary(&self, from: NaiveDate, to: NaiveDate, _now: i64) -> Result<Summary> {
        let value = self
            .post(
                "/summary",
                &json!({"from":from.to_string(),"to":to.to_string()}),
            )
            .await?;
        let mut summary: Summary = serde_json::from_value(value).map_err(|_| unavailable())?;
        if summary.authority != self.authority() {
            return Err(unavailable());
        }
        summary.unconfirmed_events = summary
            .unconfirmed_events
            .saturating_add(self.unconfirmed.load(Ordering::Relaxed));
        Ok(summary)
    }
}

impl Transport {
    async fn post(&self, path: &str, body: &Value) -> Result<Value> {
        let response = self
            .http
            .post(format!("{}/analytics/v1{path}", self.endpoint))
            .bearer_auth(self.token.as_str())
            .header("x-analytics-authority", &self.authority)
            .json(body)
            .send()
            .await
            .map_err(|_| unavailable())?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(ServiceError::new(
                match status {
                    409 | 422 | 429 => status,
                    _ => 503,
                },
                match status {
                    409 => "ANALYTICS_EVENT_CONFLICT",
                    422 => "INVALID_ANALYTICS_BATCH",
                    429 => "ANALYTICS_CAPACITY",
                    _ => "ANALYTICS_UNAVAILABLE",
                },
            ));
        }
        use futures::StreamExt;
        let mut chunks = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = chunks.next().await {
            bytes.extend_from_slice(&chunk.map_err(|_| unavailable())?);
            if bytes.len() > 64 * 1024 {
                return Err(unavailable());
            }
        }
        serde_json::from_slice(&bytes).map_err(|_| unavailable())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn absent_service_does_not_block_startup_or_enqueue_and_queue_is_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("producer-token");
        std::fs::write(&path, "a".repeat(64)).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let started = std::time::Instant::now();
        let client = Client::new(
            &ClientConfig {
                endpoint: "http://127.0.0.1:1".into(),
                token_file: path,
                insecure_loopback: true,
                tls: None,
            },
            "region:test",
        )
        .unwrap();
        for id in 0..1001 {
            client.record(&format!("event-{id}"), "workspace", "api", "query", true);
        }
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(client.pending.load(Ordering::Relaxed), 1000);
        assert_eq!(client.unconfirmed.load(Ordering::Relaxed), 1001);
        let today = Utc::now().date_naive();
        assert_eq!(
            client
                .summary(
                    today,
                    today + chrono::Duration::days(1),
                    Utc::now().timestamp()
                )
                .await
                .err()
                .unwrap()
                .status,
            503
        );
        assert_eq!(client.unconfirmed.load(Ordering::Relaxed), 1001);
    }
    #[tokio::test]
    async fn peer_auth_failure_is_unavailability_and_redirects_are_not_followed() {
        use axum::{Router, http::StatusCode, routing::post};
        use std::sync::atomic::AtomicU16;
        let status = Arc::new(AtomicU16::new(403));
        let follows = Arc::new(AtomicU64::new(0));
        let peer = status.clone();
        let trap = follows.clone();
        let router = Router::new()
            .route(
                "/analytics/v1/summary",
                post(move || {
                    let peer = peer.clone();
                    async move {
                        (
                            StatusCode::from_u16(peer.load(Ordering::Relaxed)).unwrap(),
                            [("location", "/followed")],
                        )
                    }
                }),
            )
            .route(
                "/followed",
                post(move || {
                    let trap = trap.clone();
                    async move {
                        trap.fetch_add(1, Ordering::Relaxed);
                        StatusCode::NO_CONTENT
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let directory = tempfile::tempdir().unwrap();
        let token = directory.path().join("token");
        std::fs::write(&token, "b".repeat(64)).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&token, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let client = Client::new(
            &ClientConfig {
                endpoint,
                token_file: token,
                insecure_loopback: true,
                tls: None,
            },
            "global",
        )
        .unwrap();
        let today = Utc::now().date_naive();
        for code in [403, 302] {
            status.store(code, Ordering::Relaxed);
            assert_eq!(
                client
                    .summary(
                        today,
                        today + chrono::Duration::days(1),
                        Utc::now().timestamp()
                    )
                    .await
                    .err()
                    .unwrap()
                    .status,
                503
            );
        }
        assert_eq!(follows.load(Ordering::Relaxed), 0);
        server.abort();
    }
}
