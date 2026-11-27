//! Shared implementation for the OpenAI and Anthropic API-key Provider crates.
mod catalog;
mod stream;

use agent_api as base;
use modular_agent::{
    AssistantMessage, Code, Error, ModelError, ModelErrorKind as Kind, ModelInfo, ModelRef,
    ModelRequest, Piece, Provider, ProviderContext, Result,
};
use serde_json::{Value, json};
use std::time::Duration;

/// Vendor-specific request, authentication, and response handling.
pub trait Protocol: Send + Sync {
    fn encode(&self, request: &base::ModelRequest) -> std::result::Result<Value, ModelError>;
    fn authenticate(&self, request: reqwest::RequestBuilder, key: &str) -> reqwest::RequestBuilder;
    fn decode(
        &self,
        request: &base::ModelRequest,
        response: Value,
    ) -> std::result::Result<base::ModelResponse, ModelError>;
    fn stream_decoder(&self) -> Box<dyn StreamDecoder>;
}

/// Receives parsed server-sent events for one request, returning the final reply when complete.
#[async_trait::async_trait]
pub trait StreamDecoder: Send {
    async fn event(
        &mut self,
        event: Value,
        cx: &ProviderContext,
    ) -> std::result::Result<Option<Value>, ModelError>;
}

/// An API-key Provider. Construct it with `openai()` or `anthropic()` from the vendor crate.
pub struct ApiKeyProvider {
    id: &'static str,
    protocol: Box<dyn Protocol>,
    endpoint: String,
    models: Vec<ModelInfo>,
    test: bool,
}
impl ApiKeyProvider {
    #[doc(hidden)]
    pub fn new(id: &'static str, endpoint: &str, protocol: impl Protocol + 'static) -> Self {
        Self {
            id,
            endpoint: endpoint.into(),
            protocol: Box::new(protocol),
            models: catalog::models(id),
            test: false,
        }
    }

    /// Enroll a text model, or override a listed model's limits without changing its capabilities.
    pub fn model(self, id: &str, context_window: u64, max_output: u64) -> Self {
        let input = self
            .models
            .iter()
            .find(|m| m.model.id == id)
            .and_then(|m| m.extra.get("input"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| vec!["text".into()]);
        self.model_with_input(id, context_window, max_output, input)
    }

    /// Enroll an exact model id with the input types it accepts. Unlisted ids offer no reasoning levels.
    pub fn model_with_input(
        mut self,
        id: &str,
        context_window: u64,
        max_output: u64,
        input: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        if let Some(model) = self.models.iter_mut().find(|m| m.model.id == id) {
            model.context_window = context_window;
            model.max_output = max_output;
            return self;
        }
        let input = input.into_iter().map(Into::into).collect::<Vec<String>>();
        let model = ModelInfo {
            model: ModelRef {
                provider: self.id().into(),
                id: id.into(),
            },
            context_window,
            max_output,
            thinking: vec![],
            extra: serde_json::Map::from_iter([("input".into(), json!(input))]),
        };
        self.models.push(model);
        self
    }
    /// Offline fixture only. Restricts the endpoint to loopback HTTP and never reads a real key.
    pub fn with_test_endpoint(mut self, endpoint: &str) -> Result<Self> {
        let url = reqwest::Url::parse(endpoint)
            .map_err(|e| Error::new(Code::InvalidParams, e.to_string()))?;
        if url.scheme() != "http"
            || !url.host_str().is_some_and(|host| {
                host.trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
            })
        {
            return Err(Error::new(
                Code::InvalidParams,
                "test endpoint must be loopback HTTP",
            ));
        }
        self.endpoint = endpoint.into();
        self.test = true;
        Ok(self)
    }
}

#[async_trait::async_trait]
impl Provider for ApiKeyProvider {
    fn id(&self) -> &str {
        self.id
    }
    fn models(&self) -> Vec<ModelInfo> {
        self.models.clone()
    }
    async fn request(
        &self,
        model: ModelRef,
        request: ModelRequest,
        cx: ProviderContext,
    ) -> Result<AssistantMessage> {
        if !self.models.iter().any(|m| m.model == model) {
            return Err(Error::new(Code::InvalidRequest, "unknown model"));
        }
        let work = async {
            let key = if self.test {
                "offline-fixture".into()
            } else {
                cx.credential()
                    .await
                    .map_err(|_| ModelError::new(Kind::Credentials, "API key is not set"))?
            };
            let native = base::wire::parse_request(&request.0, cx.session_id()).map_err(other)?;
            let mut body = self.protocol.encode(&native)?;
            body["model"] = json!(model.id);
            let fields = body.as_object_mut().expect("vendor request object");
            if let Some(mapping) = catalog::reasoning_fields(
                self.id(),
                &model.id,
                request.0["settings"]["reasoning"].as_str(),
                native.output_limit,
            ) {
                fields.extend(mapping);
            }
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(15))
                .read_timeout(Duration::from_secs(300))
                .build()
                .map_err(|_| ModelError::new(Kind::Other, "could not make model client"))?;
            let request = client.post(&self.endpoint).json(&body);
            let request = self.protocol.authenticate(request, &key);
            let response = request
                .send()
                .await
                .map_err(|_| ModelError::new(Kind::Temporary, "could not reach model service"))?;
            let status = response.status().as_u16();
            let sse = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.starts_with("text/event-stream"));
            let raw = if sse && status < 300 {
                stream::read(response, self.protocol.stream_decoder().as_mut(), &cx).await?
            } else {
                let raw: Value = response.json().await.map_err(|_| {
                    if status >= 300 {
                        failure(status, &Value::Null)
                    } else {
                        ModelError::new(Kind::Other, "invalid model reply")
                    }
                })?;
                if status >= 300 {
                    return Err(failure(status, &raw["error"]));
                }
                raw
            };
            let response = self.protocol.decode(&native, raw)?;
            if !sse {
                let text = response.text_content();
                if !text.is_empty() {
                    cx.piece(Piece::Text, text, None).await.map_err(other)?;
                }
            }
            Ok(AssistantMessage(base::wire::response(&response)))
        };
        tokio::select! {
            biased;
            _ = cx.cancelled().cancelled() => Err(Error::new(Code::Cancelled,"model request cancelled")),
            reply = work => Ok(reply.unwrap_or_else(ModelError::failed)),
        }
    }
}
pub fn other(error: impl std::fmt::Display) -> ModelError {
    ModelError::new(Kind::Other, error.to_string())
}
pub fn failure(status: u16, error: &Value) -> ModelError {
    let code = error["code"]
        .as_str()
        .or_else(|| error["type"].as_str())
        .unwrap_or("");
    let message = error["message"]
        .as_str()
        .unwrap_or("model service request failed");
    let kind = if matches!(status, 401 | 403)
        || matches!(
            code,
            "authentication_error" | "permission_error" | "invalid_api_key"
        ) {
        Kind::Credentials
    } else if matches!(code, "context_length_exceeded" | "prompt_too_long")
        || (status == 400 && message.to_ascii_lowercase().contains("prompt is too long"))
    {
        Kind::ContextTooLarge
    } else if matches!(status, 408 | 429 | 500..=599)
        || matches!(
            code,
            "overloaded_error" | "rate_limit_error" | "api_error" | "server_error"
        )
    {
        Kind::Temporary
    } else if matches!(code, "content_filter" | "refusal") {
        Kind::Refused
    } else {
        Kind::Other
    };
    ModelError::new(kind, message)
}
