//! First-party product measurement. Customer request diagnostics are a separate domain.
pub mod operator;
pub use workspace_analytics::{
    Attribution, Batch, BrowserEvent, BrowserInput, Client, Device, Journey, Page, Source, Summary,
    operation,
};

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    #[serde(default)]
    pub enabled: bool,
    pub service: workspace_analytics::ClientConfig,
}

#[cfg(test)]
mod tests;
