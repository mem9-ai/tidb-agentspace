use super::*;
use serde_json::json;

#[test]
fn browser_schema_rejects_secrets_trusted_outcomes_and_unknown_fields() {
    let event = json!({"id":uuid::Uuid::new_v4().to_string(),"event":{"name":"public_page_view","page":"home","source":"search","device":"desktop","campaign":null}});
    let value = json!({"version":1,"sessionId":uuid::Uuid::new_v4().to_string(),"events":[event]});
    let batch: Batch = serde_json::from_value(value.clone()).unwrap();
    assert!(batch.validate(&[]).is_ok());
    for (field, secret) in [
        ("workspaceId", json!("customer")),
        ("sql", json!("secret query")),
        ("success", json!(true)),
        ("operator", json!(true)),
    ] {
        let mut bad = value.clone();
        bad["events"][0]["event"][field] = secret;
        assert!(serde_json::from_value::<Batch>(bad).is_err());
    }
    let mut bad = value.clone();
    bad["events"][0]["event"]["name"] = json!("operation_completed");
    assert!(serde_json::from_value::<Batch>(bad).is_err());
    let mut bad = value;
    bad["events"][0]["event"]["campaign"] = json!("secret URL");
    assert!(
        serde_json::from_value::<Batch>(bad)
            .unwrap()
            .validate(&[])
            .is_err()
    );
    assert_eq!(operation("GET", "/resources/customer-secret"), None);
    assert_eq!(operation("POST", "/queries"), Some("query"));
}
