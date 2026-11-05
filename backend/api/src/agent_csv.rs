//! Private agent Guest entry. Only a fixed CSV in its own managed Workspace is addressable.
//! The project capability is independent of browser cookies, sample proofs and Workspace Keys.
use super::{
    App, ConnectInfo, Method, Request, Response, SocketAddr, product_response, reject, to_bytes,
};
use axum::{Json, http::HeaderMap, response::IntoResponse};
use serde_json::{Value, json};
use std::{collections::BTreeMap, time::Duration};
use workspace_contracts::Result;
use workspace_identity::CsvGuestKey;
use workspace_product::{Reply, Request as ProductRequest};

const LIMIT: usize = 1024 * 1024;
const SOURCE: &str = "/source.csv";

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Result<Option<&'a str>> {
    if headers.get_all(name).iter().count() > 1 {
        return Err(reject(400, "DUPLICATE_HEADER"));
    }
    headers
        .get(name)
        .map(|v| v.to_str().map_err(|_| reject(400, "INVALID_HEADER")))
        .transpose()
}

pub(super) async fn handle(app: &App, tail: &str, request: Request) -> Result<Response> {
    let runtime = app
        .guest_runtime
        .as_ref()
        .filter(|r| r.guest_enabled)
        .ok_or_else(|| reject(404, "NOT_FOUND"))?;
    if request.headers().contains_key("cookie")
        || request.headers().contains_key("origin")
        || request.uri().query().is_some()
    {
        return Err(reject(400, "NATIVE_CSV_CLIENT_REQUIRED"));
    }
    let key = CsvGuestKey::parse(
        header(request.headers(), "authorization")?
            .and_then(|v| v.strip_prefix("CsvWorkspace "))
            .ok_or_else(|| reject(401, "CSV_CREDENTIAL_REQUIRED"))?,
    )?;
    if tail == "workspaces" && request.method() == Method::POST {
        let peer = request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .ok_or_else(|| reject(403, "PEER_REQUIRED"))?
            .0
            .ip();
        let empty =
            tokio::time::timeout(Duration::from_secs(5), to_bytes(request.into_body(), 0)).await;
        if !matches!(empty, Ok(Ok(_))) {
            return Err(reject(400, "UNEXPECTED_BODY"));
        }
        let guest = runtime.entry.csv_guest(&key, peer).await?;
        let id = &guest.registration.workspace_id;
        let credential = runtime.region.csv_credential(id, &key).await?;
        let managed = runtime.workspaces.acquire(id, &credential).await?;
        let product = managed
            .product()
            .ok_or_else(|| reject(503, "FILES_UNAVAILABLE"))?;
        let caps = product.capabilities();
        if caps["filesystem"]["provider"] != "drive9-anonymous" {
            return Err(reject(503, "LIVE_FILES_REQUIRED"));
        }
        let input = json!({"name":"my-files","kind":"filesystem","region":caps["filesystem"]["regions"][0],"onlyIfNew":true});
        let raw = serde_json::to_vec(&input).map_err(|_| reject(500, "INVALID_INPUT"))?;
        let (_, reply) = managed
            .handle(ProductRequest {
                credential,
                actor: "CSV agent",
                method: "POST",
                route: "/resources",
                query: &BTreeMap::new(),
                input,
                raw: &raw,
                condition: Some("csv-workspace-files-v1"),
                if_match: None,
                if_none_match: None,
                binary_upload: false,
                table_name: None,
            })
            .await?;
        let Reply::Json(result) = reply else {
            return Err(reject(503, "FILES_UNAVAILABLE"));
        };
        let resource = &result["data"];
        if resource["status"] != "active" || !resource["connectionError"].is_null() {
            return Err(reject(503, "FILES_UNAVAILABLE"));
        }
        let resource_id = resource["id"]
            .as_str()
            .ok_or_else(|| reject(503, "FILES_UNAVAILABLE"))?;
        return Ok(Json(
            json!({"workspaceId":id,"resourceId":resource_id,"expiresAt":guest.expires_at}),
        )
        .into_response());
    }
    let parts: Vec<_> = tail.split('/').collect();
    let ["workspaces", id, "sources", resource, operation] = parts.as_slice() else {
        return Err(reject(404, "NOT_FOUND"));
    };
    if !uuid::Uuid::parse_str(id).is_ok_and(|u| u.to_string() == *id)
        || resource.len() > 100
        || resource.is_empty()
    {
        return Err(reject(404, "NOT_FOUND"));
    }
    let method = request.method().clone();
    let route = match (&method, *operation) {
        (&Method::GET, "metadata") => "/files/metadata",
        (&Method::GET | &Method::PUT, "content") => "/files/content",
        _ => return Err(reject(404, "NOT_FOUND")),
    };
    let credential = runtime.region.csv_credential(id, &key).await?;
    let managed = runtime.workspaces.acquire(id, &credential).await?;
    let headers = request.headers().clone();
    let prior = header(&headers, "if-match")?;
    let absent = header(&headers, "if-none-match")?;
    let mut raw = axum::body::Bytes::new();
    if method == Method::PUT {
        if prior.is_none() && absent.is_none() {
            return Err(reject(428, "PRECONDITION_REQUIRED"));
        }
        if header(&headers, "content-type")? != Some("text/csv") {
            return Err(reject(415, "CSV_REQUIRED"));
        }
        raw = tokio::time::timeout(
            Duration::from_secs(15),
            to_bytes(request.into_body(), LIMIT),
        )
        .await
        .map_err(|_| reject(408, "BODY_TIMEOUT"))?
        .map_err(|_| reject(413, "FILE_TOO_LARGE"))?;
        if raw.is_empty() || raw.contains(&0) || std::str::from_utf8(&raw).is_err() {
            return Err(reject(422, "UTF8_CSV_REQUIRED"));
        }
    }
    let query = BTreeMap::from([
        ("resourceId".into(), (*resource).into()),
        ("path".into(), SOURCE.into()),
    ]);
    let (status, reply) = managed
        .handle(ProductRequest {
            credential,
            actor: "CSV agent",
            method: method.as_str(),
            route,
            query: &query,
            input: Value::Null,
            raw: &raw,
            condition: None,
            if_match: prior,
            if_none_match: absent,
            binary_upload: method == Method::PUT,
            table_name: None,
        })
        .await?;
    product_response(status, reply)
}
