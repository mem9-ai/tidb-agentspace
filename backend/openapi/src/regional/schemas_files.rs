use super::*;

pub(super) fn schemas() -> Value {
    json!({
        "File": file_schema(),
        "ResultExportInput": result_export_input(),
        "ResultExportOutput": result_export_output(),
        "FileExportSource": file_export_source(),
        "FileExportParsing": file_export_parsing(),
        "FileExportPreparationInput": file_export_preparation_input(),
        "Preparation": preparation(),
        "FileExportInput": file_export_input(),
        "FileExportOutput": file_export_output(),
    })
}

fn file_schema() -> Value {
    json!({
        "type": "object",
        "required": ["id", "resourceId", "path", "type", "size", "updatedAt"],
        "properties": {
            "id": string(),
            "resourceId": string(),
            "path": string(),
            "type": {"enum": ["file", "directory"]},
            "version": {
                "type": "string",
                "description": "Opaque strong version validator, including its double quotes; send unchanged in If-Match.",
            },
            "content": string(),
            "size": integer(),
            "updatedAt": {"type": ["string", "null"], "format": "date-time"},
        },
    })
}

fn result_export_input() -> Value {
    closed_object([
        ("sourceResourceId", string()),
        (
            "result",
            closed_object([
                (
                    "columns",
                    json!({
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 100,
                        "uniqueItems": true,
                        "items": {"type": "string", "minLength": 1},
                    }),
                ),
                (
                    "rows",
                    json!({
                        "type": "array",
                        "maxItems": 1000,
                        "items": {"type": "object", "additionalProperties": true},
                    }),
                ),
            ]),
        ),
        (
            "target",
            json!({
                "oneOf": [
                    closed_object([
                        ("kind", json!({"const": "download"})),
                        ("format", json!({"type": "string", "enum": ["csv", "json", "jsonl"]})),
                    ]),
                    closed_object([
                        ("kind", json!({"const": "filesystem"})),
                        ("resourceId", string()),
                        ("path", json!({"type": "string", "maxLength": 512})),
                        ("format", json!({"type": "string", "enum": ["csv", "json", "jsonl"]})),
                    ]),
                    closed_object([
                        ("kind", json!({"const": "database"})),
                        ("resourceId", string()),
                        ("table", json!({"type": "string", "minLength": 1, "maxLength": 63})),
                    ]),
                ],
            }),
        ),
    ])
}

fn result_export_output() -> Value {
    json!({
        "oneOf": [
            closed_object([
                ("kind", json!({"const": "download"})),
                ("rowCount", json!({"type": "integer", "minimum": 0, "maximum": 1000})),
                ("format", json!({"type": "string", "enum": ["csv", "json", "jsonl"]})),
                ("filename", string()),
                ("mimeType", string()),
                ("content", string()),
                ("bytes", json!({"type": "integer", "minimum": 0})),
            ]),
            closed_object([
                ("kind", json!({"const": "filesystem"})),
                ("rowCount", json!({"type": "integer", "minimum": 0, "maximum": 1000})),
                ("resourceId", string()),
                ("path", string()),
                ("format", json!({"type": "string", "enum": ["csv", "json", "jsonl"]})),
                ("bytes", json!({"type": "integer", "minimum": 0})),
            ]),
            closed_object([
                ("kind", json!({"const": "database"})),
                ("rowCount", json!({"type": "integer", "minimum": 0, "maximum": 1000})),
                ("resourceId", string()),
                ("table", string()),
                ("columns", array(closed_object([("name", string()), ("type", string())]))),
            ]),
        ],
    })
}

fn file_export_source() -> Value {
    json!({
        "oneOf": [
            closed_object([
                ("kind", json!({"const": "original"})),
                ("resourceId", string()),
                ("path", string()),
            ]),
            closed_object([
                ("kind", json!({"const": "output"})),
                ("resourceId", string()),
                ("stream", json!({"enum": ["stdout", "stderr"]})),
                ("text", string()),
            ]),
        ],
    })
}

fn file_export_parsing() -> Value {
    json!({
        "oneOf": [
            closed_object([
                ("format", json!({"const": "csv"})),
                ("header", boolean()),
                ("delimiter", json!({"enum": [",", "\t", ";", "|"]})),
            ]),
            closed_object([("format", json!({"enum": ["parquet", "lines"]}))]),
        ],
    })
}

fn file_export_preparation_input() -> Value {
    closed_object([
        ("source", reference("FileExportSource")),
        ("parsing", reference("FileExportParsing")),
    ])
}

fn preparation() -> Value {
    closed_object([
        ("id", json!({"type": "string", "format": "uuid"})),
        ("status", json!({"enum": ["ready", "consumed"]})),
        (
            "createdAt",
            json!({"type": "string", "format": "date-time"}),
        ),
        ("expiresAt", string()),
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
        (
            "rows",
            json!({
                "type": "array",
                "maxItems": 20,
                "items": {"type": "object", "additionalProperties": true},
            }),
        ),
        (
            "rowCount",
            json!({"type": "integer", "minimum": 0, "maximum": 1000}),
        ),
        ("sourceVersion", string()),
        ("inputBytes", integer()),
        ("format", json!({"enum": ["csv", "parquet", "lines"]})),
    ])
}

fn file_export_input() -> Value {
    json!({
        "oneOf": [
            closed_object([
                ("source", closed_object([
                    ("kind", json!({"const": "original"})),
                    ("resourceId", string()),
                    ("path", string()),
                ])),
                ("target", closed_object([
                    ("kind", json!({"const": "filesystem"})),
                    ("resourceId", string()),
                    ("path", string()),
                ])),
            ]),
            closed_object([
                ("source", closed_object([
                    ("kind", json!({"const": "output"})),
                    ("resourceId", string()),
                    ("stream", json!({"enum": ["stdout", "stderr"]})),
                    ("text", string()),
                ])),
                ("target", json!({
                    "oneOf": [
                        closed_object([("kind", json!({"const": "download"}))]),
                        closed_object([
                            ("kind", json!({"const": "filesystem"})),
                            ("resourceId", string()),
                            ("path", string()),
                        ]),
                    ],
                })),
            ]),
            closed_object([
                ("preparationId", string()),
                ("confirmed", json!({"const": true})),
                ("fields", json!({
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 100,
                    "items": closed_object([
                        ("source", string()),
                        ("name", string()),
                        ("type", json!({"enum": ["TEXT", "BIGINT", "DOUBLE", "BOOLEAN"]})),
                    ]),
                })),
                ("target", closed_object([
                    ("kind", json!({"const": "database"})),
                    ("resourceId", string()),
                    ("table", string()),
                ])),
            ]),
        ],
    })
}

fn file_export_output() -> Value {
    json!({
        "oneOf": [
            closed_object([
                ("kind", json!({"const": "download"})),
                ("filename", string()),
                ("mimeType", string()),
                ("content", string()),
                ("bytes", integer()),
            ]),
            closed_object([
                ("kind", json!({"const": "filesystem"})),
                ("resourceId", string()),
                ("path", string()),
                ("bytes", integer()),
            ]),
            closed_object([
                ("kind", json!({"const": "database"})),
                ("resourceId", string()),
                ("table", string()),
                ("rowCount", integer()),
                ("columns", array(closed_object([("name", string()), ("type", string())]))),
            ]),
        ],
    })
}
