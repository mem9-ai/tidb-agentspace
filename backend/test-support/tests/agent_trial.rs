use anyhow::{Result, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use reqwest::{Method, RequestBuilder, header::HeaderMap};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use workspace_test_support::workspaces::{REGION, Workspaces};

fn identity() -> Ed25519KeyPair {
    let k = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
    Ed25519KeyPair::from_pkcs8(k.as_ref()).unwrap()
}
fn grant(keys: &Ed25519KeyPair, id: &str, exp: i64) -> String {
    let s = keys.sign(format!("drive9/trial/report-view/v1\n{id}\n{exp}").as_bytes());
    format!(
        "v1.{}.{id}.{exp}.{}",
        B64.encode(keys.public_key()),
        B64.encode(s)
    )
}
struct Trial {
    f: Workspaces,
    api: Value,
}
impl Trial {
    fn req(&self, method: Method, route: &str) -> RequestBuilder {
        self.f
            .at(0, method, &format!("/api/v1/agent-trial/{route}"), false)
    }
    async fn call(&self, req: RequestBuilder, status: u16) -> Result<(Value, HeaderMap)> {
        let original = req.try_clone().unwrap().build()?;
        let path = original.url().path().strip_prefix("/api/v1").unwrap();
        let method = original.method().as_str().to_lowercase();
        let r = req.send().await?;
        let actual = r.status().as_u16();
        let headers = r.headers().clone();
        let body = r.json::<Value>().await?;
        ensure!(
            actual == status,
            "{} {} expected {status} got {actual}: {}",
            method,
            path,
            body["error"]["code"]
        );
        let op = &self.api["paths"][path][method.as_str()];
        let docs = op["responses"]
            .get(status.to_string())
            .unwrap_or(&op["responses"]["default"]);
        if let Some(schema) = docs.pointer("/content/application~1json/schema") {
            let mut schema = schema.clone();
            schema["components"] = self.api["components"].clone();
            let validator = jsonschema::draft202012::options()
                .should_validate_formats(false)
                .build(&schema)?;
            ensure!(
                validator.is_valid(&body),
                "{method} {path} violates OpenAPI response schema"
            );
        }
        Ok((body, headers))
    }
    async fn proof(&self, keys: &Ed25519KeyPair, enroll: bool) -> Result<Value> {
        let (challenge, _) = self
            .call(self.req(Method::POST, "challenges").json(&json!({})), 200)
            .await?;
        let c = challenge["challenge"].as_str().unwrap();
        let purpose = if enroll { "start" } else { "resume" };
        let signature = keys.sign(format!("drive9/trial/v1\n{c}\n{purpose}").as_bytes());
        Ok(
            json!({"publicKey":B64.encode(keys.public_key()),"challenge":c,"enroll":enroll,"signature":B64.encode(signature)}),
        )
    }
    async fn session(&self, proof: &Value, status: u16) -> Result<Value> {
        Ok(self
            .call(self.req(Method::POST, "sessions").json(proof), status)
            .await?
            .0)
    }
    fn view(&self, grant: &str) -> RequestBuilder {
        self.req(Method::GET, "report-view")
            .header("Authorization", format!("TrialView {grant}"))
    }
    fn authenticated(&self, method: Method, path: &str, token: &str) -> RequestBuilder {
        self.req(method, path)
            .header("Authorization", format!("Trial {token}"))
    }
    fn update(&self, token: &str, v: u32, section: &str) -> RequestBuilder {
        self.authenticated(Method::PUT, "report", token)
            .header("If-Match", format!("\"{v}\""))
            .json(&json!({"section":section}))
    }
}
#[tokio::test]
#[ignore = "requires isolated RustFS and built native binaries"]
async fn public_report_proofs_isolation_expiry_and_persistence() -> Result<()> {
    let mut t = Trial {
        f: Workspaces::start(false, false).await?,
        api: serde_json::from_str(include_str!("../../../public/openapi.json"))?,
    };
    let a = identity();
    let b = identity();
    let csv = t.req(Method::GET, "us-sales-v1.csv").send().await?;
    assert_eq!(csv.status(), 200);
    assert_eq!(
        csv.bytes().await?.as_ref(),
        include_bytes!("../../../specs/gh-150/fixtures/us-sales.csv")
    );
    let enrollment = t.proof(&a, true).await?;
    let mut bad = enrollment.clone();
    bad["publicKey"] = json!(B64.encode(b.public_key()));
    t.session(&bad, 401).await?;
    let first = t.session(&enrollment, 200).await?;
    let token = first["token"].as_str().unwrap();
    let report = &first["report"];
    let id = report["id"].as_str().unwrap();
    let exp = report["expiresAt"].as_i64().unwrap();
    let g = grant(&a, id, exp);
    for (view, status) in [
        (&g[..], 404),
        (id, 401),
        (&g.replacen("v1.", "v2.", 1), 401),
        (&g.replace(id, &id.chars().rev().collect::<String>()), 401),
        (&grant(&a, id, exp + 1), 403),
    ] {
        t.call(t.view(view), status).await?;
    }
    for (method, path) in [
        (Method::PUT, "report"),
        (Method::GET, "report"),
        (Method::DELETE, "report-sharing"),
    ] {
        let mut r = t
            .req(method.clone(), path)
            .header("Authorization", format!("TrialView {g}"));
        if method == Method::PUT {
            r = r
                .header("If-Match", "\"0\"")
                .json(&json!({"section":"states"}));
        }
        t.call(r, 401).await?;
    }
    t.call(t.view(&g).header("Cookie", "browser=example"), 400)
        .await?;
    t.call(
        t.req(Method::GET, "report-view?test=1")
            .header("Authorization", format!("TrialView {g}")),
        400,
    )
    .await?;
    t.call(
        t.req(Method::PUT, "report-view")
            .header("Authorization", format!("TrialView {g}")),
        404,
    )
    .await?;
    let workspace = |t: &Trial, auth: String| {
        t.f.at(
            0,
            Method::GET,
            "/api/v1/workspaces/ws_agentlab/resources",
            false,
        )
        .header("Authorization", auth)
    };
    assert!(
        [401, 403].contains(
            &workspace(&t, format!("TrialView {g}"))
                .send()
                .await?
                .status()
                .as_u16()
        )
    );
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64;
    assert!((exp - now - 48 * 3600).abs() < 10);
    t.session(&enrollment, 401).await?;
    t.call(t.req(Method::GET, "report"), 401).await?;
    t.call(t.update(token, 0, "products"), 409).await?;
    let (rev1, h) = t.call(t.update(token, 0, "states"), 200).await?;
    let (view, vh) = t.call(t.view(&g), 200).await?;
    assert_eq!(view, rev1);
    assert_eq!(vh["cache-control"], "no-store");
    assert_eq!(h["etag"], "\"1\"");
    assert_eq!(rev1["stateSales"]["California"], 48000);
    t.call(t.update(token, 0, "states"), 412).await?;
    assert!(
        [401, 403].contains(
            &workspace(&t, format!("Trial {token}"))
                .send()
                .await?
                .status()
                .as_u16()
        )
    );
    t.session(&t.proof(&b, false).await?, 404).await?;
    let other = t.session(&t.proof(&b, true).await?, 200).await?;
    assert_ne!(other["report"]["id"], id);
    assert_eq!(other["report"]["revision"], 0);
    t.call(t.view(&grant(&b, id, exp)), 403).await?;
    let mut wrong_domain = t.proof(&a, false).await?;
    wrong_domain["signature"] = json!(g.split('.').next_back().unwrap());
    t.session(&wrong_domain, 401).await?;
    t.f.restart(false).await?;
    t.call(t.authenticated(Method::GET, "report", token), 401)
        .await?;
    let resumed = t.session(&t.proof(&a, false).await?, 200).await?;
    assert_eq!(resumed["report"]["id"], id);
    assert_eq!(resumed["report"]["expiresAt"], exp);
    let token = resumed["token"].as_str().unwrap();
    let (rev2, _) = t.call(t.update(token, 1, "products"), 200).await?;
    assert_eq!(rev2["revision"], 2);
    assert_eq!(rev2["leadingStateProducts"]["Monitors"], 18000);
    assert_eq!(
        t.call(t.authenticated(Method::GET, "report", token), 200)
            .await?
            .0,
        rev2
    );
    assert_eq!(t.call(t.view(&g), 200).await?.0, rev2);
    assert_eq!(
        t.call(t.update(token, 2, "states"), 200).await?.0["revision"],
        2
    );
    for marker in [
        "# US sales report",
        "Source: us-sales.csv",
        "$68,000.00 / $100,000.00 = 68.0%",
    ] {
        assert!(rev2["markdown"].as_str().unwrap().contains(marker));
    }
    let other = t.session(&t.proof(&b, false).await?, 200).await?;
    t.call(
        t.authenticated(
            Method::DELETE,
            "report-sharing",
            other["token"].as_str().unwrap(),
        ),
        200,
    )
    .await?;
    t.call(t.view(&g), 200).await?;
    let (revoked, _) = t
        .call(
            t.authenticated(Method::DELETE, "report-sharing", token),
            200,
        )
        .await?;
    assert_eq!(revoked["sharingRevoked"], true);
    assert_eq!(revoked["markdown"], rev2["markdown"]);
    assert_eq!(revoked["expiresAt"], exp);
    assert_eq!(
        t.call(
            t.authenticated(Method::DELETE, "report-sharing", token),
            200
        )
        .await?
        .0,
        revoked
    );
    t.f.restart(false).await?;
    assert_eq!(
        t.call(t.view(&g), 410).await?.0["error"]["code"],
        "REPORT_SHARING_REVOKED"
    );
    let last = t.session(&t.proof(&a, false).await?, 200).await?;
    assert_eq!(last["report"]["sharingRevoked"], true);
    let token = last["token"].as_str().unwrap();
    assert_eq!(
        t.call(t.update(token, 2, "states"), 200).await?.0["sharingRevoked"],
        true
    );
    let public = enrollment["publicKey"].as_str().unwrap();
    let scope = json!({"authorityId":REGION,"ownerKind":"system","ownerId":"agent-trials","family":"sample-reports","partitionId":"v1"});
    let k = format!(
        "reports/{}",
        &hex::encode(Sha256::digest(public.as_bytes()))[..2]
    );
    let records =
        t.f.region
            .call(json!({"op":"get","scope":scope,"keys":[k]}))
            .await?;
    let mut value = records["records"][&k]["value"].clone();
    value[public]["expiresAt"] = json!(now - 1);
    t.f.region.call(json!({"op":"commit","scope":scope,"mutationId":uuid::Uuid::new_v4().to_string(),"changes":[{"key":k,"value":value,"expectedVersion":records["records"][&k]["version"]}]})).await?;
    t.call(t.view(&g), 410).await?;
    t.call(t.view(&grant(&a, id, 1)), 410).await?;
    t.call(t.authenticated(Method::GET, "report", token), 410)
        .await?;
    t.session(&t.proof(&a, false).await?, 410).await?;
    Ok(())
}
