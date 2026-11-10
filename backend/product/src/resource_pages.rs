use super::*;

impl Product {
    pub(super) async fn resource_page(
        &self,
        p: &Principal,
        query: &BTreeMap<String, String>,
    ) -> Result<(Vec<Value>, Option<String>)> {
        let limit = query.get("limit").map_or(Ok(100), |value| {
            value
                .parse::<usize>()
                .map_err(|_| err(400, "INVALID_PAGE_LIMIT"))
        })?;
        if !(1..=512).contains(&limit) {
            return Err(err(400, "INVALID_PAGE_LIMIT"));
        }
        let typed = !p.resource_types.is_empty();
        let after = if let Some(token) = query.get("cursor") {
            let invalid = || err(400, "INVALID_PAGE_CURSOR");
            if token.len() > 1024 {
                return Err(invalid());
            }
            let bytes = URL_SAFE_NO_PAD.decode(token).map_err(|_| invalid())?;
            Some(if typed {
                self.open_resource_cursor(&bytes, &p.id).await?
            } else {
                String::from_utf8(bytes).map_err(|_| invalid())?
            })
        } else {
            None
        };
        let repository = self.workspace.repository();
        if let Some(name) = query.get("name") {
            if name.is_empty() || name.len() > 128 || after.is_some() {
                return Err(err(400, "INVALID_RESOURCE_NAME"));
            }
            let record = repository.resource_named(name).await?;
            return Ok((
                record
                    .into_iter()
                    .filter(|r| p.permits_record(r) && r["status"] != "deleted")
                    .collect(),
                None,
            ));
        }
        if after.as_ref().is_some_and(|id| {
            id.is_empty()
                || id.contains('/')
                || id == "."
                || id == ".."
                || (p.resource_types.is_empty() && !p.has(id))
        }) {
            return Err(err(400, "INVALID_PAGE_CURSOR"));
        }
        let (items, next) = if typed || p.has("*") {
            let (items, next) = self
                .workspace
                .repository()
                .resources_page(after.map(|id| format!("state/resources/{id}")), limit)
                .await?;
            let next = next
                .map(|key| {
                    key.strip_prefix("state/resources/")
                        .map(str::to_owned)
                        .ok_or_else(|| err(503, "META_RECORD_CORRUPT"))
                })
                .transpose()?;
            (items, next)
        } else {
            let ids = p.resource_ids.iter().collect::<BTreeSet<_>>();
            let mut remaining = ids
                .into_iter()
                .filter(|id| after.as_ref().is_none_or(|a| id.as_str() > a.as_str()));
            let selected = remaining.by_ref().take(limit).collect::<Vec<_>>();
            let next = if remaining.next().is_some() {
                selected.last().map(|id| (*id).clone())
            } else {
                None
            };
            let ids = selected.iter().map(|id| id.as_str()).collect::<Vec<_>>();
            let items = self.workspace.repository().resources_by_id(&ids).await?;
            (items, next)
        };
        let data = items
            .into_iter()
            .filter(|r| p.permits_record(r) && r["status"] != "deleted")
            .collect::<Vec<_>>();
        let next = match next {
            Some(id) if typed => Some(self.seal_resource_cursor(&id, &p.id).await?),
            other => other.map(|id| URL_SAFE_NO_PAD.encode(id)),
        };
        Ok((data, next))
    }
}
