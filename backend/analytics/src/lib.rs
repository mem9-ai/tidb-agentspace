//! First-party product measurement. Customer request diagnostics are a separate domain.
mod client;
pub mod config;
mod database;
pub mod server;
mod storage;
mod store;
pub use client::Client;
pub use config::ClientConfig;
pub use store::Summary;

use serde::{Deserialize, Serialize};
use workspace_contracts::{Result, ServiceError};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Page {
    Home,
    GetStarted,
    SalesGuide,
    ApiDocs,
    Workspace,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Search,
    AiReferral,
    Social,
    Other,
    DirectOrUnknown,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Journey {
    Agent,
    SelfService,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Device {
    Mobile,
    Desktop,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "name", rename_all = "snake_case", deny_unknown_fields)]
pub enum BrowserEvent {
    PublicPageView {
        page: Page,
        source: Source,
        device: Device,
        campaign: Option<String>,
    },
    TryClicked {
        page: Page,
    },
    SignInClicked {
        page: Page,
    },
    JourneySelected {
        journey: Journey,
    },
    HelpfulVote {
        helpful: bool,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserInput {
    pub id: String,
    pub event: BrowserEvent,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Batch {
    pub version: u8,
    pub session_id: String,
    pub events: Vec<BrowserInput>,
}
impl Batch {
    pub fn validate(&self, campaigns: &[String]) -> Result<()> {
        if self.version != 1
            || !uuid(&self.session_id)
            || self.events.is_empty()
            || self.events.len() > 20
        {
            return Err(ServiceError::new(422, "INVALID_ANALYTICS_BATCH"));
        }
        for e in &self.events {
            if !uuid(&e.id) {
                return Err(ServiceError::new(422, "INVALID_ANALYTICS_EVENT"));
            }
            if let BrowserEvent::PublicPageView {
                campaign: Some(c), ..
            } = &e.event
                && !campaigns.contains(c)
            {
                return Err(ServiceError::new(422, "UNKNOWN_CAMPAIGN"));
            }
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Attribution {
    pub source: Source,
    pub campaign: Option<String>,
    pub at: i64,
}
fn uuid(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok_and(|v| v.to_string() == s)
}

/// Only fixed operation labels enter this domain; caller-provided paths never persist.
pub fn operation(method: &str, route: &str) -> Option<&'static str> {
    match (method, route) {
        ("POST", "/queries") => Some("query"),
        ("POST", "/file-analyses") => Some("analysis"),
        ("POST", "/database-imports") => Some("import"),
        ("POST", "/result-exports" | "/file-exports") => Some("export"),
        ("PUT", "/files" | "/files/content") => Some("file_write"),
        ("POST", "/resources") => Some("resource_create"),
        ("GET", "/files/content") => Some("file_read"),
        ("POST", "/sales-sample-attempts") => Some("sample_ready"),
        _ if method == "GET" && route == "/files/tabular-preview" => Some("preview"),
        _ => None,
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Job {
    pub id: String,
    pub workspace: String,
    pub actor: String,
    pub operation: String,
    pub success: bool,
    pub at: i64,
}
impl Job {
    pub fn validate(&self) -> Result<()> {
        let safe = |s: &str| {
            !s.is_empty()
                && s.len() <= 128
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-.:".contains(&b))
        };
        if !safe(&self.id)
            || !safe(&self.workspace)
            || !(["guest", "account", "api"].contains(&self.actor.as_str())
                || (self.actor == "browser" && self.operation == "trial"))
            || ![
                "workspace_ready",
                "trial",
                "sign_in_completed",
                "query",
                "analysis",
                "import",
                "export",
                "preview",
                "report_saved",
                "file_read",
                "file_write",
                "resource_create",
                "sample_ready",
            ]
            .contains(&self.operation.as_str())
            || self.at < chrono::Utc::now().timestamp() - 900
            || self.at > chrono::Utc::now().timestamp() + 30
        {
            return Err(ServiceError::new(422, "INVALID_ANALYTICS_JOB"));
        }
        Ok(())
    }
}
