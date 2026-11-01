//! Isolated integration fixture only; never used as a hosted cleanup command.
use serde_json::json;
use std::sync::Arc;
use uuid::Uuid;
use workspace_domain::Repository;
use workspace_identity::{
    cleanup::{Job, Queue, Status},
    regional::{OwnerIdentity, Policies, Policy},
};
use workspace_meta_client::{ClientConfig, RemoteMetadata};
use workspace_providers::{Config, Providers};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    anyhow::ensure!(
        args.len() == 3,
        "expected private regional fixture config and provider fixture origin"
    );
    let config: ClientConfig = serde_json::from_slice(&std::fs::read(&args[1])?)?;
    let authority = config.authority_id.clone();
    let meta = Arc::new(RemoteMetadata::connect(config).await?);
    let workspace = Uuid::new_v4().to_string();
    let other_workspace = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();
    let guest_id = Uuid::new_v4().to_string();
    let policy = Policy {
        workspace_id: workspace.clone(),
        organization_id: Uuid::new_v4().to_string(),
        user_id: Uuid::new_v4().to_string(),
        region_id: authority.clone(),
        generation: 1,
        denied: false,
        identity: OwnerIdentity::Guest {
            guest_id: guest_id.clone(),
            verifier: "09".repeat(32),
            created_at: now - 86_401,
            expires_at: now - 1,
        },
    };
    Policies::open(meta.clone(), &authority)
        .await?
        .install(&policy, &Uuid::new_v4().to_string())
        .await?;
    let queue = Queue::open(meta.clone(), &authority).await?;
    queue.enqueue(&policy, &Uuid::new_v4().to_string()).await?;
    let job = Job {
        workspace_id: workspace.clone(),
        guest_id,
        expires_at: now - 1,
        status: Status::Scheduled,
    };
    let attempt = Uuid::new_v4().to_string();
    let claimed = queue.claim(&job, &attempt).await?;
    let repo = Arc::new(Repository::open(meta.clone(), &authority, &workspace, true, None).await?);
    let other = Arc::new(Repository::open(meta, &authority, &other_workspace, true, None).await?);
    for repository in [&repo, &other] {
        for id in [
            "cross",
            "wrong_target",
            "bad_path",
            "no_account",
            "valid",
            "lost",
        ] {
            repository.transaction(|state| {
                state["resources"].as_array_mut().ok_or_else(||workspace_providers::err(503,"TEST_STATE"))?
                    .push(json!({"id":id,"name":id,"status":"active","kind":"postgresql","provider":"db9-anonymous","region":"automatic"}));
                Ok(((),true))
            }).await?;
        }
        for (id, target) in [
            ("cross", "db_guest"),
            ("wrong_target", "db_guest"),
            ("bad_path", "../db_other"),
            ("no_account", "db_guest"),
            ("valid", "db_guest"),
            ("lost", "db_lost"),
        ] {
            repository
                .save_binding("db9", id, json!({"state":"ready","instanceId":target}))
                .await?;
        }
        repository
            .save_account(
                "db9",
                json!({"state":"ready","token":"test-only-token","expiresAt":4102444800000i64,
            "anonymousId":"test-account","anonymousSecret":"test-only-secret"}),
            )
            .await?;
    }
    let config = Config {
        test_mode: true,
        db9_endpoint: Some(format!("{}/customer", args[2])),
        drive9_endpoint: Some(args[2].clone()),
        ..Default::default()
    };
    let provider = Providers::new(config.clone(), repo.clone())?;
    let wrong_workspace = Providers::new(config, other.clone())?;
    let permit = queue
        .begin_resource(
            &claimed,
            &attempt,
            "cross",
            "db9-anonymous",
            "db_guest",
            &Uuid::new_v4().to_string(),
        )
        .await?;
    anyhow::ensure!(
        wrong_workspace
            .delete_expired_guest_db9(&queue, permit)
            .await
            .err()
            .is_some_and(|e| e.code == "CLEANUP_SCOPE_MISMATCH"),
        "cross-workspace deletion was not rejected"
    );
    let permit = queue
        .begin_resource(
            &claimed,
            &attempt,
            "wrong_target",
            "db9-anonymous",
            "db_other",
            &Uuid::new_v4().to_string(),
        )
        .await?;
    anyhow::ensure!(
        provider
            .delete_expired_guest_db9(&queue, permit)
            .await
            .err()
            .is_some_and(|e| e.code == "CLEANUP_TARGET_MISMATCH"),
        "different target was not rejected"
    );
    anyhow::ensure!(
        queue
            .begin_resource(
                &claimed,
                &attempt,
                "bad_path",
                "db9-anonymous",
                "../db_other",
                &Uuid::new_v4().to_string(),
            )
            .await
            .err()
            .is_some_and(|e| e.code == "INVALID_CLEANUP_TARGET"),
        "unsafe target path was not rejected"
    );
    repo.save_account("db9", serde_json::Value::Null).await?;
    let permit = queue
        .begin_resource(
            &claimed,
            &attempt,
            "no_account",
            "db9-anonymous",
            "db_guest",
            &Uuid::new_v4().to_string(),
        )
        .await?;
    anyhow::ensure!(
        provider
            .delete_expired_guest_db9(&queue, permit)
            .await
            .err()
            .is_some_and(|e| e.code == "CLEANUP_ACCOUNT_MISSING"),
        "missing account was not rejected"
    );
    repo.save_account(
        "db9",
        json!({"state":"ready","token":"test-only-token","expiresAt":4102444800000i64,
            "anonymousId":"test-account","anonymousSecret":"test-only-secret"}),
    )
    .await?;
    let permit = queue
        .begin_resource(
            &claimed,
            &attempt,
            "valid",
            "db9-anonymous",
            "db_guest",
            &Uuid::new_v4().to_string(),
        )
        .await?;
    provider.delete_expired_guest_db9(&queue, permit).await?;
    anyhow::ensure!(
        queue
            .begin_resource(
                &claimed,
                &attempt,
                "valid",
                "db9-anonymous",
                "db_guest",
                &Uuid::new_v4().to_string()
            )
            .await
            .err()
            .is_some_and(|e| e.code == "CLEANUP_EFFECT_REQUIRES_RECONCILIATION"),
        "repeat deletion was not rejected"
    );
    let permit = queue
        .begin_resource(
            &claimed,
            &attempt,
            "lost",
            "db9-anonymous",
            "db_lost",
            &Uuid::new_v4().to_string(),
        )
        .await?;
    anyhow::ensure!(
        provider
            .delete_expired_guest_db9(&queue, permit)
            .await
            .err()
            .is_some_and(|e| e.code == "CLEANUP_DELETE_UNCONFIRMED"),
        "lost response was not left uncertain"
    );
    anyhow::ensure!(
        queue
            .begin_resource(
                &claimed,
                &attempt,
                "lost",
                "db9-anonymous",
                "db_lost",
                &Uuid::new_v4().to_string()
            )
            .await
            .err()
            .is_some_and(|e| e.code == "CLEANUP_EFFECT_REQUIRES_RECONCILIATION"),
        "uncertain deletion was retried"
    );
    for (id, kind, provider) in [
        ("file_guest", "filesystem", "drive9-anonymous"),
        ("file_wrong", "filesystem", "drive9-anonymous"),
        ("duck_guest", "duckdb", "duckdb-drive9"),
    ] {
        repo.transaction(|state| {
            state["resources"].as_array_mut()
                .ok_or_else(|| workspace_providers::err(503, "TEST_STATE"))?
                .push(json!({"id":id,"name":id,"status":"active","kind":kind,"provider":provider,"region":"aws-ap-southeast-1"}));
            Ok(((), true))
        }).await?;
    }
    for id in ["file_guest", "file_wrong", "duck_storage"] {
        repo.save_binding(
            "drive9",
            id,
            json!({"apiKey":"test-file-token","tenantId":format!("tenant_{id}")}),
        )
        .await?;
    }
    repo.save_binding("duckdb", "duck_guest", json!({"storageId":"duck_storage"}))
        .await?;
    let wrong = queue
        .begin_resource(
            &claimed,
            &attempt,
            "file_wrong",
            "drive9-anonymous",
            "tenant_wrong",
            &Uuid::new_v4().to_string(),
        )
        .await?;
    anyhow::ensure!(
        provider
            .delete_guest_drive9(&queue, wrong)
            .await
            .err()
            .is_some_and(|e| e.code == "CLEANUP_TARGET_MISMATCH"),
        "Drive9 target mismatch was not rejected"
    );
    for (id, target) in [
        ("file_guest", "tenant_file_guest"),
        ("duck_guest", "tenant_duck_storage"),
    ] {
        let permit = queue
            .begin_resource(
                &claimed,
                &attempt,
                id,
                "drive9-anonymous",
                target,
                &Uuid::new_v4().to_string(),
            )
            .await?;
        provider.delete_guest_drive9(&queue, permit).await?;
    }
    repo.close().await?;
    other.close().await?;
    println!("{{\"verified\":true}}");
    Ok(())
}
