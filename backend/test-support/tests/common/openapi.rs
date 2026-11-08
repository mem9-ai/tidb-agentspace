use anyhow::{Context, Result};
use reqwest::Url;
use serde_json::Value;

/// Resolve the operation as an OpenAPI client would, including override precedence.
pub fn get_url(document_url: &Url, document: &Value, path: &str) -> Result<Url> {
    let item = &document["paths"][path];
    let operation = item.get("get").context("undocumented GET")?;
    let server = [operation, item, document]
        .into_iter()
        .find_map(|value| value.pointer("/servers/0/url").and_then(Value::as_str))
        .context("GET has no server")?;
    let mut target = document_url.join(server)?;
    target.set_path(&format!(
        "{}{}",
        target.path().trim_end_matches('/'),
        path.replace("{workspaceId}", "ws_agentlab"),
    ));
    Ok(target)
}
