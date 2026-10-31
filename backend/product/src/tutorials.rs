use super::*;

pub(super) struct TutorialRequest<'a> {
    pub method: &'a str,
    pub route: &'a str,
    pub query: &'a BTreeMap<String, String>,
    pub input: Value,
    pub if_match: Option<&'a str>,
    pub if_none_match: Option<&'a str>,
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

impl Product {
    pub(super) async fn tutorial_request(
        &self,
        credential: &Credential,
        p: &Principal,
        request: TutorialRequest<'_>,
    ) -> Result<(u16, Reply)> {
        let TutorialRequest {
            method,
            route,
            query,
            input,
            if_match,
            if_none_match,
        } = request;
        // These bookmarks are Workspace administration state, never a new Workspace Key grant.
        if !p.owner {
            return Err(err(403, "OWNER_REQUIRED"));
        }
        let repository = self.workspace.repository();
        if method == "GET" && route == "/tutorials" {
            if if_match.is_some()
                || if_none_match.is_some()
                || query
                    .keys()
                    .any(|k| !["cursor", "limit"].contains(&k.as_str()))
            {
                return Err(err(400, "INVALID_INPUT"));
            }
            let cursor = query.get("cursor").map(String::as_str);
            if cursor.is_some_and(|value| !identifier(value)) {
                return Err(err(400, "INVALID_CURSOR"));
            }
            let limit = match query.get("limit") {
                None => 100,
                Some(value) => value
                    .parse::<usize>()
                    .ok()
                    .filter(|v| (1..=100).contains(v))
                    .ok_or_else(|| err(400, "INVALID_LIMIT"))?,
            };
            return Ok((200, Reply::Json(repository.tutorials(cursor, limit).await?)));
        }
        let resource_id = route
            .strip_prefix("/tutorials/")
            .filter(|id| identifier(id))
            .ok_or_else(|| err(404, "NOT_FOUND"))?;
        if !query.is_empty() {
            return Err(err(400, "INVALID_INPUT"));
        }
        let (value, created) = match method {
            "GET" => {
                if if_match.is_some() || if_none_match.is_some() {
                    return Err(err(400, "INVALID_PRECONDITION"));
                }
                (repository.tutorial(resource_id).await?, false)
            }
            "PUT" => {
                if if_match.is_some() && if_none_match.is_some()
                    || if_none_match.is_some_and(|value| value != "*")
                    || if_match.is_some_and(|value| {
                        let Some(version) = value
                            .strip_prefix("\"tutorial-")
                            .and_then(|v| v.strip_suffix('"'))
                        else {
                            return true;
                        };
                        version.len() != 32
                            || !version
                                .bytes()
                                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
                    })
                {
                    return Err(err(400, "INVALID_PRECONDITION"));
                }
                if if_match.is_none() && if_none_match.is_none() {
                    return Err(err(428, "PRECONDITION_REQUIRED"));
                }
                if !input.as_object().is_some_and(|v| {
                    v.len() == 2 && v.contains_key("sampleId") && v.contains_key("state")
                }) || !input["sampleId"].as_str().is_some_and(|id| {
                    id.len() == 32
                        && id
                            .bytes()
                            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
                }) || !input["state"].as_str().is_some_and(|state| {
                    ["pending", "attempted", "ready", "completed"].contains(&state)
                }) {
                    return Err(err(400, "INVALID_TUTORIAL"));
                }
                // Validate the public resource without provider I/O. The lifecycle read guard in
                // handle prevents a concurrent deletion crossing the acknowledged bookmark write.
                let resource = repository.resource(resource_id).await?;
                p.resource(&json!({"resources":[resource]}), resource_id, None)?;
                if resource["status"] == "deleted" || resource["status"] == "deleting" {
                    return Err(err(409, "RESOURCE_DELETING"));
                }
                self.workspace.authenticate(credential).await?;
                repository
                    .replace_tutorial(resource_id, if_match, input)
                    .await?
            }
            _ => return Err(err(404, "NOT_FOUND")),
        };
        let etag = text(&value, "version")?.to_owned();
        Ok((
            if created { 201 } else { 200 },
            Reply::Entity {
                value: json!({"data":value}),
                etag,
            },
        ))
    }
}
