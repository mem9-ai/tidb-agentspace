use super::*;
use reqwest::{Method, RequestBuilder, header};
use std::sync::LazyLock;
use workspace_openapi::View;
use workspace_test_support::global::Global;

static CONTRACT: LazyLock<Value> = LazyLock::new(|| View::PortalGlobal.document());

pub(super) async fn checked(
    req: RequestBuilder,
    status: u16,
) -> Result<(Value, header::HeaderMap)> {
    let (body, headers, _) = documented(req, &[status], &CONTRACT, false).await?;
    Ok((body, headers))
}

pub(super) async fn documented(
    req: RequestBuilder,
    expected: &[u16],
    contract: &Value,
    regional: bool,
) -> Result<(Value, header::HeaderMap, String)> {
    let method = req
        .try_clone()
        .context("clone request")?
        .build()?
        .method()
        .as_str()
        .to_ascii_lowercase();
    let resp = req.send().await?;
    let path = resp.url().path().to_owned();
    let route = if regional {
        path.strip_prefix("/api/v1")
            .context("regional API prefix")?
    } else {
        &path
    };
    let status = resp.status().as_u16();
    let headers = resp.headers().clone();
    let bytes = resp.bytes().await?;
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice::<Value>(&bytes)?
    };
    ensure!(
        expected.contains(&status),
        "{method} {path}: expected {expected:?}, got {status} ({})",
        body["error"]["code"]
    );
    let lookup = |path: &str| {
        contract["paths"]
            .as_object()
            .unwrap()
            .iter()
            .find_map(|(pattern, item)| {
                let mut left = pattern.split('/');
                let mut right = path.split('/');
                loop {
                    match (left.next(), right.next()) {
                        (Some(a), Some(b)) if a == b || (a.starts_with('{') && !b.is_empty()) => {}
                        (None, None) => return item.get(&method),
                        _ => return None,
                    }
                }
            })
    };
    let op = lookup(route)
        .or_else(|| {
            (status >= 400)
                .then(|| lookup(&route.replace("/api/v1/", "/api/portal/v1/")))
                .flatten()
        })
        .context("undocumented operation")?;
    let response = op["responses"]
        .get(status.to_string())
        .unwrap_or(&op["responses"]["default"]);
    if status == 204 {
        ensure!(
            bytes.is_empty() && response.is_object(),
            "expected declared empty response"
        );
    } else {
        let mut schema = response["content"]["application/json"]["schema"].clone();
        ensure!(schema.is_object(), "missing response schema");
        schema["components"] = contract["components"].clone();
        let validator = jsonschema::draft202012::options()
            .should_validate_formats(false)
            .build(&schema)?;
        ensure!(
            validator.is_valid(&body),
            "{method} {path}: response violated its contract"
        );
    }
    Ok((
        body,
        headers,
        op["operationId"].as_str().context("operation ID")?.into(),
    ))
}
pub(super) async fn key_lifecycle(
    f: &Fixture,
    g: &mut Global,
    alice: &str,
    bob: &str,
    cookie: &str,
) -> Result<()> {
    let expires = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs()
        + 3600;
    // Lifetime is a privilege: the server decides the ceiling, not the client.
    for (expiry, code) in [
        (expires + 200 * 86400, "INVALID_EXPIRY"),
        (expires - 7200, "INVALID_EXPIRY"),
    ] {
        let (body, _) = checked(
            g.owner(Method::POST, alice, cookie, "/keys")
                .header("Idempotency-Key", id())
                .json(&json!({"scopes":["resources:read"],"resourceIds":["fs_existing"],"expiresAt":expiry})),
            400,
        )
        .await?;
        assert_eq!(body["error"]["code"], code);
    }
    let create = json!({"scopes":["resources:read","files:read"],"resourceIds":["fs_existing"],"expiresAt":expires});
    let op = id();
    let (created, headers) = checked(
        g.owner(Method::POST, alice, cookie, "/keys")
            .header("Idempotency-Key", &op)
            .json(&create),
        201,
    )
    .await?;
    let secret = field(&created, "secret");
    assert!(secret.starts_with("awk_"));
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    let key = field(&created["data"], "keyId");
    let detail = format!("/keys/{key}");
    let versions = format!("{detail}/versions");
    let collection = reqwest::Url::parse(&format!("{}/api/v1/workspaces/{alice}/keys", g.origin))?;
    let location = collection.join(headers[header::LOCATION].to_str()?)?;
    assert_eq!(
        location.path(),
        format!("/api/v1/workspaces/{alice}/keys/{key}")
    );
    checked(
        g.owner(Method::POST, alice, cookie, "/keys")
            .header("Idempotency-Key", &op)
            .json(&create),
        409,
    )
    .await?;
    checked(g.owner(Method::GET, bob, cookie, "/keys"), 401).await?;
    let hostile = g
        .http
        .post(format!(
            "{}/api/portal/v1/workspaces/{alice}/keys",
            g.origin
        ))
        .header(header::COOKIE, cookie)
        .header(header::ORIGIN, "https://hostile.example")
        .header("Idempotency-Key", id())
        .json(&create);
    checked(hostile, 403).await?;
    checked(g.agent(Method::GET, alice, secret, "/keys"), 403).await?;
    let view = checked(g.owner(Method::GET, alice, cookie, &detail), 200)
        .await?
        .0;
    assert!(view["data"].get("verifier").is_none());
    assert_eq!(view["grants"]["resourceIds"], json!(["fs_existing"]));
    assert_eq!(
        checked(g.owner(Method::GET, alice, cookie, "/keys?limit=1"), 200)
            .await?
            .0["data"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let issuance = json!({"audience":"global","scopes":["resources:read"]});
    let issue = |g: &Global, secret: &str, body: &Value| {
        g.agent(Method::POST, alice, secret, "/token-issuances")
            .json(body)
    };
    let (issued, headers) = checked(issue(g, secret, &issuance), 201).await?;
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    let token = field(&issued, "accessToken");
    assert_eq!(
        checked(g.agent(Method::GET, alice, token, "/regions"), 200)
            .await?
            .0["data"][0]["regionId"],
        "region:other"
    );
    assert!(
        checked(
            g.agent(
                Method::GET,
                alice,
                token,
                &format!("/token-issuances/{}", field(&issued, "id"))
            ),
            200
        )
        .await?
        .0["data"]
            .get("accessToken")
            .is_none()
    );
    checked(
        issue(
            g,
            secret,
            &json!({"audience":"global","scopes":["queries:execute"]}),
        ),
        403,
    )
    .await?;
    checked(issue(g, secret, &json!({"audience":"region:other"})), 409).await?;
    g.config["initializeClock"] = false.into();
    g.restart(f).await?;
    checked(g.agent(Method::GET, alice, token, "/regions"), 200).await?;
    assert_eq!(
        checked(g.owner(Method::GET, alice, cookie, &detail), 200)
            .await?
            .0["data"]["keyVersion"],
        1
    );
    let mutate = |req: RequestBuilder, version: u8| {
        req.header("Idempotency-Key", id())
            .header(header::IF_MATCH, format!("\"{version}\""))
    };
    let rotated = checked(
        mutate(g.owner(Method::POST, alice, cookie, &versions), 1),
        201,
    )
    .await?
    .0;
    let new_secret = field(&rotated, "secret");
    assert_ne!(new_secret, secret);
    checked(issue(g, secret, &issuance), 401).await?;
    assert_eq!(
        checked(
            g.owner(Method::GET, alice, cookie, &format!("{versions}/1")),
            200
        )
        .await?
        .0["data"]["keyVersion"],
        1
    );
    let before = checked(issue(g, new_secret, &issuance), 201).await?.0;
    checked(
        mutate(g.owner(Method::PATCH, alice, cookie, &detail), 2)
            .json(&json!({"expiresAt":expires+3600})),
        200,
    )
    .await?;
    // Renewal must not hand out a lifetime that creation would refuse.
    let (body, _) = checked(
        mutate(g.owner(Method::PATCH, alice, cookie, &detail), 3)
            .json(&json!({"expiresAt":expires+200*86400})),
        400,
    )
    .await?;
    assert_eq!(body["error"]["code"], "INVALID_EXPIRY");
    for invalid in [token, field(&before, "accessToken")] {
        checked(g.agent(Method::GET, alice, invalid, "/regions"), 401).await?;
    }
    checked(issue(g, new_secret, &issuance), 201).await?;
    checked(
        mutate(g.owner(Method::DELETE, alice, cookie, &detail), 2),
        412,
    )
    .await?;
    checked(
        mutate(g.owner(Method::DELETE, alice, cookie, &detail), 3),
        202,
    )
    .await?;
    checked(issue(g, new_secret, &issuance), 401).await?;
    Ok(())
}
