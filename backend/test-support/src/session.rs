use serde_json::Value;

/// Match the actual cookie issued by each native host to its full Portal contract.
pub fn assert_session_contract(cookie: &str) {
    let api: Value = serde_json::from_str(include_str!(
        "../../../tools/api-contract/portal-regional-openapi.json"
    ))
    .unwrap();
    let name = cookie.split_once('=').unwrap().0;
    let schemes: Vec<_> = api["components"]["securitySchemes"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(_, v)| v["type"] == "apiKey" && v["in"] == "cookie" && v["name"] == name)
        .collect();
    assert_eq!(schemes.len(), 1);
    let scheme = schemes[0].0;
    for (path, methods) in api["paths"].as_object().unwrap() {
        if !path.starts_with("/workspaces") {
            continue;
        }
        for op in methods.as_object().unwrap().values() {
            let Some(id) = op["operationId"].as_str() else {
                continue;
            };
            let requirements = op["security"].as_array().unwrap();
            if op["x-authentication-profile"] == "regional-token" {
                assert!(
                    [
                        "enrollRegionalRefreshFamily",
                        "issueRegionalToken",
                        "getRegionalRefreshFamily",
                        "revokeRegionalRefreshFamily",
                        "getRegionalTokenIssuance",
                        "revokeRegionalAccessToken"
                    ]
                    .contains(&id)
                );
                assert!(requirements.iter().all(|v| {
                    ["localOwner", "accountOwner", "guestOwner", "workspaceKey"]
                        .iter()
                        .all(|key| v.get(key).is_none())
                }));
                assert!(
                    (id == "enrollRegionalRefreshFamily" && requirements.is_empty())
                        || requirements
                            .iter()
                            .any(|v| v.get("regionalAccess").is_some()
                                || v.get("regionalRefresh").is_some())
                );
            } else {
                assert!(
                    requirements
                        .iter()
                        .any(|v| v.get(scheme).is_some() && v.as_object().unwrap().len() == 1),
                    "{id}: missing cookie {name}"
                );
                if [
                    "getBootstrap",
                    "listKeys",
                    "createKey",
                    "revokeKey",
                    "updateSettings",
                ]
                .contains(&id)
                {
                    assert!(requirements.iter().all(|v| v.get("workspaceKey").is_none()));
                }
            }
        }
    }
}
