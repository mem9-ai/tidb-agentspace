use super::*;
use workspace_test_support::private_write;
const LOGIN: &str = "/studio/api/global/auth/raft";
const CONTEXT: &str = "/studio/api/global/api/raft/actions/context";
const WORKSPACES: &str = "/studio/api/global/api/raft/workspaces";

fn profile(server: &str, subject: &str, kind: &str) -> Value {
    json!({"sub":subject,"type":kind,"server_id":server,"client_id":"native-client","scope":"openid profile","server_role":"admin"})
}
async fn agent_login(f: &Site, callback: &str, server: &str, subject: &str) -> Result<site::Reply> {
    f.oidc.claims(profile(server, subject, "agent"));
    let code = f.oidc.agent_code(callback);
    f.browser
        .get(&format!("{LOGIN}/callback?code={code}"), "", 200)
        .await
}

async fn policy_request(
    f: &Site,
    method: Method,
    path: &str,
    cookie: &str,
    workspace: &str,
) -> Result<reqwest::RequestBuilder> {
    let current = f
        .browser
        .get(&format!("{WORKSPACES}/{workspace}"), cookie, 200)
        .await?
        .body;
    let generation = current["data"]["generation"]
        .as_u64()
        .context("policy generation")?;
    Ok(f.browser
        .request(method, path, cookie)
        .header("If-Match", format!("\"{generation}\"")))
}

#[tokio::test]
#[ignore = "requires isolated RustFS and native binaries"]
async fn raft_public_login_is_identity_only_and_human_admission_is_explicit() -> Result<()> {
    let mut f = Site::prepare(Profile::Global, false, json!({})).await?;
    let server = Uuid::new_v4().to_string();
    let callback = format!("https://studio.example.test{LOGIN}/callback");
    f.oidc.allow_redirect(&callback);
    let secret_file = f.fixture.directory().join("raft-secret");
    private_write(&secret_file, b"fixture-confidential-client")?;
    f.global_config.as_mut().unwrap()["raft"] = json!({"issuer":f.oidc.issuer,"clientId":"native-client",
        "clientSecretFile":secret_file,"redirectUri":callback,"postLoginUrl":"https://studio.example.test/studio/",
        "allowedServerIds":[server],"allowLoopbackHttp":true});
    f.config["security"]["raft"] = json!({"issuer":f.oidc.issuer,"clientId":"native-client","allowedServerIds":[server],"allowLoopbackHttp":true});
    // The public-contract fixture runs on actual loopback HTTP; keep trusted issuer and
    // browser origins separate from the explicitly configured regional data endpoint.
    f.config["security"]["publicOrigin"] = json!(f.browser.origin);
    f.config["publicOrigins"]
        .as_array_mut()
        .unwrap()
        .push(json!(f.browser.origin));
    f.global_config.as_mut().unwrap()["regions"][0]["apiOrigin"] = json!(f.browser.origin);
    f.start().await?;
    let legacy_cookie = f.browser.login(false, 302).await?.cookie("aw_account")?;
    let legacy_workspace = super::workspace(&f.browser, &legacy_cookie).await?;
    f.browser
        .get(
            &format!("/studio/api/v1/workspaces/{legacy_workspace}/resources"),
            &legacy_cookie,
            200,
        )
        .await?;
    f.oidc.raft_mode("fixture-confidential-client");
    let manifest = f
        .browser
        .get(
            "/studio/api/global/.well-known/raft-agent-manifest.json",
            "",
            200,
        )
        .await?
        .body;
    assert_eq!(manifest["actions"].as_array().unwrap().len(), 5);
    assert_eq!(manifest["actions"][0]["endpoint"]["path"], CONTEXT);
    for (field, invalid) in [
        ("server_id", json!(Uuid::new_v4().to_string())),
        ("client_id", json!("other-client")),
        ("type", json!("admin")),
        ("sub", json!("")),
        ("scope", json!("openid")),
    ] {
        let mut claims = profile(&server, "denied-agent", "agent");
        claims[field] = invalid;
        f.oidc.claims(claims);
        let code = f.oidc.agent_code(&callback);
        let rejected = f
            .browser
            .get(&format!("{LOGIN}/callback?code={code}"), "", 401)
            .await?;
        assert!(
            rejected
                .cookies()
                .iter()
                .all(|c| !c.starts_with("aw_raft_session="))
        );
        assert!(rejected.body["error"].is_string());
    }
    f.oidc.claims(profile(&server, "one-use-agent", "agent"));
    let code = f.oidc.agent_code(&callback);
    f.browser
        .get(&format!("{LOGIN}/callback?code={code}"), "", 200)
        .await?;
    assert_eq!(
        f.browser
            .get(&format!("{LOGIN}/callback?code={code}"), "", 409)
            .await?
            .body["error"],
        "RAFT_LOGIN_REQUIRED"
    );
    let stale_flow = f.browser.get(&format!("{LOGIN}/login"), "", 303).await?;
    let code = f.oidc.agent_code(&callback);
    f.browser
        .get(
            &format!("{LOGIN}/callback?code={code}&state=invalid-state"),
            &stale_flow.cookie("aw_raft_flow")?,
            400,
        )
        .await?;
    // Failed Human state must reject before exchanging the Agent code.
    f.browser
        .get(&format!("{LOGIN}/callback?code={code}"), "", 200)
        .await?;
    let a = agent_login(&f, &callback, &server, "agent-a").await?;
    assert!(!a.body.to_string().contains("access_token"));
    assert!(a.cookies().iter().any(|v| v.starts_with("aw_raft_session=")
        && v.contains("HttpOnly")
        && v.contains("Secure")
        && v.contains("Path=/;")));
    let a_cookie = a.cookie("aw_raft_session")?;
    let a_context = f.browser.get(CONTEXT, &a_cookie, 200).await?.body;
    assert_eq!(a_context["actor"]["kind"], "agent");
    assert_eq!(a_context["actor"]["serverId"], server);
    assert_eq!(a_context["workspaces"], json!([]));
    assert_eq!(a_context["enrollmentRequired"], true);
    f.browser.post(WORKSPACES,&a_cookie,json!({"requestId":Uuid::new_v4().to_string(),"name":"must-not-exist","regionId":"region:a"}),403).await?;
    let b = agent_login(&f, &callback, &server, "agent-b").await?;
    let b_cookie = b.cookie("aw_raft_session")?;
    let b_context = f.browser.get(CONTEXT, &b_cookie, 200).await?.body;
    let b_id = b_context["actor"]["id"].as_str().unwrap();
    // A Human code without a browser transaction never creates a service session.
    f.oidc.claims(profile(&server, "human-owner", "human"));
    let no_state = f.oidc.agent_code(&callback);
    assert!(
        f.browser
            .get(&format!("{LOGIN}/callback?code={no_state}"), "", 400)
            .await?
            .cookies()
            .iter()
            .all(|cookie| !cookie.starts_with("aw_raft_session="))
    );
    let flow = f.browser.get(&format!("{LOGIN}/login"), "", 303).await?;
    let login_url = reqwest::Url::parse(flow.location())?;
    let state = login_url
        .query_pairs()
        .find(|(k, _)| k == "state")
        .context("state")?
        .1
        .to_string();
    let code: Value = http_client()?.get(login_url).send().await?.json().await?;
    let human = f
        .browser
        .get(
            &format!(
                "{LOGIN}/callback?code={}&state={state}",
                code["code"].as_str().unwrap()
            ),
            &flow.cookie("aw_raft_flow")?,
            303,
        )
        .await?;
    let human_cookie = human.cookie("aw_raft_session")?;
    let human_context = f.browser.get(CONTEXT, &human_cookie, 200).await?.body;
    assert_eq!(human_context["actor"]["kind"], "human");
    assert_ne!(human_context["actor"]["id"], a_context["actor"]["id"]);
    let region = f.global_config.as_ref().unwrap()["regions"][0]["regionId"]
        .as_str()
        .unwrap();
    let request = Uuid::new_v4().to_string();
    let created = f
        .browser
        .post(
            WORKSPACES,
            &human_cookie,
            json!({"requestId":request,"name":"explicit","regionId":region}),
            201,
        )
        .await?
        .body;
    let workspace = created["data"]["id"].as_str().unwrap();
    assert_eq!(created["resourceReady"], false);
    let repeated = f
        .browser
        .post(
            WORKSPACES,
            &human_cookie,
            json!({"requestId":request,"name":"explicit","regionId":region}),
            201,
        )
        .await?
        .body;
    assert_eq!(created, repeated);
    assert_eq!(
        f.browser.get(CONTEXT, &a_cookie, 200).await?.body["workspaces"],
        json!([])
    );
    f.browser
        .post(
            &format!("{WORKSPACES}/{workspace}/enrollments"),
            &a_cookie,
            json!({}),
            201,
        )
        .await?;
    let a_id = a_context["actor"]["id"].as_str().unwrap();
    expect(
        f.browser
            .request(
                Method::PATCH,
                &format!("{WORKSPACES}/{workspace}/enrollments/{a_id}"),
                &a_cookie,
            )
            .json(&json!({"approved":true})),
        403,
    )
    .await?;
    expect(
        policy_request(
            &f,
            Method::PATCH,
            &format!("{WORKSPACES}/{workspace}/enrollments/{a_id}"),
            &human_cookie,
            workspace,
        )
        .await?
        .json(&json!({"approved":true})),
        200,
    )
    .await?;
    assert_eq!(
        f.browser.get(CONTEXT, &a_cookie, 200).await?.body["workspaces"][0]["id"],
        workspace
    );
    // A real CLI needs only context: a Human admits that verified identity directly.
    let candidate = f
        .browser
        .get(
            &format!("{WORKSPACES}/{workspace}/principals/{b_id}"),
            &human_cookie,
            200,
        )
        .await?
        .body;
    assert_eq!(candidate["data"]["identity"]["kind"], "agent");
    f.browser
        .get(
            &format!("{WORKSPACES}/{workspace}/principals/{b_id}"),
            &a_cookie,
            403,
        )
        .await?;
    let invitation = Uuid::new_v4().to_string();
    let body = json!({"requestId":invitation,"principalId":b_id});
    let invited = expect(
        policy_request(
            &f,
            Method::POST,
            &format!("{WORKSPACES}/{workspace}/invitations"),
            &human_cookie,
            workspace,
        )
        .await?
        .json(&body),
        201,
    )
    .await?
    .body;
    assert_eq!(invited["data"]["status"], "approved");
    assert_eq!(
        f.browser
            .get(
                &format!("{WORKSPACES}/{workspace}/invitations/{invitation}"),
                &b_cookie,
                200
            )
            .await?
            .body["data"]["principal"]["id"],
        b_id
    );
    assert_eq!(
        f.browser.get(CONTEXT, &b_cookie, 200).await?.body["workspaces"][0]["id"],
        workspace
    );
    let actions = "/studio/api/global/api/raft/actions";
    let resources = format!("{WORKSPACES}/{workspace}/resources");
    let created=f.browser.post(&resources,&human_cookie,json!({"requestId":Uuid::new_v4().to_string(),"kind":"filesystem","name":"private-files","region":"aws-us-west-2"}),200).await?.body;
    let resource = created["data"]["id"].as_str().unwrap();
    assert!(created["data"]["capabilities"].is_null());
    assert!(
        !created["data"]["allowedActions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a == "files:analyze" || a == "usage:read")
    );
    let content = "a private native file";
    expect(
        policy_request(
            &f,
            Method::PUT,
            &format!("{resources}/{resource}/files"),
            &human_cookie,
            workspace,
        )
        .await?
        .json(&json!({"path":"note.txt","content":content})),
        200,
    )
    .await?;
    let list = format!("{actions}/list-resources?workspaceId={workspace}");
    assert_eq!(
        f.browser.get(&list, &a_cookie, 200).await?.body["resources"],
        json!([])
    );
    let read =
        format!("{actions}/read-file?workspaceId={workspace}&resourceId={resource}&path=note.txt");
    f.browser.get(&read, &a_cookie, 404).await?;
    assert_eq!(
        f.browser.get(&list, &b_cookie, 200).await?.body["resources"],
        json!([])
    );
    f.browser.get(&read, &b_cookie, 404).await?;
    let grant = Uuid::new_v4().to_string();
    let share = json!({"principalId":a_id,"actions":["resources:read","files:read"],"expiresAt":chrono::Utc::now().timestamp()+3600});
    let grant_path = format!("{resources}/{resource}/grants/{grant}");
    expect(policy_request(&f, Method::PUT, &grant_path, &human_cookie, workspace).await?
        .json(&json!({"principalId":a_id,"actions":["files:analyze"],"expiresAt":chrono::Utc::now().timestamp()+3600})), 422).await?;
    expect(
        f.browser
            .request(Method::PUT, &grant_path, &human_cookie)
            .json(&share),
        428,
    )
    .await?;
    expect(
        f.browser
            .request(Method::PUT, &grant_path, &human_cookie)
            .header("If-Match", "\"1\"")
            .json(&share),
        412,
    )
    .await?;
    expect(
        policy_request(&f, Method::PUT, &grant_path, &human_cookie, workspace)
            .await?
            .json(&share),
        200,
    )
    .await?;
    let inventory = f.browser.get(&list, &a_cookie, 200).await?.body;
    assert_eq!(inventory["resources"][0]["id"], resource);
    assert!(
        !inventory["resources"][0]["allowedActions"]
            .as_array()
            .unwrap()
            .contains(&json!("files:write"))
    );
    let file = f.browser.get(&read, &a_cookie, 200).await?.body;
    assert_eq!(file["content"], content);
    assert!(file["revision"].is_string());
    expect(
        f.browser
            .request(
                Method::PUT,
                &format!("{resources}/{resource}/files"),
                &a_cookie,
            )
            .json(&json!({"path":"forbidden.txt","content":"no"})),
        403,
    )
    .await?;
    // A writer edge on another resource must never broaden the read-only edge above.
    let second=f.browser.post(&resources,&human_cookie,json!({"requestId":Uuid::new_v4().to_string(),"kind":"filesystem","name":"write-files","region":"aws-ap-southeast-1"}),200).await?.body;
    let second_id = second["data"]["id"].as_str().unwrap();
    let batch = json!({"requestId":Uuid::new_v4().to_string(),"principalId":a_id,"resourceIds":[second_id],"expiresAt":chrono::Utc::now().timestamp()+3600,"actions":["resources:read","files:write"]});
    let batch_path = format!("{resources}/share-batches");
    let first = expect(
        policy_request(&f, Method::POST, &batch_path, &human_cookie, workspace)
            .await?
            .json(&batch),
        200,
    )
    .await?
    .body;
    assert_eq!(first["results"][0]["status"], "applied");
    assert_eq!(
        expect(
            policy_request(&f, Method::POST, &batch_path, &human_cookie, workspace)
                .await?
                .json(&batch),
            200
        )
        .await?
        .body,
        first
    );
    let mut enlarged = batch.clone();
    enlarged["resourceIds"] = json!([second_id, resource]);
    expect(
        policy_request(&f, Method::POST, &batch_path, &human_cookie, workspace)
            .await?
            .json(&enlarged),
        409,
    )
    .await?;
    expect(
        f.browser
            .request(
                Method::PUT,
                &format!("{resources}/{second_id}/files"),
                &a_cookie,
            )
            .json(&json!({"path":"own-write.txt","content":"permitted"})),
        200,
    )
    .await?;
    expect(
        f.browser
            .request(
                Method::PUT,
                &format!("{resources}/{resource}/files"),
                &a_cookie,
            )
            .json(&json!({"path":"still-forbidden.txt","content":"no union"})),
        403,
    )
    .await?;
    expect(
        f.browser
            .request(
                Method::PUT,
                &format!("{resources}/{second_id}/grants/{}", Uuid::new_v4()),
                &a_cookie,
            )
            .json(&json!({"principalId":a_id,"actions":["files:read"]})),
        403,
    )
    .await?;
    // Dedicated tag permission and a revision precondition; matching tags grant nothing.
    let tag_path = format!("{resources}/{resource}/tags");
    let tag = json!({"version":0,"values":{"project":"alpha"}});
    expect(
        f.browser
            .request(Method::PUT, &tag_path, &a_cookie)
            .json(&tag),
        403,
    )
    .await?;
    expect(
        f.browser
            .request(Method::PUT, &tag_path, &human_cookie)
            .json(&tag),
        200,
    )
    .await?;
    expect(
        f.browser
            .request(Method::PUT, &tag_path, &human_cookie)
            .json(&tag),
        412,
    )
    .await?;
    let filtered = format!("{list}&tags=%7B%22project%22%3A%22alpha%22%7D");
    assert_eq!(
        f.browser.get(&filtered, &a_cookie, 200).await?.body["resources"][0]["id"],
        resource
    );
    let mut revoked = share.clone();
    revoked["revoked"] = json!(true);
    // Retain an actual valid regional proof to test revocation independently of Global.
    use workspace_api::access_signer::{AccessSigner, Issuance, SigningConfig};
    use workspace_identity::federation::{ExternalIdentity, PrincipalKind};
    let stamp = ExternalIdentity {
        provider: "raft".into(),
        server_id: server.clone(),
        subject: "agent-a".into(),
        kind: PrincipalKind::Agent,
    }
    .stamp_id()?;
    f.oidc.claims(profile(&server, "agent-a", "agent"));
    let code = f.oidc.agent_code(&callback);
    let upstream: Value = http_client()?
        .post(format!("{}/token", f.oidc.issuer))
        .basic_auth("native-client", Some("fixture-confidential-client"))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", &callback),
        ])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let signer = AccessSigner::new(
        SigningConfig {
            issuer: f.config["security"]["globalIssuer"]
                .as_str()
                .unwrap()
                .into(),
            audience: "region:native-sso/audience".into(),
            environment: "test".into(),
            region: Some("region:native-sso".into()),
            key_id: "global-primary".into(),
            max_lifetime: 900,
            issuer_kind: workspace_api::signed_access::IssuerKind::Global,
        },
        &fs::read(
            f.global_config.as_ref().unwrap()["signingKeyFile"]
                .as_str()
                .unwrap(),
        )?,
    )?;
    let scope = site::workspace_scope(workspace, "federated-policy");
    let prior = f
        .region
        .call(json!({"op":"get","scope":scope,"keys":["workspace"]}))
        .await?["records"]["workspace"]["value"]
        .clone();
    let now = chrono::Utc::now().timestamp();
    let signed = signer.sign(
        &Issuance {
            workspace_id: workspace,
            principal_id: a_id,
            key_id: &stamp,
            key_version: 1,
            policy_generation: prior["generation"].as_u64().unwrap(),
            grant_ref: &format!("federated:{resource}"),
            scopes: &["resources:read".into(), "files:read".into()],
            key_expires_at: now + 50,
            grant_expires_at: now + 50,
            family: None,
        },
        now,
    )?;
    let direct = format!(
        "/studio/api/federated/workspaces/{workspace}/files/content?resourceId={resource}&path=%2Fnote.txt&preview=1"
    );
    let direct_read = || {
        f.browser
            .request(Method::GET, &direct, "")
            .header("x-agentspace-policy", &signed.token)
            .bearer_auth(upstream["access_token"].as_str().unwrap())
    };
    assert_eq!(expect(direct_read(), 200).await?.body["content"], content);
    expect(
        policy_request(&f, Method::PUT, &grant_path, &human_cookie, workspace)
            .await?
            .json(&revoked),
        200,
    )
    .await?;
    assert_eq!(
        expect(direct_read(), 403).await?.body["error"]["code"],
        "POLICY_CHANGED"
    );
    // Restore only the policy record, keeping the independent generation checkpoint.
    let current = f
        .region
        .call(json!({"op":"get","scope":scope,"keys":["workspace"]}))
        .await?;
    f.region.call(json!({"op":"commit","scope":scope,"mutationId":Uuid::new_v4().to_string(),"changes":[{
        "key":"workspace","expectedVersion":current["records"]["workspace"]["version"],"value":prior
    }]})).await?;
    assert_eq!(
        expect(direct_read(), 503).await?.body["error"]["code"],
        "POLICY_ROLLBACK"
    );
    f.browser.get(&read, &a_cookie, 404).await?;
    assert_eq!(
        f.browser.get(&filtered, &a_cookie, 200).await?.body["resources"],
        json!([])
    );
    expect(
        policy_request(&f, Method::PUT, &grant_path, &human_cookie, workspace)
            .await?
            .json(&share),
        409,
    )
    .await?;
    // Even a legacy Owner session cannot enter the explicitly federated Workspace.
    let legacy = f
        .browser
        .get(
            &format!("/studio/api/v1/workspaces/{workspace}/resources"),
            &legacy_cookie,
            404,
        )
        .await?;
    assert!(legacy.body["error"].is_object());
    expect(
        policy_request(
            &f,
            Method::DELETE,
            &format!(
                "{WORKSPACES}/{workspace}/members/{}",
                human_context["actor"]["id"].as_str().unwrap()
            ),
            &human_cookie,
            workspace,
        )
        .await?,
        409,
    )
    .await?;
    expect(
        policy_request(
            &f,
            Method::DELETE,
            &format!("{WORKSPACES}/{workspace}/members/{a_id}"),
            &human_cookie,
            workspace,
        )
        .await?,
        200,
    )
    .await?;
    f.browser.get(&list, &a_cookie, 403).await?;
    assert_eq!(
        f.browser
            .get(
                &format!("{WORKSPACES}/{workspace}/enrollments/self"),
                &a_cookie,
                200
            )
            .await?
            .body["data"]["status"],
        "removed"
    );
    let audit = f
        .browser
        .get(
            &format!("{WORKSPACES}/{workspace}/audit-events"),
            &human_cookie,
            200,
        )
        .await?
        .body;
    assert!(
        audit["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["action"] == "grant.created"
                && event["actor"]["id"] == human_context["actor"]["id"])
    );
    assert!(
        audit["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["outcome"] == "denied")
    );
    f.browser
        .get(
            &format!("{WORKSPACES}/{workspace}/audit-events"),
            &b_cookie,
            403,
        )
        .await?;
    // An upstream outage is temporary, while a local logout remains revoked after recovery.
    f.oidc.userinfo_status(503);
    f.browser.get(CONTEXT, &a_cookie, 503).await?;
    f.oidc.userinfo_status(401);
    f.browser.get(CONTEXT, &a_cookie, 401).await?;
    f.oidc.userinfo_status(200);
    f.browser
        .post(&format!("{LOGIN}/logout"), &a_cookie, json!({}), 204)
        .await?;
    f.browser.get(CONTEXT, &a_cookie, 401).await?;
    f.stop()?;
    f.steady();
    f.start().await?;
    f.browser.get(CONTEXT, &a_cookie, 401).await?;
    assert_eq!(
        f.browser.get(CONTEXT, &human_cookie, 200).await?.body["workspaces"][0]["id"],
        workspace
    );
    f.stop()?;
    Ok(())
}
