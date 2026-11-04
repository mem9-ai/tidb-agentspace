//! Classify covered operations without keeping SQL, file paths or request content.
use serde_json::Value;
use std::collections::BTreeMap;
use workspace_domain::{Principal, observability::AuditAction};

/// Only conclusive pre-effect scope denials can be called denied. Later failures can
/// follow a committed effect and must remain unknown without a domain outcome marker.
pub fn scope_denied(action: AuditAction, principal: &Principal) -> bool {
    match action {
        AuditAction::WorkspaceUpdate => !principal.owner,
        AuditAction::ResourceCreate => {
            principal.scope("resources:write").is_err() || !principal.has("*")
        }
        AuditAction::ResourceDelete | AuditAction::ResourceRetry => {
            principal.scope("resources:write").is_err()
        }
        AuditAction::FileWrite | AuditAction::FileDelete => principal.scope("files:write").is_err(),
        AuditAction::QueryWrite | AuditAction::QueryExecute | AuditAction::DatabaseImport => {
            principal.scope("queries:execute").is_err()
        }
    }
}

/// This is merely a candidate. Persist it only after the domain operation has succeeded
/// and therefore authorized and resolved the selected resource.
pub fn target_candidate(
    method: &str,
    route: &str,
    query: &BTreeMap<String, String>,
    input: &Value,
) -> Option<String> {
    let value = match (method, route) {
        ("PUT", "/files") | ("POST", "/reports" | "/queries" | "/database-imports") => {
            input["resourceId"].as_str()
        }
        ("PUT", "/files/content") | ("DELETE", "/files/entry") => {
            query.get("resourceId").map(String::as_str)
        }
        ("POST", "/result-exports" | "/file-exports") => input["target"]["resourceId"].as_str(),
        _ => {
            let parts = route
                .split('/')
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>();
            match (method, parts.as_slice()) {
                ("DELETE", ["resources", id]) | ("POST", ["resources", id, "setup-attempts"]) => {
                    Some(*id)
                }
                _ => None,
            }
        }
    }?;
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-.:".contains(&byte))
    {
        return None;
    }
    Some(value.to_owned())
}

pub fn action(method: &str, route: &str, input: &Value) -> Option<AuditAction> {
    match (method, route) {
        ("PATCH", "/settings") => Some(AuditAction::WorkspaceUpdate),
        ("POST", "/resources") => Some(AuditAction::ResourceCreate),
        ("PUT", "/files" | "/files/content") | ("POST", "/reports") => Some(AuditAction::FileWrite),
        ("DELETE", "/files/entry") => Some(AuditAction::FileDelete),
        ("POST", "/database-imports") => Some(AuditAction::DatabaseImport),
        // A non-read-only query can mutate; the label does not assert that it did.
        ("POST", "/queries") if input["readOnly"] != true => Some(AuditAction::QueryExecute),
        ("POST", "/result-exports" | "/file-exports") => match input["target"]["kind"].as_str() {
            Some("filesystem") => Some(AuditAction::FileWrite),
            Some("database") => Some(AuditAction::QueryExecute),
            _ => None,
        },
        _ => {
            let parts = route
                .split('/')
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>();
            match (method, parts.as_slice()) {
                ("DELETE", ["resources", _]) => Some(AuditAction::ResourceDelete),
                ("POST", ["resources", _, "setup-attempts"]) => Some(AuditAction::ResourceRetry),
                _ => None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn covers_mutations_without_claiming_read_only_queries_are_writes() {
        assert!(matches!(
            action("PATCH", "/settings", &json!({})),
            Some(AuditAction::WorkspaceUpdate)
        ));
        assert!(matches!(
            action("POST", "/resources", &json!({})),
            Some(AuditAction::ResourceCreate)
        ));
        assert!(matches!(
            action("DELETE", "/resources/opaque", &json!({})),
            Some(AuditAction::ResourceDelete)
        ));
        assert!(matches!(
            action("POST", "/resources/opaque/setup-attempts", &json!({})),
            Some(AuditAction::ResourceRetry)
        ));
        assert!(matches!(
            action("PUT", "/files/content", &json!({})),
            Some(AuditAction::FileWrite)
        ));
        assert!(matches!(
            action("DELETE", "/files/entry", &json!({})),
            Some(AuditAction::FileDelete)
        ));
        assert!(matches!(
            action("POST", "/database-imports", &json!({})),
            Some(AuditAction::DatabaseImport)
        ));
        assert!(matches!(
            action(
                "POST",
                "/queries",
                &json!({"readOnly":false,"sql":"sensitive"})
            ),
            Some(AuditAction::QueryExecute)
        ));
        assert!(action("POST", "/queries", &json!({"readOnly":true})).is_none());
        assert!(matches!(
            action(
                "POST",
                "/file-exports",
                &json!({"target":{"kind":"filesystem","path":"secret"}})
            ),
            Some(AuditAction::FileWrite)
        ));
        assert!(matches!(
            action(
                "POST",
                "/result-exports",
                &json!({"target":{"kind":"database"}})
            ),
            Some(AuditAction::QueryExecute)
        ));
        assert!(
            action(
                "POST",
                "/result-exports",
                &json!({"target":{"kind":"download"}})
            )
            .is_none()
        );
        assert!(action("GET", "/files", &json!({})).is_none());
    }
}
