use super::*;
use workspace_identity::federation::PrincipalKind;

pub(super) async fn handle(
    app: &App,
    path: &str,
    method: &Method,
    headers: &HeaderMap,
    query: &BTreeMap<String, String>,
    request: Request,
) -> workspace_contracts::Result<Response> {
    let audit = if path.starts_with("/api/raft/workspaces/")
        && matches!(method.as_str(), "POST" | "PATCH" | "PUT" | "DELETE")
    {
        if let (Some(raft), Some(secret)) = (&app.raft, cookie(headers, "aw_raft_session")) {
            raft.authenticate(secret, app.clock.now().await?).await.ok()
        } else {
            None
        }
    } else {
        None
    };
    match dispatch(app, path, method, headers, query, request).await {
        Ok(response) => Ok(response),
        Err(error) => {
            if let (Some(actor), Some(raft)) = (audit, &app.raft) {
                let parts = path
                    .trim_start_matches("/api/raft/workspaces/")
                    .split('/')
                    .collect::<Vec<_>>();
                if let [workspace, operation, ..] = parts.as_slice() {
                    let _ = raft
                        .directory()
                        .record_governance_failure(
                            &actor.principal,
                            workspace,
                            operation,
                            &error.code,
                            error.status >= 500,
                        )
                        .await;
                }
            }
            Err(error)
        }
    }
}

async fn dispatch(
    app: &App,
    path: &str,
    method: &Method,
    headers: &HeaderMap,
    query: &BTreeMap<String, String>,
    request: Request,
) -> workspace_contracts::Result<Response> {
    let raft = app.raft.as_ref().ok_or_else(|| err(404, "NOT_FOUND"))?;
    if headers
        .get(header::ORIGIN)
        .is_some_and(|origin| origin.to_str().ok() != Some(app.config.public_origin.as_str()))
    {
        return Err(err(403, "ORIGIN_DENIED"));
    }
    if headers.contains_key(header::AUTHORIZATION) {
        return Err(err(401, "RAFT_SESSION_REQUIRED"));
    }
    match (method.as_str(), path) {
        ("GET", "/.well-known/raft-agent-manifest.json") => {
            let mut manifest:Value=serde_json::from_str(include_str!("raft_manifest.json")).map_err(|_|err(503,"MANIFEST_UNAVAILABLE"))?;
            let base=format!("{}{}",app.config.public_origin,app.config.public_path);
            manifest["app_origin"]=json!(app.config.public_origin);
            manifest["execution"]["base_url"]=json!(app.config.public_origin);
            manifest["auth"]["login_url"]=json!(format!("{base}/auth/raft/login"));
            manifest["context_check"]["url"]=json!(format!("{base}/api/raft/actions/context"));
            for action in manifest["actions"].as_array_mut().ok_or_else(||err(503,"MANIFEST_UNAVAILABLE"))? {
                action["endpoint"]["path"]=json!(format!("{}{}",app.config.public_path,action["endpoint"]["path"].as_str().ok_or_else(||err(503,"MANIFEST_UNAVAILABLE"))?));
            }
            Ok(Json(manifest).into_response())
        }
        ("GET", "/api/raft/config") => Ok(Json(json!({"loginUrl":format!("{}{}/auth/raft/login",app.config.public_origin,app.config.public_path),"regions":app.config.regions.iter().map(|r|&r.region_id).collect::<Vec<_>>()})).into_response()),
        ("GET", "/auth/raft/login") => {
            let (target, flow) = raft.login("global-raft-login").await?;
            let mut response = StatusCode::SEE_OTHER.into_response();
            response.headers_mut().insert(
                header::LOCATION,
                target.parse().map_err(|_| err(503, "RAFT_UNAVAILABLE"))?,
            );
            response.headers_mut().append(header::SET_COOKIE, flow);
            Ok(response)
        }
        ("GET", "/auth/raft/callback") => {
            let login = match raft
                .callback(
                    cookie(headers, "aw_raft_flow"),
                    query,
                    app.clock.now().await?,
                )
                .await
            {
                Ok(login) => login,
                Err(error) => {
                    let hint = match error.code.as_str() {
                        "RAFT_LOGIN_REQUIRED" => "Obtain a fresh login code and start login again.",
                        "RAFT_STATE_REQUIRED"
                        | "SSO_STATE_INVALID"
                        | "SSO_STATE_MISMATCH"
                        | "RAFT_STATE_INVALID" => {
                            "Humans must start sign-in from the application's login page. Agents must use Login with Raft."
                        }
                        "RAFT_IDENTITY_INVALID"
                        | "INVALID_EXTERNAL_IDENTITY"
                        | "IDENTITY_KIND_MISMATCH" => {
                            "The login does not match the configured app and allowed identity."
                        }
                        _ => {
                            "Login could not complete. Try a fresh login when the service is available."
                        }
                    };
                    let mut response = (
                        StatusCode::from_u16(error.status)
                            .unwrap_or(StatusCode::SERVICE_UNAVAILABLE),
                        Json(json!({"error":error.code,"hint":hint})),
                    )
                        .into_response();
                    response
                        .headers_mut()
                        .append(header::SET_COOKIE, raft.cookie("aw_raft_flow", "", 0)?);
                    return Ok(response);
                }
            };
            let mut response = if login.kind == PrincipalKind::Human {
                let mut response = StatusCode::SEE_OTHER.into_response();
                response.headers_mut().insert(
                    header::LOCATION,
                    raft.config
                        .post_login_url
                        .parse()
                        .map_err(|_| err(503, "SESSION_UNAVAILABLE"))?,
                );
                response
            } else {
                Json(json!({"authenticated":true,"nextAction":"invoke context"})).into_response()
            };
            response
                .headers_mut()
                .append(header::SET_COOKIE, login.cookie);
            response
                .headers_mut()
                .append(header::SET_COOKIE, raft.cookie("aw_raft_flow", "", 0)?);
            Ok(response)
        }
        ("POST", "/auth/raft/logout") => {
            // JSON plus same-origin browser metadata prevents form-based CSRF. Native
            // clients without browser metadata still need a valid service session.
            if headers
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                != Some("application/json")
                || headers
                    .get("sec-fetch-site")
                    .is_some_and(|v| v != "same-origin" && v != "none")
            {
                return Err(err(403, "CSRF_DENIED"));
            }
            let secret =
                cookie(headers, "aw_raft_session").ok_or_else(|| err(401, "UNAUTHENTICATED"))?;
            let mut response = StatusCode::NO_CONTENT.into_response();
            response
                .headers_mut()
                .append(header::SET_COOKIE, raft.logout(secret).await?);
            Ok(response)
        }
        ("GET", "/api/raft/actions/context") => {
            let secret =
                cookie(headers, "aw_raft_session").ok_or_else(|| err(401, "UNAUTHENTICATED"))?;
            let actor = raft.authenticate(secret, app.clock.now().await?).await?;
            let workspaces = raft
                .directory()
                .workspaces(&actor.principal, query.get("cursor").cloned())
                .await?;
            let admitted = workspaces["data"]
                .as_array()
                .is_some_and(|items| !items.is_empty());
            Ok(Json(
                json!({"actor":{"id":actor.principal.id,"kind":actor.principal.identity.kind,
                "serverId":actor.principal.identity.server_id},"expiresAt":actor.expires_at,
                "enrollmentRequired":!admitted,"resourceReady":null,"readinessAction":"list-resources","workspaces":workspaces["data"],"nextCursor":workspaces["nextCursor"]}),
            )
            .into_response())
        }
        _ if path.starts_with("/api/raft/actions/") => {
            super::raft_actions::handle(app, path, method, headers, query, request).await
        }
        _ if path.starts_with("/api/raft/workspaces/") && path.contains("/resources") => {
            super::raft_actions::governance(app, path, method, headers, query, request).await
        }
        _ if path.starts_with("/api/raft/workspaces") => {
            let secret =
                cookie(headers, "aw_raft_session").ok_or_else(|| err(401, "UNAUTHENTICATED"))?;
            let actor = raft.authenticate(secret, app.clock.now().await?).await?;
            let input = if method == Method::POST || method == Method::PATCH {
                if headers
                    .get(header::CONTENT_TYPE)
                    .and_then(|v| v.to_str().ok())
                    != Some("application/json")
                    || headers
                        .get("sec-fetch-site")
                        .is_some_and(|v| v != "same-origin" && v != "none")
                {
                    return Err(err(403, "CSRF_DENIED"));
                }
                let raw = to_bytes(request.into_body(), 65536)
                    .await
                    .map_err(|_| err(413, "BODY_TOO_LARGE"))?;
                serde_json::from_slice::<Value>(&raw).map_err(|_| err(400, "INVALID_BODY"))?
            } else {
                Value::Null
            };
            let parts = path
                .trim_start_matches("/api/raft/workspaces")
                .trim_matches('/')
                .split('/')
                .collect::<Vec<_>>();
            let directory = raft.directory();
            match (method.as_str(), parts.as_slice()) {
                ("POST", [""]) => {
                    actor.recent_human(app.clock.now().await?)?;
                    if actor.principal.identity.kind != PrincipalKind::Human {
                        return Err(err(403, "HUMAN_APPROVAL_REQUIRED"));
                    }
                    #[derive(Deserialize)]
                    #[serde(rename_all = "camelCase", deny_unknown_fields)]
                    struct Create {
                        request_id: String,
                        name: String,
                        region_id: String,
                    }
                    let input: Create =
                        serde_json::from_value(input).map_err(|_| err(400, "INVALID_BODY"))?;
                    if !app
                        .config
                        .regions
                        .iter()
                        .any(|r| r.region_id == input.region_id)
                    {
                        return Err(err(400, "INVALID_REGION"));
                    }
                    let workspace = directory
                        .create_workspace(
                            &actor.principal,
                            &input.request_id,
                            &input.name,
                            &input.region_id,
                        )
                        .await?;
                    apply_policy(app, &workspace).await?;
                    Ok((
                        StatusCode::CREATED,
                        Json(json!({"data":workspace,"resourceReady":false})),
                    )
                        .into_response())
                }
                ("GET", [workspace]) if !workspace.is_empty() => {
                    let (workspace,member)=directory.membership(&actor.principal,workspace).await?;
                    let mut value=json!(workspace);value["canManage"]=json!(member.governor&&actor.principal.identity.kind==PrincipalKind::Human);
                    Ok(Json(json!({"data":value})).into_response())
                }
                ("GET", [""]) => Ok(Json(
                    directory
                        .workspaces(&actor.principal, query.get("cursor").cloned())
                        .await?,
                )
                .into_response()),
                ("POST", [workspace, "enrollments"]) => {
                    if input != json!({}) {
                        return Err(err(400, "INVALID_BODY"));
                    }
                    Ok((StatusCode::CREATED,Json(json!({"data":directory.request_enrollment(&actor.principal,workspace).await?}))).into_response())
                }
                ("GET", [workspace, "principals", principal]) => Ok(Json(json!({
                    "data":directory.admission_candidate(&actor.principal,workspace,principal).await?
                })).into_response()),
                ("POST", [workspace, "invitations"]) => {
                    actor.recent_human(app.clock.now().await?)?;
                    #[derive(Deserialize)]
                    #[serde(rename_all = "camelCase", deny_unknown_fields)]
                    struct Invitation {
                        request_id: String,
                        principal_id: String,
                    }
                    let input: Invitation = serde_json::from_value(input)
                        .map_err(|_| err(400, "INVALID_BODY"))?;
                    let invited = directory.invite(&actor.principal,workspace,&input.principal_id,
                        &input.request_id,revision(headers)?).await?;
                    let updated = directory.membership(&actor.principal,workspace).await?.0;
                    apply_policy(app,&updated).await?;
                    Ok((StatusCode::CREATED,Json(json!({
                        "data":invited,"authorizationStatus":"applied"
                    }))).into_response())
                }
                ("GET", [workspace, "invitations", request]) => Ok(Json(json!({
                    "data":directory.invitation(&actor.principal,workspace,request).await?
                })).into_response()),
                ("GET",[workspace,"audit-events"])=>Ok(Json(directory.audit_events(&actor.principal,workspace,query.get("cursor").cloned()).await?).into_response()),
                ("GET", [workspace, "enrollments"]) => Ok(Json(
                    directory
                        .enrollments(&actor.principal, workspace, query.get("cursor").cloned())
                        .await?,
                )
                .into_response()),
                ("DELETE", [workspace, "members", principal]) => {
                    actor.recent_human(app.clock.now().await?)?;
                    if headers
                        .get("sec-fetch-site")
                        .is_some_and(|v| v != "same-origin" && v != "none")
                    {
                        return Err(err(403, "CSRF_DENIED"));
                    }
                    let updated = directory
                        .suspend_member(&actor.principal, workspace, principal,Some(revision(headers)?))
                        .await?;
                    apply_policy(app, &updated).await?;
                    Ok(
                        Json(json!({"data":updated,"authorizationStatus":"applied"}))
                            .into_response(),
                    )
                }
                ("GET", [workspace, "enrollments", "self"]) => Ok(Json(
                    json!({"data":directory.enrollment(&actor.principal,workspace).await?}),
                )
                .into_response()),
                ("PATCH", [workspace, "enrollments", principal]) => {
                    actor.recent_human(app.clock.now().await?)?;
                    #[derive(Deserialize)]
                    #[serde(deny_unknown_fields)]
                    struct Decision {
                        approved: bool,
                    }
                    let input: Decision =
                        serde_json::from_value(input).map_err(|_| err(400, "INVALID_BODY"))?;
                    let enrollment = directory
                        .decide_enrollment(&actor.principal, workspace, principal, input.approved,Some(revision(headers)?))
                        .await?;
                    let updated = directory.membership(&actor.principal, workspace).await?.0;
                    apply_policy(app, &updated).await?;
                    Ok(
                        Json(json!({"data":enrollment,"authorizationStatus":"applied"}))
                            .into_response(),
                    )
                }
                _ => Err(err(404, "NOT_FOUND")),
            }
        }
        _ => Err(err(404, "NOT_FOUND")),
    }
}

pub(super) async fn apply_policy(
    app: &App,
    workspace: &workspace_identity::federation::Workspace,
) -> workspace_contracts::Result<()> {
    let raft = app
        .raft
        .as_ref()
        .ok_or_else(|| err(503, "FEDERATION_UNAVAILABLE"))?;
    let region = app
        .regional
        .get(&workspace.region_id)
        .ok_or_else(|| err(503, "REGION_UNAVAILABLE"))?;
    if let Some(initial) = raft.directory().pending_placement(&workspace.id).await? {
        region.control.federation(&initial).await?;
        raft.directory().confirm_placement(&initial).await?;
    }
    region.control.federation(workspace).await?;
    Ok(())
}

pub(super) fn revision(headers: &HeaderMap) -> workspace_contracts::Result<u64> {
    let value = headers
        .get(header::IF_MATCH)
        .ok_or_else(|| err(428, "POLICY_VERSION_REQUIRED"))?
        .to_str()
        .map_err(|_| err(400, "INVALID_PRECONDITION"))?;
    let number = value
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n > 0)
        .ok_or_else(|| err(400, "INVALID_PRECONDITION"))?;
    if value != format!("\"{number}\"") {
        return Err(err(400, "INVALID_PRECONDITION"));
    }
    Ok(number)
}
