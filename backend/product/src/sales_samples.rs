use super::*;

const FIXTURE: &str = include_str!("../../../specs/gh-150/fixtures/us-sales.csv");
const PATH: &str = "/us-sales.csv";

pub(super) struct SampleRequest<'a> {
    pub method: &'a str,
    pub route: &'a str,
    pub query: &'a BTreeMap<String, String>,
    pub input: Value,
    pub idempotency: Option<&'a str>,
}

fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}

fn visible_attempt(value: &Value) -> Value {
    const FIELDS: [&str; 9] = [
        "id",
        "fixture",
        "status",
        "resourceId",
        "path",
        "fileVersion",
        "errorCode",
        "createdAt",
        "updatedAt",
    ];
    Value::Object(
        FIELDS
            .into_iter()
            .filter_map(|key| value.get(key).map(|field| (key.to_owned(), field.clone())))
            .collect(),
    )
}

fn can_observe(p: &Principal, attempt: &Value) -> bool {
    if p.owner {
        return true;
    }
    if p.scope("files:read").is_err() {
        return false;
    }
    if let Some(id) = attempt["resourceId"].as_str() {
        return p.has(id) || p.permits_type("filesystem");
    }
    p.has("*") && p.scope("resources:write").is_ok() && p.scope("files:write").is_ok()
}

impl Product {
    async fn sales_sample_file_version(
        &self,
        credential: &Credential,
        resource_id: &str,
    ) -> Result<String> {
        let resource = self.workspace.repository().resource(resource_id).await?;
        if resource["status"] != "active" || !resource["deletion"].is_null() {
            return Err(err(409, "SAMPLE_RESOURCE_NOT_READY"));
        }
        let query = BTreeMap::from([
            ("resourceId".into(), resource_id.into()),
            ("path".into(), PATH.into()),
        ]);
        let metadata = || files::FileRequest {
            method: "GET",
            route: "/files/metadata",
            query: &query,
            input: json!({}),
            raw: &[],
            if_match: None,
            if_none_match: None,
        };
        let (_, first_metadata) = self.files(credential, metadata()).await?;
        let version = match first_metadata {
            Reply::Entity { etag, .. } => etag,
            _ => return Err(err(409, "FILE_VERSION_UNAVAILABLE")),
        };
        let (_, bytes) = self
            .snapshot(credential, &resource, PATH, false, FIXTURE.len())
            .await?;
        if bytes != FIXTURE.as_bytes() {
            return Err(err(409, "FILE_CHANGED"));
        }
        let (_, last_metadata) = self.files(credential, metadata()).await?;
        if !matches!(last_metadata, Reply::Entity { etag, .. } if etag == version) {
            return Err(err(409, "FILE_CHANGED"));
        }
        Ok(version)
    }

    async fn observe_sales_sample(&self, credential: &Credential, attempt: Value) -> Result<Value> {
        // Inspect only the recorded file. A failed observation never replays a write
        // or treats an existing customer file as the public fixture.
        if attempt["status"] == "outcome_unknown"
            && attempt["writeIntent"] == true
            && attempt["path"] == PATH
            && let Some(resource_id) = attempt["resourceId"].as_str()
            && let Ok(version) = self
                .sales_sample_file_version(credential, resource_id)
                .await
        {
            return self
                .workspace
                .repository()
                .confirm_sales_sample(text(&attempt, "id")?, &version)
                .await;
        }
        Ok(attempt)
    }

    pub(super) async fn sales_sample_request(
        &self,
        credential: &Credential,
        p: &Principal,
        request: SampleRequest<'_>,
    ) -> Result<(u16, Reply)> {
        let SampleRequest {
            method,
            route,
            query,
            input,
            idempotency,
        } = request;
        let repository = self.workspace.repository();
        if method == "GET" && route == "/sales-sample-attempts" {
            if query.len() != 1 || query.get("fixture").map(String::as_str) != Some("us-sales-v1") {
                return Err(err(400, "INVALID_INPUT"));
            }
            let attempt = repository.current_sales_sample().await?;
            let data = if let Some(attempt) = attempt.filter(|value| can_observe(p, value)) {
                vec![visible_attempt(
                    &self.observe_sales_sample(credential, attempt).await?,
                )]
            } else {
                vec![]
            };
            return Ok((200, Reply::Json(json!({"data":data}))));
        }
        if method == "GET" {
            let id = route
                .strip_prefix("/sales-sample-attempts/")
                .filter(|id| canonical_uuid(id))
                .ok_or_else(|| err(404, "NOT_FOUND"))?;
            if !query.is_empty() {
                return Err(err(400, "INVALID_INPUT"));
            }
            let attempt = repository.sales_sample(id).await?;
            if !can_observe(p, &attempt) {
                return Err(err(404, "NOT_FOUND"));
            }
            let attempt = self.observe_sales_sample(credential, attempt).await?;
            return Ok((200, Reply::Json(json!({"data":visible_attempt(&attempt)}))));
        }
        if method != "POST" || route != "/sales-sample-attempts" {
            return Err(err(404, "NOT_FOUND"));
        }
        if !query.is_empty() {
            return Err(err(400, "INVALID_INPUT"));
        }
        let key = idempotency.ok_or_else(|| err(400, "IDEMPOTENCY_KEY_REQUIRED"))?;
        if !canonical_uuid(key) {
            return Err(err(400, "INVALID_IDEMPOTENCY_KEY"));
        }
        for scope in ["files:read", "files:write"] {
            p.scope(scope)?;
        }
        if !input.as_object().is_some_and(|obj| {
            obj.get("fixture") == Some(&json!("us-sales-v1"))
                && obj
                    .keys()
                    .all(|key| key == "fixture" || key == "resourceId")
                && obj
                    .get("resourceId")
                    .is_none_or(|value| value.as_str().is_some_and(|id| !id.is_empty()))
        }) {
            if repository.has_sales_sample_key(&p.id, key).await? {
                return Err(err(409, "IDEMPOTENCY_CONFLICT"));
            }
            return Err(err(400, "INVALID_INPUT"));
        }
        let requested_resource = input["resourceId"].as_str();
        if let Some(resource_id) = requested_resource {
            let resource = repository.resource(resource_id).await?;
            if !p.has(resource_id) && !p.permits_record(&resource) {
                return Err(err(403, "FORBIDDEN"));
            }
            if resource["kind"] != "filesystem"
                || resource["status"] != "active"
                || !resource["deletion"].is_null()
            {
                return Err(err(409, "SAMPLE_RESOURCE_NOT_READY"));
            }
        } else {
            p.scope("resources:write")?;
            if !p.has("*") {
                return Err(err(403, "FORBIDDEN"));
            }
        }
        // Resource-index backfill has no provider effects. Wait before reserving the
        // sample slot, so a slow migration remains an explicitly retryable request.
        // An idempotent replay observes its already-recorded attempt immediately.
        if requested_resource.is_none() && !repository.has_sales_sample_key(&p.id, key).await? {
            repository.prepare_sample_resource_index().await?;
        }
        let id = uuid::Uuid::new_v4().to_string();
        let now = timestamp();
        let attempt = json!({"id":id,"fixture":"us-sales-v1","status":"preparing","resourceId":requested_resource,"requestedResourceId":requested_resource,"path":null,"fileVersion":null,"errorCode":null,"createdAt":now,"updatedAt":now,"writeIntent":false});
        let (attempt, created) = repository
            .begin_sales_sample(credential, &p.id, key, attempt)
            .await?;
        if !created {
            let attempt = self.observe_sales_sample(credential, attempt).await?;
            return Ok((200, Reply::Json(json!({"data":visible_attempt(&attempt)}))));
        }
        let id = text(&attempt, "id")?.to_owned();
        let resource_id = requested_resource
            .map(str::to_owned)
            .unwrap_or(format!("fs_{}", secret(6)?));
        let caps = self.capabilities();
        let region = caps["filesystem"]["regions"][0]
            .as_str()
            .ok_or_else(|| err(503, "SERVICE_UNAVAILABLE"))?;
        let resource = json!({"id":resource_id,"name":format!("sales-{}",&id[..8]),"kind":"filesystem","region":region,"regionId":repository.authority_id(),"status":if self.providers.config.files_provider=="local"{"active"}else{"provisioning"},"provider":self.providers.config.files_provider,"createdAt":timestamp()});
        repository
            .update_sales_sample(&id, json!({"resourceId":resource_id}))
            .await?;
        let event = json!({"id":uuid::Uuid::new_v4().to_string(),"action":"resource.created","resource":resource["name"],"resourceId":resource_id,"actor":p.actor,"at":timestamp(),"outcome":"success"});
        let operation = async {
            let resource = if requested_resource.is_some() {
                repository.resource(&resource_id).await?
            } else {
                let resource = repository
                    .create_indexed_resource(credential, None, "sales-sample-v1", resource, event)
                    .await?;
                let current = self.workspace.authenticate(credential).await?;
                current.scope("resources:write")?;
                self.update_resource(resource, true).await?
            };
            if resource["status"] != "active" {
                return Err(err(409, "SAMPLE_RESOURCE_NOT_READY"));
            }
            self.context(
                credential,
                "files:write",
                Some((&resource_id, Some("filesystem"))),
            )
            .await?;
            repository
                .update_sales_sample(&id, json!({"path":PATH,"writeIntent":true}))
                .await?;
            let input =
                json!({"resourceId":resource_id,"path":PATH,"type":"file","content":FIXTURE});
            self.files(
                credential,
                files::FileRequest {
                    method: "PUT",
                    route: "/files",
                    query: &BTreeMap::new(),
                    input,
                    raw: &[],
                    if_match: None,
                    if_none_match: Some("*"),
                },
            )
            .await?;
            let version = self
                .sales_sample_file_version(credential, &resource_id)
                .await?;
            repository
                .update_sales_sample(&id, json!({"status":"ready","fileVersion":version}))
                .await
        }
        .await;
        let result = match operation {
            Ok(value) => value,
            Err(error) => {
                let current = repository.sales_sample(&id).await?;
                let uncertain = current["writeIntent"] == true
                    || error.status >= 500
                    || error.code == "SAMPLE_RESOURCE_NOT_READY";
                repository.update_sales_sample(&id, json!({"status":if uncertain {"outcome_unknown"} else {"failed"},"errorCode":error.code})).await?
            }
        };
        Ok((201, Reply::Json(json!({"data":visible_attempt(&result)}))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_attempt_fields_stay_out_of_customer_responses() {
        let public = json!({"id":"example","fixture":"us-sales-v1","status":"outcome_unknown",
            "resourceId":"fs","path":"/us-sales.csv","fileVersion":null,"errorCode":null,
            "createdAt":"before","updatedAt":"after"});
        let mut stored = public.clone();
        stored["writeIntent"] = json!(true);
        stored["requestedResourceId"] = json!("fs");
        stored["futureRecoveryField"] = json!("private");
        assert_eq!(visible_attempt(&stored), public);
    }
}
