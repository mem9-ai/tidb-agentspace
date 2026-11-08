use super::*;

pub(super) fn paths() -> Value {
    json!({
        "/operator/session": {"get": get_operator_session()},
        "/operator/auth/login": {"get": begin_operator_login()},
        "/operator/auth/logout": {"post": end_operator_session()},
        "/operator/analytics/breakdowns/{kind}": {
            "parameters": [
                {
                    "name": "kind",
                    "in": "path",
                    "required": true,
                    "schema": {"enum": ["acquisition", "funnel", "retention", "outcomes"]},
                },
            ],
            "get": get_product_insight_breakdown(),
        },
        "/operator/analytics/summary": {"get": get_product_insights()},
        "/operator/analytics/coverage": {"get": get_product_analytics_coverage()},
    })
}

fn get_operator_session() -> Value {
    json!({
        "operationId": "getOperatorSession",
        "security": [{"operatorSession": []}],
        "responses": responses(json!({"200": response("Success", closed_object([("operator", json!({"const": true}))]))})),
    })
}

fn begin_operator_login() -> Value {
    json!({
        "operationId": "beginOperatorLogin",
        "security": [],
        "responses": {
            "303": {
                "description": "Redirect to the existing TiDB Cloud code/PKCE login with operator mode. The existing registered callback verifies the flow before issuing a distinct Admin session. No customer Workspace is created.",
            },
        },
    })
}

fn end_operator_session() -> Value {
    json!({
        "operationId": "endOperatorSession",
        "security": [{"operatorSession": []}],
        "responses": {
            "204": {"description": "Revoked and cleared. Exact trusted Origin required."},
            "401": response("Structured service error. No customer content or secrets.", object([("error", object([("code", string())]))])),
            "403": response("Structured service error. No customer content or secrets.", object([("error", object([("code", string())]))])),
        },
    })
}

fn get_product_insight_breakdown() -> Value {
    json!({
        "operationId": "getProductInsightBreakdown",
        "security": [{"operatorSession": []}],
        "responses": responses(json!({"200": response("Success", product_insights())})),
        "parameters": [from_parameter(), to_parameter()],
    })
}

fn get_product_insights() -> Value {
    json!({
        "operationId": "getProductInsights",
        "security": [{"operatorSession": []}],
        "responses": responses(json!({"200": response("Success", product_insights())})),
        "parameters": [from_parameter(), to_parameter()],
    })
}

fn get_product_analytics_coverage() -> Value {
    json!({
        "operationId": "getProductAnalyticsCoverage",
        "security": [{"operatorSession": []}],
        "responses": responses(json!({"200": response("Success", product_insights())})),
        "parameters": [from_parameter(), to_parameter()],
    })
}
