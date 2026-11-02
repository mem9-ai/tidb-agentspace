//! Test-only helper for exercising history against the real metadata service and RustFS.
use std::{env, fs, sync::Arc};
use uuid::Uuid;
use workspace_domain::{Repository, observability::*};
use workspace_meta_client::{ClientConfig, RemoteMetadata};

fn page<'a>(cursor: Option<&'a str>, limit: usize) -> HistoryFilter<'a> {
    HistoryFilter {
        cursor,
        limit,
        from: None,
        to: None,
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let config: ClientConfig =
        serde_json::from_slice(&fs::read(args.next().ok_or("missing configuration")?)?)?;
    let stage = args.next().ok_or("missing stage")?;
    let authority = config.authority_id.clone();
    let metadata = Arc::new(RemoteMetadata::connect(config).await?);
    let initialize = stage == "write";
    let a = Repository::open(
        metadata.clone(),
        &authority,
        "ws_history_a",
        initialize,
        None,
    )
    .await?;
    let b = Repository::open(metadata, &authority, "ws_history_b", initialize, None).await?;
    if initialize {
        let entry = |status| RequestEntry {
            request_id: Uuid::new_v4(),
            actor_kind: ActorKind::Owner,
            actor_id: "owner-a",
            operation: HttpOperation::Files,
            method: HttpMethod::Get,
            completion: HttpCompletion::Responded(status),
            started_at: chrono::Utc::now(),
            duration_ms: 5,
        };
        a.append_request_batch(&[entry(200), entry(403)]).await?;
        let operation = a
            .begin_audit_operation(AuditIntent {
                request_id: None,
                actor_kind: ActorKind::Owner,
                actor_id: "owner-a",
                action: AuditAction::FileWrite,
                target_id: None,
            })
            .await?;
        a.finish_audit_operation(operation, AuditOutcome::Succeeded)
            .await?;
        let _unresolved = a
            .begin_audit_operation(AuditIntent {
                request_id: None,
                actor_kind: ActorKind::Owner,
                actor_id: "owner-a",
                action: AuditAction::QueryWrite,
                target_id: None,
            })
            .await?;
        let first = a
            .history_page(HistoryStream::Requests, page(None, 1))
            .await?;
        let cursor = first["nextCursor"].as_str().ok_or("missing cursor")?;
        assert_eq!(
            b.history_page(HistoryStream::Requests, page(Some(cursor), 1))
                .await
                .unwrap_err()
                .code,
            "INVALID_HISTORY_CURSOR"
        );
    } else if stage == "verify" {
        let first = a
            .history_page(HistoryStream::Requests, page(None, 1))
            .await?;
        assert_eq!(first["data"][0]["status"], 403);
        let cursor = first["nextCursor"]
            .as_str()
            .ok_or("missing persisted cursor")?;
        assert_eq!(
            a.history_page(HistoryStream::Requests, page(Some(cursor), 1))
                .await?["data"][0]["status"],
            200
        );
        let audit = a.history_page(HistoryStream::Audit, page(None, 10)).await?;
        assert_eq!(audit["data"][0]["outcome"], "attempted");
        assert_eq!(audit["data"][1]["outcome"], "succeeded");
        assert!(
            b.history_page(HistoryStream::Requests, page(None, 10))
                .await?["data"]
                .as_array()
                .ok_or("invalid page")?
                .is_empty()
        );
        assert!(
            b.history_page(HistoryStream::Audit, page(None, 10)).await?["data"]
                .as_array()
                .ok_or("invalid page")?
                .is_empty()
        );
        assert_eq!(
            a.purge_expired_request_batch(chrono::Utc::now() + chrono::Duration::days(8))
                .await?,
            2
        );
        assert!(
            a.history_page(HistoryStream::Requests, page(None, 10))
                .await?["data"]
                .as_array()
                .ok_or("invalid page")?
                .is_empty()
        );
    } else {
        return Err("invalid stage".into());
    }
    a.close().await?;
    b.close().await?;
    Ok(())
}
