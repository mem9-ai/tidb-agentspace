use serde_json::{Map, Value, json};

pub(crate) fn reference(name: &str) -> Value {
    json!({"$ref": format!("#/components/schemas/{name}")})
}

pub(crate) fn resource_types() -> Value {
    json!({"type":"array","items":{"type":"string","enum":["database","filesystem"]},"maxItems":2,"uniqueItems":true,"description":"Selected types include current and future public resources in this Workspace."})
}

pub(crate) fn string() -> Value {
    json!({"type": "string"})
}
pub(crate) fn integer() -> Value {
    json!({"type": "integer"})
}
pub(crate) fn number() -> Value {
    json!({"type": "number"})
}
pub(crate) fn boolean() -> Value {
    json!({"type": "boolean"})
}

pub(crate) fn array(items: Value) -> Value {
    json!({"type": "array", "items": items})
}

pub(crate) fn object<const N: usize>(fields: [(&str, Value); N]) -> Value {
    let required: Vec<_> = fields.iter().map(|(name, _)| *name).collect();
    let properties: Map<_, _> = fields
        .into_iter()
        .map(|(name, schema)| (name.into(), schema))
        .collect();
    json!({"type": "object", "required": required, "properties": properties})
}

pub(crate) fn closed_object<const N: usize>(fields: [(&str, Value); N]) -> Value {
    let mut schema = object(fields);
    schema["additionalProperties"] = json!(false);
    schema
}

pub(crate) fn request(schema: Value) -> Value {
    json!({"required": true, "content": {"application/json": {"schema": schema}}})
}

pub(crate) fn response(description: &str, schema: Value) -> Value {
    json!({"description": description, "content": {"application/json": {"schema": schema}}})
}

pub(crate) fn extend(mut base: Value, overrides: Value) -> Value {
    let Value::Object(extra) = overrides else {
        unreachable!("expected contract object");
    };
    base.as_object_mut()
        .expect("expected contract object")
        .extend(extra);
    base
}

pub(crate) fn merge<const N: usize>(parts: [Value; N]) -> Value {
    let mut result = Map::new();
    for part in parts {
        let Value::Object(fields) = part else {
            unreachable!("expected contract object");
        };
        for (name, value) in fields {
            assert!(
                result.insert(name, value).is_none(),
                "duplicate contract declaration"
            );
        }
    }
    Value::Object(result)
}
