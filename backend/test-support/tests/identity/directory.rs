use super::*;
use sha2::{Digest, Sha256};

const PROBE: &str = "identity_probe";
const ISSUER: &str = "https://issuer.example";

async fn concurrent(f: &Fixture, args: [&'static str; 4], count: usize) -> Result<Value> {
    let mut jobs = tokio::task::JoinSet::new();
    for _ in 0..count {
        let dir = f.directory().to_owned();
        jobs.spawn(async move { run(&dir, PROBE, &args).await });
    }
    let first = jobs.join_next().await.context("empty probe batch")???;
    while let Some(result) = jobs.join_next().await {
        assert_eq!(result??, first);
    }
    Ok(first)
}
async fn due(f: &Fixture, workspace: &str) -> Result<Value> {
    let partition = Sha256::digest(workspace.as_bytes())[0] % 64;
    private_json(
        &f.directory().join("partition"),
        &json!({"regionId":"region:other","partition":partition}),
    )?;
    let result = run(
        f.directory(),
        PROBE,
        &["region", "--cleanup-due", "partition", "-"],
    )
    .await?;
    result["jobs"]
        .as_array()
        .context("jobs")?
        .iter()
        .find(|j| j["workspaceId"] == workspace)
        .cloned()
        .context("missing cleanup job")
}
async fn schedule(f: &Fixture) -> Result<String> {
    let workspace = id();
    let expires = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs()
        - 1;
    let p = json!({"workspaceId":workspace,"organizationId":id(),"userId":id(),"regionId":"region:other","generation":1,"denied":false,
        "identity":{"kind":"guest","guestId":id(),"verifier":"09".repeat(32),"createdAt":expires-86400,"expiresAt":expires}});
    private_json(&f.directory().join("expired"), &p)?;
    for mode in ["--region-install", "--cleanup-enqueue"] {
        run(f.directory(), PROBE, &["region", mode, "expired", &id()]).await?;
    }
    Ok(workspace)
}
#[tokio::test]
#[ignore = "requires isolated RustFS and native examples"]
async fn identity_reservations_and_durable_cleanup() -> Result<()> {
    let f = Fixture::start().await?;
    let dir = f.directory();
    let mut global = f.meta("global").await?;
    let mut region = f.meta("other").await?;
    private_json(&dir.join("global"), &global.client)?;
    private_json(&dir.join("region"), &region.client)?;
    let alice = concurrent(&f, ["global", ISSUER, "alice", "region:other"], 6).await?;
    let bob = run(dir, PROBE, &["global", ISSUER, "bob", "region:other"]).await?;
    let other = run(
        dir,
        PROBE,
        &["global", "https://other.example", "alice", "region:other"],
    )
    .await?;
    for key in ["workspaceId", "userId", "organizationId"] {
        assert_ne!(alice[key], bob[key]);
    }
    assert_ne!(alice["workspaceId"], other["workspaceId"]);
    let a = field(&alice, "workspaceId");
    let mut guests = Vec::new();
    for _ in 0..2 {
        guests.push(
            run(
                dir,
                PROBE,
                &["global", "--guest-create", "region:other", "-"],
            )
            .await?,
        );
    }
    for k in ["workspaceId", "userId", "organizationId"] {
        assert_ne!(guests[0]["registration"][k], guests[1]["registration"][k]);
        assert_ne!(guests[0]["registration"][k], bob[k]);
    }
    reject(
        dir,
        PROBE,
        &[
            "global",
            "--guest-auth",
            field(&guests[0], "guestId"),
            field(&guests[1], "secret"),
        ],
    )
    .await?;
    let charlie = concurrent(&f, ["global", "--onboard-personal", "region", "charlie"], 4).await?;
    let guest = &guests[0];
    private_json(&dir.join("guest"), guest)?;
    let onboarded = run(
        dir,
        PROBE,
        &["global", "--onboard-guest", "region", "guest"],
    )
    .await?;
    let guest_ws = field(&onboarded, "workspaceId");
    let charlie_ws = field(&charlie, "workspaceId");
    assert_eq!(
        onboarded["workspaceId"],
        guest["registration"]["workspaceId"]
    );
    assert_ne!(guest_ws, charlie_ws);
    for ws in [guest_ws, charlie_ws] {
        run(dir, PROBE, &["region", "--workspace-check", ws, "-"]).await?;
    }
    run(
        dir,
        PROBE,
        &["region", "--workspace-isolation", charlie_ws, guest_ws],
    )
    .await?;
    run(dir, PROBE, &["region", "--expired-guest-check", "-", "-"]).await?;
    let p = json!({"workspaceId":a,"organizationId":alice["organizationId"],"userId":alice["userId"],"regionId":"region:other","generation":1,"denied":false,"identity":{"kind":"oidc","issuer":ISSUER,"subject":"alice"}});
    private_json(
        &dir.join("guest-session"),
        &json!({"regionId":"region:other","guestId":guest["guestId"],"secret":guest["secret"]}),
    )?;
    let g = run(
        dir,
        PROBE,
        &["region", "--guest-region-issue", "guest-session", guest_ws],
    )
    .await?;
    assert!(g["accessExpiresAt"].as_i64().unwrap() <= guest["expiresAt"].as_i64().unwrap());
    let save = |file: &str, token: &Value| {
        private_json(
            &dir.join(file),
            &json!({"regionId":"region:other","token":token}),
        )
    };
    save("guest-session", &g["access"])?;
    run(
        dir,
        PROBE,
        &["region", "--region-access", "guest-session", guest_ws],
    )
    .await?;
    reject(
        dir,
        PROBE,
        &["region", "--region-access", "guest-session", charlie_ws],
    )
    .await?;
    let claims = |subject: &str| {
        private_json(
            &dir.join("claims"),
            &json!({"regionId":"region:other","issuer":ISSUER,"subject":subject}),
        )
    };
    private_json(&dir.join("policy"), &p)?;
    claims("alice")?;
    run(dir, PROBE, &["region", "--region-install", "policy", &id()]).await?;
    let auth = ["region", "--region-auth", "claims", a];
    run(dir, PROBE, &auth).await?;
    let creds = run(dir, PROBE, &["region", "--region-issue", "claims", a]).await?;
    save("session", &creds["access"])?;
    let access = ["region", "--region-access", "session", a];
    run(dir, PROBE, &access).await?;
    reject(
        dir,
        PROBE,
        &[
            "region",
            "--region-access",
            "session",
            field(&bob, "workspaceId"),
        ],
    )
    .await?;
    let expired = schedule(&f).await?;
    let status = ["global", "--status", ISSUER, "alice"];
    assert_eq!(run(dir, PROBE, &status).await?["state"], "pending");
    private_json(
        &dir.join("ack"),
        &json!({"issuer":ISSUER,"subject":"alice","registration":alice}),
    )?;
    run(dir, PROBE, &["global", "--region-ready", "ack", &id()]).await?;
    assert_eq!(run(dir, PROBE, &status).await?["state"], "ready");
    let health = global.health().await?;
    global.process.crash()?;
    run(dir, PROBE, &auth).await?;
    let job = due(&f, &expired).await?;
    assert_eq!(job["status"]["state"], "scheduled");
    let input = |job: &Value, attempt: Option<&str>| {
        let mut cmd = json!({"regionId":"region:other","job":job});
        if let Some(attempt) = attempt {
            cmd["attemptId"] = attempt.into();
        }
        private_json(&dir.join("job"), &cmd)
    };
    input(&job, None)?;
    let attempt = id();
    let claim = ["region", "--cleanup-claim", "job", attempt.as_str()];
    let claimed = run(dir, PROBE, &claim).await?;
    restart(&f, &mut region).await?;
    run(dir, PROBE, &auth).await?;
    run(
        dir,
        PROBE,
        &["region", "--region-access", "guest-session", guest_ws],
    )
    .await?;
    reject(dir, PROBE, &claim).await?;
    input(&claimed, Some(&attempt))?;
    run(dir, PROBE, &["region", "--cleanup-complete", "job", &id()]).await?;
    assert_eq!(due(&f, &expired).await?["status"]["state"], "complete");
    let unsupported = schedule(&f).await?;
    run(dir, PROBE, &["region", "--cleanup-scan", "-", "-"]).await?;
    let deferred = due(&f, &unsupported).await?;
    assert_eq!(deferred["status"]["state"], "deferred");
    input(&deferred, Some(field(&deferred["status"], "attemptId")))?;
    reject(dir, PROBE, &["region", "--cleanup-complete", "job", &id()]).await?;
    restart(&f, &mut region).await?;
    let deferred = due(&f, &unsupported).await?;
    assert_eq!(deferred["status"]["state"], "deferred");
    assert_eq!(deferred["status"]["reason"], "providerDeletionUnsupported");
    run(dir, PROBE, &access).await?;
    save("session", &creds["renewal"])?;
    let renewed = run(dir, PROBE, &["region", "--region-renew", "session", a]).await?;
    save("session", &renewed["access"])?;
    run(dir, PROBE, &access).await?;
    claims("bob")?;
    reject(dir, PROBE, &auth).await?;
    let _restored = f
        .start_meta(
            global.server.clone(),
            false,
            Some(field(&health, "ownerId")),
        )
        .await?;
    assert_eq!(
        run(dir, PROBE, &["global", ISSUER, "alice", "region:b"]).await?,
        alice
    );
    assert_eq!(run(dir, PROBE, &status).await?["state"], "ready");
    for guest in &guests {
        assert_eq!(
            run(
                dir,
                PROBE,
                &[
                    "global",
                    "--guest-auth",
                    field(guest, "guestId"),
                    field(guest, "secret")
                ]
            )
            .await?,
            guest["registration"]
        );
    }
    reject(dir, PROBE, &["region", ISSUER, "mallory", "region:other"]).await
}
