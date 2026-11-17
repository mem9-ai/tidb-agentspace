//! Security history commits with the governance intent, independently of analytics.
use super::*;

fn audit(
    actor: &FederatedPrincipal,
    action: &str,
    details: Value,
    outcome: &str,
) -> (String, Value) {
    let now = chrono::Utc::now();
    let id = Uuid::new_v4().to_string();
    (
        format!("audit/{:020}/{id}", now.timestamp_millis()),
        json!({"id":id,"at":now.to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"actor":{"id":actor.id,"kind":actor.identity.kind,"serverId":actor.identity.server_id},"action":action,"outcome":outcome,"details":details}),
    )
}
impl Federation {
    pub(super) async fn commit_audited(
        &self,
        scope: &Scope,
        actor: &FederatedPrincipal,
        action: &str,
        details: Value,
        mut changes: Vec<Value>,
    ) -> Result<()> {
        let (key, event) = audit(actor, action, details, "recorded");
        changes.push(change(&key, &Value::Null, event));
        self.commit(scope, changes).await
    }
    /// Failed attempts never authorize effects. Only safe operation labels/reasons are recorded.
    pub async fn record_governance_failure(
        &self,
        actor: &FederatedPrincipal,
        workspace: &str,
        operation: &str,
        code: &str,
        uncertain: bool,
    ) -> Result<()> {
        let scope = workspace_scope(workspace)?;
        let current = self.records(&scope, vec!["workspace".into()]).await?;
        if current["workspace"].is_null() {
            return Ok(());
        }
        let (key, event) = audit(
            actor,
            operation,
            json!({"code":code}),
            if uncertain { "uncertain" } else { "denied" },
        );
        self.commit(&scope, vec![change(&key, &Value::Null, event)])
            .await
    }
    pub async fn audit_events(
        &self,
        actor: &FederatedPrincipal,
        workspace: &str,
        after: Option<String>,
    ) -> Result<Value> {
        self.membership(actor, workspace).await?.1.govern(actor)?;
        if after
            .as_ref()
            .is_some_and(|s| !s.starts_with("audit/") || s.len() > 80)
        {
            return Err(error(400, "INVALID_PAGE_CURSOR"));
        }
        let page = self
            .metadata
            .execute(MetaRequest::List {
                scope: workspace_scope(workspace)?,
                guard: None,
                prefix: "audit/".into(),
                after,
                limit: 50,
            })
            .await?;
        self.membership(actor, workspace).await?.1.govern(actor)?;
        let data = page["records"]
            .as_array()
            .ok_or_else(|| error(503, "FEDERATED_RECORD_CORRUPT"))?
            .iter()
            .map(|r| r["value"].clone())
            .collect::<Vec<_>>();
        Ok(json!({"data":data,"nextCursor":page["nextCursor"]}))
    }
}
