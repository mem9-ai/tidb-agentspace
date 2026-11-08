#[path = "sso/site.rs"]
mod site;
use anyhow::{Context, Result, ensure};
use reqwest::Method;
use serde_json::{Value, json};
use site::{AUTH, BASE, Browser, GLOBAL, Profile, Site, expect, now, response, workspace_scope};
use std::{fs, process::Command, time::Duration};
use uuid::Uuid;
use workspace_test_support::{binary, http_client, private_json};

#[tokio::test]
#[ignore = "requires a loopback listener"]
async fn oidc_fixture_drains_open_connections() -> Result<()> {
    let mut oidc =
        workspace_test_support::oidc::Provider::start("fixture", "https://example.test/return")
            .await?;
    let http = http_client()?;
    let stream = http
        .get(format!("{}/fixture-held-connection", oidc.issuer))
        .send()
        .await?;
    tokio::time::timeout(Duration::from_secs(5), async {
        oidc.close().await?;
        ensure!(
            stream.bytes().await?.is_empty(),
            "Held stream did not close"
        );
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated RustFS and native binaries"]
async fn hosted_sso_verifies_browser_identity_grants_and_single_use_state() -> Result<()> {
    let f = Site::new(Profile::Shared, false, json!({})).await?;
    let b = &f.browser;
    assert_eq!(
        b.get("/studio/api/auth/config", "", 200).await?.body["enabled"],
        true
    );
    b.post("/api/session", "", json!({}), 403).await?;
    b.get(BASE, "", 401).await?;
    for (key, value) in [
        ("Host", "hostile.example"),
        ("Origin", "http://studio.example.test"),
    ] {
        expect(
            b.request(Method::GET, "/api/auth/config", "")
                .headers(site::override_header(key, value)),
            403,
        )
        .await?;
    }
    let flow = b.flow(false).await?;
    assert!(
        flow.login.cookies()[0]
            .contains("HttpOnly; SameSite=Lax; Secure; Path=/studio/api/auth/tidbcloud")
    );
    let signed = b.callback(&flow, 302).await?;
    assert_eq!(signed.location(), "https://studio.example.test/studio/");
    assert!(signed.cookies()[0].contains("HttpOnly; SameSite=Strict; Secure; Path=/studio/"));
    let cookie = signed.cookie("aw_session")?;
    b.get(&format!("/studio{BASE}"), &cookie, 200).await?;
    expect(
        b.request(Method::GET, BASE, "")
            .header("Cookie", &cookie)
            .bearer_auth("invalid"),
        401,
    )
    .await?;
    assert_eq!(
        b.callback(&flow, 400).await?.body["error"]["code"],
        "SSO_STATE_INVALID"
    );
    let updated=expect(b.request(Method::PATCH,&format!("{BASE}/settings"),&cookie).json(&json!({"workspaceName":"SSO workspace","name":"Alice","description":"SSO audited"})),200).await?;
    let request_id = updated.headers["x-request-id"].to_str()?;
    let audit = b
        .get(&format!("{BASE}/audit-history"), &cookie, 200)
        .await?;
    let records: Vec<_> = audit.body["data"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|record| record["requestId"] == request_id)
        .collect();
    assert_eq!(records.len(), 2);
    let actor = records[0]["actor"]["id"]
        .as_str()
        .unwrap()
        .strip_prefix("owner-")
        .context("Missing anonymized actor")?;
    assert!(
        actor.len() == 64
            && actor
                .bytes()
                .all(|x| x.is_ascii_hexdigit() && !x.is_ascii_uppercase())
    );
    assert!(!serde_json::to_string(&records)?.contains("alice"));
    let events = b
        .get(&format!("{BASE}/events"), &cookie, 200)
        .await?
        .body
        .to_string();
    assert!(events.contains("tidb:alice") && !events.contains(&cookie));
    b.post(&format!("{AUTH}/logout"), &cookie, json!({}), 200)
        .await?;
    b.get(BASE, &cookie, 401).await?;
    for (claims, bad, status) in [
        (json!({"iss":"https://other.example/"}), false, 401),
        (json!({"aud":"wrong"}), false, 401),
        (json!({"nonce":"wrong"}), false, 401),
        (json!({"exp":1}), false, 401),
        (json!({"sub":["alice"]}), false, 401),
        (json!({}), true, 401),
        (json!({"sub":"bob"}), false, 403),
        (
            json!({"sub":"bob","email":"bob@example.org","email_verified":"true"}),
            false,
            403,
        ),
        (
            json!({"sub":"bob","email":"bob@example.org.evil","email_verified":true}),
            false,
            403,
        ),
        (json!({"org_id":"other"}), false, 403),
        (
            json!({"sub":"bob","email":"BOB@EXAMPLE.ORG","email_verified":true}),
            false,
            302,
        ),
    ] {
        f.oidc.claims(claims);
        f.oidc.bad_signature(bad);
        let r = b.login(false, status).await?;
        assert!(r.cookies().iter().any(|c| c.contains("Max-Age=0")));
        if status != 302 {
            assert!(r.cookie("aw_session").is_err());
        }
    }
    f.oidc.claims(json!({}));
    f.oidc.bad_signature(false);
    let mut mismatch = b.flow(false).await?;
    let state = std::mem::replace(&mut mismatch.state, "wrong".into());
    b.callback(&mismatch, 400).await?;
    mismatch.state = state;
    assert_eq!(
        b.callback(&mismatch, 400).await?.body["error"]["code"],
        "SSO_STATE_INVALID"
    );
    let mut bound = b.flow(false).await?;
    bound.cookie.clear();
    b.callback(&bound, 400).await?;
    let mut limited = false;
    for index in 0..25 {
        let r = response(
            b.request(Method::GET, &format!("{AUTH}/login"), "")
                .header("X-Forwarded-For", format!("192.0.2.{index}")),
        )
        .await?;
        limited = r.status == 429;
    }
    assert!(limited);
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated RustFS and native binaries"]
async fn oidc_discovery_mismatch_is_sanitized() -> Result<()> {
    let s = Site::new(Profile::Shared, false, json!({})).await?;
    s.oidc
        .discovery_issuer(Some("https://unexpected.example".into()));
    let r = s.browser.get(&format!("{AUTH}/login"), "", 503).await?;
    assert!(!r.body.to_string().contains("unexpected.example"));
    Ok(())
}

async fn workspace(b: &Browser, cookie: &str) -> Result<String> {
    let r = b.get("/api/v1/workspaces", cookie, 200).await?;
    assert_eq!(r.body["data"].as_array().unwrap().len(), 1);
    Ok(r.body["data"][0]["id"].as_str().unwrap().into())
}

#[tokio::test]
#[ignore = "requires isolated RustFS and native binaries"]
async fn account_login_with_guest_signup_disabled() -> Result<()> {
    let s = Site::new(Profile::AccountOnly, false, json!({})).await?;
    let b = &s.browser;
    assert_eq!(
        b.get("/api/auth/config", "", 200).await?.body["guestEnabled"],
        false
    );
    b.post("/api/auth/guest", "", json!({}), 404).await?;
    let cookie = b.login(false, 302).await?.cookie("aw_account")?;
    assert_ne!(workspace(b, &cookie).await?, "ws_agentlab");
    Ok(())
}

async fn verify_retirement(mode: Profile) -> Result<()> {
    let mut s = Site::new(mode, false, json!({})).await?;
    let purge = || {
        Command::new(binary("workspace-backend"))
            .args(["purge-legacy", "--config"])
            .arg(&s.hosted_plan)
            .args(["--workspace", "ws_agentlab"])
            .env("WORKSPACE_GUEST_ENABLED", "true")
            .output()
    };
    if mode == Profile::RetireOnStart {
        let cookie = s.browser.login(false, 302).await?.cookie("aw_account")?;
        workspace(&s.browser, &cookie).await?;
    }
    s.process.as_mut().unwrap().stop()?;
    if mode == Profile::Retire {
        let output = purge()?;
        assert!(
            output.status.success()
                && String::from_utf8_lossy(&output.stdout)
                    .contains("Legacy Workspace live metadata and credentials removed")
        );
    }
    let mut region = s
        .fixture
        .start_meta(s.region.server.clone(), false, None)
        .await?;
    assert_eq!(region.call(json!({"op":"list","scope":workspace_scope("ws_agentlab","workspace"),"prefix":"","limit":100})).await?["records"],json!([]));
    assert_eq!(region.call(json!({"op":"get","scope":workspace_scope("unrelated-workspace","workspace"),"keys":["state/workspace"]})).await?["records"]["state/workspace"]["value"]["id"],"unrelated-workspace");
    region.process.stop()?;
    if mode == Profile::Retire {
        assert!(purge()?.status.success());
    }
    Ok(())
}
#[tokio::test]
#[ignore = "requires isolated RustFS and native binaries"]
async fn retirement_is_scoped_and_repeatable() -> Result<()> {
    verify_retirement(Profile::Retire).await?;
    verify_retirement(Profile::RetireOnStart).await
}

#[tokio::test]
#[ignore = "requires isolated RustFS and native binaries"]
async fn one_callback_authorizes_independent_owner_sessions_for_both_gateway_paths() -> Result<()> {
    for stripped in [false, true] {
        let s = Site::new(Profile::Global, stripped, json!({})).await?;
        let b = &s.browser;
        let health = format!("{GLOBAL}/api/health");
        b.get(&health, "", 200).await?;
        expect(
            b.request(Method::GET, &health, "")
                .headers(site::override_header("Host", "gateway.example.test")),
            200,
        )
        .await?;
        expect(
            b.request(Method::POST, "/studio/api/v1/token-issuances", "")
                .headers(site::override_header("Host", "gateway.example.test"))
                .json(&json!({"audience":"region"})),
            401,
        )
        .await?;
        for header in ["Host", "Origin"] {
            expect(
                b.request(Method::GET, &health, "")
                    .headers(site::override_header(header, "unexpected.example")),
                403,
            )
            .await?;
        }
        assert_eq!(
            b.get(&format!("{GLOBAL}/openapi.json"), "", 200)
                .await?
                .body["servers"][0]["url"],
            "https://studio.example.test/studio/api/global"
        );
        let delegated = b
            .get(
                &format!("{GLOBAL}/api/auth/tidbcloud/login?workspaceId=ignored"),
                "",
                303,
            )
            .await?;
        assert_eq!(delegated.location(), "/studio/api/auth/tidbcloud/login");
        assert!(delegated.cookies().is_empty());
        let flow = b.flow(false).await?;
        let accepted = b.callback(&flow, 302).await?;
        let account = accepted.cookie("aw_account")?;
        let owner = accepted.cookie("aw_global_owner")?;
        let hdr = accepted
            .cookies()
            .into_iter()
            .find(|c| c.starts_with("aw_global_owner="))
            .unwrap();
        for component in ["HttpOnly", "Secure", "SameSite=Strict", "Path=/studio/;"] {
            assert!(hdr.contains(component));
        }
        let ws = workspace(b, &account).await?;
        let session = format!("{GLOBAL}/api/auth/session?workspaceId={ws}");
        b.get(&session, &owner, 200).await?;
        b.get(&session, &account, 401).await?;
        b.get(&format!("/studio/api/v1/workspaces/{ws}"), &owner, 401)
            .await?;
        b.get(
            &format!("{GLOBAL}/api/auth/session?workspaceId=another-workspace"),
            &owner,
            401,
        )
        .await?;
        b.callback(&flow, 400).await?;
        let root = format!("{GLOBAL}/api/v1/workspaces/{ws}");
        let key=expect(b.request(Method::POST,&format!("{root}/keys"),&owner).header("Idempotency-Key",Uuid::new_v4().to_string())
            .json(&json!({"name":"Research agent","scopes":["resources:read","resources:write"],"resourceIds":["*"],"expiresAt":now()+3600})),201).await?;
        assert_eq!(key.body["regionalStatus"], "applied");
        let token = expect(
            b.request(Method::POST, &format!("{root}/token-issuances"), "")
                .bearer_auth(key.body["secret"].as_str().unwrap())
                .json(&json!({"audience":"region:native-sso"})),
            201,
        )
        .await?;
        let access = token.body["accessToken"].as_str().unwrap();
        use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
        let claims: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(access.split('.').nth(1).unwrap())?)?;
        assert_eq!(
            claims["iss"],
            "https://studio.example.test/studio/api/global"
        );
        assert_eq!(token.body["region"]["apiPathPrefix"], "/studio");
        expect(
            b.request(
                Method::POST,
                &format!("/studio/api/v1/workspaces/{ws}/resources"),
                "",
            )
            .bearer_auth(access)
            .json(
                &json!({"kind":"filesystem","name":"research-files","region":"aws-ap-southeast-1"}),
            ),
            201,
        )
        .await?;
        let quit = b
            .post(
                &format!("{AUTH}/logout"),
                &format!("{account}; {owner}"),
                json!({}),
                200,
            )
            .await?;
        assert!(
            quit.cookies()
                .iter()
                .any(|c| c.starts_with("aw_global_owner=;") && c.contains("Path=/studio/;"))
        );
        b.get(&session, &owner, 401).await?;
        b.get("/studio/api/v1/workspaces", &account, 401).await?;
    }
    Ok(())
}

async fn guest(browser: &Browser) -> Result<(String, String)> {
    let r = browser
        .post("/studio/api/auth/guest", "", json!({}), 200)
        .await?;
    Ok((
        r.body["workspaceId"].as_str().unwrap().into(),
        r.cookie("aw_guest")?,
    ))
}

async fn guest_key(
    b: &Browser,
    workspace: &str,
    cookie: &str,
    scopes: Value,
    targets: Value,
) -> Result<String> {
    let path = format!("{GLOBAL}/api/v1/workspaces/{workspace}/keys");
    let r=expect(b.request(Method::POST,&path,cookie).header("Idempotency-Key",Uuid::new_v4().to_string())
        .json(&json!({"name":"guest-agent","scopes":scopes,"resourceIds":targets,"expiresAt":now()+30*86400})),201).await?;
    assert_eq!(r.body["regionalStatus"], "applied");
    let expiry = r.body["data"]["expiresAt"]
        .as_u64()
        .context("Missing Key expiration")?;
    assert!((now() + 172700..=now() + 172800).contains(&expiry));
    Ok(r.body["secret"].as_str().unwrap().into())
}

async fn issue(b: &Browser, path: &str, secret: &str, audience: &str) -> Result<site::Reply> {
    response(
        b.request(Method::POST, path, "")
            .bearer_auth(secret)
            .json(&json!({"audience":audience})),
    )
    .await
}

#[tokio::test]
#[ignore = "requires isolated RustFS and native binaries"]
async fn guest_scoped_global_and_regional_credentials_are_isolated_and_revoked_on_logout()
-> Result<()> {
    for local in [true, false] {
        let f = Site::new(
            if local {
                Profile::LocalGuest
            } else {
                Profile::Global
            },
            !local,
            json!({}),
        )
        .await?;
        let b = &f.browser;
        let (ws, cookie) = guest(b).await?;
        let (other, other_cookie) = guest(b).await?;
        let own = format!("/studio/api/v1/workspaces/{ws}");
        let global = format!("{GLOBAL}/api/v1/workspaces/{ws}");
        let keys = format!("{global}/keys");
        assert_eq!(b.get(&keys, &cookie, 200).await?.body["data"], json!([]));
        b.get(&keys, &other_cookie, 404).await?;
        let spec = b.get("/studio/api/openapi.json", "", 200).await?.body;
        assert_eq!(
            spec["servers"][0]["url"],
            format!("{}/studio/api", b.public_origin)
        );
        assert!(spec["paths"]["/v1/token-issuances"]["post"].is_object());
        let session = |id: &str| format!("{GLOBAL}/api/auth/session?workspaceId={id}");
        b.get(&session(&ws), &cookie, 200).await?;
        b.get(&session(&other), &cookie, 404).await?;
        b.get(&session(&ws), "", 401).await?;
        let fs=b.post(&format!("{own}/resources"),&cookie,json!({"name":"guest-agent-test","kind":"filesystem","region":"aws-ap-southeast-1"}),201).await?.body["data"]["id"].clone();
        let secret = guest_key(
            b,
            &ws,
            &cookie,
            json!(["resources:read", "files:read", "files:write"]),
            json!([fs]),
        )
        .await?;
        let central_path = "/studio/api/v1/token-issuances";
        let global_token = issue(b, central_path, &secret, "global").await?;
        assert_eq!(global_token.status, 201);
        assert_eq!(global_token.body["workspaceId"], ws);
        assert!(
            global_token
                .location()
                .starts_with(&format!("/studio/api/v1/workspaces/{ws}/issuances/"))
        );
        let token = global_token.body["accessToken"].as_str().unwrap();
        expect(
            b.request(Method::GET, global_token.location(), "")
                .bearer_auth(token),
            200,
        )
        .await?;
        let stripped = issue(b, "/api/v1/token-issuances", &secret, "global").await?;
        assert_eq!(stripped.status, 201);
        assert_eq!(stripped.body["workspaceId"], ws);
        expect(
            b.request(
                Method::GET,
                &format!("/api/v1/workspaces/{ws}/region-route"),
                "",
            )
            .bearer_auth(stripped.body["accessToken"].as_str().unwrap()),
            307,
        )
        .await?;
        let route = expect(
            b.request(Method::GET, &format!("{own}/region-route"), "")
                .bearer_auth(token),
            307,
        )
        .await?;
        assert_eq!(route.headers["x-region-id"], "region:native-sso");
        assert_eq!(route.location(), format!("{}/studio", b.public_origin));
        assert_ne!(
            response(
                b.request(
                    Method::GET,
                    &format!("/studio/api/v1/workspaces/{other}/region-route"),
                    ""
                )
                .bearer_auth(token)
            )
            .await?
            .status,
            307
        );
        assert_ne!(
            response(
                b.request(Method::GET, &format!("{global}/region-route"), "")
                    .bearer_auth(&secret)
            )
            .await?
            .status,
            307
        );
        let direct = issue(b, central_path, &secret, "region").await?;
        assert_eq!(direct.status, 201);
        assert_eq!(direct.body["workspaceId"], ws);
        assert_eq!(direct.body["region"]["regionId"], "region:native-sso");
        assert_eq!(
            format!(
                "{}{}",
                direct.body["region"]["apiOrigin"].as_str().unwrap(),
                direct.body["region"]["apiPathPrefix"].as_str().unwrap()
            ),
            route.location()
        );
        let exchange = format!("{global}/token-issuances");
        let region = issue(b, &exchange, &secret, "region:native-sso").await?;
        assert_eq!(region.status, 201);
        let regional = region.body["accessToken"].as_str().unwrap();
        let resources = format!("{own}/resources");
        let files = format!("{own}/files");
        let listing = format!("{files}?resourceId={}", fs.as_str().unwrap());
        assert!(
            expect(
                b.request(Method::GET, &resources, "").bearer_auth(regional),
                200
            )
            .await?
            .body["data"]
                .is_array()
        );
        let put = || {
            b.request(Method::PUT,&files,"").bearer_auth(regional).json(&json!({"resourceId":fs,"path":"/agent.txt","type":"file","content":"guest test"}))
        };
        expect(put(), 200).await?;
        let read = expect(
            b.request(Method::GET, &listing, "").bearer_auth(regional),
            200,
        )
        .await?;
        assert!(
            read.body["data"]
                .as_array()
                .unwrap()
                .iter()
                .any(|f| f["path"] == "/agent.txt" && f["content"] == "guest test")
        );
        b.post("/studio/api/auth/guest/logout", &cookie, json!({}), 200)
            .await?;
        assert_ne!(
            issue(b, &exchange, &secret, "region:native-sso")
                .await?
                .status,
            201
        );
        assert_ne!(issue(b, central_path, &secret, "region").await?.status, 201);
        assert_ne!(
            response(
                b.request(Method::GET, &format!("{own}/regions"), "")
                    .bearer_auth(token)
            )
            .await?
            .status,
            200
        );
        for path in [&listing, &resources] {
            assert_ne!(
                response(b.request(Method::GET, path, "").bearer_auth(regional))
                    .await?
                    .status,
                200
            );
        }
        assert_ne!(response(put()).await?.status, 200);
        b.get(
            &format!("{GLOBAL}/api/v1/workspaces/{other}/keys"),
            &other_cookie,
            200,
        )
        .await?;
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated RustFS and native binaries"]
async fn scoped_guest_analyzes_sales_and_preserves_conditional_report() -> Result<()> {
    let f = Site::new(Profile::Global, true, json!({})).await?;
    let b = &f.browser;
    let (ws, cookie) = guest(b).await?;
    let own = format!("/studio/api/v1/workspaces/{ws}");
    let r = expect(
        b.request(
            Method::POST,
            &format!("{own}/sales-sample-attempts"),
            &cookie,
        )
        .header("Idempotency-Key", Uuid::new_v4().to_string())
        .json(&json!({"fixture":"us-sales-v1"})),
        201,
    )
    .await?;
    assert_eq!(r.body["data"]["status"], "ready");
    let fs = &r.body["data"]["resourceId"];
    let secret = guest_key(
        b,
        &ws,
        &cookie,
        json!([
            "resources:read",
            "files:read",
            "files:analyze",
            "files:write"
        ]),
        json!([fs]),
    )
    .await?;
    let token_path = "/studio/api/v1/token-issuances";
    let issued = issue(b, token_path, &secret, "region").await?;
    assert_eq!(issued.status, 201);
    let token = issued.body["accessToken"].as_str().unwrap();
    let analysis=expect(b.request(Method::POST,&format!("{own}/file-analyses"),"").bearer_auth(token)
        .json(&json!({"resourceId":fs,"path":"/us-sales.csv","engine":"duckdb","sql":"SELECT state, SUM(sales_usd) AS sales FROM file GROUP BY state ORDER BY sales DESC"})),200).await?;
    assert_eq!(analysis.body["readOnly"], true);
    let rows: Vec<_> = analysis.body["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["state"].as_str().unwrap(),
                r["sales"]
                    .to_string()
                    .trim_matches('"')
                    .parse::<f64>()
                    .unwrap() as u32,
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            ("California", 48000),
            ("Texas", 20000),
            ("New York", 12000),
            ("Washington", 8000),
            ("Florida", 7000),
            ("Massachusetts", 5000)
        ]
    );
    let files = format!("{own}/files");
    let mut report = json!({"resourceId":fs,"path":"/us-sales-report.md","type":"file","content":"# Sales report\nCalifornia: $48,000\n"});
    expect(
        b.request(Method::PUT, &files, "")
            .bearer_auth(token)
            .header("If-None-Match", "*")
            .json(&report),
        200,
    )
    .await?;
    let fresh = issue(b, token_path, &secret, "region").await?;
    assert_eq!(fresh.status, 201);
    let read = expect(
        b.request(
            Method::GET,
            &format!(
                "{files}/content?resourceId={}&path=%2Fus-sales-report.md&preview=1",
                fs.as_str().unwrap()
            ),
            "",
        )
        .bearer_auth(fresh.body["accessToken"].as_str().unwrap()),
        200,
    )
    .await?;
    assert!(
        read.body["content"]
            .as_str()
            .unwrap()
            .contains("California: $48,000")
    );
    report["content"] = json!("overwrite");
    expect(
        b.request(Method::PUT, &files, "")
            .bearer_auth(token)
            .header("If-None-Match", "*")
            .json(&report),
        412,
    )
    .await?;
    Ok(())
}

use workspace_test_support::provider::{Provider, SqlResponse};
fn settings(origin: &str) -> Value {
    json!({"providers":{"filesProvider":"drive9-anonymous","postgresProvider":"db9-anonymous","testMode":true,
        "drive9Endpoint":origin,"db9Endpoint":format!("{origin}/customer"),"sqlFixture":format!("{origin}/sql")}})
}
#[tokio::test]
#[ignore = "requires isolated RustFS and native binaries"]
async fn sso_logout_during_create_prevents_import_rows() -> Result<()> {
    for profile in [Profile::Shared, Profile::Personal] {
        let provider = Provider::start(false).await?;
        let s = Site::new(profile, false, settings(&provider.origin)).await?;
        let b = &s.browser;
        let name = if profile == Profile::Personal {
            "aw_account"
        } else {
            "aw_session"
        };
        let cookie = b.login(false, 302).await?.cookie(name)?;
        let root = if profile == Profile::Personal {
            format!("/api/v1/workspaces/{}", workspace(b, &cookie).await?)
        } else {
            BASE.into()
        };
        let resource = expect(
            b.request(Method::POST, &format!("{root}/resources"), &cookie)
                .header("Idempotency-Key", "native-sso-import")
                .json(
                    &json!({"name":"sso-import-target","kind":"postgresql","region":"automatic"}),
                ),
            201,
        )
        .await?;
        assert_eq!(resource.body["data"]["status"], "active");
        let id = resource.body["data"]["id"].as_str().unwrap();
        let prep=expect(b.request(Method::POST,&format!("{root}/database-import-preparations?resourceId={id}&filename=input.csv&format=csv&header=true&delimiter=%2C"),&cookie).header("Content-Type","application/octet-stream").body("id\n001\n"),201).await?;
        let commit = json!({"resourceId":id,"preparationId":prep.body["id"],"confirmed":true,"table":"mid_logout_import","fields":prep.body["fields"]});
        let path = format!("{root}/database-imports");
        let other = b.login(false, 302).await?.cookie(name)?;
        assert_eq!(
            b.post(&path, &other, commit.clone(), 409).await?.body["error"]["code"],
            "IMPORT_PREPARATION_UNAVAILABLE"
        );
        let logout = b.clone();
        let original = cookie.clone();
        provider.set_sql_hook(move |input| {
            let logout = logout.clone();
            let original = original.clone();
            async move {
                if input["sql"].as_str().unwrap().starts_with("CREATE TABLE") {
                    logout
                        .post(&format!("{AUTH}/logout"), &original, json!({}), 200)
                        .await
                        .unwrap();
                }
                None
            }
        });
        provider.state.lock().unwrap().statements.clear();
        let result = b.post(&path, &cookie, commit, 502).await?;
        assert_eq!(result.body["error"]["code"], "EXPORT_INCOMPLETE");
        let state = provider.state.lock().unwrap();
        assert_eq!(
            state
                .statements
                .iter()
                .filter(|s| s.starts_with("CREATE TABLE"))
                .count(),
            1
        );
        assert!(!state.statements.iter().any(|s| s.starts_with("INSERT")));
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated RustFS and native binaries"]
async fn two_personal_workspaces_stay_isolated_and_serve_during_global_outage() -> Result<()> {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let provider = Provider::start(true).await?;
    let inserted = Arc::new(AtomicBool::new(false));
    provider.set_sql_hook(move |input|{
        let inserted=inserted.clone();async move{
            match input["sql"].as_str()?{
                "INSERT INTO outage_test VALUES (42)"=>{inserted.store(true,Ordering::SeqCst);Some(SqlResponse::Json(200,json!({"columns":[],"rows":[],"rowCount":0,"affectedRows":1})))},
                "SELECT id FROM outage_test"=>{let rows=if inserted.load(Ordering::SeqCst){json!([{"id":42}])}else{json!([])};Some(SqlResponse::Json(200,json!({"columns":["id"],"rows":rows,"rowCount":rows.as_array().unwrap().len(),"affectedRows":0})))},
                _=>None,
            }
        }
    });
    let mut s = Site::new(Profile::Personal, false, settings(&provider.origin)).await?;
    let b = s.browser.clone();
    let mut accounts = Vec::new();
    for subject in ["alice", "bob"] {
        s.oidc.claims(json!({"sub":subject,"name":format!("{subject} Example"),"email":format!("{subject}@example.org"),"email_verified":subject=="alice"}));
        let r = b.login(false, 302).await?;
        let cookie = r.cookie("aw_account")?;
        workspace_test_support::session::assert_session_contract(&cookie);
        assert!(
            r.cookies()
                .iter()
                .any(|h| h.contains("HttpOnly") && h.contains("Secure"))
        );
        accounts.push((workspace(&b, &cookie).await?, cookie));
    }
    let [(alice, a), (bob, bc)] = &accounts[..] else {
        unreachable!()
    };
    assert_ne!(alice, bob);
    assert_ne!(alice, "ws_agentlab");
    let ap = s.policy(alice).await?;
    let bp = s.policy(bob).await?;
    for field in ["userId", "organizationId"] {
        assert_ne!(ap[field], bp[field]);
    }
    assert_eq!(ap["identity"]["subject"], "alice");
    assert_eq!(bp["identity"]["subject"], "bob");
    let av = format!("/api/v1/workspaces/{alice}");
    let bv = format!("/api/v1/workspaces/{bob}");
    b.get(&bv, &a.replace(alice, bob), 401).await?;
    let alice_profile = json!({"name":"alice Example","email":"alice@example.org"});
    assert_eq!(
        b.get("/api/auth/config", a, 200).await?.body["account"],
        alice_profile
    );
    assert_eq!(
        b.get("/api/auth/config", bc, 200).await?.body["account"],
        json!({"name":"bob Example"})
    );
    assert!(
        b.get("/api/auth/config", "", 200)
            .await?
            .body
            .get("account")
            .is_none()
    );
    assert_eq!(
        b.get("/api/auth/config", a, 200).await?.body["sessionKind"],
        "account"
    );
    b.get(&bv, a, 404).await?;
    b.get(&av, bc, 404).await?;
    b.get(BASE, a, 404).await?;
    expect(
        b.request(Method::GET, BASE, "")
            .bearer_auth("old-shared-key"),
        401,
    )
    .await?;
    let mut ids = Vec::new();
    for (root, cookie, kind, region) in [
        (&av, a, "postgresql", "automatic"),
        (&bv, bc, "filesystem", "aws-ap-southeast-1"),
    ] {
        let r = expect(
            b.request(Method::POST, &format!("{root}/resources"), cookie)
                .header("Idempotency-Key", format!("account-{kind}"))
                .json(&json!({"name":format!("private-{kind}"),"kind":kind,"region":region})),
            201,
        )
        .await?;
        ids.push(r.body["data"]["id"].as_str().unwrap().to_owned());
    }
    for (root, cookie, own, other) in [
        (&av, a, "private-postgresql", "private-filesystem"),
        (&bv, bc, "private-filesystem", "private-postgresql"),
    ] {
        let body = b
            .get(&format!("{root}/resources"), cookie, 200)
            .await?
            .body
            .to_string();
        assert!(body.contains(own) && !body.contains(other));
    }
    expect(b.request(Method::PATCH,&format!("{av}/settings"),a).json(&json!({"workspaceName":"Alice private workspace","name":"Alice","description":"Private data"})),200).await?;
    assert!(
        !b.get(&bv, bc, 200)
            .await?
            .body
            .to_string()
            .contains("Alice private workspace")
    );
    b.post(&format!("{av}/keys"), a, json!({}), 404).await?;
    expect(
        b.request(Method::GET, &format!("{av}/resources"), "")
            .bearer_auth("retired-key"),
        401,
    )
    .await?;
    s.oidc.claims(json!({"sub":"alice","name":"alice Example","email":"alice@example.org","email_verified":true}));
    assert_eq!(
        &workspace(&b, &b.login(false, 302).await?.cookie("aw_account")?).await?,
        alice
    );
    let (g, gc) = guest(&b).await?;
    assert!(&g != alice && &g != bob);
    b.get(&av, &gc, 404).await?;
    s.stop()?;
    s.steady();
    let mut offline = s.global.as_ref().unwrap().server.clone();
    offline["s3"]["prefix"] = json!("intentionally-offline-account-global");
    private_json(&s.fixture.directory().join("global-managed.json"), &offline)?;
    s.start().await?;
    assert_eq!(
        b.get("/api/auth/config", a, 200).await?.body["account"],
        alice_profile
    );
    assert!(
        b.get("/api/auth/config", &gc, 200)
            .await?
            .body
            .get("account")
            .is_none()
    );
    for sql in [
        "INSERT INTO outage_test VALUES (42)",
        "SELECT id FROM outage_test",
    ] {
        let r = b
            .post(
                &format!("{av}/queries"),
                a,
                json!({"resourceId":ids[0],"sql":sql}),
                200,
            )
            .await?;
        assert!(
            provider
                .state
                .lock()
                .unwrap()
                .statements
                .iter()
                .any(|s| s == sql)
        );
        if sql.starts_with("SELECT") {
            assert_eq!(r.body["rows"], json!([{"id":42}]));
        }
    }
    let path = format!(
        "{bv}/files/content?resourceId={}&path=%2Fglobal-outage.bin",
        ids[1]
    );
    let bytes = vec![0, 255, 17, 42];
    expect(
        b.request(Method::PUT, &path, bc)
            .header("Content-Type", "application/octet-stream")
            .body(bytes.clone()),
        200,
    )
    .await?;
    assert_eq!(
        b.request(Method::GET, &path, bc)
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?,
        bytes
    );
    b.get(&path, a, 404).await?;
    b.get(&av, a, 200).await?;
    b.get(&bv, bc, 200).await?;
    b.get(&format!("/api/v1/workspaces/{g}"), &gc, 200).await?;
    s.oidc.subject("new-user");
    b.login(false, 503).await?;
    b.post(&format!("{AUTH}/logout"), a, json!({}), 200).await?;
    b.get(&av, a, 401).await?;
    b.get(&bv, bc, 200).await?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires isolated RustFS and native binaries"]
async fn hosted_bootstrap_runs_offline_then_steady_host_reopens_without_seeding() -> Result<()> {
    let mut s = Site::prepare(Profile::Global, false, json!({})).await?;
    let dir = s.fixture.directory().to_owned();
    s.config["insecureLoopback"] = json!(false);
    s.config["sso"]["issuer"] = json!("https://identity.example.test/");
    s.config["sso"]["allowLoopbackHttp"] = json!(false);
    s.save()?;
    let mut plan: Value = serde_json::from_slice(&fs::read(&s.hosted_plan)?)?;
    for role in plan["services"].as_array_mut().unwrap() {
        if role["kind"] == "metadata" {
            role["initialize"] = json!(true);
            let file = std::path::Path::new(role["configFile"].as_str().unwrap());
            let mut cfg: Value = serde_json::from_slice(&fs::read(file)?)?;
            cfg["s3"]["prefix"] = json!(format!(
                "hosted/{}",
                cfg["installationId"].as_str().unwrap()
            ));
            private_json(file, &cfg)?;
        }
    }
    let bootstrap = dir.join("bootstrap.json");
    private_json(&bootstrap, &plan)?;
    let reservation = std::net::TcpListener::bind(s.config["bind"].as_str().unwrap())?;
    let out = Command::new(binary("workspace-backend"))
        .args(["initialize", "--config"])
        .arg(&bootstrap)
        .output()?;
    ensure!(out.status.success(), "Hosted initialization failed");
    drop(reservation);
    for clock in ["global-clock", "region-clock"] {
        assert!(!dir.join(clock).exists());
    }
    s.steady();
    s.start().await?;
    let b = &s.browser;
    b.get("/studio/api/health", "", 200).await?;
    let local = http_client()?;
    expect(local.get(format!("{}/api/health", b.origin)), 200).await?;
    let denied = expect(
        local.get(format!("{}/studio/api/v1/workspaces", b.origin)),
        403,
    )
    .await?;
    assert_eq!(denied.body["error"]["code"], "HOST_DENIED");
    expect(
        local
            .post(format!("{}/api/session", b.origin))
            .json(&json!({})),
        403,
    )
    .await?;
    b.post("/studio/api/session", "", json!({}), 403).await?;
    s.stop()?;
    s.start().await?;
    s.browser.get("/studio/api/health", "", 200).await?;
    Ok(())
}

#[path = "sso/analytics.rs"]
mod analytics;
