use crate::schema::*;
use serde_json::{Value, json};

mod administration;
mod analytics;
mod schemas;

pub(crate) fn paths() -> Value {
    merge([analytics::paths(), administration::paths()])
}
pub(crate) fn schemas() -> Value {
    schemas::schemas()
}

pub(super) fn product_insights() -> Value {
    closed_object([
        ("authorities", array(authority_summary())),
        ("missingRegions", array(string())),
        ("definitionsVersion", json!({"const": 1})),
        ("timezone", json!({"const": "UTC"})),
        ("partial", boolean()),
        ("monitoring", json!({"const": "not_included"})),
    ])
}

pub(super) fn authority_summary() -> Value {
    closed_object([
        (
            "firstUseSources",
            json!({"type": "object", "additionalProperties": {"type": "integer", "minimum": 0}}),
        ),
        (
            "firstUseCampaigns",
            json!({"type": "object", "additionalProperties": {"type": "integer", "minimum": 0}}),
        ),
        ("authority", string()),
        ("from", string()),
        ("to", string()),
        ("timezone", json!({"const": "UTC"})),
        ("counts", event_counts()),
        ("sessions", json!({"type": "integer", "minimum": 0})),
        ("trials", json!({"type": "integer", "minimum": 0})),
        ("activeWorkspaces", json!({"type": "integer", "minimum": 0})),
        ("apiWorkspaces", json!({"type": "integer", "minimum": 0})),
        ("cohorts", array(cohort())),
        (
            "timeToValueSeconds",
            json!({"type": "object", "additionalProperties": {"type": "integer", "minimum": 0}}),
        ),
        ("generatedAt", json!({"type": "integer", "minimum": 0})),
        (
            "unconfirmedEvents",
            json!({"type": "integer", "minimum": 0}),
        ),
        ("coverage", string()),
    ])
}

pub(super) fn cohort() -> Value {
    closed_object([
        ("actor", string()),
        ("ready", json!({"type": "integer", "minimum": 0})),
        ("eligible", json!({"type": "integer", "minimum": 0})),
        ("activated", json!({"type": "integer", "minimum": 0})),
        ("d1Eligible", json!({"type": "integer", "minimum": 0})),
        ("d1Returned", json!({"type": "integer", "minimum": 0})),
        ("d7Eligible", json!({"type": "integer", "minimum": 0})),
        ("d7Returned", json!({"type": "integer", "minimum": 0})),
    ])
}

pub(super) fn event_counts() -> Value {
    closed_object([
        ("pageViews", json!({"type": "integer", "minimum": 0})),
        ("tryClicks", json!({"type": "integer", "minimum": 0})),
        ("signInClicks", json!({"type": "integer", "minimum": 0})),
        ("ready", json!({"type": "integer", "minimum": 0})),
        ("successes", json!({"type": "integer", "minimum": 0})),
        ("failures", json!({"type": "integer", "minimum": 0})),
        ("helpful", json!({"type": "integer", "minimum": 0})),
        ("votes", json!({"type": "integer", "minimum": 0})),
        (
            "events",
            json!({"type": "object", "additionalProperties": {"type": "integer", "minimum": 0}}),
        ),
        (
            "sources",
            json!({"type": "object", "additionalProperties": {"type": "integer", "minimum": 0}}),
        ),
        (
            "campaigns",
            json!({"type": "object", "additionalProperties": {"type": "integer", "minimum": 0}}),
        ),
        (
            "journeys",
            json!({"type": "object", "additionalProperties": {"type": "integer", "minimum": 0}}),
        ),
    ])
}

pub(super) fn from_parameter() -> Value {
    json!({
        "name": "from",
        "in": "query",
        "schema": {"type": "string", "format": "date"},
        "description": "Inclusive UTC date. Maximum 31-day range, within the retained window.",
    })
}

pub(super) fn to_parameter() -> Value {
    json!({
        "name": "to",
        "in": "query",
        "schema": {"type": "string", "format": "date"},
        "description": "Exclusive UTC date. Maximum 31-day range, within the retained window.",
    })
}

pub(super) fn responses(overrides: Value) -> Value {
    let error = response(
        "Structured service error. No customer content or secrets.",
        object([("error", object([("code", string())]))]),
    );
    let errors = [
        "400", "401", "403", "404", "413", "415", "422", "429", "503",
    ]
    .into_iter()
    .map(|code| (code.into(), error.clone()))
    .collect();
    extend(Value::Object(errors), overrides)
}

pub(super) fn security_schemes() -> Value {
    json!({
        "operatorSession": json!({
            "type": "apiKey",
            "in": "cookie",
            "name": "aw_operator",
            "description": "Host-only Secure HttpOnly SameSite=Strict session, one-hour maximum; current private policy is checked on every read.",
        }),
    })
}
