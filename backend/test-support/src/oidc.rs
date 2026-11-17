//! An ephemeral public OIDC client fixture with single-use authorization codes and S256 PKCE.
use anyhow::{Result, ensure};
use axum::{
    Form, Json, Router,
    body::{Body, Bytes},
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode, jwk::Jwk};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    convert::Infallible,
    process::Command,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

struct Flow {
    challenge: String,
    nonce: String,
    redirect_uri: String,
    claims: Value,
    bad_signature: bool,
}

struct Control {
    redirects: Vec<String>,
    discovery_issuer: Option<String>,
    flows: HashMap<String, Flow>,
    claims: Value,
    bad_signature: bool,
    raft_secret: Option<String>,
    tokens: HashMap<String, Value>,
    userinfo_status: u16,
}

struct Identity {
    issuer: String,
    client_id: String,
    key: EncodingKey,
    wrong_key: EncodingKey,
    jwk: Value,
    raft_key: EncodingKey,
    wrong_raft_key: EncodingKey,
    raft_jwk: Value,
    control: Mutex<Control>,
    closing: CancellationToken,
}

pub struct Provider {
    pub issuer: String,
    identity: Arc<Identity>,
    task: Option<JoinHandle<std::io::Result<()>>>,
}

fn key(ec: bool) -> Result<EncodingKey> {
    let command = Command::new("openssl")
        .args([
            "genpkey",
            "-outform",
            if ec { "PEM" } else { "DER" },
            "-algorithm",
        ])
        .args(if ec {
            ["EC", "-pkeyopt", "ec_paramgen_curve:P-256"]
        } else {
            ["RSA", "-pkeyopt", "rsa_keygen_bits:2048"]
        })
        .output()?;
    ensure!(
        command.status.success(),
        "Cannot generate a temporary OIDC key"
    );
    Ok(if ec {
        let pem = std::str::from_utf8(&command.stdout)?;
        let body = pem
            .lines()
            .filter(|line| !line.starts_with('-'))
            .collect::<String>();
        let der = base64::engine::general_purpose::STANDARD.decode(body)?;
        EncodingKey::from_ec_der(&der)
    } else {
        EncodingKey::from_rsa_der(&command.stdout)
    })
}

impl Provider {
    pub async fn start(client_id: &str, redirect_uri: &str) -> Result<Self> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let issuer = format!("http://{}", listener.local_addr()?);
        let signing_key = key(false)?;
        let mut jwk =
            serde_json::to_value(Jwk::from_encoding_key(&signing_key, Algorithm::RS256)?)?;
        jwk["kid"] = json!("fixture");
        jwk["use"] = json!("sig");
        let raft_key = key(true)?;
        let mut raft_jwk =
            serde_json::to_value(Jwk::from_encoding_key(&raft_key, Algorithm::ES256)?)?;
        raft_jwk["kid"] = json!("raft-fixture");
        raft_jwk["use"] = json!("sig");
        let identity = Arc::new(Identity {
            issuer: issuer.clone(),
            client_id: client_id.into(),
            key: signing_key,
            wrong_key: key(false)?,
            jwk,
            raft_key,
            wrong_raft_key: key(true)?,
            raft_jwk,
            control: Mutex::new(Control {
                redirects: vec![redirect_uri.into()],
                discovery_issuer: None,
                flows: HashMap::new(),
                claims: json!({}),
                bad_signature: false,
                raft_secret: None,
                tokens: HashMap::new(),
                userinfo_status: 200,
            }),
            closing: CancellationToken::new(),
        });
        let router = Router::new()
            .route("/.well-known/openid-configuration", get(discovery))
            .route(
                "/jwks",
                get(async |State(s): State<Arc<Identity>>| {
                    Json(json!({"keys":[s.jwk,s.raft_jwk]}))
                }),
            )
            .route("/authorize", get(authorize))
            .route("/token", post(token))
            .route("/userinfo", get(userinfo))
            .route("/fixture-held-connection", get(held_connection))
            .with_state(identity.clone());
        let closing = identity.closing.clone();
        let task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(closing.cancelled_owned())
                .await
        });
        Ok(Self {
            issuer,
            identity,
            task: Some(task),
        })
    }

    pub fn raft_mode(&self, secret: &str) {
        self.identity.control.lock().unwrap().raft_secret = Some(secret.into());
    }
    pub fn userinfo_status(&self, status: u16) {
        self.identity.control.lock().unwrap().userinfo_status = status;
    }
    pub fn agent_code(&self, redirect: &str) -> String {
        let mut control = self.identity.control.lock().unwrap();
        assert!(control.raft_secret.is_some() && control.redirects.iter().any(|r| r == redirect));
        let code = Uuid::new_v4().to_string();
        let claims = control.claims.clone();
        control.flows.insert(
            code.clone(),
            Flow {
                challenge: String::new(),
                nonce: String::new(),
                redirect_uri: redirect.into(),
                claims,
                bad_signature: false,
            },
        );
        code
    }
    pub fn allow_redirect(&self, value: &str) {
        self.identity
            .control
            .lock()
            .unwrap()
            .redirects
            .push(value.into());
    }
    pub fn subject(&self, value: &str) {
        self.identity.control.lock().unwrap().claims["sub"] = json!(value);
    }
    pub fn claims(&self, value: Value) {
        self.identity.control.lock().unwrap().claims = value;
    }
    pub fn bad_signature(&self, value: bool) {
        self.identity.control.lock().unwrap().bad_signature = value;
    }
    pub fn discovery_issuer(&self, value: Option<String>) {
        self.identity.control.lock().unwrap().discovery_issuer = value;
    }
    pub async fn close(&mut self) -> Result<()> {
        self.identity.closing.cancel();
        if let Some(task) = self.task.take() {
            task.await??;
        }
        Ok(())
    }
}

impl Drop for Provider {
    fn drop(&mut self) {
        self.identity.closing.cancel();
    }
}

async fn held_connection(State(id): State<Arc<Identity>>) -> Response {
    // Emit headers immediately. Close the held body as part of fixture shutdown.
    let chunks = futures::stream::once(async move {
        id.closing.cancelled().await;
        Ok::<Bytes, Infallible>(Bytes::new())
    });
    Response::new(Body::from_stream(chunks))
}

async fn discovery(State(id): State<Arc<Identity>>) -> Json<Value> {
    let issuer = id
        .control
        .lock()
        .unwrap()
        .discovery_issuer
        .clone()
        .unwrap_or_else(|| id.issuer.clone());
    Json(
        json!({"issuer":issuer,"authorization_endpoint":format!("{}/authorize",id.issuer),
        "token_endpoint":format!("{}/token",id.issuer),"jwks_uri":format!("{}/jwks",id.issuer),"userinfo_endpoint":format!("{}/userinfo",id.issuer)}),
    )
}

type Fields = HashMap<String, String>;

async fn authorize(
    State(id): State<Arc<Identity>>,
    Query(q): Query<Fields>,
) -> Result<Json<Value>, StatusCode> {
    let mut control = id.control.lock().unwrap();
    let redirect_uri = q
        .get("redirect_uri")
        .filter(|s| control.redirects.contains(s))
        .ok_or(StatusCode::BAD_REQUEST)?
        .clone();
    if q.get("client_id") != Some(&id.client_id)
        || q.get("code_challenge_method").map(String::as_str) != Some("S256")
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let code = Uuid::new_v4().to_string();
    let flow = Flow {
        redirect_uri,
        challenge: q
            .get("code_challenge")
            .ok_or(StatusCode::BAD_REQUEST)?
            .clone(),
        nonce: q.get("nonce").ok_or(StatusCode::BAD_REQUEST)?.clone(),
        claims: control.claims.clone(),
        bad_signature: control.bad_signature,
    };
    control.flows.insert(code.clone(), flow);
    Ok(Json(json!({"code":code})))
}

async fn token(
    State(id): State<Arc<Identity>>,
    headers: HeaderMap,
    Form(q): Form<Fields>,
) -> Result<Json<Value>, StatusCode> {
    let flow = id
        .control
        .lock()
        .unwrap()
        .flows
        .remove(q.get("code").ok_or(StatusCode::BAD_REQUEST)?)
        .ok_or(StatusCode::BAD_REQUEST)?;
    let control = id.control.lock().unwrap();
    let confidential = if let Some(secret) = &control.raft_secret {
        use base64::engine::general_purpose::STANDARD;
        headers.get("authorization").and_then(|v| v.to_str().ok())
            == Some(
                format!(
                    "Basic {}",
                    STANDARD.encode(format!("{}:{secret}", id.client_id))
                )
                .as_str(),
            )
    } else {
        !headers.contains_key("authorization") && q.get("client_id") == Some(&id.client_id)
    };
    drop(control);
    let valid_pkce = if flow.challenge.is_empty() {
        !q.contains_key("code_verifier")
    } else {
        q.get("code_verifier")
            .is_some_and(|v| URL_SAFE_NO_PAD.encode(Sha256::digest(v.as_bytes())) == flow.challenge)
    };
    if !confidential
        || !valid_pkce
        || q.contains_key("client_secret")
        || q.get("grant_type").map(String::as_str) != Some("authorization_code")
        || q.get("redirect_uri") != Some(&flow.redirect_uri)
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut claims = json!({"iss":id.issuer,"sub":"alice","aud":id.client_id,"exp":now+300,"iat":now,"nonce":flow.nonce,"org_id":"org-a"});
    claims
        .as_object_mut()
        .unwrap()
        .extend(flow.claims.as_object().unwrap().clone());
    let raft = id.control.lock().unwrap().raft_secret.is_some();
    // Public OIDC does not require a kind claim in the ID token; userinfo proves kind.
    if raft {
        claims.as_object_mut().unwrap().remove("type");
    }
    let mut header = Header::new(if raft {
        Algorithm::ES256
    } else {
        Algorithm::RS256
    });
    header.kid = Some(if raft { "raft-fixture" } else { "fixture" }.into());
    let token = encode(
        &header,
        &claims,
        if raft && flow.bad_signature {
            &id.wrong_raft_key
        } else if raft {
            &id.raft_key
        } else if flow.bad_signature {
            &id.wrong_key
        } else {
            &id.key
        },
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if id.control.lock().unwrap().raft_secret.is_some() {
        let access = Uuid::new_v4().to_string();
        id.control
            .lock()
            .unwrap()
            .tokens
            .insert(access.clone(), flow.claims);
        Ok(Json(
            json!({"id_token":token,"access_token":access,"token_type":"Bearer","expires_in":300}),
        ))
    } else {
        Ok(Json(json!({"id_token":token})))
    }
}

async fn userinfo(
    State(id): State<Arc<Identity>>,
    headers: HeaderMap,
) -> Result<Json<Value>, StatusCode> {
    let control = id.control.lock().unwrap();
    let status = StatusCode::from_u16(control.userinfo_status).unwrap();
    if !status.is_success() {
        return Err(status);
    }
    let access = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let profile = control.tokens.get(access).ok_or(StatusCode::UNAUTHORIZED)?;
    Ok(Json(profile.clone()))
}
