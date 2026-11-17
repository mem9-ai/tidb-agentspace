//! The optional federated API uses its own cookie, never legacy Owner/Key authority.
use super::*;

fn parameter(name: &str, location: &str, required: bool) -> Value {
    json!({"name":name,"in":location,"required":required,"schema":string()})
}
fn operation(id: &str, summary: &str, output: Value) -> Value {
    json!({"operationId":id,"summary":summary,"security":[{"raftSession":[]}],
        "description":"Requires current Raft identity and current exact AgentSpace permissions. Admission grants no data access. Upstream outages fail closed. No Owner impersonation.",
        "responses":responses(json!({"200":response("Success",output)}))})
}
fn mutation(id: &str, summary: &str, input: Value, output: Value) -> Value {
    extend(
        operation(id, summary, output),
        json!({"requestBody":request(input)}),
    )
}
fn page(items: Value) -> Value {
    closed_object([
        ("data", array(items)),
        ("nextCursor", json!({"type":["string","null"]})),
    ])
}
fn data(schema: Value) -> Value {
    object([("data", schema)])
}
fn enrollment_page() -> Value {
    object([
        (
            "records",
            array(object([("value", reference("RaftEnrollment"))])),
        ),
        ("nextCursor", json!({"type":["string","null"]})),
    ])
}
fn governance(mut operation: Value) -> Value {
    operation["parameters"] = json!([{"name":"If-Match","in":"header","required":true,"schema":string(),"description":"Quoted current Workspace generation, reviewed before this Human mutation. A fresh Human sign-in within ten minutes is required. Immutable retries resolve the original intent."}]);
    operation
}
fn path_workspace() -> Value {
    parameter("workspaceId", "path", true)
}
fn path_resource() -> Value {
    parameter("resourceId", "path", true)
}
fn resource_path(operation: Value) -> Value {
    extend(
        operation,
        json!({"parameters":[path_workspace(),path_resource()]}),
    )
}

pub(super) fn paths() -> Value {
    let mut context = operation(
        "raftContext",
        "Inspect current identity and own Workspaces",
        reference("RaftContext"),
    );
    context["parameters"] = json!([parameter("cursor", "query", false)]);
    let mut inventory = operation(
        "raftListResources",
        "Discover only currently authorized resources",
        object([
            ("resources", array(reference("RaftResource"))),
            ("nextCursor", json!({"type":["string","null"]})),
        ]),
    );
    inventory["parameters"] = json!([
        parameter("workspaceId", "query", true),
        parameter("cursor", "query", false),
        extend(
            parameter("tags", "query", false),
            json!({"description":"JSON object of at most 20 exact string key/value filters, AND semantics. Tags convey no permission. A changed policy/filter invalidates the cursor."})
        )
    ]);
    let mut read = operation(
        "raftReadFile",
        "Read at most 128 KiB of UTF-8 content",
        reference("RaftFile"),
    );
    read["parameters"] = json!([
        parameter("workspaceId", "query", true),
        parameter("resourceId", "query", true),
        extend(
            parameter("path", "query", true),
            json!({"description":"Relative path without traversal, empty, dot or backslash segments."})
        )
    ]);
    let mut status = operation(
        "raftQueryStatus",
        "Observe an existing own request without repeating SQL",
        reference("RaftQuery"),
    );
    status["parameters"] = json!([
        parameter("workspaceId", "query", true),
        parameter("resourceId", "query", true),
        parameter("requestId", "query", true)
    ]);
    let mut workspaces = mutation(
        "raftCreateWorkspace",
        "Explicitly create an empty federated Workspace",
        closed_object([
            ("requestId", string()),
            ("name", string()),
            ("regionId", string()),
        ]),
        data(reference("RaftWorkspace")),
    );
    workspaces["responses"] = responses(
        json!({"201":response("Created; resourceReady is false until a usable resource is explicitly created",object([("data",reference("RaftWorkspace")),("resourceReady",boolean())]))}),
    );
    let workspace_ops = json!({"parameters":[path_workspace()]});
    let mut enrollment = mutation(
        "raftRequestEnrollment",
        "Request admission without data or creation rights",
        closed_object([]),
        data(reference("RaftEnrollment")),
    );
    enrollment["responses"] =
        responses(json!({"201":response("Requested",data(reference("RaftEnrollment")))}));
    json!({
        "/api/raft/config":{"get":extend(operation("raftConfig","Discover public Raft sign-in and Region choices",closed_object([("loginUrl",string()),("regions",array(string()))])),json!({"security":[]}))},
        "/.well-known/raft-agent-manifest.json":{"get":extend(operation("raftManifest","Public v0 manifest for five actions",json!({"type":"object"})),json!({"security":[]}))},
        "/auth/raft/login":{"get":{"operationId":"raftLogin","summary":"Start Human OIDC with one-use state, nonce and S256 PKCE","security":[],"responses":{"303":{"description":"Redirect to trusted Raft issuer; sets flow cookie"}}}},
        "/auth/raft/callback":{"get":{"operationId":"raftCallback","summary":"Redeem a Human or no-state Agent code at one registered callback","security":[],"parameters":[parameter("code","query",true),parameter("state","query",false)],"responses":{"200":response("Agent session cookie set on this response",closed_object([("authenticated",boolean()),("nextAction",string())])),"303":{"description":"Human session established; redirect to fixed Console URL"},"default":response("Flat CLI-compatible failure; expired/consumed code is 409",closed_object([("error",string()),("hint",string())]))}}},
        "/auth/raft/logout":{"post":extend(mutation("raftLogout","Durably revoke this session",closed_object([]),json!({})),json!({"responses":{"204":{"description":"Signed out; session cookie cleared"},"default":response("Denied",reference("Error"))}}))},
        "/api/raft/actions/context":{"get":context},
        "/api/raft/actions/list-resources":{"get":inventory},
        "/api/raft/actions/read-file":{"get":read},
        "/api/raft/actions/query":{"post":mutation("raftQuery","Submit SQL with a retained request UUID; INVALID_SQL (400) and READ_ONLY_SQL_REQUIRED (403) reject before execution; other errors require observing the original ID",reference("RaftQueryInput"),reference("RaftQuery"))},
        "/api/raft/actions/query-status":{"get":status},
        "/api/raft/workspaces":{"get":extend(operation("raftWorkspaces","List current own Workspaces",page(reference("RaftWorkspace"))),json!({"parameters":[parameter("cursor","query",false)]})),"post":workspaces},
        "/api/raft/workspaces/{workspaceId}":{"parameters":[path_workspace()],"get":operation("raftWorkspace","Read current membership and Workspace policy generation for a Human review",data(reference("RaftWorkspace")))},
        "/api/raft/workspaces/{workspaceId}/principals/{principalId}":{"parameters":[path_workspace(),parameter("principalId","path",true)],"get":operation("raftAdmissionCandidate","Human governor reviews one exact previously verified identity in this Server",data(reference("RaftPrincipal")))},
        "/api/raft/workspaces/{workspaceId}/invitations":{"parameters":[path_workspace()],"post":extend(governance(mutation("raftInvite","Human admits a verified identity with no resource or creation rights",closed_object([("requestId",string()),("principalId",string())]),data(reference("RaftEnrollment")))),json!({"responses":responses(json!({"201":response("Recorded and applied",data(reference("RaftEnrollment")))}))}))},
        "/api/raft/workspaces/{workspaceId}/invitations/{requestId}":{"parameters":[path_workspace(),parameter("requestId","path",true)],"get":operation("raftInvitation","Read original admission outcome; a removed member is never reactivated by retry",data(reference("RaftEnrollment")))},
        "/api/raft/workspaces/{workspaceId}/audit-events":{"parameters":[path_workspace()],"get":extend(operation("raftAuditEvents","Human governor reads durable security history in chronological pages",page(reference("RaftAuditEvent"))),json!({"parameters":[parameter("cursor","query",false)]}))},
        "/api/raft/workspaces/{workspaceId}/enrollments":extend(workspace_ops.clone(),json!({"get":extend(operation("raftEnrollments","Human governor reads admission requests",enrollment_page()),json!({"parameters":[parameter("cursor","query",false)]})),"post":enrollment})),
        "/api/raft/workspaces/{workspaceId}/enrollments/self":extend(workspace_ops.clone(),json!({"get":operation("raftOwnEnrollment","Inspect own pending, approved or denied enrollment",data(json!({"oneOf":[reference("RaftEnrollment"),{"type":"null"}]})))})),
        "/api/raft/workspaces/{workspaceId}/enrollments/{principalId}":{"parameters":[path_workspace(),parameter("principalId","path",true)],"patch":governance(mutation("raftDecideEnrollment","Human governor approves or denies one enrollment",closed_object([("approved",boolean())]),data(reference("RaftEnrollment"))))},
        "/api/raft/workspaces/{workspaceId}/members/{principalId}":{"parameters":[path_workspace(),parameter("principalId","path",true)],"delete":governance(operation("raftRemoveMember","Remove membership without deleting data; never remove last Human owner",data(reference("RaftWorkspace"))))},
        "/api/raft/workspaces/{workspaceId}/resources":extend(workspace_ops,json!({"get":extend(operation("raftGovernanceResources","Human governor lists resource metadata for sharing",reference("RaftCatalog")),json!({"parameters":[parameter("cursor","query",false)]})),"post":mutation("raftCreateResource","Human governor explicitly creates a native resource",closed_object([("requestId",string()),("kind",json!({"enum":["filesystem","postgresql"]})),("name",string()),("region",string())]),data(reference("RaftResource")))})),
        "/api/raft/workspaces/{workspaceId}/resources/share-batches":{"parameters":[path_workspace()],"post":governance(mutation("raftShareBatch","Freeze exact reviewed resources before sharing; partial edges are explicit and retries retain the same request ID",reference("RaftShareBatchInput"),reference("RaftShareBatch")))},
        "/api/raft/workspaces/{workspaceId}/resources/{resourceId}/grants":{"parameters":[path_workspace(),path_resource()],"get":extend(operation("raftResourceGrants","Human governor inspects exact resource grants",page(reference("RaftGrant"))),json!({"parameters":[parameter("cursor","query",false)]}))},
        "/api/raft/workspaces/{workspaceId}/resources/{resourceId}/grants/{grantId}":{"parameters":[path_workspace(),path_resource(),parameter("grantId","path",true)],"put":governance(mutation("raftPutGrant","Human governor shares one exact resource or irrevocably revokes a grant ID",reference("RaftGrantInput"),data(reference("RaftGrant"))))},
        "/api/raft/workspaces/{workspaceId}/resources/{resourceId}/tags":{"put":resource_path(mutation("raftSetTags","Replace organizational tags with tags:write and current version",reference("RaftTags"),data(reference("RaftTags"))))},
        "/api/raft/workspaces/{workspaceId}/resources/{resourceId}/files":{"get":extend(resource_path(operation("raftGetFile","Read an authorized text file",reference("RaftFile"))),json!({"parameters":[path_workspace(),path_resource(),parameter("path","query",true)]})),"put":resource_path(mutation("raftWriteFile","Create-only text write, or replace with the exact current revision; 64 KiB limit",json!({"type":"object","additionalProperties":false,"required":["path","content"],"properties":{"path":string(),"content":string(),"version":string()}}),json!({"type":"object"})))}
    })
}

pub(super) fn schemas() -> Value {
    let action = json!({"type":"string","enum":["resources:read","files:read","files:write","queries:read","queries:execute","tags:write"]});
    let principal = closed_object([
        ("id", string()),
        (
            "identity",
            closed_object([
                ("provider", string()),
                ("serverId", string()),
                ("subject", string()),
                ("kind", json!({"enum":["human","agent"]})),
            ]),
        ),
    ]);
    json!({
        "RaftWorkspace":extend(closed_object([("id",string()),("name",string()),("serverId",string()),("regionId",string()),("generation",integer())]),json!({"properties":{"id":string(),"name":string(),"serverId":string(),"regionId":string(),"generation":integer(),"canManage":boolean()}})),
        "RaftContext":object([("actor",closed_object([("id",string()),("kind",json!({"enum":["human","agent"]})),("serverId",string())])),("expiresAt",integer()),("enrollmentRequired",boolean()),("resourceReady",json!({"type":["boolean","null"],"description":"Null until list-resources has checked resource readiness."})),("workspaces",array(reference("RaftWorkspace"))),("nextCursor",json!({"type":["string","null"]}))]),
        "RaftPrincipal":principal,
        "RaftEnrollment":closed_object([("principal",reference("RaftPrincipal")),("status",json!({"enum":["pending","approved","denied","removed"]}))]),
        "RaftCatalog":object([("data",array(reference("RaftResource"))),("nextCursor",json!({"type":["string","null"]})),("capabilities",object([("filesystem",object([("regions",array(string())),("provider",string())])),("postgresql",object([("regions",array(string())),("provider",string()),("available",boolean())]))]))]),
        "RaftShareBatchInput":closed_object([("requestId",string()),("expiresAt",integer()),("principalId",string()),("resourceIds",json!({"type":"array","minItems":1,"maxItems":20,"uniqueItems":true,"items":string()})),("actions",array(action.clone()))]),
        "RaftShareBatch":closed_object([("requestId",string()),("results",array(json!({"type":"object","required":["resourceId","status"],"properties":{"resourceId":string(),"status":{"enum":["applied","pending","failed"]},"errorCode":string(),"grant":reference("RaftGrant")}})))]),
        "RaftAuditEvent":closed_object([("id",string()),("at",string()),("action",string()),("outcome",json!({"enum":["recorded","denied","uncertain"]})),("actor",closed_object([("id",string()),("kind",json!({"enum":["human","agent"]})),("serverId",string())])),("details",json!({"type":"object"}))]),
        "RaftGrantInput":json!({"type":"object","additionalProperties":false,"required":["principalId","actions"],"properties":{"principalId":string(),"actions":array(action.clone()),"expiresAt":integer(),"revoked":boolean()}}),
        "RaftGrant":extend(closed_object([("id",string()),("principalId",string()),("resourceId",string()),("actions",array(action.clone())),("revoked",boolean())]),json!({"properties":{"id":string(),"principalId":string(),"resourceId":string(),"actions":array(action.clone()),"revoked":boolean(),"expiresAt":integer()}})),
        "RaftTags":closed_object([("version",json!({"type":"integer","minimum":0})),("values",json!({"type":"object","maxProperties":20,"additionalProperties":{"type":"string","maxLength":256}}))]),
        "RaftResource":json!({"type":"object","required":["id","name","kind","region","status","provider","allowedActions"],"properties":{"id":string(),"name":string(),"kind":{"enum":["filesystem","postgresql"]},"region":string(),"status":string(),"provider":string(),"allowedActions":array(string()),"tags":reference("RaftTags"),"createdBy":string()}}),
        "RaftFile":json!({"type":"object","required":["content","encoding","size"],"properties":{"content":string(),"encoding":{"const":"utf8"},"size":integer(),"revision":string()}}),
        "RaftQueryInput":closed_object([("workspaceId",string()),("resourceId",string()),("requestId",json!({"type":"string","format":"uuid"})),("sql",json!({"type":"string","minLength":1,"maxLength":65536}))]),
        "RaftQuery":closed_object([("requestId",string()),("operationId",string()),("status",json!({"enum":["running","succeeded","failed","outcomeUnknown"]})),("result",json!({"type":["object","null"]})),("errorCode",json!({"type":["string","null"]}))])
    })
}
