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
        let after = query
            .get("cursor")
            .map(|cursor| {
                if cursor.len() > 1024 {
                    return Err(err(400, "INVALID_PAGE_CURSOR"));
                }
                String::from_utf8(
                    URL_SAFE_NO_PAD
                        .decode(cursor)
                        .map_err(|_| err(400, "INVALID_PAGE_CURSOR"))?,
                )
                .map_err(|_| err(400, "INVALID_PAGE_CURSOR"))
            })
            .transpose()?;
        if after
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.contains('/') || !p.has(id))
        {
            return Err(err(400, "INVALID_PAGE_CURSOR"));
        }
        let (items, next) = if p.owner || p.resource_ids.iter().any(|id| id == "*") {
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
            .filter(|r| visible_resource(r) && r["status"] != "deleted")
            .collect::<Vec<_>>();
        Ok((data, next.map(|value| URL_SAFE_NO_PAD.encode(value))))
    }
}
