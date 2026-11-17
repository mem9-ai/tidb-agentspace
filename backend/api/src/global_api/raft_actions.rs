//! Same-origin Raft action adapter. Region receives a live Raft credential plus a short,
//! signed exact-resource ceiling; browser cookies and Owner credentials are never forwarded.
use super::*;
use crate::raft_auth::{Authenticated, Runtime as Raft};
use workspace_identity::federation::{ResourceAction, Workspace};

struct Decision {
    workspace: Workspace,
    scopes: Vec<String>,
    observed: i64,
    expires_at: i64,
}
struct Call {
    selector: String,
    method: Method,
    route: String,
    input: Option<Value>,
    query: BTreeMap<String, String>,
    idempotency: Option<String>,
    condition: Option<(&'static str, String)>,
}
fn value<'a>(
    query: &'a BTreeMap<String, String>,
    key: &str,
) -> workspace_contracts::Result<&'a str> {
    query
        .get(key)
        .map(String::as_str)
        .filter(|v| !v.is_empty() && v.len() <= 1024)
        .ok_or_else(|| err(400, "INVALID_PARAMETER"))
}
fn identifier(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
async fn actor(
    app: &App,
    raft: &Raft,
    headers: &HeaderMap,
) -> workspace_contracts::Result<Authenticated> {
    let cookie = cookie(headers, "aw_raft_session").ok_or_else(|| err(401, "UNAUTHENTICATED"))?;
    raft.authenticate(cookie, app.clock.now().await?).await
}
async fn resource_decision(
    app: &App,
    raft: &Raft,
    actor: &Authenticated,
    workspace: &str,
    resource: &str,
) -> workspace_contracts::Result<Decision> {
    if !identifier(resource) {
        return Err(err(400, "INVALID_RESOURCE"));
    }
    let observed = app.clock.now().await?;
    for _ in 0..8 {
        let before = raft
            .directory()
            .membership(&actor.principal, workspace)
            .await?
            .0;
        let access = raft
            .directory()
            .resource_access(&actor.principal, workspace, resource, observed)
            .await?;
        let actions = access.actions;
        let after = raft
            .directory()
            .membership(&actor.principal, workspace)
            .await?
            .0;
        if before.generation != after.generation {
            continue;
        }
        let mut scopes = actions
            .iter()
            .filter(|a| **a != ResourceAction::EditTags)
            .map(|a| a.as_str().to_owned())
            .collect::<Vec<_>>();
        if actions.contains(&ResourceAction::ExecuteQueries)
            && !actions.contains(&ResourceAction::ReadQueries)
        {
            scopes.push("queries:read".into());
        }
        if scopes.is_empty() {
            return Err(err(404, "NOT_FOUND"));
        }
        return Ok(Decision {
            workspace: after,
            scopes,
            observed,
            expires_at: access.expires_at,
        });
    }
    Err(err(409, "POLICY_CHANGED"))
}
async fn governor(
    app: &App,
    raft: &Raft,
    actor: &Authenticated,
    workspace: &str,
    scope: &str,
) -> workspace_contracts::Result<Decision> {
    let observed = app.clock.now().await?;
    let (workspace, membership) = raft
        .directory()
        .membership(&actor.principal, workspace)
        .await?;
    membership.govern(&actor.principal)?;
    if scope == "resources:write" {
        actor.recent_human(observed)?;
    }
    Ok(Decision {
        workspace,
        scopes: vec![scope.into()],
        observed,
        expires_at: actor.expires_at,
    })
}
async fn regional(
    app: &App,
    raft: &Raft,
    actor: &Authenticated,
    decision: Decision,
    call: Call,
) -> workspace_contracts::Result<Value> {
    super::raft_routes::apply_policy(app, &decision.workspace).await?;
    let now = app.clock.now().await?;
    let expiry = actor
        .expires_at
        .min(
            decision
                .observed
                .saturating_add(crate::raft_auth::ADMISSION_SECONDS),
        )
        .min(decision.expires_at);
    if expiry <= now {
        return Err(err(503, "POLICY_OBSERVATION_EXPIRED"));
    }
    let region = app
        .regional
        .get(&decision.workspace.region_id)
        .ok_or_else(|| err(503, "REGION_UNAVAILABLE"))?;
    let stamp = actor.principal.identity.stamp_id()?;
    let issued = region.access.sign(
        &Issuance {
            workspace_id: &decision.workspace.id,
            principal_id: &actor.principal.id,
            key_id: &stamp,
            key_version: 1,
            policy_generation: decision.workspace.generation,
            grant_ref: &format!("federated:{}", call.selector),
            scopes: &decision.scopes,
            key_expires_at: expiry,
            grant_expires_at: expiry,
            family: None,
        },
        now,
    )?;
    let descriptor = app
        .config
        .regions
        .iter()
        .find(|r| r.region_id == decision.workspace.region_id)
        .ok_or_else(|| err(503, "REGION_UNAVAILABLE"))?;
    let target = format!(
        "{}{}/api/federated/workspaces/{}/{}",
        descriptor.api_origin, descriptor.api_path_prefix, decision.workspace.id, call.route
    );
    let mut target = reqwest::Url::parse(&target).map_err(|_| err(503, "REGION_UNAVAILABLE"))?;
    target.query_pairs_mut().extend_pairs(&call.query);
    let mut proof = header::HeaderValue::from_str(&issued.token)
        .map_err(|_| err(503, "REGIONAL_REQUEST_FAILED"))?;
    proof.set_sensitive(true);
    let mut request = raft
        .client
        .request(call.method, target)
        .timeout(Duration::from_secs(30))
        .bearer_auth(&actor.access_token)
        .header("x-agentspace-policy", proof);
    if let Some(input) = call.input {
        request = request.json(&input);
    }
    if let Some((name, value)) = call.condition {
        let value =
            header::HeaderValue::from_str(&value).map_err(|_| err(400, "INVALID_PRECONDITION"))?;
        request = request.header(name, value);
    }
    if let Some(idempotency) = call.idempotency {
        request = request.header("Idempotency-Key", idempotency);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| err(503, "REGIONAL_OUTCOME_UNKNOWN"))?;
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| err(503, "REGIONAL_OUTCOME_UNKNOWN"))?
    {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err(err(502, "REGIONAL_RESULT_TOO_LARGE"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let body: Value =
        serde_json::from_slice(&bytes).map_err(|_| err(502, "REGIONAL_INVALID_RESPONSE"))?;
    if !(200..300).contains(&status) {
        let code = body["error"]["code"]
            .as_str()
            .filter(|s| s.len() <= 100 && s.bytes().all(|b| b.is_ascii_uppercase() || b == b'_'))
            .unwrap_or("REGIONAL_REQUEST_FAILED");
        return Err(ServiceError::new(status, code));
    }
    raft.revalidate(actor, app.clock.now().await?).await?;
    // Permission is checked again before returning rows or file content after network I/O.
    let (_, membership) = raft
        .directory()
        .membership(&actor.principal, &decision.workspace.id)
        .await?;
    if call.selector.starts_with("create-") || call.selector == "governance" {
        membership.govern(&actor.principal)?;
    }
    if !call.selector.starts_with("create-") && call.selector != "governance" {
        let current =
            resource_decision(app, raft, actor, &decision.workspace.id, &call.selector).await?;
        if !decision.scopes.iter().all(|s| current.scopes.contains(s)) {
            return Err(err(403, "POLICY_CHANGED"));
        }
    }
    Ok(body)
}
fn get(selector: &str, route: String, query: BTreeMap<String, String>) -> Call {
    Call {
        selector: selector.into(),
        method: Method::GET,
        route,
        input: None,
        query,
        idempotency: None,
        condition: None,
    }
}
async fn json_input(request: Request, headers: &HeaderMap) -> workspace_contracts::Result<Value> {
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
    let bytes = to_bytes(request.into_body(), 128 * 1024)
        .await
        .map_err(|_| err(413, "BODY_TOO_LARGE"))?;
    serde_json::from_slice(&bytes).map_err(|_| err(400, "INVALID_BODY"))
}

pub(super) async fn handle(
    app: &App,
    path: &str,
    method: &Method,
    headers: &HeaderMap,
    query: &BTreeMap<String, String>,
    request: Request,
) -> workspace_contracts::Result<Response> {
    let raft = app.raft.as_ref().ok_or_else(|| err(404, "NOT_FOUND"))?;
    let actor = actor(app, raft, headers).await?;
    let result = match (method.as_str(), path) {
        ("GET", "/api/raft/actions/list-resources") => {
            list_resources(app, raft, &actor, query).await?
        }
        ("GET", "/api/raft/actions/read-file") => {
            let workspace = value(query, "workspaceId")?;
            let resource = value(query, "resourceId")?;
            let path = relative_path(value(query, "path")?)?;
            let decision = resource_decision(app, raft, &actor, workspace, resource).await?;
            if !decision.scopes.iter().any(|s| s == "files:read") {
                return Err(err(403, "FORBIDDEN"));
            }
            let body = regional(
                app,
                raft,
                &actor,
                decision,
                get(
                    resource,
                    "files/content".into(),
                    BTreeMap::from([
                        ("resourceId".into(), resource.into()),
                        ("path".into(), path),
                        ("preview".into(), "1".into()),
                    ]),
                ),
            )
            .await?;
            file_content(body)?
        }
        ("POST", "/api/raft/actions/query") => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Query {
                workspace_id: String,
                resource_id: String,
                request_id: String,
                sql: String,
                #[serde(default)]
                parameters: Vec<Value>,
            }
            let input: Query = serde_json::from_value(json_input(request, headers).await?)
                .map_err(|_| err(400, "INVALID_BODY"))?;
            // The body is the target for POST; query target overrides are forbidden.
            if !query.is_empty() {
                return Err(err(400, "INVALID_PARAMETER"));
            }
            if !input.parameters.is_empty() {
                return Err(err(422, "QUERY_PARAMETERS_UNSUPPORTED"));
            }
            let workspace = input.workspace_id.as_str();
            let decision =
                resource_decision(app, raft, &actor, workspace, &input.resource_id).await?;
            if !decision
                .scopes
                .iter()
                .any(|s| s == "queries:read" || s == "queries:execute")
            {
                return Err(err(403, "FORBIDDEN"));
            }
            regional(app,raft,&actor,decision,Call {selector:input.resource_id.clone(),method:Method::POST,route:"query-requests".into(),
                input:Some(json!({"resourceId":input.resource_id,"requestId":input.request_id,"sql":input.sql})),query:BTreeMap::new(),idempotency:None,condition:None}).await?
        }
        ("GET", "/api/raft/actions/query-status") => {
            let workspace = value(query, "workspaceId")?;
            let resource = value(query, "resourceId")?;
            let request = value(query, "requestId")?;
            if !Uuid::parse_str(request).is_ok_and(|id| id.to_string() == request) {
                return Err(err(400, "INVALID_REQUEST_ID"));
            }
            let decision = resource_decision(app, raft, &actor, workspace, resource).await?;
            regional(
                app,
                raft,
                &actor,
                decision,
                get(
                    resource,
                    format!("resources/{resource}/query-requests/{request}"),
                    BTreeMap::new(),
                ),
            )
            .await?
        }
        _ => return Err(err(404, "NOT_FOUND")),
    };
    let result = if matches!(
        path,
        "/api/raft/actions/query" | "/api/raft/actions/query-status"
    ) {
        json!({"requestId":result["operation"]["requestId"],"operationId":result["operation"]["requestId"],
            "status":result["operation"]["state"],"result":result["result"],"errorCode":result["operation"]["errorCode"]})
    } else {
        result
    };
    let status = if path == "/api/raft/actions/query" && result["status"] == "running" {
        StatusCode::ACCEPTED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(result)).into_response())
}

pub(super) async fn resource_metadata(
    app: &App,
    raft: &Raft,
    actor: &Authenticated,
    workspace: &str,
    resource: &str,
) -> workspace_contracts::Result<Value> {
    if !identifier(resource) {
        return Err(err(400, "INVALID_RESOURCE"));
    }
    let decision = governor(app, raft, actor, workspace, "resources:read").await?;
    regional(
        app,
        raft,
        actor,
        decision,
        get(
            "governance",
            format!("resources/{resource}"),
            BTreeMap::new(),
        ),
    )
    .await
}

pub(super) async fn governance(
    app: &App,
    path: &str,
    method: &Method,
    headers: &HeaderMap,
    query: &BTreeMap<String, String>,
    request: Request,
) -> workspace_contracts::Result<Response> {
    let raft = app.raft.as_ref().ok_or_else(|| err(404, "NOT_FOUND"))?;
    let actor = actor(app, raft, headers).await?;
    let parts = path
        .trim_start_matches("/api/raft/workspaces/")
        .split('/')
        .collect::<Vec<_>>();
    let result = match (method.as_str(), parts.as_slice()) {
        ("POST", [workspace, "resources", "share-batches"]) => {
            actor.recent_human(app.clock.now().await?)?;
            #[derive(Deserialize, Serialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Batch {
                request_id: String,
                principal_id: String,
                resource_ids: Vec<String>,
                actions: Vec<ResourceAction>,
                expires_at: i64,
            }
            let input: Batch = serde_json::from_value(json_input(request, headers).await?)
                .map_err(|_| err(400, "INVALID_BODY"))?;
            valid_expiry(input.expires_at, app.clock.now().await?)?;
            if input.resource_ids.is_empty()
                || input.resource_ids.len() > 20
                || input
                    .resource_ids
                    .iter()
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
                    != input.resource_ids.len()
            {
                return Err(err(400, "INVALID_RESOURCE_SET"));
            }
            for resource in &input.resource_ids {
                let metadata = resource_metadata(app, raft, &actor, workspace, resource).await?;
                validate_actions(&input.actions, metadata["data"]["kind"] == "filesystem")?;
            }
            raft.directory().prepare_share_batch(&actor.principal,workspace,&input.request_id,json!({"principalId":input.principal_id,"resourceIds":input.resource_ids,"actions":input.actions,"expiresAt":input.expires_at}),Some(super::raft_routes::revision(headers)?)).await?;
            let mut results = Vec::new();
            for resource in &input.resource_ids {
                let digest = Sha256::digest(
                    format!(
                        "share-batch-v1\0{}\0{}\0{}",
                        actor.principal.id, input.request_id, resource
                    )
                    .as_bytes(),
                );
                let grant = workspace_identity::federation::AccessGrant {
                    id: Uuid::from_bytes(digest[..16].try_into().expect("16 bytes")).to_string(),
                    principal_id: input.principal_id.clone(),
                    resource_id: resource.clone(),
                    actions: input.actions.clone(),
                    revoked: false,
                    expires_at: Some(input.expires_at),
                };
                let result = match raft
                    .directory()
                    .put_grant(&actor.principal, workspace, grant.clone(), None)
                    .await
                {
                    Ok(updated) => match super::raft_routes::apply_policy(app, &updated).await {
                        Ok(()) => json!({"resourceId":resource,"grant":grant,"status":"applied"}),
                        Err(e) => {
                            json!({"resourceId":resource,"status":"pending","errorCode":e.code})
                        }
                    },
                    Err(e) => json!({"resourceId":resource,"status":"failed","errorCode":e.code}),
                };
                results.push(result);
            }
            json!({"requestId":input.request_id,"results":results})
        }
        ("GET", [workspace, "resources"]) => {
            let decision = governor(app, raft, &actor, workspace, "resources:read").await?;
            regional(
                app,
                raft,
                &actor,
                decision,
                get("governance", "resources".into(), query.clone()),
            )
            .await?
        }
        ("POST", [workspace, "resources"]) => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Create {
                request_id: String,
                kind: String,
                name: String,
                region: String,
            }
            let input: Create = serde_json::from_value(json_input(request, headers).await?)
                .map_err(|_| err(400, "INVALID_BODY"))?;
            if !matches!(input.kind.as_str(), "filesystem" | "postgresql")
                || Uuid::parse_str(&input.request_id).is_err()
            {
                return Err(err(400, "INVALID_RESOURCE"));
            }
            let decision = governor(app, raft, &actor, workspace, "resources:write").await?;
            let body = regional(
                app,
                raft,
                &actor,
                decision,
                Call {
                    selector: format!("create-{}", input.kind),
                    method: Method::POST,
                    route: "resources".into(),
                    input: Some(json!({"kind":input.kind,"name":input.name,"region":input.region})),
                    query: BTreeMap::new(),
                    idempotency: Some(input.request_id.clone()),
                    condition: None,
                },
            )
            .await?;
            let resource = body["data"]["id"]
                .as_str()
                .filter(|id| identifier(id))
                .ok_or_else(|| err(502, "REGIONAL_INVALID_RESPONSE"))?;
            let actions = if input.kind == "filesystem" {
                vec![
                    ResourceAction::Discover,
                    ResourceAction::ReadFiles,
                    ResourceAction::WriteFiles,
                    ResourceAction::EditTags,
                ]
            } else {
                vec![
                    ResourceAction::Discover,
                    ResourceAction::ReadQueries,
                    ResourceAction::ExecuteQueries,
                    ResourceAction::EditTags,
                ]
            };
            // A repeated create uses the same native attempt and exact initial-grant intent.
            let digest = Sha256::digest(
                format!(
                    "initial-grant-v1\0{}\0{}\0{}",
                    actor.principal.id, resource, input.request_id
                )
                .as_bytes(),
            );
            let grant = workspace_identity::federation::AccessGrant {
                id: Uuid::from_bytes(digest[..16].try_into().expect("16 bytes")).to_string(),
                principal_id: actor.principal.id.clone(),
                resource_id: resource.into(),
                actions,
                revoked: false,
                expires_at: None,
            };
            let updated = raft
                .directory()
                .put_grant(&actor.principal, workspace, grant, None)
                .await?;
            super::raft_routes::apply_policy(app, &updated).await?;
            let decision = resource_decision(app, raft, &actor, workspace, resource).await?;
            regional(
                app,
                raft,
                &actor,
                decision,
                get(resource, format!("resources/{resource}"), BTreeMap::new()),
            )
            .await?
        }
        ("PUT", [workspace, "resources", resource, "tags"]) => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Tags {
                version: u64,
                values: BTreeMap<String, String>,
            }
            let input: Tags = serde_json::from_value(json_input(request, headers).await?)
                .map_err(|_| err(400, "INVALID_BODY"))?;
            let decision = resource_decision(app, raft, &actor, workspace, resource).await?;
            regional(
                app,
                raft,
                &actor,
                decision,
                get(resource, format!("resources/{resource}"), BTreeMap::new()),
            )
            .await?;
            let tags = raft
                .directory()
                .set_tags(
                    &actor.principal,
                    workspace,
                    resource,
                    input.version,
                    input.values,
                    app.clock.now().await?,
                )
                .await?;
            let updated = raft
                .directory()
                .membership(&actor.principal, workspace)
                .await?
                .0;
            super::raft_routes::apply_policy(app, &updated).await?;
            json!({"data":tags})
        }
        ("GET", [workspace, "resources", resource, "files"]) => {
            let path = relative_path(value(query, "path")?)?;
            let decision = resource_decision(app, raft, &actor, workspace, resource).await?;
            let body = regional(
                app,
                raft,
                &actor,
                decision,
                get(
                    resource,
                    "files/content".into(),
                    BTreeMap::from([
                        ("resourceId".into(), (*resource).into()),
                        ("path".into(), path),
                        ("preview".into(), "1".into()),
                    ]),
                ),
            )
            .await?;
            file_content(body)?
        }
        ("PUT", [workspace, "resources", resource, "files"]) => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Write {
                path: String,
                content: String,
                version: Option<String>,
            }
            let input: Write = serde_json::from_value(json_input(request, headers).await?)
                .map_err(|_| err(400, "INVALID_BODY"))?;
            let path = relative_path(&input.path)?;
            if input.content.len() > 65536 || input.version.as_ref().is_some_and(|v| v.len() > 256)
            {
                return Err(err(413, "FILE_TOO_LARGE"));
            }
            let decision = resource_decision(app, raft, &actor, workspace, resource).await?;
            let condition = match input.version {
                Some(version) => ("If-Match", version),
                None => ("If-None-Match", "*".into()),
            };
            regional(app,raft,&actor,decision,Call {selector:(*resource).into(),method:Method::PUT,route:"files".into(),
                input:Some(json!({"resourceId":resource,"path":path,"type":"file","content":input.content})),query:BTreeMap::new(),idempotency:None,condition:Some(condition)}).await?
        }
        ("GET", [workspace, "resources", resource, "grants"]) => {
            resource_metadata(app, raft, &actor, workspace, resource).await?;
            let page = raft
                .directory()
                .resource_grants(
                    &actor.principal,
                    workspace,
                    resource,
                    query.get("cursor").cloned(),
                )
                .await?;
            json!({"data":page["records"].as_array().ok_or_else(||err(503,"FEDERATED_RECORD_CORRUPT"))?.iter().map(|r|&r["value"]).collect::<Vec<_>>(),"nextCursor":page["nextCursor"]})
        }
        ("PUT", [workspace, "resources", resource, "grants", grant]) => {
            actor.recent_human(app.clock.now().await?)?;
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Share {
                principal_id: String,
                actions: Vec<ResourceAction>,
                #[serde(default)]
                revoked: bool,
                expires_at: Option<i64>,
            }
            let input: Share = serde_json::from_value(json_input(request, headers).await?)
                .map_err(|_| err(400, "INVALID_BODY"))?;
            if !input.revoked {
                valid_expiry(
                    input
                        .expires_at
                        .ok_or_else(|| err(400, "GRANT_EXPIRY_REQUIRED"))?,
                    app.clock.now().await?,
                )?;
            }
            let record = resource_metadata(app, raft, &actor, workspace, resource).await?;
            let files = record["data"]["kind"] == "filesystem";
            validate_actions(&input.actions, files)?;
            let grant = workspace_identity::federation::AccessGrant {
                id: (*grant).into(),
                principal_id: input.principal_id,
                resource_id: (*resource).into(),
                actions: input.actions,
                revoked: input.revoked,
                expires_at: input.expires_at,
            };
            let updated = raft
                .directory()
                .put_grant(
                    &actor.principal,
                    workspace,
                    grant.clone(),
                    Some(super::raft_routes::revision(headers)?),
                )
                .await?;
            super::raft_routes::apply_policy(app, &updated).await?;
            json!({"data":grant,"authorizationStatus":"applied"})
        }
        _ => return Err(err(404, "NOT_FOUND")),
    };
    let mut result = result;
    if let Some(resources) = result["data"].as_array_mut() {
        for resource in resources {
            project_resource(resource);
        }
    } else {
        project_resource(&mut result["data"]);
    }
    Ok(Json(result).into_response())
}

// Native capabilities include operations this opt-in adapter does not expose.
fn project_resource(resource: &mut Value) {
    if !matches!(resource["kind"].as_str(), Some("filesystem" | "postgresql")) {
        return;
    }
    if let Some(fields) = resource.as_object_mut() {
        fields.retain(|key, _| {
            matches!(
                key.as_str(),
                "id" | "name"
                    | "kind"
                    | "region"
                    | "status"
                    | "provider"
                    | "allowedActions"
                    | "tags"
                    | "createdBy"
            )
        });
    }
    if let Some(actions) = resource["allowedActions"].as_array_mut() {
        actions.retain(|action| {
            matches!(
                action.as_str(),
                Some(
                    "resources:read"
                        | "files:read"
                        | "files:write"
                        | "queries:read"
                        | "queries:execute"
                        | "tags:write"
                )
            )
        });
    }
}

fn relative_path(path: &str) -> workspace_contracts::Result<String> {
    if path.is_empty()
        || path.len() > 1024
        || path.starts_with('/')
        || path.contains('\\')
        || path.chars().any(char::is_control)
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(err(400, "INVALID_PATH"));
    }
    Ok(format!("/{path}"))
}
fn file_content(body: Value) -> workspace_contracts::Result<Value> {
    let content = body["content"]
        .as_str()
        .ok_or_else(|| err(422, "FILE_CONTENT_UNAVAILABLE"))?;
    if content.len() > 128 * 1024 {
        return Err(err(413, "FILE_TOO_LARGE"));
    }
    let mut result = json!({"content":content,"encoding":"utf8","size":body["size"]});
    if let Some(version) = body["version"].as_str() {
        result["revision"] = json!(version);
    }
    Ok(result)
}

/// Cursor contents are bounded to the actor's own index. The fingerprint prevents
/// accidentally continuing a different filter or policy snapshot; it conveys no rights.
async fn list_resources(
    app: &App,
    raft: &Raft,
    actor: &Authenticated,
    query: &BTreeMap<String, String>,
) -> workspace_contracts::Result<Value> {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    if query
        .keys()
        .any(|k| !matches!(k.as_str(), "workspaceId" | "cursor" | "tags"))
    {
        return Err(err(400, "INVALID_PARAMETER"));
    }
    let workspace = value(query, "workspaceId")?;
    let tags: BTreeMap<String, String> = query
        .get("tags")
        .map(|s| serde_json::from_str(s).map_err(|_| err(400, "INVALID_TAGS")))
        .transpose()?
        .unwrap_or_default();
    if tags.len() > 20 || tags.iter().any(|(k, v)| k.len() > 64 || v.len() > 256) {
        return Err(err(400, "INVALID_TAGS"));
    }
    let snapshot = raft
        .directory()
        .membership(&actor.principal, workspace)
        .await?
        .0;
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&json!([
                actor.principal.id,
                workspace,
                snapshot.generation,
                tags
            ]))
            .map_err(|_| err(400, "INVALID_TAGS"))?
        )
    );
    #[derive(Deserialize, Serialize)]
    #[serde(deny_unknown_fields)]
    struct Cursor {
        fingerprint: String,
        after: String,
    }
    let after = if let Some(encoded) = query.get("cursor") {
        if encoded.len() > 1024 {
            return Err(err(400, "INVALID_PAGE_CURSOR"));
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| err(400, "INVALID_PAGE_CURSOR"))?;
        let cursor: Cursor =
            serde_json::from_slice(&bytes).map_err(|_| err(400, "INVALID_PAGE_CURSOR"))?;
        if cursor.fingerprint != fingerprint {
            return Err(err(409, "PAGE_SNAPSHOT_CHANGED"));
        }
        Some(cursor.after)
    } else {
        None
    };
    let page = raft
        .directory()
        .resource_index(&actor.principal, workspace, after)
        .await?;
    let mut resources = Vec::new();
    for record in page["records"]
        .as_array()
        .ok_or_else(|| err(503, "FEDERATED_RECORD_CORRUPT"))?
    {
        let id = record["value"]["resourceId"]
            .as_str()
            .ok_or_else(|| err(503, "FEDERATED_RECORD_CORRUPT"))?;
        let actions = raft
            .directory()
            .resource_actions(&actor.principal, workspace, id, app.clock.now().await?)
            .await?;
        if !actions.contains(&ResourceAction::Discover) {
            continue;
        }
        let metadata = raft
            .directory()
            .tags(&actor.principal, workspace, id, app.clock.now().await?)
            .await?;
        if !tags.iter().all(|(k, v)| metadata["values"][k] == *v) {
            continue;
        }
        let decision = resource_decision(app, raft, actor, workspace, id).await?;
        let body = match regional(
            app,
            raft,
            actor,
            decision,
            get(id, format!("resources/{id}"), BTreeMap::new()),
        )
        .await
        {
            Err(e) if e.status == 404 => continue,
            result => result?,
        };
        let mut resource = body["data"].clone();
        resource["tags"] = metadata;
        if actions.contains(&ResourceAction::EditTags)
            && let Some(allowed) = resource["allowedActions"].as_array_mut()
        {
            allowed.push(json!("tags:write"));
        }
        project_resource(&mut resource);
        resources.push(resource);
    }
    raft.revalidate(actor, app.clock.now().await?).await?;
    if raft
        .directory()
        .membership(&actor.principal, workspace)
        .await?
        .0
        .generation
        != snapshot.generation
    {
        return Err(err(409, "PAGE_SNAPSHOT_CHANGED"));
    }
    let next = page["nextCursor"].as_str().map(|after| {
        URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&Cursor {
                fingerprint,
                after: after.into(),
            })
            .expect("cursor serialization"),
        )
    });
    Ok(json!({"resources":resources,"nextCursor":next}))
}

fn validate_actions(actions: &[ResourceAction], files: bool) -> workspace_contracts::Result<()> {
    if actions.iter().any(|action| {
        matches!(
            action,
            ResourceAction::AnalyzeFiles | ResourceAction::ReadUsage
        )
    }) {
        return Err(err(422, "RESOURCE_ACTION_UNSUPPORTED"));
    }
    if actions.is_empty()
        || actions.len() > 8
        || actions.iter().any(|a| match a {
            ResourceAction::ReadFiles
            | ResourceAction::WriteFiles
            | ResourceAction::AnalyzeFiles => !files,
            ResourceAction::ReadQueries | ResourceAction::ExecuteQueries => files,
            _ => false,
        })
    {
        return Err(err(400, "INVALID_RESOURCE_ACTION"));
    }
    Ok(())
}

fn valid_expiry(expiry: i64, now: i64) -> workspace_contracts::Result<()> {
    if expiry <= now || expiry > now.saturating_add(90 * 86400) {
        return Err(err(400, "INVALID_GRANT_EXPIRY"));
    }
    Ok(())
}
