//! Signed path-style requests for isolated local RustFS installations.
use anyhow::{Result, ensure};
use axum::http::Request;
use reqwest::{Client, Method, Response, StatusCode, Url};
use sha2::{Digest, Sha256};
use slatedb::object_store::{
    aws::{AwsAuthorizer, AwsCredential},
    client::HttpRequestBody,
};
use std::time::Duration;

pub struct LocalS3 {
    endpoint: Url,
    region: String,
    credentials: AwsCredential,
    client: Client,
}

impl LocalS3 {
    pub fn new(endpoint: &str, region: &str, access_key: &str, secret_key: &str) -> Result<Self> {
        let endpoint = Url::parse(endpoint)?;
        ensure!(
            endpoint.scheme() == "http"
                && matches!(endpoint.host_str(), Some("127.0.0.1" | "[::1]"))
                && endpoint.username().is_empty()
                && endpoint.password().is_none()
                && endpoint.path() == "/"
                && endpoint.query().is_none()
                && endpoint.fragment().is_none(),
            "Local S3 requires a loopback HTTP origin"
        );
        let _ = rustls::crypto::ring::default_provider().install_default();
        Ok(Self {
            endpoint,
            region: region.into(),
            credentials: AwsCredential {
                key_id: access_key.into(),
                secret_key: secret_key.into(),
                token: None,
            },
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(5))
                .build()?,
        })
    }

    pub async fn request(
        &self,
        method: Method,
        path_and_query: &str,
        body: Vec<u8>,
    ) -> Result<Response> {
        let url = self.endpoint.join(path_and_query)?;
        ensure!(
            path_and_query.starts_with('/')
                && url.origin() == self.endpoint.origin()
                && url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none(),
            "Local S3 requests must stay on the configured origin"
        );
        let mut signed = Request::builder()
            .method(method.clone())
            .uri(url.as_str())
            .body(HttpRequestBody::empty())?;
        AwsAuthorizer::new(&self.credentials, "s3", &self.region)
            .try_authorize(&mut signed, Some(&Sha256::digest(&body)))?;
        Ok(self
            .client
            .request(method, url)
            .headers(signed.into_parts().0.headers)
            .body(body)
            .send()
            .await?)
    }

    pub async fn create_bucket(&self, bucket: &str) -> Result<()> {
        ensure!(
            !bucket.is_empty()
                && bucket
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
            "Invalid local bucket name"
        );
        let response = self
            .request(Method::PUT, &format!("/{bucket}"), Vec::new())
            .await?;
        ensure!(
            response.status().is_success() || response.status() == StatusCode::CONFLICT,
            "Local bucket unavailable"
        );
        Ok(())
    }
}
