use super::*;
impl Product {
    pub(super) async fn preparation_request(
        &self,
        credential: &Credential,
        actor: &str,
        method: &str,
        collection: &str,
        id: &str,
    ) -> Result<(u16, Reply)> {
        let entry = self
            .preparations
            .lock()
            .await
            .get(id)
            .filter(|e| {
                e.actor == actor
                    && e.expires > chrono::Utc::now().timestamp_millis()
                    && (e.destination.is_some() == (collection == "database-import-preparations"))
            })
            .cloned()
            .ok_or_else(|| err(404, "PREPARATION_NOT_FOUND"))?;
        if let Some(destination) = &entry.destination {
            self.export_authorize(
                credential,
                destination,
                &json!({"kind":"database","resourceId":destination}),
                false,
                false,
            )
            .await?;
        }
        if entry.source["kind"] != "upload" {
            self.export_authorize(
                credential,
                text(&entry.source, "resourceId")?,
                &json!({"kind":"download"}),
                false,
                true,
            )
            .await?;
        }
        // Recheck the exact entry after authorization; an admitted commit may have claimed it.
        let mut map = self.preparations.lock().await;
        let current = map
            .get(id)
            .filter(|e| e.actor == actor && e.expires > chrono::Utc::now().timestamp_millis())
            .ok_or_else(|| err(404, "PREPARATION_NOT_FOUND"))?;
        if method == "DELETE" {
            if current.used {
                return Err(err(409, "IMPORT_ALREADY_COMMITTED"));
            }
            map.remove(id);
            Ok((204, Reply::Empty))
        } else {
            let mut review = current.review.clone();
            review["status"] = json!(if current.used { "consumed" } else { "ready" });
            Ok((200, Reply::Json(review)))
        }
    }
}
