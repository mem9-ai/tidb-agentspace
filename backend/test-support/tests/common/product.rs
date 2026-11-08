use anyhow::{Context, Result, ensure};
use serde_json::json;
use std::{
    process::Command,
    time::{Duration, Instant},
};
use workspace_test_support::{
    Fixture, Meta, Process, binary, http_client, port, private_json, provider::Provider,
};

async fn seed(meta: &Meta) -> Result<()> {
    let now = "2026-01-01T00:00:00Z";
    let values = [
        (
            "state/workspace",
            json!({"id":"ws_agentlab","name":"Fixture workspace","description":"Isolated native integration test","plan":"Free","createdAt":now}),
        ),
        (
            "state/profile",
            json!({"name":"Fixture owner","email":"","role":"Local developer"}),
        ),
        (
            "state/resources/db_memory",
            json!({"position":0,"record":{"id":"db_memory","name":"fixture-postgresql","kind":"postgresql","provider":"db9-anonymous","region":"automatic","status":"active","createdAt":now}}),
        ),
        (
            "state/resources/fs_shared",
            json!({"position":1,"record":{"id":"fs_shared","name":"fixture-files","kind":"filesystem","region":"aws-ap-southeast-1","status":"active","createdAt":now}}),
        ),
        ("state/queryCount", json!(0)),
        (
            "credentials/accounts/db9",
            json!({"state":"ready","anonymousId":"fixture","anonymousSecret":"fixture-account","token":"account-token","expiresAt":4070908800000_i64}),
        ),
        (
            "bindings/db9/db_memory",
            json!({"state":"ready","instanceId":"fixture","credentialRef":"credentials/db9/db_memory"}),
        ),
        (
            "credentials/db9/db_memory",
            json!({"connection":{"kind":"postgresql","region":"automatic","host":"pg.db9.io","port":5432,"user":"tenant.wabcdef123456","password":"fixture-protocol-password","database":"postgres"}}),
        ),
    ];
    let changes: Vec<_> = values
        .into_iter()
        .map(|(key, value)| json!({"key":key,"expectedVersion":null,"value":value}))
        .collect();
    let scope = json!({"authorityId":meta.server["authorityId"],"ownerKind":"workspace","ownerId":"ws_agentlab","family":"workspace","partitionId":"primary"});
    meta.call(json!({"op":"commit","scope":scope,"mutationId":uuid::Uuid::new_v4().to_string(),"changes":changes})).await?;
    Ok(())
}

pub struct Product {
    pub origin: String,
    _process: Process,
    _meta: Meta,
    _storage: Fixture,
    _provider: Provider,
}
impl Product {
    pub async fn start() -> Result<Self> {
        let storage = Fixture::start().await?;
        let meta = storage.meta("contract").await?;
        seed(&meta).await?;
        let provider = Provider::start(false).await?;
        let db9 = &provider.origin;
        let listen = format!("127.0.0.1:{}", port()?);
        let origin = format!("http://{listen}");
        let config = storage.directory().join("workspace.json");
        private_json(
            &config,
            &json!({"bind":listen,"workspaceId":"ws_agentlab","authorityId":meta.server["authorityId"],"insecureLoopback":true,"consoleOrigins":["http://127.0.0.1:5173"],"metadata":{"transport":"remote","client":meta.client},"product":{"providers":{"filesProvider":"local","postgresProvider":"db9-anonymous","testMode":true,"db9Endpoint":format!("{db9}/customer"),"sqlFixture":format!("{db9}/sql")}}}),
        )?;
        let plan = storage.directory().join("plan.json");
        private_json(
            &plan,
            &json!({"format":1,"services":[{"kind":"workspace","configFile":config}]}),
        )?;
        let mut process = Process::spawn(
            Command::new(binary("workspace-backend"))
                .args(["serve", "--config"])
                .arg(&plan),
            &storage.directory().join("workspace.log"),
        )?;
        let end = Instant::now() + Duration::from_secs(20);
        let client = http_client()?;
        loop {
            process.ensure_running().context("workspace startup")?;
            if client
                .get(format!("{origin}/api/health"))
                .send()
                .await
                .is_ok_and(|r| r.status().is_success())
            {
                break;
            }
            ensure!(Instant::now() < end, "workspace startup timed out");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Ok(Self {
            origin,
            _process: process,
            _meta: meta,
            _storage: storage,
            _provider: provider,
        })
    }
}
