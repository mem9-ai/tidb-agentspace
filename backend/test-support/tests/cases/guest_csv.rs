use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) struct Saved {
    key: String,
    source: String,
    version: String,
}
fn request(host: &Host, m: Method, path: &str, key: &str) -> RequestBuilder {
    host.client
        .request(m, format!("{}/api/v1/agent-csv/{path}", host.root))
        .header("Host", "studio.example.test")
        .header("Authorization", format!("CsvWorkspace {key}"))
}
const UPDATED: &str = "city,sales\nOakland,40\nAustin,20\n";
impl Saved {
    pub(super) async fn resume(&self, host: &Host) -> Result<()> {
        let get = |path: &str| {
            request(
                host,
                Method::GET,
                &format!("{}{path}", self.source),
                &self.key,
            )
        };
        assert_eq!(status(get("content"), 200).await?.text().await?, UPDATED);
        assert_ne!(
            status(get("metadata"), 200).await?.json::<Value>().await?["data"]["version"],
            self.version
        );
        Ok(())
    }
}
pub(super) async fn exercise(host: &Host, browser: &Guest) -> Result<Saved> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| anyhow::anyhow!("random key"))?;
    let key = hex::encode(bytes);
    let enroll = || request(host, Method::POST, "workspaces", &key);
    status(enroll().header("Cookie", &browser.cookie), 403).await?;
    status(
        enroll()
            .header("Cookie", &browser.cookie)
            .header("Origin", "https://studio.example.test"),
        400,
    )
    .await?;
    status(
        host.client
            .post(format!("{}/api/v1/agent-csv/workspaces", host.root))
            .header("Host", "studio.example.test")
            .header("Authorization", "Trial invalid"),
        401,
    )
    .await?;
    let res = status(enroll(), 200).await?;
    assert!(res.headers().get("set-cookie").is_none());
    let ws = res.json::<Value>().await?;
    assert_eq!(status(enroll(), 200).await?.json::<Value>().await?, ws);
    assert_ne!(ws["workspaceId"], browser.id);
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64;
    assert!((ws["expiresAt"].as_i64().context("expiresAt")? - now - 172800).abs() < 30);
    let ws_id = ws["workspaceId"].as_str().unwrap();
    let source = format!(
        "workspaces/{ws_id}/sources/{}/",
        ws["resourceId"].as_str().unwrap()
    );
    let content = format!("{source}content");
    let metadata = format!("{source}metadata");
    getrandom::fill(&mut bytes).map_err(|_| anyhow::anyhow!("random key"))?;
    for req in [
        request(host, Method::GET, &content, &hex::encode(bytes)),
        request(
            host,
            Method::GET,
            &content.replace(ws_id, &browser.id),
            &key,
        ),
    ] {
        assert!([401, 403].contains(&req.send().await?.status().as_u16()));
    }
    status(request(host, Method::GET, &metadata, &key), 404).await?;
    let put = |s: &'static str| {
        request(host, Method::PUT, &content, &key)
            .header("content-type", "text/csv")
            .body(s)
    };
    let data = "city,sales\nOakland,40\n";
    status(put(data), 428).await?;
    status(put(data).header("If-None-Match", "*"), 200).await?;
    let v = status(request(host, Method::GET, &metadata, &key), 200)
        .await?
        .json::<Value>()
        .await?;
    let version = v["data"]["version"].as_str().context("version")?.to_owned();
    assert!(!version.is_empty());
    assert_eq!(
        status(request(host, Method::GET, &content, &key), 200)
            .await?
            .text()
            .await?,
        data
    );
    status(put("different").header("If-None-Match", "*"), 412).await?;
    status(put("different").header("If-Match", "\"stale\""), 412).await?;
    status(put(UPDATED).header("If-Match", &version), 200).await?;
    status(request(host, Method::DELETE, &content, &key), 404).await?;
    Ok(Saved {
        key,
        source,
        version,
    })
}
