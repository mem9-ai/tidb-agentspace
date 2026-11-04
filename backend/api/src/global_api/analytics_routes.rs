use super::*;
use chrono::NaiveDate;

pub(super) async fn handle(
    app: &App,
    path: &str,
    method: &Method,
    h: &HeaderMap,
    query: &BTreeMap<String, String>,
    request: Request,
) -> workspace_contracts::Result<Response> {
    let settings = app
        .config
        .analytics
        .as_ref()
        .ok_or_else(|| err(404, "ANALYTICS_UNAVAILABLE"))?;
    if path == "/analytics/session" && matches!(*method, Method::DELETE | Method::POST) {
        if !h
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|o| app.allowed_origin(o))
        {
            return Err(err(403, "ORIGIN_REQUIRED"));
        }
        if let Some(token) = cookie(h, "aw_acquisition") {
            app.acquisition.lock().await.remove(token);
        }
        let prefix = app
            .config
            .public_path
            .strip_suffix("/api/global")
            .unwrap_or(&app.config.public_path);
        let secure = if app.config.public_origin.starts_with("https:") {
            " Secure;"
        } else {
            ""
        };
        let mut response = StatusCode::NO_CONTENT.into_response();
        let age = if *method == Method::DELETE {
            31536000
        } else {
            0
        };
        for (name, value, max_age) in [("aw_analytics_off", "1", age), ("aw_acquisition", "", 0)] {
            response.headers_mut().append(header::SET_COOKIE,format!("{name}={value}; HttpOnly; SameSite=Strict;{secure} Path={prefix}/; Max-Age={max_age}").parse().map_err(|_|err(503,"ANALYTICS_UNAVAILABLE"))?);
        }
        return Ok(response);
    }
    if path == "/operator/openapi.json" && *method == Method::GET {
        return Ok(Json(
            serde_json::from_str::<Value>(include_str!("../../../../public/operator-openapi.json"))
                .map_err(|_| err(503, "CONTRACT_UNAVAILABLE"))?,
        )
        .into_response());
    }
    if path == "/analytics/config" && *method == Method::GET {
        return Ok(Json(json!({"enabled":settings.browser_enabled && app.analytics.is_some(),"campaigns":settings.campaigns,"policy":"session_only","version":1})).into_response());
    }
    if path == "/analytics/events" && *method == Method::POST {
        let store = app
            .analytics
            .as_ref()
            .ok_or_else(|| err(503, "ANALYTICS_UNAVAILABLE"))?;
        if !settings.browser_enabled {
            return Err(err(404, "ANALYTICS_DISABLED"));
        }
        if !h
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|o| app.allowed_origin(o))
        {
            return Err(err(403, "ORIGIN_REQUIRED"));
        }
        if h.get("sec-gpc").is_some_and(|v| v == "1") || cookie(h, "aw_analytics_off") == Some("1")
        {
            return Ok(StatusCode::NO_CONTENT.into_response());
        }
        if h.get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_none_or(|v| v != "application/json")
        {
            return Err(err(415, "JSON_REQUIRED"));
        }
        let peer = request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|p| p.0.ip().to_string())
            .unwrap_or_else(|| "unknown".into());
        let bytes = to_bytes(request.into_body(), 32 * 1024)
            .await
            .map_err(|_| err(413, "ANALYTICS_BATCH_TOO_LARGE"))?;
        let batch: crate::analytics::Batch =
            serde_json::from_slice(&bytes).map_err(|_| err(422, "INVALID_ANALYTICS_BATCH"))?;
        batch.validate(&settings.campaigns)?;
        let mut limits = app.analytics_limits.lock().await;
        limits.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(60));
        for (key, max) in [
            (format!("session:{}", batch.session_id), 60),
            (format!("peer:{peer}"), 120),
            ("process".into(), 600),
        ] {
            if limits.len() >= 4096 && !limits.contains_key(&key) {
                return Err(err(429, "ANALYTICS_RATE_LIMITED"));
            }
            let entry = limits.entry(key).or_insert((Instant::now(), 0));
            if entry.1 >= max {
                return Err(err(429, "ANALYTICS_RATE_LIMITED"));
            }
            entry.1 += 1;
        }
        drop(limits);
        let session = batch.session_id.clone();
        let attribution = batch.events.iter().find_map(|event| match &event.event {
            crate::analytics::BrowserEvent::PublicPageView {
                source, campaign, ..
            } => Some(crate::analytics::Attribution {
                source: source.clone(),
                campaign: campaign.clone(),
                at: chrono::Utc::now().timestamp(),
            }),
            _ => None,
        });
        store.browser(batch, chrono::Utc::now().timestamp()).await?;
        let mut acquisition = app.acquisition.lock().await;
        acquisition.retain(|_, v| v.expires > Instant::now());
        let token = if let Some(token) = cookie(h, "aw_acquisition").filter(|token| {
            acquisition
                .get(*token)
                .is_some_and(|v| v.session == session)
        }) {
            token.to_owned()
        } else {
            workspace_domain::secret(32).map_err(|_| err(503, "ANALYTICS_UNAVAILABLE"))?
        };
        if acquisition.len() < 4096 && !acquisition.contains_key(&token) {
            acquisition.insert(
                token.clone(),
                Acquisition {
                    attribution,
                    session,
                    expires: Instant::now() + Duration::from_secs(600),
                },
            );
        }
        let prefix = app
            .config
            .public_path
            .strip_suffix("/api/global")
            .unwrap_or(&app.config.public_path);
        let secure = if app.config.public_origin.starts_with("https:") {
            " Secure;"
        } else {
            ""
        };
        let mut response = (
            StatusCode::ACCEPTED,
            Json(json!({"accepted":true,"durability":"queued"})),
        )
            .into_response();
        response.headers_mut().append(header::SET_COOKIE,format!("aw_acquisition={token}; HttpOnly; SameSite=Strict;{secure} Path={prefix}/; Max-Age=600").parse().map_err(|_|err(503,"ANALYTICS_UNAVAILABLE"))?);
        return Ok(response);
    }
    let operators = app
        .operators
        .as_ref()
        .ok_or_else(|| err(503, "OPERATOR_UNAVAILABLE"))?;
    if path == "/operator/auth/login" && *method == Method::GET {
        let mut response = StatusCode::SEE_OTHER.into_response();
        let prefix = app
            .config
            .public_path
            .strip_suffix("/api/global")
            .unwrap_or(&app.config.public_path);
        response.headers_mut().insert(
            header::LOCATION,
            format!("{prefix}/api/auth/tidbcloud/login?operator=1")
                .parse()
                .map_err(|_| err(503, "OPERATOR_UNAVAILABLE"))?,
        );
        return Ok(response);
    }
    operators.authorize(h).await?;
    if path == "/operator/auth/logout" && *method == Method::POST {
        if !h
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|o| app.allowed_origin(o))
        {
            return Err(err(403, "ORIGIN_REQUIRED"));
        }
        let mut response = StatusCode::NO_CONTENT.into_response();
        response
            .headers_mut()
            .append(header::SET_COOKIE, operators.logout(h).await?);
        return Ok(response);
    }
    if path == "/operator/session" && *method == Method::GET {
        return Ok(Json(json!({"operator":true})).into_response());
    }
    if *method != Method::GET {
        return Err(err(404, "NOT_FOUND"));
    }
    let breakdown = path.strip_prefix("/operator/analytics/breakdowns/");
    if !matches!(
        path,
        "/operator/analytics/summary" | "/operator/analytics/coverage"
    ) && !breakdown
        .is_some_and(|v| matches!(v, "acquisition" | "funnel" | "retention" | "outcomes"))
    {
        return Err(err(404, "NOT_FOUND"));
    }
    if query.keys().any(|k| !matches!(k.as_str(), "from" | "to")) {
        return Err(err(422, "INVALID_ANALYTICS_FILTER"));
    }
    let _read_permit = app
        .analytics_reads
        .try_acquire()
        .map_err(|_| err(429, "ANALYTICS_BUSY"))?;
    let store = app
        .analytics
        .as_ref()
        .ok_or_else(|| err(503, "ANALYTICS_UNAVAILABLE"))?;
    let today = chrono::Utc::now().date_naive();
    let parse = |name: &str, default: NaiveDate| -> workspace_contracts::Result<NaiveDate> {
        query
            .get(name)
            .map(|s| {
                NaiveDate::parse_from_str(s, "%Y-%m-%d")
                    .map_err(|_| err(422, "INVALID_ANALYTICS_RANGE"))
            })
            .unwrap_or(Ok(default))
    };
    let from = parse("from", today - chrono::Duration::days(7))?;
    let to = parse("to", today)?;
    operators.audit_read();
    let now = chrono::Utc::now().timestamp();
    let mut authorities = vec![store.summary(from, to, now).await?];
    let mut missing = Vec::new();
    let regional = futures::future::join_all(app.config.regions.iter().map(|region| async {
        let summary = if let Some(hub) = &app.region_connection {
            hub.analytics(&region.region_id, from, to).await.ok()
        } else {
            None
        };
        (region.region_id.clone(), summary)
    }))
    .await;
    for (region, summary) in regional {
        if let Some(summary) = summary {
            authorities.push(summary);
        } else {
            missing.push(region);
        }
    }

    Ok(Json(json!({"authorities":authorities,"missingRegions":missing,"definitionsVersion":1,"timezone":"UTC","partial":!missing.is_empty(),"monitoring":"not_included"})).into_response())
}
