use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::{Method, RequestBuilder, Url, header};
use serde_json::{Value, json};
use std::time::Duration;
use workspace_test_support::{provider::NATIVE_SECRET, workspaces::Workspaces};
#[path = "workflows/agent.rs"]
mod agent;

struct Reply {
    data: Value,
    bytes: Vec<u8>,
    headers: header::HeaderMap,
    status: u16,
    url: Url,
}
async fn send(req: RequestBuilder) -> Result<Reply> {
    let r = req.send().await?;
    let status = r.status().as_u16();
    let url = r.url().clone();
    let headers = r.headers().clone();
    let bytes = r.bytes().await?.to_vec();
    ensure!(
        !bytes
            .windows(NATIVE_SECRET.len())
            .any(|w| w == NATIVE_SECRET.as_bytes()),
        "leaked native credential for {}",
        url.path()
    );
    let data = if headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|s| s.contains("application/json"))
        && !bytes.is_empty()
    {
        serde_json::from_slice(&bytes)?
    } else {
        Value::Null
    };
    Ok(Reply {
        data,
        bytes,
        headers,
        status,
        url,
    })
}
async fn check(req: RequestBuilder, status: u16, code: &str) -> Result<Reply> {
    let r = send(req).await?;
    ensure!(
        r.status == status,
        "{}: expected {status}, got {} ({})",
        r.url.path(),
        r.status,
        r.data["error"]["code"]
    );
    if !code.is_empty() {
        assert_eq!(r.data["error"]["code"], code, "{}", r.url.path());
    }
    Ok(r)
}
struct Key {
    meta: Value,
    token: String,
    expires: i64,
}
async fn key(f: &Workspaces, i: usize, scopes: &[&str], ids: &[&str]) -> Result<Key> {
    let k = f.create_key(i, "workflow", scopes, ids).await?;
    let token = f.exchange(i, text(&k, "secret")).await?;
    let claims: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD.decode(token.split('.').nth(1).context("regional token claims")?)?,
    )?;
    Ok(Key {
        meta: k["data"].clone(),
        token,
        expires: claims["exp"].as_i64().context("regional token expiry")?,
    })
}
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().expect(k)
}
fn get(f: &Workspaces, path: &str, t: &str) -> RequestBuilder {
    f.agent(0, Method::GET, path, Some(t))
}
fn post(f: &Workspaces, path: &str, t: &str) -> RequestBuilder {
    f.agent(0, Method::POST, path, Some(t))
}
fn delete(f: &Workspaces, path: &str, t: &str) -> RequestBuilder {
    f.agent(0, Method::DELETE, path, Some(t))
}
fn calls(f: &Workspaces) -> usize {
    f.provider.state.lock().unwrap().calls
}
fn follow(r: &Reply) -> Result<String> {
    Ok(r.url
        .join(r.headers[header::LOCATION].to_str()?)?
        .path()
        .to_owned())
}
fn relative(path: &str) -> &str {
    path.strip_prefix("/api/v1/workspaces/ws_agentlab")
        .unwrap_or(path)
}
fn setup(f: &Workspaces, id: &str, attempt: &str, t: &str) -> RequestBuilder {
    post(f, &format!("/resources/{id}/setup-attempts"), t).header("Idempotency-Key", attempt)
}
#[tokio::test]
#[ignore = "requires isolated RustFS and native binaries"]
async fn remote_agent_operations() -> Result<()> {
    agent::run(false).await
}
#[tokio::test]
#[ignore = "requires isolated RustFS and native binaries"]
async fn embedded_agent_operations() -> Result<()> {
    agent::run(true).await
}

#[path = "workflows/rest.rs"]
mod rest;
#[tokio::test]
#[ignore = "requires isolated RustFS and native binaries"]
async fn remote_rest_workflows() -> Result<()> {
    rest::run(false).await
}
#[tokio::test]
#[ignore = "requires isolated RustFS and native binaries"]
async fn embedded_rest_workflows() -> Result<()> {
    rest::run(true).await
}
