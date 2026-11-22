//! Shared HTTP transport for stateless Responses Providers.
mod body;

use crate::{
    AssistantMessage, ClientIdentity, Code, Error, Login, ModelError,
    ModelErrorKind as FailureKind, ModelInfo, ModelRef, ModelRequest, Piece, Provider,
    ProviderContext, SubscriptionLogins, async_trait,
};
use anyhow::{Result, ensure};
use futures_util::{StreamExt, future::BoxFuture};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc, time::Duration};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponsesModel {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub context_window: u64,
    pub max_tokens: u64,
    /// Shared reasoning level to the vendor's effort name. A level left out
    /// is one the model does not accept.
    #[serde(default)]
    pub effort: BTreeMap<String, String>,
    #[serde(default)]
    pub extra: serde_json::Map<String, Value>,
}
pub(crate) const LEVELS: [&str; 6] = ["off", "minimal", "low", "medium", "high", "xhigh"];

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ResponsesFormat {
    ChatGpt,
    SystemMessage,
}

pub type Refresh =
    Arc<dyn Fn(reqwest::Client, Login) -> BoxFuture<'static, Result<Login>> + Send + Sync>;

pub struct ResponsesOptions {
    pub id: &'static str,
    pub label: &'static str,
    pub endpoint: &'static str,
    pub format: ResponsesFormat,
    pub refresh: Refresh,
}

pub(crate) fn validate_loopback(endpoint: &str) -> Result<()> {
    let url = reqwest::Url::parse(endpoint)?;
    ensure!(
        url.scheme() == "http"
            && url
                .host_str()
                .and_then(|host| host
                    .trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .ok())
                .is_some_and(|ip| ip.is_loopback())
            && url.username().is_empty()
            && url.password().is_none(),
        "test endpoint must be loopback HTTP"
    );
    Ok(())
}

pub struct ResponsesProvider {
    id: &'static str,
    label: &'static str,
    format: ResponsesFormat,
    models: Vec<ResponsesModel>,
    endpoint: String,
    client_identity: ClientIdentity,
    client: reqwest::Client,
    auth: SubscriptionLogins,
    refresh: Refresh,
    fixture: bool,
}

impl ResponsesProvider {
    /// Apply ma's explicit catalog replacements after the shared defaults.
    #[doc(hidden)]
    pub fn with_catalog_overrides(mut self, overrides: Vec<ResponsesModel>) -> Self {
        for model in overrides {
            self.models.retain(|existing| existing.id != model.id);
            self.models.push(model);
        }
        self
    }

    pub(crate) fn set_refresh(&mut self, refresh: Refresh) {
        self.refresh = refresh;
    }

    /// The shared Responses transport; callers choose the endpoint and authentication.
    pub fn new(
        options: ResponsesOptions,
        models: Vec<ResponsesModel>,
        auth: SubscriptionLogins,
        client_identity: ClientIdentity,
    ) -> Result<Self> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(300))
            .user_agent(concat!("modular-agent/", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Self {
            id: options.id,
            label: options.label,
            format: options.format,
            endpoint: options.endpoint.into(),
            refresh: options.refresh,
            models,
            client_identity,
            client,
            auth,
            fixture: false,
        })
    }

    /// Offline protocol fixtures only. Never send a real sign-in to a fixture.
    pub fn with_test_endpoint(mut self, endpoint: &str) -> Result<Self> {
        self.use_loopback(endpoint)?;
        self.fixture = true;
        Ok(self)
    }

    pub(crate) fn use_loopback(&mut self, endpoint: &str) -> Result<()> {
        validate_loopback(endpoint)?;
        self.endpoint = endpoint.into();
        self.client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(())
    }
}

#[async_trait]
impl Provider for ResponsesProvider {
    fn id(&self) -> &str {
        self.id
    }

    fn models(&self) -> Vec<ModelInfo> {
        self.models
            .iter()
            .map(|model| ModelInfo {
                model: ModelRef {
                    provider: self.id.into(),
                    id: model.id.clone(),
                },
                context_window: model.context_window,
                max_output: model.max_tokens,
                thinking: LEVELS
                    .iter()
                    .filter(|level| model.effort.contains_key(**level))
                    .map(|level| level.to_string())
                    .collect(),
                extra: {
                    let mut extra = model.extra.clone();
                    extra.insert("label".into(), json!(model.name));
                    extra
                },
            })
            .collect()
    }

    fn available(&self) -> bool {
        self.fixture
            || self.auth.login(self.id).is_ok_and(|v| match self.format {
                ResponsesFormat::ChatGpt => matches!(v, Some(Login::Oauth { .. })),
                ResponsesFormat::SystemMessage => v.is_some(),
            })
    }

    async fn request(
        &self,
        model: ModelRef,
        request: ModelRequest,
        cx: ProviderContext,
    ) -> crate::Result<AssistantMessage> {
        let model = self
            .models
            .iter()
            .find(|m| self.id == model.provider && m.id == model.id)
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

impl ResponsesProvider {
    async fn sign_in(&self, rejected: Option<&str>) -> Result<Login> {
        if self.fixture {
            return Ok(Login::ApiKey {
                key: "test-credential".into(),
            });
        }
        let result = if self.format == ResponsesFormat::ChatGpt {
            let id = self.id;
            let logins = self.auth.clone();
            let refresh = self.refresh.clone();
            let client = self.client.clone();
            let rejected = rejected.map(str::to_owned);
            // A token may have been spent before cancellation reaches the
            // request. Finish saving the rotated login even if the turn ends.
            tokio::spawn(async move {
                logins
                    .current(id, rejected.as_deref(), |old| refresh(client, old))
                    .await
            })
            .await?
        } else {
            self.auth
                .current(self.id, rejected, |old| {
                    (self.refresh)(self.client.clone(), old)
                })
                .await
        };
        result.map_err(|e| failed(FailureKind::Credentials, format!("{e:#}")).into())
    }
    async fn send(&self, login: &Login, session: &str, body: &Value) -> Result<reqwest::Response> {
        let mut request = self
            .client
            .post(&self.endpoint)
            .bearer_auth(login.secret())
            .header("accept", "text/event-stream")
            .json(body);
        if self.format == ResponsesFormat::ChatGpt {
            let account = match login {
                Login::Oauth {
                    account: Some(account),
                    ..
                } => account.clone(),
                _ if self.fixture => "test-account".into(),
                _ => crate::chatgpt::oauth::chatgpt_account(login.secret())?,
            };
            request = request
                .header("chatgpt-account-id", account)
                .header("OpenAI-Beta", "responses=experimental")
                .header("originator", self.client_identity.as_str())
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
        model: &ResponsesModel,
        request: &ModelRequest,
        cx: &ProviderContext,
    ) -> Result<AssistantMessage> {
        let body = body::request(self.id, self.format, model, request, cx.session_id())?;
        let mut login = self.sign_in(None).await?;
        let mut retried = false;
        loop {
            let response = self
                .send(&login, cx.session_id(), &body)
                .await
                .map_err(|e| {
                    failed(
                        FailureKind::Temporary,
                        format!("could not reach {}: {e}", self.label),
                    )
                })?;
            let status = response.status();
            if status.is_success() {
                let raw = self.read_stream(cx, response).await.map_err(|e| {
                    if self.format == ResponsesFormat::ChatGpt
                        && let Some(failure) = e.downcast_ref::<Failure>()
                    {
                        let mut failure = Failure(failure.0.clone());
                        scrub_login(&mut failure.0.message, &login);
                        return failure.into();
                    }
                    e
                })?;
                return body::response(self.id, &raw);
            }
            // A token the service no longer honours, though not yet past its
            // stated expiry: refresh once and try again.
            if status.as_u16() == 401
                && !retried
                && !self.fixture
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
            if self.format == ResponsesFormat::ChatGpt {
                scrub_login(&mut failure.0.message, &login);
            }
            if failure.0.kind == FailureKind::Credentials {
                failure.0.message = if self.format == ResponsesFormat::ChatGpt {
                    "ChatGPT refused the sign-in; sign in again.".into()
                } else {
                    format!(
                        "{} Run `ma login {}` to sign in again.",
                        failure.0.message, self.id
                    )
                };
            }
            return Err(failure.into());
        }
    }
}

fn scrub_login(message: &mut String, login: &Login) {
    if let Login::Oauth {
        access, refresh, ..
    } = login
    {
        for token in [access, refresh] {
            if !token.is_empty() {
                *message = message.replace(token, "<redacted>");
            }
        }
    }
}
