use super::*;
use sha2::{Digest, Sha256};
use std::os::unix::fs::PermissionsExt;

#[tokio::test]
#[ignore = "requires isolated RustFS and native examples"]
async fn global_key_recovery_and_secret_storage() -> Result<()> {
    let f = Fixture::start().await?;
    let dir = f.directory();
    let mut meta = f.meta("global").await?;
    private_json(&dir.join("global"), &meta.client)?;
    let probe = "global_key_probe";
    let mutation = id();
    let attempts: Vec<_> = (0..8)
        .map(|_| {
            let dir = dir.to_path_buf();
            let mutation = mutation.clone();
            tokio::spawn(async move {
                output(
                    &dir,
                    "global_key_probe",
                    &["global", "create", "current", &mutation],
                )
                .await
            })
        })
        .collect();
    let mut created = 0;
    for attempt in attempts {
        created += usize::from(attempt.await??.status.success());
    }
    assert_eq!(created, 1);
    let original = run(dir, probe, &["global", "check", "current", &id()]).await?;
    assert_eq!(original["keyVersion"], 1);
    assert_eq!(original["workspaceId"], "ws_agentlab");
    let key: Value = serde_json::from_slice(&fs::read(dir.join("current"))?)?;
    let secret = field(&key, "secret");
    let verifier = hex::encode(Sha256::digest(secret.as_bytes()));
    let records=meta.call(json!({"op":"list","scope":{"authorityId":"global","ownerKind":"workspace","ownerId":"ws_agentlab","family":"global-keys","partitionId":"primary"},"prefix":"","after":null,"limit":100})).await?;
    assert!(!records.to_string().contains(secret));
    let keys = records["records"].as_array().unwrap();
    assert!(keys.iter().all(|r| !field(r, "key").contains(&verifier)));
    assert_eq!(
        keys.iter()
            .filter(|r| field(r, "key").starts_with("keys/"))
            .count(),
        1
    );
    restart(&f, &mut meta).await?;
    assert_eq!(
        run(dir, probe, &["global", "check", "current", &id()]).await?,
        original
    );
    run(dir, probe, &["global", "renew", "current", &id()]).await?;
    let renewed = run(dir, probe, &["global", "check", "current", &id()]).await?;
    assert_eq!(renewed["keyVersion"], 2);
    assert_eq!(renewed["keyId"], original["keyId"]);
    assert_eq!(
        renewed["expiresAt"].as_i64().unwrap(),
        original["expiresAt"].as_i64().unwrap() + 600
    );
    fs::copy(dir.join("current"), dir.join("old"))?;
    run(dir, probe, &["global", "rotate", "current", &id()]).await?;
    let rotated = run(dir, probe, &["global", "check", "current", &id()]).await?;
    assert_eq!(rotated["keyVersion"], 3);
    assert_eq!(rotated["keyId"], original["keyId"]);
    reject(dir, probe, &["global", "check", "old", &id()]).await?;
    run(dir, probe, &["global", "revoke", "current", &id()]).await?;
    reject(dir, probe, &["global", "check", "current", &id()]).await
}

#[tokio::test]
#[ignore = "requires isolated RustFS and native examples"]
async fn region_policy_and_refresh_survive_global_loss() -> Result<()> {
    let f = Fixture::start().await?;
    let dir = f.directory();
    let mut global = f.meta("global").await?;
    let mut region = f.meta("other").await?;
    private_json(&dir.join("region"), &region.client)?;
    let key = "regional_key_policy_probe";
    let refresh = "regional_refresh_probe";
    let signed = "policy_command_probe";
    let mut p = policy();
    p["expiresAt"] = json!(4000);
    let mut next = p.clone();
    next["keyVersion"] = 2.into();
    next["policyGeneration"] = 2.into();
    let mutation = id();
    private_json(&dir.join("policy"), &p)?;
    run(dir, key, &["region", "install", "policy", &mutation]).await?;
    run(dir, key, &["region", "install", "policy", &mutation]).await?;
    assert_eq!(
        run(dir, key, &["region", "check", "policy", "2000"]).await?["grantRef"],
        p["grantRef"]
    );
    private_json(&dir.join("wrong"), &{
        let mut wrong = p.clone();
        wrong["workspaceId"] = "ws_other".into();
        wrong
    })?;
    run(
        dir,
        refresh,
        &["region", "enroll", "policy", "current", "1000"],
    )
    .await?;
    assert_eq!(
        fs::metadata(dir.join("current"))?.permissions().mode() & 0o777,
        0o600
    );
    fs::copy(dir.join("current"), dir.join("old"))?;
    reject(
        dir,
        refresh,
        &["region", "check", "wrong", "current", "1000"],
    )
    .await?;
    let mut signed_v1 = p.clone();
    signed_v1["keyId"] = id().into();
    let mut signed_v2 = signed_v1.clone();
    signed_v2["keyVersion"] = 2.into();
    signed_v2["policyGeneration"] = 2.into();
    for (filename, value) in [("v1", &signed_v1), ("v2", &signed_v2)] {
        private_json(&dir.join(format!("{filename}.json")), value)?;
        private_json(&dir.join("sign"), &json!({"policy":value,"commandId":id()}))?;
        run(dir, signed, &["sign", "-", "sign", filename]).await?;
    }
    let mut tampered = fs::read(dir.join("v1"))?;
    tampered.push(b'x');
    private_write(&dir.join("tampered"), &tampered)?;
    global.process.crash()?;
    reject(dir, signed, &["apply", "region", "tampered", "-"]).await?;
    reject(dir, key, &["region", "check", "v1.json", "2000"]).await?;
    run(
        dir,
        refresh,
        &["region", "rotate", "policy", "current", "1010"],
    )
    .await?;
    run(
        dir,
        refresh,
        &["region", "check", "policy", "current", "1010"],
    )
    .await?;
    restart(&f, &mut region).await?;
    run(
        dir,
        refresh,
        &["region", "check", "policy", "current", "1011"],
    )
    .await?;
    run(
        dir,
        refresh,
        &["region", "rotate", "policy", "current", "1020"],
    )
    .await?;
    run(
        dir,
        refresh,
        &["region", "check", "policy", "current", "1020"],
    )
    .await?;
    reject(
        dir,
        refresh,
        &["region", "check", "policy", "current", "4000"],
    )
    .await?;
    reject(dir, refresh, &["region", "rotate", "policy", "old", "1022"]).await?;
    reject(
        dir,
        refresh,
        &["region", "check", "policy", "current", "1022"],
    )
    .await?;
    private_json(&dir.join("next"), &next)?;
    reject(dir, key, &["region", "install", "next", &mutation]).await?;
    run(dir, signed, &["apply", "region", "v1", "-"]).await?;
    assert_eq!(
        run(dir, key, &["region", "check", "v1.json", "2000"]).await?["grantRef"],
        p["grantRef"]
    );
    run(dir, signed, &["apply", "region", "v2", "-"]).await?;
    run(dir, signed, &["apply", "region", "v1", "-"]).await?;
    reject(dir, key, &["region", "check", "v1.json", "2000"]).await?;
    run(dir, key, &["region", "install", "next", &id()]).await?;
    reject(dir, key, &["region", "check", "policy", "2000"]).await?;
    restart(&f, &mut region).await?;
    assert_eq!(
        run(dir, key, &["region", "check", "next", "2000"]).await?["grantRef"],
        p["grantRef"]
    );
    assert_eq!(
        run(dir, key, &["region", "check", "v2.json", "2000"]).await?["grantRef"],
        p["grantRef"]
    );
    reject(dir, key, &["region", "check", "next", "4000"]).await?;
    next["keyVersion"] = 3.into();
    next["policyGeneration"] = 3.into();
    next["revoked"] = true.into();
    private_json(&dir.join("next"), &next)?;
    run(dir, key, &["region", "install", "next", &id()]).await?;
    reject(dir, key, &["region", "check", "next", "2000"]).await
}
