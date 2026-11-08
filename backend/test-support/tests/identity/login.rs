use super::*;
use reqwest::{Method, header};
use std::os::unix::fs::PermissionsExt;
use workspace_test_support::{global::Global, oidc::Provider, port};

#[tokio::test]
#[ignore = "requires isolated RustFS and native examples"]
async fn verified_account_login_and_guest_continuity() -> Result<()> {
    let f = Fixture::start().await?;
    let dir = f.directory();
    let mut meta = f.meta("global").await?;
    let mut region = f.meta("other").await?;
    private_json(&dir.join("global"), &meta.client)?;
    private_json(&dir.join("region"), &region.client)?;
    let callback = "https://studio.example.test/studio/api/auth/tidbcloud/callback";
    let mut oidc = Provider::start("fixture-client", callback).await?;
    oidc.subject("alice");
    let origin = format!("http://127.0.0.1:{}", port()?);
    oidc.allow_redirect(&format!("{origin}/api/auth/tidbcloud/callback"));
    let settings = json!({"issuer":oidc.issuer,"clientId":"fixture-client","redirectUri":callback,"allowLoopbackHttp":true});
    private_json(&dir.join("sso"), &settings)?;
    let probe = "personal_login_probe";
    let args = ["sso", "global", "region"];
    let alice = run(dir, probe, &["sso", "global", "region", "alice-cookie"]).await?;
    assert_eq!(
        fs::metadata(dir.join("alice-cookie"))?.permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(run(dir, probe, &args).await?, alice);
    let mut invalid = settings.clone();
    invalid["ownerSubjects"] = json!(["alice"]);
    private_json(&dir.join("sso"), &invalid)?;
    reject(dir, probe, &args).await?;
    private_json(&dir.join("sso"), &settings)?;
    oidc.subject("bob");
    oidc.bad_signature(true);
    reject(dir, probe, &args).await?;
    reject(
        dir,
        "identity_probe",
        &["global", "--status", &oidc.issuer, "bob"],
    )
    .await?;
    oidc.bad_signature(false);
    let bob = run(dir, probe, &args).await?;
    for k in ["userId", "workspaceId", "organizationId"] {
        assert_ne!(alice[k], bob[k]);
    }
    assert_eq!(
        run(
            dir,
            "identity_probe",
            &["global", "--status", &oidc.issuer, "bob"]
        )
        .await?["state"],
        "ready"
    );
    let a = field(&alice, "workspaceId");
    let b = field(&bob, "workspaceId");
    let mut global = Global::start(&f, &meta, origin, settings).await?;
    let (bob_cookie, _) = global.login(Some(b)).await?;
    let list = || global.owner(Method::GET, b, &bob_cookie, "/keys");
    assert_eq!(list().send().await?.status(), 200);
    let expires = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs()
        + 3600;
    let created = global
        .owner(Method::POST, b, &bob_cookie, "/keys")
        .header("Idempotency-Key", id())
        .json(&json!({"scopes":["resources:read"],"resourceIds":["*"],"expiresAt":expires}))
        .send()
        .await?;
    assert_eq!(created.status(), 201);
    assert_eq!(
        global
            .http
            .post(format!(
                "{}/api/auth/tidbcloud/logout?workspaceId={b}",
                global.origin
            ))
            .header(header::COOKIE, &bob_cookie)
            .header(header::ORIGIN, &global.origin)
            .send()
            .await?
            .status(),
        204
    );
    assert_eq!(list().send().await?.status(), 401);
    let owner_cookie = format!(
        "aw_global_owner={}",
        fs::read_to_string(dir.join("alice-cookie"))?
    );
    super::global::key_lifecycle(&f, &mut global, a, b, &owner_cookie).await?;
    global.stop()?;
    let mut guests = Vec::new();
    for cookie in ["guest1", "guest2"] {
        private_write(&dir.join(cookie), b"")?;
        guests.push(run(dir, "guest_signup_probe", &["global", "region", cookie]).await?);
    }
    for k in ["userId", "workspaceId", "organizationId"] {
        assert_ne!(guests[0]["registration"][k], guests[1]["registration"][k]);
        assert_ne!(guests[0]["registration"][k], alice[k]);
    }
    assert!(
        guests[0]["accessExpiresAt"].as_i64().unwrap() <= guests[0]["expiresAt"].as_i64().unwrap()
    );
    for probe in ["guest_http_probe", "guest_pool_probe"] {
        assert_eq!(
            run(dir, probe, &["global", "region"]).await?["isolated"],
            true
        );
    }
    private_write(&dir.join("entry-cookie"), b"")?;
    let entry = run(
        dir,
        "guest_entry_probe",
        &["global", "region", "entry-cookie", "create"],
    )
    .await?;
    assert_ne!(
        entry["workspaceId"],
        guests[0]["registration"]["workspaceId"]
    );
    restart(&f, &mut meta).await?;
    let check = "global_owner_session_probe";
    run(dir, check, &["global", "check", a, "alice-cookie"]).await?;
    reject(dir, check, &["global", "check", b, "alice-cookie"]).await?;
    run(dir, check, &["global", "revoke", a, "alice-cookie"]).await?;
    reject(dir, check, &["global", "check", a, "alice-cookie"]).await?;
    meta.process.crash()?;
    restart(&f, &mut region).await?;
    let guest = "guest_cookie_probe";
    for (i, cookie) in ["guest1", "guest2"].into_iter().enumerate() {
        assert_eq!(
            run(dir, guest, &["region", cookie, "access"]).await?["workspaceId"],
            guests[i]["registration"]["workspaceId"]
        );
    }
    assert_eq!(
        run(
            dir,
            "guest_entry_probe",
            &["-", "region", "entry-cookie", "resume"]
        )
        .await?,
        entry
    );
    let corrupt = fs::read_to_string(dir.join("guest1"))?.replace(
        field(&guests[0]["registration"], "workspaceId"),
        field(&guests[1]["registration"], "workspaceId"),
    );
    private_write(&dir.join("wrong"), corrupt.as_bytes())?;
    reject(dir, guest, &["region", "wrong", "access"]).await?;
    run(dir, guest, &["region", "guest1", "logout"]).await?;
    reject(dir, guest, &["region", "guest1", "access"]).await?;
    assert_eq!(
        run(dir, guest, &["region", "guest2", "access"]).await?["workspaceId"],
        guests[1]["registration"]["workspaceId"]
    );
    oidc.close().await
}
