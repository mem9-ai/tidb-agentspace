use crate::{Config, reject};
use anyhow::{Result, ensure};
use axum::http::{HeaderMap, Method};
use reqwest::Url;
use workspace_contracts::ServiceError;

pub fn validate(config: &Config) -> Result<()> {
    ensure!(
        config.public_path.is_empty()
            || config.public_path.split('/').skip(1).all(|s| !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)))
                && config.public_path.starts_with('/'),
        "Invalid public path"
    );
    for origin in &config.public_origins {
        let url = crate::sso::endpoint(
            origin,
            config.insecure_loopback && config.security.is_some(),
        )?;
        ensure!(
            url.origin().ascii_serialization() == *origin,
            "Public origins must be exact HTTPS origins"
        );
    }
    for origin in &config.console_origins {
        let url = crate::sso::endpoint(origin, true)?;
        ensure!(
            url.origin().ascii_serialization() == *origin
                && (url.scheme() == "http" || config.public_origins.contains(origin)),
            "Console origins must be exact loopback or configured public origins"
        );
    }
    if let Some(sso) = &config.sso {
        sso.validate(&config.public_path, config.insecure_loopback)?;
    }
    if config.security.is_some() {
        ensure!(
            !config.public_origins.is_empty(),
            "Regional Token hosting requires a trusted public origin"
        );
    } else if !config.insecure_loopback || !config.public_origins.is_empty() {
        let sso = config
            .sso
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Public API requires SSO"))?;
        let redirect = Url::parse(&sso.redirect_uri)?;
        ensure!(
            sso.secure()
                && config
                    .public_origins
                    .contains(&redirect.origin().ascii_serialization()),
            "Public callback origin must be trusted HTTPS"
        );
    }
    Ok(())
}
pub fn allowed(
    config: &Config,
    headers: &HeaderMap,
    method: &Method,
) -> Result<bool, ServiceError> {
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    // Parse rather than splitting ':' so ports/IPv6 cannot create host aliases.
    let local = Url::parse(&format!("http://{host}")).ok().is_some_and(|u| {
        matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
            && u.path() == "/"
            && u.username().is_empty()
            && u.password().is_none()
    });
    let public = config.public_origins.iter().any(|o| {
        Url::parse(o).ok().is_some_and(|u| {
            u.host_str().is_some_and(|h| {
                format!(
                    "{}{}",
                    h,
                    u.port().map(|p| format!(":{p}")).unwrap_or_default()
                ) == host
            })
        })
    });
    if config.security.is_some()
        && !public
        && !(config.insecure_loopback && host == config.bind.to_string())
    {
        return Err(reject(403, "HOST_DENIED"));
    }
    if !local && !public {
        return Err(reject(403, "LOCAL_ONLY"));
    }
    let origin = headers.get("origin").and_then(|v| v.to_str().ok());
    let allowed = origin.is_none_or(|o| {
        config.console_origins.iter().any(|v| v == o)
            || config.public_origins.iter().any(|v| v == o)
            || (local && o == format!("http://{host}"))
    });
    if !allowed {
        return Err(reject(403, "ORIGIN_DENIED"));
    }
    if public
        && !matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
        && headers.contains_key("cookie")
        && origin.is_none()
    {
        return Err(reject(403, "ORIGIN_DENIED"));
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_configuration_and_cors_are_explicit() {
        let mut c:Config=serde_json::from_value(serde_json::json!({"bind":"0.0.0.0:4318","workspaceId":"ws","authorityId":"region:test","metadata":{"transport":"inProcess","authorityId":"region:test"},"insecureLoopback":false,"consoleOrigins":[],"publicOrigins":["https://studio.example"],"publicPath":"/studio","sso":{"issuer":"https://issuer.example/","clientId":"client","redirectUri":"https://studio.example/studio/api/auth/tidbcloud/callback"}})).unwrap();
        assert!(c.validate().is_ok());
        let mut h = HeaderMap::new();
        h.insert("host", "studio.example".parse().unwrap());
        h.insert("origin", "http://studio.example".parse().unwrap());
        assert!(allowed(&c, &h, &Method::GET).is_err());
        h.insert("origin", "https://studio.example".parse().unwrap());
        assert!(allowed(&c, &h, &Method::GET).is_ok());
        h.remove("origin");
        h.insert("cookie", "aw_session=test".parse().unwrap());
        assert!(allowed(&c, &h, &Method::POST).is_err());
        h.insert("host", "evil.example".parse().unwrap());
        assert!(allowed(&c, &h, &Method::GET).is_err());
        c.sso = None;
        assert!(c.validate().is_err());
        c.public_origins.clear();
        assert!(c.validate().is_err());
        c.insecure_loopback = true;
        assert!(c.validate().is_err());
    }
}
