//! Providers that speak the OpenAI Responses API on a subscription sign-in:
//! ChatGPT (the Codex backend) and Grok (xAI). Both are stateless: every
//! request carries the full context the agent supplies, and nothing is stored
//! at the vendor. Sign-in and token refresh are in [`oauth`].
pub mod body;
pub mod oauth;

use anyhow::{Result, anyhow, ensure};
use credentials_auth::{AuthFile, Login};
use futures_util::StreamExt;
use modular_agent::{
    AssistantMessage, Code, Error, ModelError, ModelErrorKind as FailureKind, ModelInfo, ModelRef,
    ModelRequest, Piece, Provider, ProviderContext, async_trait,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::BTreeMap, time::Duration};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Vendor {
    /// A ChatGPT subscription, through the Codex backend.
    Codex,
    /// A SuperGrok or X Premium subscription, through the xAI API.
    Xai,
}
impl Vendor {
    pub fn id(self) -> &'static str {
        match self {
            Self::Codex => "openai-codex",
            Self::Xai => "xai",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Codex => "ChatGPT subscription",
            Self::Xai => "Grok subscription",
        }
    }
    fn endpoint(self) -> &'static str {
        match self {
            Self::Codex => "https://chatgpt.com/backend-api/codex/responses",
            Self::Xai => "https://api.x.ai/v1/responses",
        }
    }
    pub fn parse(id: &str) -> Option<Self> {
        [Self::Codex, Self::Xai].into_iter().find(|v| v.id() == id)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub context_window: u64,
    pub max_tokens: u64,
    /// Shared reasoning level to the vendor's effort name. A level left out
    /// is one the model does not accept.
    #[serde(default)]
    pub effort: BTreeMap<String, String>,
}
pub(crate) const LEVELS: [&str; 6] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/// The built-in catalog, with `overrides` (the same shape, by vendor id)
/// replacing or adding models by id.
pub fn catalog(vendor: Vendor, overrides: &Value) -> Result<Vec<Model>> {
    let builtin: Value = serde_json::from_str(include_str!("models.json"))?;
    let mut models: Vec<Model> = serde_json::from_value(builtin[vendor.id()].clone())?;
    if let Some(extra) = overrides.get(vendor.id()).filter(|v| !v.is_null()) {
        for model in serde_json::from_value::<Vec<Model>>(extra.clone())
            .map_err(|e| anyhow!("models for {}: {e}", vendor.id()))?
        {
            models.retain(|m| m.id != model.id);
            models.push(model);
        }
    }
    Ok(models)
}

pub struct ResponsesPlugin {
    pub vendor: Vendor,
    pub models: Vec<Model>,
    endpoint: String,
    pub originator: String,
    client: reqwest::Client,
    auth: AuthFile,
    test: bool,
}

impl ResponsesPlugin {
    pub fn new(vendor: Vendor, models: Vec<Model>, auth: AuthFile) -> Result<Self> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(300))
            .user_agent(concat!("modular-agent/", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Self {
            vendor,
            models,
            endpoint: vendor.endpoint().into(),
            originator: oauth::CLIENT_IDENTITY.into(),
            client,
            auth,
            test: false,
        })
    }

    /// Offline protocol fixtures only. Never send a real sign-in to a fixture.
    pub fn with_test_endpoint(mut self, endpoint: &str) -> Result<Self> {
        let url = reqwest::Url::parse(endpoint)?;
        ensure!(
            url.scheme() == "http"
                && url
                    .host_str()
                    .and_then(|host| host
                        .trim_matches(['[', ']'])
                        .parse::<std::net::IpAddr>()
                        .ok())
                    .is_some_and(|ip| ip.is_loopback()),
            "test endpoint must be loopback HTTP"
        );
        self.endpoint = endpoint.into();
        self.test = true;
        self.client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(self)
    }
}

#[async_trait]
impl Provider for ResponsesPlugin {
    fn id(&self) -> &str {
        self.vendor.id()
    }

    fn models(&self) -> Vec<ModelInfo> {
        self.models
            .iter()
            .map(|model| ModelInfo {
                model: ModelRef {
                    provider: self.vendor.id().into(),
                    id: model.id.clone(),
                },
                context_window: model.context_window,
                max_output: model.max_tokens,
                thinking: LEVELS
                    .iter()
                    .filter(|level| model.effort.contains_key(**level))
                    .map(|level| level.to_string())
                    .collect(),
                extra: serde_json::from_value(json!({"label":model.name}))
                    .expect("model metadata is an object"),
            })
            .collect()
    }

    fn available(&self) -> bool {
        self.test || self.auth.login(self.vendor.id()).is_ok_and(|v| v.is_some())
    }

    async fn request(
        &self,
        model: ModelRef,
        request: ModelRequest,
        cx: ProviderContext,
    ) -> modular_agent::Result<AssistantMessage> {
        let model = self
            .models
            .iter()
            .find(|m| m.id == model.id)
            .ok_or_else(|| Error::new(Code::InvalidRequest, "unknown model"))?;
        let response = tokio::select! {
            biased;
            _ = cx.cancelled().cancelled() => return Err(Error::new(Code::Cancelled, "cancelled")),
            response = self.generate(model, &request, &cx) => response,
        };
        Ok(response.unwrap_or_else(|e| {
            e.downcast_ref::<Failure>()
                .map(|f| f.0.clone())
                .unwrap_or_else(|| ModelError::new(FailureKind::Other, format!("{e:#}")))
                .failed()
        }))
    }
}

#[derive(Debug)]
struct Failure(ModelError);
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0.message)
    }
}
impl std::error::Error for Failure {}
fn failed(kind: FailureKind, message: impl Into<String>) -> Failure {
    Failure(ModelError::new(kind, message))
}
fn api_failure(status: Option<u16>, error: &Value) -> Failure {
    let code = error["code"]
        .as_str()
        .or_else(|| error["type"].as_str())
        .unwrap_or("");
    let message = error["message"]
        .as_str()
        .or_else(|| error["detail"].as_str())
        .or_else(|| error.as_str())
        .unwrap_or("the model service refused the request");
    let kind = match (code, status) {
        ("context_length_exceeded" | "context_window_exceeded", _) => FailureKind::ContextTooLarge,
        ("usage_limit_reached" | "usage_not_included" | "insufficient_quota", _) => {
            FailureKind::Other
        }
        ("invalid_api_key" | "authentication_error" | "token_expired", _)
        | (_, Some(401 | 403)) => FailureKind::Credentials,
        ("rate_limit_exceeded" | "server_error" | "overloaded", _) | (_, Some(429 | 500..=599)) => {
            FailureKind::Temporary
        }
        ("content_policy_violation", _) => FailureKind::Refused,
        _ => FailureKind::Other,
    };
    let message = match (code, status) {
        ("", Some(status)) => format!("{message} (HTTP {status})"),
        ("", None) => message.into(),
        (code, _) => format!("{message} ({code})"),
    };
    failed(kind, message)
}

impl ResponsesPlugin {
    async fn sign_in(&self, rejected: Option<&str>) -> Result<Login> {
        if self.test {
            return Ok(Login::ApiKey {
                key: "test-credential".into(),
            });
        }
        self.auth
            .current(self.vendor.id(), rejected, |old| {
                oauth::refresh(&self.client, self.vendor, old)
            })
            .await
            .map_err(|e| failed(FailureKind::Credentials, format!("{e:#}")).into())
    }
    async fn send(&self, login: &Login, session: &str, body: &Value) -> Result<reqwest::Response> {
        let mut request = self
            .client
            .post(&self.endpoint)
            .bearer_auth(login.secret())
            .header("accept", "text/event-stream")
            .json(body);
        if self.vendor == Vendor::Codex {
            let account = match login {
                Login::Oauth {
                    account: Some(account),
                    ..
                } => account.clone(),
                _ if self.test => "test-account".into(),
                _ => oauth::chatgpt_account(login.secret())?,
            };
            request = request
                .header("chatgpt-account-id", account)
                .header("OpenAI-Beta", "responses=experimental")
                .header("originator", &self.originator)
                .header("session-id", session)
                .header("x-client-request-id", session);
        }
        Ok(request.send().await?)
    }
    async fn read_stream(
        &self,
        cx: &ProviderContext,
        response: reqwest::Response,
    ) -> Result<Value> {
        let mut stream = response.bytes_stream();
        let mut buffer = vec![];
        let mut data = String::new();
        let mut completed = None;
        // Some backends leave `output` empty on the final event. Keep the
        // items as they finish, in order.
        let mut items: Vec<Value> = vec![];
        loop {
            let chunk = stream.next().await;
            let Some(chunk) = chunk else { break };
            buffer.extend_from_slice(&chunk?);
            ensure!(buffer.len() < 16 * 1024 * 1024, "model event too large");
            while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
                let line: Vec<_> = buffer.drain(..=end).collect();
                let line = std::str::from_utf8(&line)?.trim_end_matches(['\r', '\n']);
                if let Some(piece) = line.strip_prefix("data:") {
                    if !data.is_empty() {
                        data.push('\n');
                    }
                    data.push_str(piece.trim_start());
                    ensure!(data.len() < 16 * 1024 * 1024, "model event too large");
                }
                if !line.is_empty() || data.is_empty() {
                    continue;
                }
                if data == "[DONE]" {
                    data.clear();
                    continue;
                }
                let event: Value = serde_json::from_str(&data)?;
                data.clear();
                match event["type"].as_str().unwrap_or("") {
                    "response.output_text.delta" => {
                        cx.piece(
                            Piece::Text,
                            event["delta"].as_str().unwrap_or_default(),
                            None,
                        )
                        .await?;
                    }
                    "response.output_item.done" => items.push(event["item"].clone()),
                    "response.completed" | "response.incomplete" | "response.done" => {
                        completed = Some(event["response"].clone())
                    }
                    "response.failed" => {
                        return Err(api_failure(None, &event["response"]["error"]).into());
                    }
                    "error" => {
                        let error = if event["error"].is_object() {
                            &event["error"]
                        } else {
                            &event
                        };
                        return Err(api_failure(None, error).into());
                    }
                    _ => (),
                }
            }
        }
        let mut completed = completed.ok_or_else(|| {
            failed(
                FailureKind::Temporary,
                "the model stream ended before a complete response",
            )
        })?;
        if completed["output"].as_array().is_none_or(Vec::is_empty) && !items.is_empty() {
            completed["output"] = json!(items);
        }
        Ok(completed)
    }
    async fn generate(
        &self,
        model: &Model,
        request: &ModelRequest,
        cx: &ProviderContext,
    ) -> Result<AssistantMessage> {
        let vendor = self.vendor;
        let body = body::request(vendor, model, request, cx.session_id())?;
        let mut login = self.sign_in(None).await?;
        let mut retried = false;
        loop {
            let response = self
                .send(&login, cx.session_id(), &body)
                .await
                .map_err(|e| {
                    failed(
                        FailureKind::Temporary,
                        format!("could not reach {}: {e}", vendor.label()),
                    )
                })?;
            let status = response.status();
            if status.is_success() {
                let raw = self.read_stream(cx, response).await?;
                return body::response(vendor, &raw);
            }
            // A token the service no longer honours, though not yet past its
            // stated expiry: refresh once and try again.
            if status.as_u16() == 401
                && !retried
                && !self.test
                && matches!(login, Login::Oauth { .. })
            {
                login = self.sign_in(Some(login.secret())).await?;
                retried = true;
                continue;
            }
            let text = response.text().await.unwrap_or_default();
            let value: Value = serde_json::from_str(&text).unwrap_or(json!(text));
            let error = if value["error"].is_object() {
                value["error"].clone()
            } else if value.is_object() {
                value
            } else {
                json!({"message": text.chars().take(500).collect::<String>()})
            };
            let mut failure = api_failure(Some(status.as_u16()), &error);
            if failure.0.kind == FailureKind::Credentials {
                failure.0.message = format!(
                    "{} Run `ma login {}` to sign in again.",
                    failure.0.message,
                    vendor.id()
                );
            }
            return Err(failure.into());
        }
    }
}
