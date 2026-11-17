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
}

struct Identity {
    issuer: String,
    client_id: String,
    key: EncodingKey,
    wrong_key: EncodingKey,
    jwk: Value,
    control: Mutex<Control>,
    closing: CancellationToken,
}

pub struct Provider {
    pub issuer: String,
    identity: Arc<Identity>,
    task: Option<JoinHandle<std::io::Result<()>>>,
}

fn key() -> Result<EncodingKey> {
    let command = Command::new("openssl")
        .args([
            "genpkey",
            "-outform",
            "DER",
            "-algorithm",
            "RSA",
            "-pkeyopt",
            "rsa_keygen_bits:2048",
        ])
        .output()?;
    ensure!(
        command.status.success(),
        "Cannot generate a temporary OIDC key"
    );
    Ok(EncodingKey::from_rsa_der(&command.stdout))
}

impl Provider {
    pub async fn start(client_id: &str, redirect_uri: &str) -> Result<Self> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let issuer = format!("http://{}", listener.local_addr()?);
        let signing_key = key()?;
        let mut jwk =
            serde_json::to_value(Jwk::from_encoding_key(&signing_key, Algorithm::RS256)?)?;
        jwk["kid"] = json!("fixture");
        jwk["use"] = json!("sig");
        let identity = Arc::new(Identity {
            issuer: issuer.clone(),
            client_id: client_id.into(),
            key: signing_key,
            wrong_key: key()?,
            jwk,
            control: Mutex::new(Control {
                redirects: vec![redirect_uri.into()],
                discovery_issuer: None,
                flows: HashMap::new(),
                claims: json!({}),
                bad_signature: false,
            }),
            closing: CancellationToken::new(),
        });
        let router = Router::new()
            .route("/.well-known/openid-configuration", get(discovery))
            .route(
                "/jwks",
                get(async |State(s): State<Arc<Identity>>| Json(json!({"keys":[s.jwk]}))),
            )
            .route("/authorize", get(authorize))
            .route("/token", post(token))
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
        "token_endpoint":format!("{}/token",id.issuer),"jwks_uri":format!("{}/jwks",id.issuer)}),
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
    let verifier = q.get("code_verifier").ok_or(StatusCode::BAD_REQUEST)?;
    if headers.contains_key("authorization")
        || q.contains_key("client_secret")
        || q.get("grant_type").map(String::as_str) != Some("authorization_code")
        || q.get("client_id") != Some(&id.client_id)
        || q.get("redirect_uri") != Some(&flow.redirect_uri)
        || URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())) != flow.challenge
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
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some("fixture".into());
    let token = encode(
        &header,
        &claims,
        if flow.bad_signature {
            &id.wrong_key
        } else {
            &id.key
        },
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(json!({"id_token":token})))
}
