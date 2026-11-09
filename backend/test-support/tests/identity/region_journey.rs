use super::*;
const DATA_SCOPES: [&str; 4] = [
    "resources:read",
    "queries:execute",
    "files:read",
    "files:write",
];

async fn verify_ticket(
    g: &Global,
    r: &Regional,
    first: &Value,
    cookie: &str,
    alice: &str,
) -> Result<()> {
    let ws = field(first, "workspaceId");
    let issued = result(
        g.owner(Method::POST, ws, cookie, "/regional-session-tickets"),
        201,
    )
    .await?;
    assert_eq!(issued["region"]["apiOrigin"], r.origin);
    let exchange = || {
        r.http
            .post(format!("{}/api/portal/auth/session-exchanges", r.origin))
            .header(header::ORIGIN, &g.origin)
            .json(&json!({"ticket":issued["ticket"]}))
    };
    let response = exchange().send().await?;
    assert_eq!(response.status(), 200);
    let session = response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find(|v| v.starts_with("aw_account="))
        .and_then(|v| v.split(';').next())
        .context("regional session")?
        .to_owned();
    assert_eq!(response.json::<Value>().await?["workspaceId"], ws);
    result(
        r.http
            .get(format!(
                "{}/api/portal/v1/workspaces/{ws}/resources",
                r.origin
            ))
            .header(header::ORIGIN, &g.origin)
            .header(header::COOKIE, session),
        200,
    )
    .await?;
    assert_eq!(exchange().send().await?.status(), 401);
    assert_ne!(
        g.owner(Method::POST, alice, cookie, "/regional-session-tickets")
            .send()
            .await?
            .status(),
        201
    );
    Ok(())
}
async fn pending_reconciliation(
    f: &Fixture,
    g: &mut Global,
    r: &mut Regional,
    ws: &str,
    cookie: &str,
    resources: &Value,
    proof: &Proof,
) -> Result<()> {
    let full = g.config.clone();
    g.config.as_object_mut().unwrap().remove("regionConnection");
    g.config["regionControls"] = json!([]);
    g.restart(f).await?;
    let pending = new_key(g, ws, cookie, &["resources:read"], resources, now() + 3600).await?;
    assert_eq!(pending["regionalStatus"], "pending");
    let revoked = revoke(g, ws, cookie, &pending).await?;
    assert_eq!(revoked["regionalStatus"], "pending");
    let delivery = id();
    let post = |g: &Global| {
        g.owner(Method::POST, ws, cookie, "/key-policy-deliveries")
            .header("Idempotency-Key", &delivery)
            .json(&json!({"keyId":pending["data"]["keyId"],"keyVersion":2}))
    };
    assert_eq!(
        checked(post(g), 201).await?.0["data"]["regionalStatus"],
        "pending"
    );
    let path = format!("/key-policy-deliveries/{delivery}");
    checked(
        g.agent(Method::GET, ws, field(&pending, "secret"), &path),
        403,
    )
    .await?;
    g.config = full;
    g.restart(f).await?;
    assert_eq!(
        checked(post(g), 201).await?.0["data"]["regionalStatus"],
        "applied"
    );
    assert_eq!(
        checked(g.owner(Method::GET, ws, cookie, &path), 200)
            .await?
            .0["data"]["regionalStatus"],
        "applied"
    );
    assert_eq!(
        checked(
            g.owner(
                Method::GET,
                ws,
                cookie,
                &format!("/key-revocations/{}", field(&revoked, "id"))
            ),
            200
        )
        .await?
        .0["data"]["regionalStatus"],
        "applied"
    );
    let reconnect = new_key(g, ws, cookie, &["resources:read"], resources, now() + 3600).await?;
    assert_eq!(reconnect["regionalStatus"], "applied");
    r.stop().await?;
    assert_eq!(
        revoke(g, ws, cookie, &reconnect).await?["regionalStatus"],
        "pending"
    );
    g.restart(f).await?;
    r.restart(f).await?;
    let end = Instant::now() + Duration::from_secs(20);
    let key = format!("/keys/{}", field(&reconnect["data"], "keyId"));
    loop {
        if checked(g.owner(Method::GET, ws, cookie, &key), 200)
            .await?
            .0["regionalStatus"]
            == "applied"
        {
            break;
        }
        ensure!(
            Instant::now() < end,
            "revocation was not reconciled after reconnect"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    issuance(g, ws, &reconnect, proof, 401).await?;
    checked(
        g.agent(
            Method::POST,
            ws,
            field(&pending, "secret"),
            "/token-issuances",
        )
        .json(&json!({"audience":"global"})),
        401,
    )
    .await?;
    Ok(())
}
async fn data(
    r: &Regional,
    ws: &str,
    resources: &Value,
    token: &str,
    mut family: Option<(&mut Value, &Proof)>,
) -> Result<()> {
    let mut token = token.to_string();
    let pg = &resources[0];
    let files = resources[1].as_str().unwrap();
    for step in 0..4 {
        if let Some((family, proof)) = family.as_mut() {
            token = r.renew(ws, family, proof).await?;
        }
        match step {
            0 | 1 => {
                let sql = if step == 0 {
                    "INSERT INTO continuity VALUES (7)"
                } else {
                    "SELECT value FROM continuity"
                };
                let body = result(
                    r.req(Method::POST, ws, "/queries")
                        .bearer_auth(&token)
                        .json(&json!({"resourceId":pg,"sql":sql})),
                    200,
                )
                .await?;
                if step == 1 {
                    assert_eq!(body["rows"], json!([{"value":7}]));
                }
            }
            2 => {
                result(
                    r.req(
                        Method::PUT,
                        ws,
                        &format!("/files/content?resourceId={files}&path=/continuity.bin"),
                    )
                    .bearer_auth(&token)
                    .header(header::CONTENT_TYPE, "application/octet-stream")
                    .body(vec![0, 255, 7]),
                    200,
                )
                .await?;
            }
            _ => {
                let response = r
                    .req(
                        Method::GET,
                        ws,
                        &format!("/files/content?resourceId={files}&path=/continuity.bin"),
                    )
                    .bearer_auth(&token)
                    .send()
                    .await?;
                assert_eq!(response.status(), 200);
                assert_eq!(response.bytes().await?.as_ref(), [0, 255, 7]);
            }
        }
    }
    Ok(())
}
async fn other_access(
    r: &Regional,
    ws: &str,
    other: &str,
    other_family: &mut Value,
    proof: &Proof,
) -> Result<()> {
    let token = r.renew(other, other_family, proof).await?;
    result(
        r.req(Method::GET, other, "/resources").bearer_auth(&token),
        200,
    )
    .await?;
    result(
        r.req(Method::GET, ws, "/resources").bearer_auth(&token),
        401,
    )
    .await?;
    Ok(())
}
async fn short_expiry(
    f: &Fixture,
    g: &mut Global,
    r: &Regional,
    ws: &str,
    cookie: &str,
    resources: &Value,
    proof: &Proof,
) -> Result<()> {
    let expires = now() + 15;
    let fixed = new_key(g, ws, cookie, &["resources:read"], resources, expires).await?;
    let late = new_key(g, ws, cookie, &["resources:read"], resources, expires).await?;
    let fixed = r
        .enroll(ws, &issuance(g, ws, &fixed, proof, 201).await?, proof)
        .await?;
    let family = r
        .enroll(ws, &issuance(g, ws, &late, proof, 201).await?, proof)
        .await?;
    r.security(r.refresh(ws, &family, None), &[401]).await?;
    let full = g.config.clone();
    g.config["regionControls"] = json!([]);
    g.config.as_object_mut().unwrap().remove("regionConnection");
    g.restart(f).await?;
    assert_eq!(
        extend_key(g, ws, cookie, &late).await?["regionalStatus"],
        "pending"
    );
    tokio::time::sleep(Duration::from_secs((expires + 1).saturating_sub(now()))).await;
    for expired in [&fixed, &family] {
        r.security(r.refresh(ws, expired, Some(proof)), &[401])
            .await?;
    }
    g.config = full;
    g.restart(f).await?;
    let delivered = checked(
        g.owner(Method::POST, ws, cookie, "/key-policy-deliveries")
            .header("Idempotency-Key", id())
            .json(&json!({"keyId":late["data"]["keyId"],"keyVersion":2})),
        201,
    )
    .await?
    .0;
    assert_eq!(delivered["data"]["regionalStatus"], "applied");
    assert_eq!(delivered["data"]["regionalContinuity"], "unavailable");
    r.security(r.refresh(ws, &family, Some(proof)), &[401])
        .await?;
    Ok(())
}
#[tokio::test]
#[ignore = "requires isolated RustFS and native examples"]
async fn regional_token_enrollment_delivery_and_outage_recovery() -> Result<()> {
    let f = Fixture::start().await?;
    let dir = f.directory();
    let mut global_meta = f.meta("global").await?;
    let meta = f.meta("other").await?;
    private_json(&dir.join("g-meta"), &global_meta.client)?;
    private_json(&dir.join("r-meta"), &meta.client)?;
    let origin = format!("http://127.0.0.1:{}", port()?);
    let cb = format!("{origin}/api/auth/tidbcloud/callback");
    let mut oidc = Oidc::start("fixture-client", &cb).await?;
    let settings = json!({"issuer":oidc.issuer,"clientId":"fixture-client","redirectUri":cb,"allowLoopbackHttp":true});
    let local = "https://studio.example.test/studio/api/auth/tidbcloud/callback";
    oidc.allow_redirect(local);
    let mut probe_settings = settings.clone();
    probe_settings["redirectUri"] = local.into();
    private_json(&dir.join("sso"), &probe_settings)?;
    oidc.subject("alice");
    let alice = run(
        dir,
        "personal_login_probe",
        &["sso", "g-meta", "r-meta", "owner-cookie"],
    )
    .await?;
    let ws = field(&alice, "workspaceId");
    let cookie = format!(
        "aw_global_owner={}",
        fs::read_to_string(dir.join("owner-cookie"))?
    );
    oidc.subject("bob");
    let bob = run(
        dir,
        "personal_login_probe",
        &["sso", "g-meta", "r-meta", "bob-cookie"],
    )
    .await?;
    let other = field(&bob, "workspaceId");
    let other_cookie = format!(
        "aw_global_owner={}",
        fs::read_to_string(dir.join("bob-cookie"))?
    );
    let mut g = Global::start(&f, &global_meta, origin, settings).await?;
    g.config["initializeClock"] = false.into();
    let provider = Provider::start(false).await?;
    provider.state.lock().unwrap().require_file_auth = true;
    let credentials = Arc::new(Mutex::new(BTreeMap::<String, String>::new()));
    let captured = credentials.clone();
    let stored = Arc::new(Mutex::new(false));
    provider.set_sql_hook(move |input|{let captured=captured.clone();let stored=stored.clone();async move {
        let binding=&input["binding"];let key=format!("{}:{}",binding["kind"],binding["user"]);let password=binding["password"].as_str().expect("database credential");
        let actual=captured.lock().unwrap().entry(key).or_insert(password.into()).clone();assert_eq!(actual,password);
        match input["sql"].as_str()?{
            "INSERT INTO continuity VALUES (7)"=>{*stored.lock().unwrap()=true;Some(SqlResponse::Json(200,json!({"columns":[],"rows":[],"rowCount":0,"affectedRows":1})))},
            "SELECT value FROM continuity"=>{let rows=if *stored.lock().unwrap(){json!([{"value":7}])}else{json!([])};Some(SqlResponse::Json(200,json!({"columns":["value"],"rowCount":rows.as_array().unwrap().len(),"rows":rows})))},_=>None
        }
    }});
    let (server, client) = certificates(dir)?;
    let control = format!("https://127.0.0.1:{}", port()?);
    let mut r =
        Regional::create(&f, &meta, &g, ws, &provider, &control, (&server, &client)).await?;
    let initial = r
        .http
        .post(format!("{}/api/session", r.origin))
        .json(&json!({}))
        .send()
        .await?;
    assert_eq!(initial.status(), 200);
    let local_cookie = initial.headers()[header::SET_COOKIE]
        .to_str()?
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    g.config["regions"][0]["apiOrigin"] = r.origin.clone().into();
    g.config["regionControls"] = json!([{"regionId":AUTHORITY,"origin":control,"tls":client}]);
    let mut conn = server;
    conn["bind"] = control.strip_prefix("https://").unwrap().into();
    conn["allowedRegions"] =
        json!([{"regionId":AUTHORITY,"certificateFile":client["certificateFile"]}]);
    g.config["regionConnection"] = conn;
    g.restart(&f).await?;
    oidc.subject("first-time-distributed-user");
    let (first_cookie, first) = g.login(None).await?;
    assert_eq!(first["regionId"], AUTHORITY);
    assert_ne!(first["workspaceId"], ws);
    assert_ne!(first["workspaceId"], other);
    let records=meta.call(json!({"op":"get","scope":{"authorityId":AUTHORITY,"ownerKind":"workspace","ownerId":first["workspaceId"],"family":"workspace","partitionId":"primary"},"keys":["state/workspace","ownership/onboarding"]})).await?;
    assert_eq!(
        records["records"]["state/workspace"]["value"]["id"],
        first["workspaceId"]
    );
    assert_eq!(
        records["records"]["ownership/onboarding"]["value"]["workspaceId"],
        first["workspaceId"]
    );
    let proof = Proof::create()?;
    let setup = new_key(
        &g,
        ws,
        &cookie,
        &["resources:read", "resources:write"],
        &json!(["*"]),
        now() + 3600,
    )
    .await?;
    let setup = issuance(&g, ws, &setup, &proof, 201).await?;
    let access = field(&setup, "accessToken");
    let mut resources = Vec::new();
    for (kind, name, region) in [
        ("postgresql", "continuity-db", "automatic"),
        ("filesystem", "continuity-fs", "aws-ap-southeast-1"),
    ] {
        let resource = result(
            r.req(Method::POST, ws, "/resources")
                .bearer_auth(access)
                .json(&json!({"kind":kind,"name":name,"region":region})),
            201,
        )
        .await?;
        assert_eq!(resource["data"]["status"], "active", "{kind} provisioning");
        assert_eq!(resource["data"]["regionId"], AUTHORITY);
        resources.push(resource["data"]["id"].clone());
    }
    let resources = json!(resources);
    assert_eq!(
        result(r.req(Method::GET, ws, "").bearer_auth(access), 200).await?["data"]["defaultRegionId"],
        AUTHORITY
    );
    result(r.req(Method::POST,ws,"/resources").bearer_auth(access).json(&json!({"kind":"postgresql","name":"wrong-region","region":"automatic","regionId":"region:elsewhere"})),400).await?;
    result(
        r.http
            .post(format!("{}/api/portal/v1/workspaces/{ws}/keys", r.origin))
            .header(header::COOKIE, local_cookie)
            .header(header::ORIGIN, &r.origin)
            .json(&json!({})),
        404,
    )
    .await?;
    let retired = |r: &Regional| {
        r.req(Method::GET, ws, "/resources")
            .bearer_auth("retired-workspace-key")
    };
    result(retired(&r), 401).await?;
    let counts = || {
        let s = provider.state.lock().unwrap();
        (s.database_creates, s.account_creates, s.creates)
    };
    let before = counts();
    let native_credentials = credentials.lock().unwrap().len();
    r.config["managedWorkspaceLimit"] = 16.into();
    r.config["security"]["initializeClock"] = false.into();
    r.restart(&f).await?;
    verify_ticket(&g, &r, &first, &first_cookie, ws).await?;
    result(retired(&r), 401).await?;
    pending_reconciliation(&f, &mut g, &mut r, ws, &cookie, &resources, &proof).await?;
    let created = new_key(&g, ws, &cookie, &DATA_SCOPES, &resources, now() + 3600).await?;
    assert_eq!(created["regionalStatus"], "applied");
    let issued = issuance(&g, ws, &created, &proof, 201).await?;
    data(&r, ws, &resources, field(&issued, "accessToken"), None).await?;
    let bob_key = new_key(
        &g,
        other,
        &other_cookie,
        &["resources:read"],
        &json!(["*"]),
        now() + 3600,
    )
    .await?;
    let bob_issued = issuance(&g, other, &bob_key, &proof, 201).await?;
    let btoken = field(&bob_issued, "accessToken");
    let visible = result(
        r.req(Method::GET, other, "/resources").bearer_auth(btoken),
        200,
    )
    .await?;
    assert!(
        visible["data"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| !resources.as_array().unwrap().contains(&v["id"]))
    );
    let listed = result(
        r.http
            .get(format!("{}/api/v1/workspaces", r.origin))
            .bearer_auth(btoken),
        200,
    )
    .await?;
    assert_eq!(
        listed["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| field(v, "id"))
            .collect::<Vec<_>>(),
        [other]
    );
    result(
        r.req(Method::GET, other, "/resources")
            .bearer_auth(field(&issued, "accessToken")),
        401,
    )
    .await?;
    result(
        r.req(Method::GET, ws, "/resources").bearer_auth(btoken),
        401,
    )
    .await?;
    let mut other_family = r.enroll(other, &bob_issued, &proof).await?;
    r.security(r.refresh(ws, &other_family, Some(&proof)), &[401, 404])
        .await?;
    other_access(&r, ws, other, &mut other_family, &proof).await?;
    let mut family = r.enroll(ws, &issued, &proof).await?;
    let token = r.renew(ws, &mut family, &proof).await?;
    data(&r, ws, &resources, &token, Some((&mut family, &proof))).await?;
    let token = r.renew(ws, &mut family, &proof).await?;
    for (route, hidden) in [
        (
            format!("/refresh-families/{}", field(&family, "familyId")),
            "verifier",
        ),
        (
            format!("/token-issuances/{}", field(&family, "id")),
            "accessToken",
        ),
    ] {
        let status = r
            .security(r.req(Method::GET, ws, &route).bearer_auth(&token), &[200])
            .await?;
        assert!(status["data"].get(hidden).is_none());
    }
    let jti = field(&family, "id").split('.').nth(1).unwrap();
    r.security(
        r.req(Method::DELETE, ws, &format!("/access-tokens/{jti}"))
            .bearer_auth(&token),
        &[204],
    )
    .await?;
    result(
        r.req(Method::GET, ws, "/resources").bearer_auth(&token),
        401,
    )
    .await?;
    r.renew(ws, &mut family, &proof).await?;
    let mut extra = r
        .enroll(ws, &issuance(&g, ws, &created, &proof, 201).await?, &proof)
        .await?;
    let access = r.renew(ws, &mut extra, &proof).await?;
    r.security(
        r.req(
            Method::DELETE,
            ws,
            &format!("/refresh-families/{}", field(&extra, "familyId")),
        )
        .bearer_auth(&access),
        &[204],
    )
    .await?;
    result(
        r.req(Method::GET, ws, "/resources").bearer_auth(&access),
        401,
    )
    .await?;
    let token = r.renew(ws, &mut family, &proof).await?;
    data(&r, ws, &resources, &token, Some((&mut family, &proof))).await?;
    assert_eq!(
        *r.covered.lock().unwrap(),
        [
            "enrollRegionalRefreshFamily",
            "issueRegionalToken",
            "getRegionalRefreshFamily",
            "revokeRegionalRefreshFamily",
            "getRegionalTokenIssuance",
            "revokeRegionalAccessToken"
        ]
        .into_iter()
        .map(str::to_owned)
        .collect()
    );
    short_expiry(&f, &mut g, &r, ws, &cookie, &resources, &proof).await?;
    let expires = now() + 30;
    let keep = new_key(&g, ws, &cookie, &DATA_SCOPES, &resources, expires).await?;
    let mut continuity = r
        .enroll(ws, &issuance(&g, ws, &keep, &proof, 201).await?, &proof)
        .await?;
    r.renew(ws, &mut continuity, &proof).await?;
    let extended = extend_key(&g, ws, &cookie, &keep).await?;
    assert_eq!(extended["regionalStatus"], "applied");
    assert_eq!(extended["regionalContinuity"], "eligible");
    assert_eq!(extended["data"]["keyVersion"], 2);
    let health = global_meta.health().await?;
    g.process.as_mut().unwrap().crash()?;
    global_meta.process.crash()?;
    tokio::time::sleep(Duration::from_secs(
        4.max((expires + 1).saturating_sub(now())),
    ))
    .await;
    result(
        r.req(Method::GET, ws, "/resources").bearer_auth(&token),
        401,
    )
    .await?;
    let token = r.renew(ws, &mut family, &proof).await?;
    assert_eq!(
        result(r.req(Method::GET, ws, "").bearer_auth(&token), 200).await?["data"]["defaultRegionId"],
        AUTHORITY
    );
    assert!(
        result(
            r.req(Method::GET, ws, "/resources").bearer_auth(&token),
            200
        )
        .await?["data"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v["regionId"] == AUTHORITY)
    );
    data(&r, ws, &resources, &token, Some((&mut family, &proof))).await?;
    other_access(&r, ws, other, &mut other_family, &proof).await?;
    let access = r.renew(ws, &mut continuity, &proof).await?;
    assert_eq!(
        continuity["refreshExpiresAt"],
        extended["data"]["expiresAt"]
    );
    data(&r, ws, &resources, &access, Some((&mut continuity, &proof))).await?;
    private_json(&dir.join("saved-family"), &continuity)?;
    r.restart(&f).await?;
    let token = r.renew(ws, &mut family, &proof).await?;
    data(&r, ws, &resources, &token, Some((&mut family, &proof))).await?;
    result(retired(&r), 401).await?;
    other_access(&r, ws, other, &mut other_family, &proof).await?;
    let mut saved = serde_json::from_slice(&fs::read(dir.join("saved-family"))?)?;
    let token = r.renew(ws, &mut saved, &proof).await?;
    data(&r, ws, &resources, &token, Some((&mut saved, &proof))).await?;
    assert_eq!(counts(), before);
    assert_eq!(credentials.lock().unwrap().len(), native_credentials);
    r.stop().await?;
    let restored = f
        .start_meta(
            global_meta.server.clone(),
            false,
            Some(field(&health, "ownerId")),
        )
        .await?;
    g.config["metadata"]["client"] = restored.client.clone();
    g.restart(&f).await?;
    checked(
        g.agent(Method::POST, ws, field(&keep, "secret"), "/token-issuances")
            .json(&json!({"audience":"global"})),
        201,
    )
    .await?;
    assert_eq!(
        checked(
            g.owner(
                Method::GET,
                ws,
                &cookie,
                &format!("/keys/{}", field(&keep["data"], "keyId"))
            ),
            200
        )
        .await?
        .0["data"]["grantRef"],
        keep["data"]["grantRef"]
    );
    g.stop().await?;
    oidc.close().await
}
