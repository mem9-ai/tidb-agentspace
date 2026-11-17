use super::*;

pub(super) fn schemas() -> Value {
    json!({
        "DatabaseImportParsing": database_import_parsing(),
        "DatabaseImportPreparationInput": database_import_preparation_input(),
        "DatabaseImportInput": database_import_input(),
        "DatabaseImportResult": database_import_result(),
        "QueryResult": query_result(),
        "DatabaseTable": database_table(),
        "TableList": table_list(),
        "TableDetail": table_detail(),
    })
}

fn database_import_parsing() -> Value {
    json!({
        "oneOf": [
            closed_object([
                ("format", json!({"const": "csv"})),
                ("header", boolean()),
                ("delimiter", json!({"enum": [",", "\t", ";", "|"]})),
            ]),
            closed_object([("format", json!({"const": "parquet"}))]),
        ],
    })
}

fn database_import_preparation_input() -> Value {
    closed_object([
        ("resourceId", json!({"type": "string", "minLength": 1})),
        (
            "source",
            closed_object([
                ("resourceId", json!({"type": "string", "minLength": 1})),
                ("path", json!({"type": "string", "minLength": 1})),
            ]),
        ),
        ("parsing", reference("DatabaseImportParsing")),
    ])
}

fn database_import_input() -> Value {
    closed_object([
        ("resourceId", json!({"type": "string", "minLength": 1})),
        ("preparationId", json!({"type": "string", "minLength": 1})),
        ("confirmed", json!({"const": true})),
        ("table", json!({"type": "string", "minLength": 1})),
        (
            "fields",
            json!({
                "type": "array",
                "minItems": 1,
                "maxItems": 100,
                "items": closed_object([
                    ("source", string()),
                    ("name", string()),
                    ("type", json!({"enum": ["TEXT", "BIGINT", "DOUBLE", "BOOLEAN"]})),
                ]),
            }),
        ),
    ])
}

fn database_import_result() -> Value {
    closed_object([
        ("kind", json!({"const": "database"})),
        ("resourceId", string()),
        ("table", string()),
        ("rowCount", integer()),
        (
            "columns",
            array(closed_object([("name", string()), ("type", string())])),
        ),
    ])
}

fn query_result() -> Value {
    json!({
        "type": "object",
        "required": ["columns", "rows", "rowCount", "mode", "durationMs"],
        "properties": {
            "columns": array(string()),
            "rows": array(json!({"type": "object", "additionalProperties": true})),
            "rowCount": integer(),
            "mode": {"enum": ["demo", "live"]},
            "affectedRows": {"type": "integer", "description": "Live statement affected-row count; SELECT returns zero."},
            "durationMs": number(),
        },
    })
}

fn database_table() -> Value {
    object([("name", string()), ("type", string())])
}

fn table_list() -> Value {
    object([
        (
            "data",
            json!({"type": "array", "maxItems": 500, "items": reference("DatabaseTable")}),
        ),
        ("truncated", boolean()),
        ("mode", json!({"enum": ["demo", "live"]})),
    ])
}

fn table_detail() -> Value {
    object([
        ("name", string()),
        ("type", string()),
        ("mode", json!({"enum": ["demo", "live"]})),
        ("query", string()),
        (
            "columns",
            array(object([
                ("name", string()),
                ("type", string()),
                ("nullable", boolean()),
                ("default", json!({"type": ["string", "null"]})),
                ("key", string()),
                ("extra", string()),
            ])),
        ),
        (
            "indexes",
            array(object([
                ("name", string()),
                ("unique", boolean()),
                (
                    "columns",
                    array(object([
                        ("name", json!({"type": ["string", "null"]})),
                        ("position", integer()),
                        ("prefixLength", json!({"type": ["integer", "null"]})),
                    ])),
                ),
            ])),
        ),
    ])
}
