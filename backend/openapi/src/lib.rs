//! OpenAPI descriptions for each Workspace API audience. HTTP handlers and the export
//! command build the same documents from these native route and schema definitions.
mod global;
mod operator;
mod regional;
mod schema;

use anyhow::{Result, anyhow};
use serde_json::{Value, json};
use std::{str::FromStr, sync::OnceLock};

const PORTAL_ACCESS: &str = " An authenticated Workspace Owner session under the enabled profile may also call this endpoint.";
const OWNER_SCHEMES: [&str; 3] = ["localOwner", "accountOwner", "guestOwner"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    Regional,
    Owner,
    PortalRegional,
    Global,
    PortalGlobal,
    Entry,
    Operator,
}

impl View {
    pub const ALL: [Self; 7] = [
        Self::Regional,
        Self::Owner,
        Self::PortalRegional,
        Self::Global,
        Self::PortalGlobal,
        Self::Entry,
        Self::Operator,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::Regional => "regional",
            Self::Owner => "owner",
            Self::PortalRegional => "portal-regional",
            Self::Global => "global",
            Self::PortalGlobal => "portal-global",
            Self::Entry => "entry",
            Self::Operator => "operator",
        }
    }

    pub fn path(self) -> &'static str {
        match self {
            Self::Regional => "public/openapi.json",
            Self::Owner => "public/owner-openapi.json",
            Self::PortalRegional => "tools/api-contract/portal-regional-openapi.json",
            Self::Global => "public/global-openapi.json",
            Self::PortalGlobal => "tools/api-contract/portal-global-openapi.json",
            Self::Entry => "public/agent-entry-openapi.json",
            Self::Operator => "public/operator-openapi.json",
        }
    }

    pub fn document(self) -> Value {
        match self {
            Self::Regional | Self::Owner | Self::PortalRegional => regional_document(self),
            Self::Global | Self::Entry | Self::PortalGlobal => global_document(self),
            Self::Operator => json!({
                "openapi": "3.1.0",
                "info": {
                    "title": "Product analytics and Admin API",
                    "version": "1.0.0",
                    "description": "Separate platform authority. TiDB Cloud OIDC with a verified pingcap.com email is required for Admin. Workspace Keys and personal Owner sessions grant no access. Business actions use native outcomes; browser events are untrusted. HTTP monitoring is excluded."
                },
                "servers": [{"url": "/api/global"}],
                "paths": operator::paths(),
                "components": {"securitySchemes": operator::security_schemes(), "schemas": operator::schemas()},
            }),
        }
    }

    /// Bind a document to the public HTTP mount of its authority. Offline exports keep
    /// their standalone defaults. Path- and operation-level servers override the root.
    pub fn mounted_document(self, mount: &str) -> Value {
        let mut document = self.document();
        if self == Self::Operator {
            // The offline artifact assumes a shared /api/global listener. A running
            // Global authority may instead live at the origin root or another mount.
            document["servers"][0]["url"] = "/".into();
        }
        mount_servers(&mut document, mount);
        for path in document["paths"].as_object_mut().unwrap().values_mut() {
            mount_servers(path, mount);
            for operation in path.as_object_mut().unwrap().values_mut() {
                mount_servers(operation, mount);
            }
        }
        document
    }

    /// Render once per audience so a contract request does not rebuild large schema trees.
    pub fn rendered(self) -> &'static str {
        static DOCUMENTS: [OnceLock<String>; View::ALL.len()] =
            [const { OnceLock::new() }; View::ALL.len()];
        DOCUMENTS[self as usize].get_or_init(|| {
            let mut doc = self.document();
            doc.sort_all_objects();
            let mut text =
                serde_json::to_string_pretty(&doc).expect("JSON document must serialize");
            text.push('\n');
            text
        })
    }
}

impl FromStr for View {
    type Err = anyhow::Error;
    fn from_str(input: &str) -> Result<Self> {
        Self::ALL.into_iter().find(|view| view.name() == input)
            .ok_or_else(|| anyhow!("Unknown OpenAPI view '{input}'. Choose regional, owner, portal-regional, global, portal-global, entry or operator."))
    }
}

fn mount_servers(item: &mut Value, mount: &str) {
    if let Some(servers) = item.get_mut("servers").and_then(Value::as_array_mut) {
        for server in servers {
            if let Some(path) = server["url"]
                .as_str()
                .filter(|s| s.starts_with('/') && !s.starts_with("//"))
                && !mount.is_empty()
            {
                server["url"] = format!("{mount}{}", path.trim_end_matches('/')).into();
            }
        }
    }
}

fn remove_schemes(schemes: &mut Value, names: &[&str]) {
    schemes
        .as_object_mut()
        .expect("security schemes")
        .retain(|name, _| !names.contains(&name.as_str()));
}

fn regional_document(view: View) -> Value {
    let mut paths = regional::paths();
    let mut schemes = regional::security_schemes();
    let all_paths = paths.as_object_mut().expect("regional paths");
    let description = "A Workspace gateway for PostgreSQL-compatible databases and File Systems. Workspace Keys authorize actions and resources; upstream credentials stay internal.";
    let (title, description, server, tags) = match view {
        View::Regional => {
            remove_schemes(&mut schemes, &OWNER_SCHEMES);
            all_paths.retain(|path, entry| {
                if path.starts_with("/api/") {
                    return false;
                }
                let items = entry.as_object_mut().expect("regional path item");
                items.retain(|_, op| {
                    if op.get("operationId").is_none() {
                        return true;
                    }
                    if op["tags"]
                        .as_array()
                        .is_some_and(|tags| tags.iter().any(|t| t == "Owner"))
                    {
                        return false;
                    }
                    if let Some(requirements) = op.get_mut("security").and_then(Value::as_array_mut)
                    {
                        requirements.retain(|requirement| {
                            OWNER_SCHEMES
                                .iter()
                                .all(|key| requirement.get(key).is_none())
                        });
                    }
                    if let Some(text) = op["description"]
                        .as_str()
                        .filter(|s| s.contains(PORTAL_ACCESS))
                    {
                        op["description"] = text.replace(PORTAL_ACCESS, "").into();
                    }
                    true
                });
                items.values().any(|op| op.get("operationId").is_some())
            });
            (
                "TiDB Agent Workspace · Local Prototype API",
                description,
                json!({"url": "/api/v1", "description": "Standalone Workspace API; resolve against the API origin"}),
                json!([{"name":"Workspace"}]),
            )
        }
        View::Owner | View::PortalRegional => {
            remove_schemes(
                &mut schemes,
                &["trialSession", "trialReportView", "csvWorkspace"],
            );
            if view == View::Owner {
                all_paths.retain(|path, _| {
                    matches!(
                        path.as_str(),
                        "/workspaces/{workspaceId}/request-history"
                            | "/workspaces/{workspaceId}/audit-history"
                    )
                });
                (
                    "Workspace Regional Owner API",
                    "Owner-session operations for partial regional request and audit history. Global activity is not included; read each response’s coverage and health before interpreting the records.",
                    json!({"url":"/api/v1","description":"Session-authenticated Regional Owner API"}),
                    json!([{"name":"Owner"}]),
                )
            } else {
                all_paths.retain(|path, _| !path.starts_with("/agent-"));
                (
                    "Workspace Portal API",
                    description,
                    json!({"url":"/api/portal/v1","description":"Session-authenticated Portal API"}),
                    json!([{"name":"Workspace"},{"name":"Owner"}]),
                )
            }
        }
        _ => unreachable!("regional authority"),
    };
    let mut document = json!({
        "openapi": "3.1.0", "info": {"title":title,"version":"0.1.0","description":description},
        "servers":[server], "tags": tags, "paths": paths,
        "components":{"schemas":regional::schemas(),"securitySchemes":schemes},
    });
    if view == View::Regional {
        document["externalDocs"] = json!({"description": "Regional Owner history API contract","url":"owner-openapi.json"});
    }
    document
}

fn global_document(view: View) -> Value {
    let mut paths = global::paths();
    let mut schemes = global::security_schemes();
    let mut server = "/";
    if view != View::PortalGlobal {
        remove_schemes(&mut schemes, &["globalOwner"]);
        paths
            .as_object_mut()
            .expect("global paths")
            .retain(|path, entry| {
                if path.starts_with("/api/auth/") || path == "/api/session" {
                    return false;
                }
                let items = entry.as_object_mut().expect("global path item");
                items.retain(|_, op| {
                    !op["security"].as_array().is_some_and(|requirements| {
                        requirements.iter().any(|r| r.get("globalOwner").is_some())
                    })
                });
                items.values().any(|op| op.get("operationId").is_some())
            });
    }
    if view == View::Entry {
        server = "/api";
        let source = paths.as_object_mut().expect("global paths");
        let mut entry = serde_json::Map::new();
        for (path, public) in [
            ("/api/v1/token-issuances", "/v1/token-issuances"),
            (
                "/api/v1/workspaces/{workspaceId}/region-route",
                "/v1/workspaces/{workspaceId}/region-route",
            ),
            (
                "/api/v1/workspaces/{workspaceId}/regions",
                "/v1/workspaces/{workspaceId}/regions",
            ),
            (
                "/api/v1/workspaces/{workspaceId}/token-issuances/{issuanceId}",
                "/v1/workspaces/{workspaceId}/issuances/{issuanceId}",
            ),
        ] {
            entry.insert(
                public.into(),
                source
                    .remove(path)
                    .expect("entry route must exist at Global"),
            );
        }
        paths = Value::Object(entry);
    }
    json!({
        "openapi":"3.1.0",
        "info":{"title":"Workspace Global Public API","version":"0.1.0","description":"Independent Global management authority. Key and Global Token issuance are available. Regional data and refresh endpoints are served by Region directly. All expiry values use Unix seconds. Credentials must never be logged or stored in URLs."},
        "servers":[{"url": server}], "paths":paths,
        "components":{"schemas":global::schemas(),"securitySchemes":schemes},
    })
}
