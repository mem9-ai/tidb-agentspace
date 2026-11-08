#[path = "common/openapi.rs"]
mod openapi;
#[path = "common/product.rs"]
mod product;

use anyhow::{Context, Result, ensure};
use jsonschema::Validator;
use reqwest::{Method, header};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use workspace_test_support::http_client;

fn contract() -> Value {
    serde_json::from_str(include_str!(
        "../../../tools/api-contract/portal-regional-openapi.json"
    ))
    .unwrap()
}
fn owner_contract() -> Value {
    serde_json::from_str(include_str!("../../../public/owner-openapi.json")).unwrap()
}
fn schema(contract: &Value, source: &Value) -> Result<Validator> {
    ensure!(source.is_object(), "operation schema missing");
    let mut root = source.clone();
    root["components"] = contract["components"].clone();
    Ok(jsonschema::draft202012::options()
        .should_validate_formats(false)
        .build(&root)?)
}

#[test]
fn resource_names_enforce_database_and_filesystem_rules() -> Result<()> {
    let api = contract();
    let create = &api["paths"]["/workspaces/{workspaceId}/resources"]["post"]["requestBody"]["content"]
        ["application/json"]["schema"];
    let validator = schema(&api, create)?;
    for (kind, name, valid) in [
        ("postgresql", "tidb_pg-example", true),
        ("filesystem", "tidb_pg-example", false),
        ("postgresql", "_tidb-pg", false),
        ("filesystem", "my-files", true),
        ("mysql", "retired-db", false),
        ("duckdb", "retired-db", false),
    ] {
        assert_eq!(
            validator.is_valid(&json!({"kind":kind,"name":name,"region":"automatic"})),
            valid,
            "{kind} {name}"
        );
    }
    Ok(())
}
#[test]
fn published_regional_owner_history_only_accepts_owner_sessions() {
    let api = owner_contract();
    let paths = api["paths"].as_object().unwrap();
    assert_eq!(
        paths.keys().map(String::as_str).collect::<BTreeSet<_>>(),
        BTreeSet::from([
            "/workspaces/{workspaceId}/audit-history",
            "/workspaces/{workspaceId}/request-history"
        ])
    );
    assert!(
        api["components"]["securitySchemes"]
            .get("workspaceKey")
            .is_none()
    );
    for entry in paths.values() {
        assert_eq!(
            entry["get"]["security"],
            json!([{"localOwner":[]},{"accountOwner":[]},{"guestOwner":[]}])
        );
    }
}

const REGIONAL: [&str; 6] = [
    "enrollRegionalRefreshFamily",
    "issueRegionalToken",
    "getRegionalRefreshFamily",
    "revokeRegionalRefreshFamily",
    "getRegionalTokenIssuance",
    "revokeRegionalAccessToken",
];

fn substitute(value: &mut Value, saved: &BTreeMap<String, Value>) -> Result<()> {
    match value {
        Value::String(s) if s == "$uuid" => *value = json!(uuid::Uuid::new_v4().to_string()),
        Value::String(s) if s.starts_with('$') => {
            let (name, path) = s[1..]
                .split_once('/')
                .context("expected $name/path in case data")?;
            *value = saved
                .get(name)
                .and_then(|v| v.pointer(&format!("/{path}")))
                .with_context(|| format!("unknown response reference: {s}"))?
                .clone();
        }
        Value::Object(o) => {
            for child in o.values_mut() {
                substitute(child, saved)?;
            }
        }
        Value::Array(a) => {
            for child in a {
                substitute(child, saved)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn all_regional_portal_operations_match_their_live_schemas() -> Result<()> {
    let product = product::Product::start().await?;
    let client = http_client()?;
    let published = client
        .get(format!("{}/owner-openapi.json", product.origin))
        .send()
        .await?;
    assert_eq!(published.status(), 200);
    let document_url = published.url().clone();
    let owner = published.json::<Value>().await?;
    assert_eq!(owner, owner_contract());
    let url = openapi::get_url(
        &document_url,
        &owner,
        "/workspaces/{workspaceId}/audit-history",
    )?;
    assert_eq!(
        url.as_str(),
        format!(
            "{}/api/v1/workspaces/ws_agentlab/audit-history",
            product.origin
        )
    );
    assert_eq!(client.get(url).send().await?.status(), 401);
    let api = contract();
    let mut ops = BTreeMap::new();
    for (path, item) in api["paths"].as_object().unwrap() {
        for (method, op) in item.as_object().unwrap() {
            if let Some(id) = op["operationId"].as_str() {
                let root = item
                    .pointer("/servers/0/url")
                    .unwrap_or(&api["servers"][0]["url"])
                    .as_str()
                    .unwrap();
                assert!(
                    ops.insert(id, (path, method, root, op)).is_none(),
                    "duplicate {id}"
                );
            }
        }
    }
    let mut saved = BTreeMap::new();
    let mut covered = BTreeSet::new();
    let mut validators = BTreeMap::new();
    let mut cookie = None::<String>;
    let cases: Vec<Value> = serde_json::from_str(include_str!("cases/portal-operations.json"))?;
    let mut bootstrap = Value::Null;
    for mut case in cases {
        substitute(&mut case, &saved)?;
        let id = case["operation"].as_str().unwrap();
        let &(path, method, root, op) = ops
            .get(id)
            .with_context(|| format!("undocumented operation {id}"))?;
        let mut route = path.replace("{workspaceId}", "ws_agentlab");
        for param in [
            "resourceId",
            "keyId",
            "tableName",
            "preparationId",
            "attemptId",
        ] {
            if let Some(value) = case[param].as_str() {
                route = route.replace(&format!("{{{param}}}"), value);
            }
        }
        assert!(!route.contains('{'), "{id}: unresolved path parameter");
        let uri = format!(
            "{}{}{}{}",
            product.origin,
            root.trim_end_matches('/'),
            route,
            case["query"].as_str().unwrap_or("")
        );
        let mut req = client
            .request(
                Method::from_bytes(method.to_ascii_uppercase().as_bytes())?,
                uri,
            )
            .header(header::CONTENT_TYPE, "application/json");
        if case["owner"] != false
            && let Some(c) = &cookie
        {
            req = req.header(header::COOKIE, c);
        }
        if let Some(headers) = case["headers"].as_object() {
            for (k, v) in headers {
                req = req.header(k, v.as_str().unwrap());
            }
        }
        if let Some(body) = case.get("body") {
            req = req.json(body);
        }
        let response = req.send().await.with_context(|| format!("request {id}"))?;
        let headers = response.headers().clone();
        let status = response.status().as_u16();
        let bytes = response.bytes().await?;
        let expected = case["status"].as_u64().unwrap() as u16;
        let result = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)
                .with_context(|| format!("{id} response is not JSON ({status})"))?
        };
        assert_eq!(
            status,
            expected,
            "{id}: {}",
            result.pointer("/error/code").unwrap_or(&Value::Null)
        );
        if status == 204 {
            assert!(bytes.is_empty(), "{id}");
        } else {
            let key = (id.to_owned(), status);
            if !validators.contains_key(&key) {
                let source =
                    &op["responses"][status.to_string()]["content"]["application/json"]["schema"];
                validators.insert(
                    key.clone(),
                    schema(&api, source)
                        .with_context(|| format!("response schema {id} {status}"))?,
                );
            }
            let validator = &validators[&key];
            if let Err(err) = validator.validate(&result) {
                anyhow::bail!("{id} schema mismatch at {}: {}", err.instance_path(), err);
            }
        }
        if status < 300 {
            covered.insert(id.to_owned());
        }
        if id == "getBootstrap" {
            bootstrap = result.clone();
        }
        if let Some(save) = case["save"].as_str() {
            if save == "session" {
                let c = headers
                    .get(header::SET_COOKIE)
                    .context("owner session cookie missing")?
                    .to_str()?
                    .split(';')
                    .next()
                    .unwrap();
                workspace_test_support::session::assert_session_contract(c);
                cookie = Some(c.to_owned());
            } else if save == "tutorial" {
                assert_eq!(
                    headers.get(header::ETAG).unwrap().to_str()?,
                    result["data"]["version"].as_str().unwrap()
                );
            }
            saved.insert(save.to_owned(), result);
        }
    }
    assert_eq!(saved["salesSample"]["data"]["status"], "failed");
    assert_eq!(saved["salesSample"]["data"]["errorCode"], "FREE_TIER_LIMIT");
    assert_eq!(
        saved["reportMetadata"]["data"]["version"],
        saved["savedReport"]["data"]["version"]
    );
    assert_eq!(
        saved["textCapabilities"]["engines"][0]["input"],
        json!({"path":"/contract.txt","workingDirectory":"/workspace","aliases":["/workspace/input.log"],"fileVariable":"FILE"})
    );
    assert_eq!(
        saved["csvCapabilities"]["engines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["engine"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["duckdb", "bash"]
    );
    let other_fixtures = [
        "exchangePortalRegionSession",
        "uploadFile",
        "downloadFile",
        "startGuestSession",
        "logoutGuestSession",
        "startTidbLogin",
        "completeTidbLogin",
    ];
    let declared: BTreeSet<_> = ops
        .keys()
        .filter(|id| !REGIONAL.contains(id) && !other_fixtures.contains(id))
        .map(|id| id.to_string())
        .collect();
    assert_eq!(covered, declared);
    bootstrap.as_object_mut().unwrap().remove("workspace");
    assert!(!schema(&api, &api["components"]["schemas"]["Bootstrap"])?.is_valid(&bootstrap));
    Ok(())
}
