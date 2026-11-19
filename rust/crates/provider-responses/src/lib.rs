//! Providers that speak the OpenAI Responses API on a subscription sign-in:
//! ChatGPT (the Codex backend) and Grok (xAI). Both are stateless: every
//! request carries the full context the agent supplies, and nothing is stored
//! at the vendor. Sign-in and token refresh are in [`oauth`].
pub mod body;
pub mod oauth;

use agent_api::*;
use credentials_auth::{Login, Logins};
use futures_util::StreamExt;
use serde::Deserialize;
use std::{collections::BTreeMap, sync::Arc, time::Duration};

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
    /// The Codex backend wants an `originator` on every request. Pi sends
    /// "pi"; the header names a client family, it does not authenticate.
    pub originator: String,
}
impl ResponsesPlugin {
    pub fn new(vendor: Vendor, models: Vec<Model>) -> Self {
        Self {
            vendor,
            models,
            endpoint: vendor.endpoint().into(),
            originator: "pi".into(),
        }
    }
    /// Offline protocol fixtures only. Never send a real sign-in to a fixture.
    pub fn with_test_endpoint(mut self, endpoint: &str) -> Result<Self> {
        let url = reqwest::Url::parse(endpoint)?;
        ensure!(
            url.scheme() == "http"
                && url.host_str().is_some_and(|h| h
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())),
            "test endpoint must be loopback HTTP"
        );
        self.endpoint = endpoint.into();
        Ok(self)
    }
}
#[derive(Clone)]
struct Responses {
    vendor: Vendor,
    models: Arc<Vec<Model>>,
    endpoint: String,
    originator: String,
    client: reqwest::Client,
    test: bool,
    /// This Provider's hold on its own sign-in.
    claim: CredentialClaim,
}
struct Bound {
    provider: Responses,
    model: Model,
}
impl Plugin for ResponsesPlugin {
    fn name(&self) -> &str {
        match self.vendor {
            Vendor::Codex => "provider.openai-codex",
            Vendor::Xai => "provider.xai",
        }
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        // No overall timeout: a long answer is a long stream. A stream that
        // goes quiet is cut instead.
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(300))
            .user_agent(concat!("modular-agent/", env!("CARGO_PKG_VERSION")))
            .build()?;
        let claim = r.claim_credentials(&[self.vendor.id()])?;
        r.provide::<dyn Provider>(
            self.name(),
            Arc::new(Responses {
                claim,
                vendor: self.vendor,
                models: Arc::new(self.models.clone()),
                test: self.endpoint != self.vendor.endpoint(),
                endpoint: self.endpoint.clone(),
                originator: self.originator.clone(),
                client,
            }),
        )
    }
}
fn info(vendor: Vendor, model: &Model) -> ModelInfo {
    ModelInfo {
        name: format!("{}/{}", vendor.id(), model.id),
        context_window: model.context_window,
        output_limit: model.max_tokens,
        thinking: LEVELS
            .iter()
            .filter(|level| model.effort.contains_key(**level))
            .map(|level| level.to_string())
            .collect(),
        keeps_state: false,
        runs_tools: false,
        extra: json!({"label": model.name}),
    }
}
#[async_trait]
impl Provider for Responses {
    fn catalog(&self) -> Vec<ModelInfo> {
        self.models.iter().map(|m| info(self.vendor, m)).collect()
    }
    fn bind(&self, model: &str) -> Result<Arc<dyn ModelAccess>> {
        let id = model
            .strip_prefix(self.vendor.id())
            .and_then(|rest| rest.strip_prefix('/'))
            .ok_or_else(|| anyhow!("{model} is not a {} model", self.vendor.id()))?;
        let model = self
            .models
            .iter()
            .find(|m| m.id == id)
            .ok_or_else(|| anyhow!("{} does not offer {id}", self.vendor.id()))?;
        Ok(Arc::new(Bound {
            provider: self.clone(),
            model: model.clone(),
        }))
    }
}

fn failed(kind: FailureKind, message: impl Into<String>) -> ModelFailure {
    ModelFailure {
        kind,
        message: message.into(),
    }
}
fn api_failure(status: Option<u16>, error: &Value) -> ModelFailure {
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

impl Bound {
    async fn login(&self, api: &Api) -> Result<Login> {
        let vendor = self.provider.vendor;
        if self.provider.test {
            return Ok(Login::ApiKey {
                key: "test-credential".into(),
            });
        }
        let logins: Arc<Logins> = capability(api.as_ref(), "credentials.logins")?;
        let client = self.provider.client.clone();
        logins
            .current(&self.provider.claim, vendor.id(), |old| async move {
                oauth::refresh(&client, vendor, old).await
            })
            .await
            .map_err(|e| failed(FailureKind::Credentials, format!("{e:#}")).into())
    }
    async fn send(&self, login: &Login, session: &str, body: &Value) -> Result<reqwest::Response> {
        let mut request = self
            .provider
            .client
            .post(&self.provider.endpoint)
            .bearer_auth(login.secret())
            .header("accept", "text/event-stream")
            .json(body);
        if self.provider.vendor == Vendor::Codex {
            let account = match login {
                Login::Oauth {
                    account: Some(account),
                    ..
                } => account.clone(),
                _ if self.provider.test => "test-account".into(),
                _ => oauth::chatgpt_account(login.secret())?,
            };
            request = request
                .header("chatgpt-account-id", account)
                .header("OpenAI-Beta", "responses=experimental")
                .header("originator", &self.provider.originator)
                .header("session-id", session)
                .header("x-client-request-id", session);
        }
        Ok(request.send().await?)
    }
    async fn read_stream(
        &self,
        api: &Api,
        scope: &Scope,
        response: reqwest::Response,
        cancel: &CancellationToken,
        stream_id: &str,
    ) -> Result<Value> {
        let mut stream = response.bytes_stream();
        let mut buffer = vec![];
        let mut data = String::new();
        let mut completed = None;
        // Some backends leave `output` empty on the final event. Keep the
        // items as they finish, in order.
        let mut items: Vec<Value> = vec![];
        loop {
            let chunk = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(failed(FailureKind::Cancelled, "cancelled").into()),
                chunk = stream.next() => chunk,
            };
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
                        let mut e = Event::new(scope, "model.delta", event["delta"].clone());
                        e.stream = Some(stream_id.into());
                        api.emit(e).await?;
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
    async fn request(
        &self,
        api: &Api,
        scope: &Scope,
        request: &ModelRequest,
        cancel: &CancellationToken,
        stream_id: &str,
    ) -> Result<ModelResponse> {
        let vendor = self.provider.vendor;
        let body = body::request(vendor, &self.model, request)?;
        let mut login = self.login(api).await?;
        let mut retried = false;
        loop {
            let response = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(failed(FailureKind::Cancelled, "cancelled").into()),
                response = self.send(&login, &request.session, &body) => response,
            }
            .map_err(|e| failed(FailureKind::Temporary, format!("could not reach {}: {e}", vendor.label())))?;
            let status = response.status();
            if status.is_success() {
                let raw = self
                    .read_stream(api, scope, response, cancel, stream_id)
                    .await?;
                return body::response(vendor, &raw);
            }
            // A token the service no longer honours, though not yet past its
            // stated expiry: refresh once and try again.
            if status.as_u16() == 401
                && !retried
                && !self.provider.test
                && matches!(login, Login::Oauth { .. })
            {
                let logins: Arc<Logins> = capability(api.as_ref(), "credentials.logins")?;
                logins.expire(&self.provider.claim, vendor.id())?;
                login = self.login(api).await?;
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
            if failure.kind == FailureKind::Credentials {
                failure.message = format!(
                    "{} Run `ma login {}` to sign in again.",
                    failure.message,
                    vendor.id()
                );
            }
            return Err(failure.into());
        }
    }
}
#[async_trait]
impl ModelAccess for Bound {
    fn info(&self) -> ModelInfo {
        info(self.provider.vendor, &self.model)
    }
    async fn generate(
        &self,
        api: Api,
        scope: Scope,
        request: ModelRequest,
        cancel: CancellationToken,
    ) -> std::result::Result<ModelResponse, ModelFailure> {
        let stream_id = id();
        let result = self
            .request(&api, &scope, &request, &cancel, &stream_id)
            .await;
        let mut end = Event::new(&scope, "model.end", Value::Null);
        end.stream = Some(stream_id);
        end.end = true;
        let emitted = api.emit(end).await;
        result
            .and_then(|response| emitted.map(|()| response))
            .map_err(|e| {
                e.downcast_ref::<ModelFailure>()
                    .cloned()
                    .unwrap_or_else(|| failed(FailureKind::Other, format!("{e:#}")))
            })
    }
}
