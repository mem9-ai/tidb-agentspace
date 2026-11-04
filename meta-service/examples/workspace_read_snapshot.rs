use serde_json::{Value, json};
use std::path::Path;
use uuid::Uuid;
use workspace_contracts::{MetaRead, MetaRequest, Metadata, Scope, WriterGuard};
use workspace_meta_service::{config::Config, server::MetaService};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let path = std::env::args().nth(1).expect("private fixture config");
    let config = Config::load(Path::new(&path))?;
    let service = MetaService::open(config.clone(), false, None).await?;
    let authority = service.health().await?["authorityId"]
        .as_str()
        .unwrap()
        .to_owned();
    let workspace = Scope {
        authority_id: authority,
        owner_kind: "workspace".into(),
        owner_id: "snapshot-test".into(),
        family: "workspace".into(),
        partition_id: "primary".into(),
    };
    let mut policy = workspace.clone();
    policy.family = "regional-policy".into();
    let guard = WriterGuard {
        owner_id: "writer-a".into(),
    };
    async fn commit(
        service: &MetaService,
        scope: Scope,
        guard: Option<WriterGuard>,
        changes: Vec<Value>,
    ) -> anyhow::Result<Value> {
        Ok(service
            .execute(MetaRequest::Commit {
                scope,
                guard,
                mutation_id: Uuid::new_v4().to_string(),
                changes,
            })
            .await?)
    }
    commit(
        &service,
        workspace.clone(),
        None,
        vec![json!({"key":"system/writer","expectedVersion":null,"value":{"ownerId":"writer-a"}})],
    )
    .await?;
    commit(&service, workspace.clone(), Some(guard.clone()), vec![json!({"key":"ownership/onboarding","expectedVersion":null,"value":{"userId":"owner-a"}})]).await?;
    let policy_version = commit(
        &service,
        policy.clone(),
        None,
        vec![json!({"key":"owner-policy","expectedVersion":null,"value":{"denied":false}})],
    )
    .await?["version"]
        .clone();
    let reads = vec![
        MetaRead {
            scope: workspace.clone(),
            guard: Some(guard),
            keys: vec!["ownership/onboarding".into()],
        },
        MetaRead {
            scope: policy.clone(),
            guard: None,
            keys: vec!["owner-policy".into()],
        },
    ];
    let result = service.read_workspace_scopes(reads.clone()).await?;
    assert_eq!(
        result["results"][0]["records"]["ownership/onboarding"]["value"]["userId"],
        "owner-a"
    );
    assert_eq!(
        result["results"][1]["records"]["owner-policy"]["value"]["denied"],
        false
    );
    commit(
        &service,
        policy,
        None,
        vec![
            json!({"key":"owner-policy","expectedVersion":policy_version,"value":{"denied":true}}),
        ],
    )
    .await?;
    let revoked = service.read_workspace_scopes(reads.clone()).await?;
    assert_eq!(
        revoked["results"][1]["records"]["owner-policy"]["value"]["denied"],
        true
    );
    let mut wrong_writer = reads.clone();
    wrong_writer[0].guard = Some(WriterGuard {
        owner_id: "other-writer".into(),
    });
    assert_eq!(
        service
            .read_workspace_scopes(wrong_writer)
            .await
            .err()
            .unwrap()
            .code,
        "META_WRITER_FENCED"
    );
    let mut other_workspace = reads.clone();
    other_workspace[1].scope.owner_id = "another-workspace".into();
    assert_eq!(
        service
            .read_workspace_scopes(other_workspace)
            .await
            .err()
            .unwrap()
            .code,
        "META_INVALID_REQUEST"
    );
    let mut invalid_key = reads.clone();
    invalid_key[1].keys = vec!["../bad key".into()];
    assert_eq!(
        service
            .read_workspace_scopes(invalid_key)
            .await
            .err()
            .unwrap()
            .code,
        "META_INVALID_REQUEST"
    );
    let displaced_owner = service.health().await?["ownerId"]
        .as_str()
        .unwrap()
        .to_owned();
    let replacement = MetaService::open(config, false, Some(&displaced_owner)).await?;
    assert_eq!(
        service
            .read_workspace_scopes(reads)
            .await
            .err()
            .unwrap()
            .code,
        "META_OWNER_FENCED"
    );
    replacement.close().await?;
    let _ = service.close().await;
    Ok(())
}
