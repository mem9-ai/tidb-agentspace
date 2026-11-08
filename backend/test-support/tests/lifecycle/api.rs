//! Validate each JSON response against the published operation that served it.
use anyhow::{Context, Result, ensure};
use jsonschema::Validator;
use reqwest::{Method, RequestBuilder};
use serde_json::Value;
use std::{cell::RefCell, collections::BTreeMap};
use workspace_test_support::{provider::NATIVE_SECRET, workspaces::Workspaces};

pub struct Api<'a> {
    pub f: &'a Workspaces,
    documents: [Value; 2],
    validators: RefCell<BTreeMap<(String, String, String), Validator>>,
}
impl<'a> Api<'a> {
    pub fn new(f: &'a Workspaces) -> Result<Self> {
        Ok(Self {
            f,
            documents: [
                serde_json::from_str(include_str!("../../../../public/openapi.json"))?,
                serde_json::from_str(include_str!(
                    "../../../../tools/api-contract/portal-regional-openapi.json"
                ))?,
            ],
            validators: RefCell::new(BTreeMap::new()),
        })
    }
    pub async fn json(
        &self,
        method: Method,
        builder: RequestBuilder,
        status: u16,
    ) -> Result<Value> {
        let r = builder.send().await?;
        let path = r.url().path().to_owned();
        let actual = r.status().as_u16();
        let body: Value = r.json().await?;
        ensure!(
            actual == status,
            "{method} {path}: expected {status}, got {actual} ({})",
            body["error"]["code"]
        );
        assert!(!body.to_string().contains(NATIVE_SECRET));
        self.validate(&method, &path, status, &body)?;
        Ok(body)
    }
    fn validate(&self, method: &Method, path: &str, status: u16, body: &Value) -> Result<()> {
        let method = method.as_str().to_lowercase();
        for document in &self.documents {
            for (pattern, entry) in document["paths"].as_object().unwrap() {
                let Some(op) = entry.get(&method) else {
                    continue;
                };
                let base = entry["servers"][0]["url"]
                    .as_str()
                    .unwrap_or_else(|| document["servers"][0]["url"].as_str().unwrap());
                let full = format!("{}{pattern}", base.trim_end_matches('/'));
                let mut components = path.split('/');
                if !full.split('/').all(|s| {
                    components.next().is_some_and(|c| {
                        c == s || (!c.is_empty() && s.starts_with('{') && s.ends_with('}'))
                    })
                }) || components.next().is_some()
                {
                    continue;
                }
                let exact = status.to_string();
                let (code, response) = op["responses"]
                    .get(&exact)
                    .map(|v| (exact, v))
                    .unwrap_or_else(|| ("default".into(), &op["responses"]["default"]));
                let schema = &response["content"]["application/json"]["schema"];
                if schema.is_null() {
                    return Ok(());
                }
                let key = (method.clone(), full, code);
                let mut validators = self.validators.borrow_mut();
                if !validators.contains_key(&key) {
                    let mut shape = schema.clone();
                    shape["components"] = document["components"].clone();
                    validators.insert(
                        key.clone(),
                        jsonschema::draft202012::options()
                            .should_validate_formats(false)
                            .build(&shape)?,
                    );
                }
                if let Err(e) = validators[&key].validate(body) {
                    anyhow::bail!("Invalid {method} {path} response at {}", e.instance_path());
                }
                return Ok(());
            }
        }
        Ok(())
    }
    pub async fn owner(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        status: u16,
    ) -> Result<Value> {
        let mut req = self.f.owner(0, method.clone(), path);
        if let Some(body) = body {
            req = req.json(body);
        }
        self.json(method, req, status).await
    }
    pub async fn get(&self, path: &str) -> Result<Value> {
        self.owner(Method::GET, path, None, 200).await
    }
    pub async fn post(&self, path: &str, body: &Value, status: u16) -> Result<Value> {
        self.owner(Method::POST, path, Some(body), status).await
    }
    pub async fn agent(
        &self,
        method: Method,
        path: &str,
        token: &str,
        body: Option<&Value>,
        status: u16,
    ) -> Result<Value> {
        let mut req = self.f.agent(0, method.clone(), path, Some(token));
        if let Some(body) = body {
            req = req.json(body);
        }
        self.json(method, req, status).await
    }
    pub async fn token(&self, name: &str, scopes: &[&str], targets: &[&str]) -> Result<String> {
        let key = self.f.create_key(0, name, scopes, targets).await?;
        self.f
            .exchange(0, key["secret"].as_str().context("Missing key")?)
            .await
    }
}
