use serde_json::{Value, json};
use std::collections::HashSet;
use workspace_openapi::View;

#[test]
fn public_and_portal_surfaces_keep_separate_credentials() {
    let regional = View::Regional.document();
    let global = View::Global.document();
    let entry = View::Entry.document();
    let portal = View::PortalRegional.document();
    let portal_global = View::PortalGlobal.document();
    assert!(regional["paths"]["/workspaces/{workspaceId}/resources"].is_object());
    assert!(global["paths"]["/api/v1/token-issuances"].is_object());
    for path in ["/workspaces/{workspaceId}/bootstrap", "/api/auth/guest"] {
        assert!(regional["paths"].get(path).is_none());
    }
    for path in ["/api/v1/workspaces/{workspaceId}/keys", "/api/auth/session"] {
        assert!(global["paths"].get(path).is_none());
    }
    assert!(portal["paths"]["/workspaces/{workspaceId}/bootstrap"].is_object());
    assert!(portal_global["paths"]["/api/portal/v1/workspaces/{workspaceId}/keys"].is_object());
    assert_eq!(entry["servers"], json!([{"url":"/api"}]));
    for (path, method) in [
        ("/v1/token-issuances", "post"),
        ("/v1/workspaces/{workspaceId}/region-route", "get"),
        ("/v1/workspaces/{workspaceId}/regions", "get"),
        ("/v1/workspaces/{workspaceId}/issuances/{issuanceId}", "get"),
    ] {
        assert!(entry["paths"][path][method].is_object());
    }
    assert_eq!(entry["paths"].as_object().unwrap().len(), 4);
    for api in [regional, global, entry] {
        let schemes = api["components"]["securitySchemes"].as_object().unwrap();
        assert!(schemes.keys().all(|s| !s.to_lowercase().contains("owner")));
        for path in api["paths"].as_object().unwrap().values() {
            for op in path.as_object().unwrap().values() {
                for requirement in op["security"].as_array().into_iter().flatten() {
                    assert!(
                        requirement
                            .as_object()
                            .unwrap()
                            .keys()
                            .all(|s| schemes.contains_key(s))
                    );
                }
            }
        }
    }
}

fn references_resolve(value: &Value, root: &Value) {
    match value {
        Value::Object(object) => {
            if let Some(reference) = object.get("$ref").and_then(Value::as_str) {
                assert!(
                    root.pointer(reference.strip_prefix('#').expect("local schema reference"))
                        .is_some(),
                    "{reference}"
                );
            }
            for item in object.values() {
                references_resolve(item, root);
            }
        }
        Value::Array(items) => {
            for item in items {
                references_resolve(item, root);
            }
        }
        _ => {}
    }
}

#[test]
fn every_view_has_resolvable_schemas_and_unique_operation_ids() {
    for view in View::ALL {
        let api = view.document();
        references_resolve(&api, &api);
        let mut operations = HashSet::new();
        for path in api["paths"].as_object().unwrap().values() {
            for id in path
                .as_object()
                .unwrap()
                .values()
                .filter_map(|op| op["operationId"].as_str())
            {
                assert!(operations.insert(id), "duplicate {id} in {}", view.name());
            }
        }
        assert!(!operations.is_empty());
    }
}
