use super::*;

pub(super) fn paths() -> Value {
    json!({
        "/agent-trial/report-view": {"get": get_agent_trial_report_view()},
        "/agent-trial/challenges": {"post": create_agent_trial_challenge()},
        "/agent-trial/sessions": {"post": create_agent_trial_session()},
        "/agent-trial/report": {"get": get_agent_trial_report(), "put": update_agent_trial_report()},
        "/agent-trial/report-sharing": {"delete": revoke_agent_trial_report_sharing()},
        "/agent-trial/us-sales-v1.csv": {"get": download_agent_trial_sample()},
        "/agent-csv/workspaces": {"post": open_private_csv_workspace()},
        "/agent-csv/workspaces/{workspaceId}/sources/{resourceId}/metadata": {
            "parameters": [
                {"in": "path", "name": "workspaceId", "required": true, "schema": string()},
                {"in": "path", "name": "resourceId", "required": true, "schema": string()},
            ],
            "get": get_private_csv_version(),
        },
        "/agent-csv/workspaces/{workspaceId}/sources/{resourceId}/content": {
            "parameters": [
                {"in": "path", "name": "workspaceId", "required": true, "schema": string()},
                {"in": "path", "name": "resourceId", "required": true, "schema": string()},
            ],
            "get": download_private_csv(),
            "put": upload_private_csv(),
        },
    })
}

fn get_agent_trial_report_view() -> Value {
    json!({
        "operationId": "getAgentTrialReportView",
        "security": [{"trialReportView": []}],
        "description": "Read the latest saved revision. Grant is valid for one report until its original 48-hour deadline (410 when expired or sharing is revoked). Cookies and query parameters are rejected. Reading never enrolls, renews, or changes a trial.",
        "responses": {
            "200": response("Success", report_schema()),
            "default": response("Request rejected", reference("Error")),
        },
    })
}

fn create_agent_trial_challenge() -> Value {
    json!({
        "operationId": "createAgentTrialChallenge",
        "security": [],
        "responses": {
            "200": response("Success", closed_object([
                ("challenge", string()),
                ("expiresAt", json!({"type": "integer", "description": "Unix seconds"})),
            ])),
            "default": response("Request rejected", reference("Error")),
        },
    })
}

fn create_agent_trial_session() -> Value {
    json!({
        "operationId": "createAgentTrialSession",
        "security": [],
        "description": "Sign the UTF-8 text drive9/trial/v1, challenge, and start (enroll=true) or resume, joined by LF, with the project Ed25519 key. Keys and signatures use unpadded base64url. Challenges expire after 60 seconds. Sessions expire within five minutes; trial lifetime is 48 hours.",
        "requestBody": request(closed_object([
            ("publicKey", string()),
            ("challenge", string()),
            ("signature", string()),
            ("enroll", boolean()),
        ])),
        "responses": {
            "200": response("Success", closed_object([("token", string()), ("report", report_schema())])),
            "default": response("Request rejected", reference("Error")),
        },
    })
}

fn get_agent_trial_report() -> Value {
    json!({
        "operationId": "getAgentTrialReport",
        "security": [{"trialSession": []}],
        "responses": {
            "200": response("Success", report_schema()),
            "default": response("Request rejected", reference("Error")),
        },
    })
}

fn update_agent_trial_report() -> Value {
    json!({
        "operationId": "updateAgentTrialReport",
        "security": [{"trialSession": []}],
        "description": "The report is the immutable us-sales-v1 sample plus the selected analyses. Revision 0 is empty, 1 contains state totals, and 2 also contains the top product for the leading state. Append in order. Read back after unknown outcomes.",
        "parameters": [
            {
                "in": "header",
                "name": "If-Match",
                "required": true,
                "schema": {"enum": ["\"0\"", "\"1\"", "\"2\""]},
            },
        ],
        "requestBody": request(closed_object([("section", json!({"enum": ["states", "products"]}))])),
        "responses": {
            "200": response("Success", report_schema()),
            "default": response("Request rejected", reference("Error")),
        },
    })
}

fn revoke_agent_trial_report_sharing() -> Value {
    json!({
        "operationId": "revokeAgentTrialReportSharing",
        "security": [{"trialSession": []}],
        "description": "Permanently revoke all read-only links for this trial. Only the originating writer session may revoke. Repeated deletion is idempotent. Content, local reports, writer access and the original expiry are retained; later report updates never re-enable sharing. A new trial is required to publish again.",
        "responses": {
            "200": response("Success", report_schema()),
            "default": response("Request rejected", reference("Error")),
        },
    })
}

fn download_agent_trial_sample() -> Value {
    json!({
        "operationId": "downloadAgentTrialSample",
        "security": [],
        "responses": {
            "200": {
                "description": "Immutable public US sales fixture",
                "content": {"text/csv": {"schema": string()}},
            },
            "default": response("Unavailable", reference("Error")),
        },
    })
}

fn open_private_csv_workspace() -> Value {
    json!({
        "operationId": "openPrivateCsvWorkspace",
        "description": "Enroll or recover the same private 48-hour Guest workspace and its default File System using the same project capability. Send an empty body. Resume known files using the source endpoints.",
        "tags": ["Private CSV workspace"],
        "security": [{"csvWorkspace": []}],
        "responses": {
            "200": response("Success", object([
                ("workspaceId", json!({"type": "string", "format": "uuid"})),
                ("resourceId", string()),
                ("expiresAt", json!({"type": "integer", "description": "Original expiry in Unix seconds"})),
            ])),
            "default": response("Rejected or unavailable", reference("Error")),
        },
    })
}

fn get_private_csv_version() -> Value {
    json!({
        "operationId": "getPrivateCsvVersion",
        "description": "Read the current source version. Missing source returns 404.",
        "tags": ["Private CSV workspace"],
        "security": [{"csvWorkspace": []}],
        "responses": {
            "200": {
                "description": "Success",
                "content": {
                    "application/json": {
                        "schema": object([
                            ("data", object([
                                ("resourceId", string()),
                                ("path", string()),
                                ("type", json!({"enum": ["file", "directory"]})),
                                ("size", integer()),
                                ("version", json!({"type": ["string", "null"]})),
                                ("conditionalWrites", boolean()),
                            ])),
                        ]),
                    },
                },
                "headers": {
                    "ETag": {
                        "schema": string(),
                        "description": "Strong version validator when available. Never cache authenticated metadata.",
                    },
                },
            },
            "default": response("Rejected or unavailable", reference("Error")),
        },
    })
}

fn download_private_csv() -> Value {
    json!({
        "operationId": "downloadPrivateCsv",
        "description": "Read the private source from its original workspace without a local file or a new signup.",
        "tags": ["Private CSV workspace"],
        "security": [{"csvWorkspace": []}],
        "responses": {
            "200": {
                "description": "Success",
                "content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}},
            },
            "default": response("Rejected or unavailable", reference("Error")),
        },
    })
}

fn upload_private_csv() -> Value {
    json!({
        "operationId": "uploadPrivateCsv",
        "description": "Write one nonempty UTF-8 CSV of up to 1048576 bytes. Supply exactly one of If-None-Match: * (new) or If-Match (explicit replacement). A stale precondition cannot overwrite the source.",
        "tags": ["Private CSV workspace"],
        "security": [{"csvWorkspace": []}],
        "parameters": [
            {"in": "header", "name": "If-Match", "schema": string()},
            {"in": "header", "name": "If-None-Match", "schema": string()},
        ],
        "requestBody": {"required": true, "content": {"text/csv": {"schema": string()}}},
        "responses": {
            "200": response("Success", object([("saved", boolean()), ("size", integer())])),
            "default": response("Rejected or unavailable", reference("Error")),
        },
    })
}
