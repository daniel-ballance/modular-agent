//! Stateless API-key Providers. OpenAI body and result conversion come from the base.
use crate::{
    AssistantMessage, Code, Error, ModelError, ModelErrorKind as Kind, ModelInfo, ModelRef,
    ModelRequest, Piece, Provider, ProviderContext, Result,
};
use agent_api as base;
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Clone, Copy)]
enum Vendor {
    OpenAi,
    Anthropic,
}

/// OpenAI Responses using `OPENAI_API_KEY`.
pub fn openai() -> ApiKeyProvider {
    ApiKeyProvider::new(Vendor::OpenAi, "https://api.openai.com/v1/responses")
}
/// Anthropic Messages using `ANTHROPIC_API_KEY`.
pub fn anthropic() -> ApiKeyProvider {
    ApiKeyProvider::new(Vendor::Anthropic, "https://api.anthropic.com/v1/messages")
}

pub struct ApiKeyProvider {
    vendor: Vendor,
    endpoint: String,
    models: Vec<ModelInfo>,
    test: bool,
}
impl ApiKeyProvider {
    fn new(vendor: Vendor, endpoint: &str) -> Self {
        let mut provider = Self {
            vendor,
            endpoint: endpoint.into(),
            models: vec![],
            test: false,
        };
        provider.models = table()
            .iter()
            .filter(|m| m["provider"] == provider.id())
            .map(|m| {
                let mut catalog = m.clone();
                catalog.as_object_mut().unwrap().remove("levels");
                catalog["thinking"] = json!(levels(m));
                serde_json::from_value(catalog).expect("valid API-key model table")
            })
            .collect();
        provider
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
        match self.vendor {
            Vendor::OpenAi => "openai",
            Vendor::Anthropic => "anthropic",
        }
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
            let mut body = match self.vendor {
                Vendor::OpenAi => provider_openai::request_body(&native).map_err(other)?,
                Vendor::Anthropic => anthropic_body(&native),
            };
            body["model"] = json!(model.id);
            let fields = body.as_object_mut().expect("vendor request object");
            fields.remove("reasoning"); // Replace legacy Responses defaults with the shared table.
            if let Some(mapping) = reasoning_fields(
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
            let request = match self.vendor {
                Vendor::OpenAi => request.bearer_auth(key),
                Vendor::Anthropic => request
                    .header("x-api-key", key)
                    .header("anthropic-version", "2023-06-01"),
            };
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
                stream(self.vendor, response, &cx).await?
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
            let response = match self.vendor {
                Vendor::OpenAi => provider_openai::normalize_for(&native, &raw).map_err(other)?,
                Vendor::Anthropic => anthropic_response(raw)?,
            };
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
const LEVELS: &[&str] = &["off", "minimal", "low", "medium", "high", "xhigh"];

fn table() -> &'static [Value] {
    static TABLE: std::sync::OnceLock<Vec<Value>> = std::sync::OnceLock::new();
    TABLE.get_or_init(|| {
        let table: Value = serde_json::from_str(include_str!("../api-key-models.json"))
            .expect("valid API-key model table");
        table["models"]
            .as_array()
            .expect("API-key model list")
            .clone()
    })
}

fn levels(model: &Value) -> Vec<String> {
    LEVELS
        .iter()
        .filter(|level| model["levels"].get(**level).is_some())
        .map(|level| (*level).into())
        .collect()
}

fn reasoning_fields(
    provider: &str,
    id: &str,
    chosen: Option<&str>,
    max_output: u64,
) -> Option<serde_json::Map<String, Value>> {
    let chosen = chosen?;
    let rank = LEVELS.iter().position(|level| *level == chosen)?;
    let mappings = table()
        .iter()
        .find(|model| model["provider"] == provider && model["id"] == id)?["levels"]
        .as_object()?;
    let mut fields = LEVELS[..=rank]
        .iter()
        .rev()
        .find_map(|level| mappings.get(*level))?
        .clone();
    if fields["thinking"]["type"] == "enabled" {
        let budget = fields["thinking"]["budget_tokens"]
            .as_u64()?
            .min(max_output.saturating_sub(1));
        if budget < 1024 {
            return mappings.get("off")?.as_object().cloned();
        }
        fields["thinking"]["budget_tokens"] = json!(budget);
    }
    fields.as_object().cloned()
}

fn other(error: impl std::fmt::Display) -> ModelError {
    ModelError::new(Kind::Other, error.to_string())
}
fn failure(status: u16, error: &Value) -> ModelError {
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
fn anthropic_body(r: &base::ModelRequest) -> Value {
    let mut messages: Vec<Value> = vec![];
    for m in &r.messages {
        let (role, parts) = if m.role == "tool" {
            (
                "user",
                vec![
                    json!({"type":"tool_result","tool_use_id":m.call,"content":m.text_content(),"is_error":m.opaque["_pluginWire"]["status"].as_str().is_some_and(|s| s != "completed")}),
                ],
            )
        } else {
            (m.role.as_str(), m.parts.iter().filter_map(|p| match p {
                base::Part::Text { text } => Some(json!({"type":"text","text":text})),
                base::Part::ToolCall { call } => Some(json!({"type":"tool_use","id":call.id,"name":call.name,"input":call.input})),
                _ => None,
            }).collect())
        };
        if parts.is_empty() {
            continue;
        }
        if let Some(previous) = messages.last_mut().filter(|p| p["role"] == role) {
            previous["content"].as_array_mut().unwrap().extend(parts);
        } else {
            messages.push(json!({"role":role,"content":parts}));
        }
    }
    json!({"system":r.system,"messages":messages,"stream":true,"max_tokens":r.output_limit,
        "tools":r.tools.iter().map(|t| json!({"name":t.name,"description":t.description,"input_schema":t.input})).collect::<Vec<_>>()})
}
fn anthropic_response(raw: Value) -> std::result::Result<base::ModelResponse, ModelError> {
    if raw["stop_reason"] == "refusal" {
        return Err(ModelError::new(Kind::Refused, "model refused the request"));
    }
    let parts = raw["content"]
        .as_array()
        .ok_or_else(|| other("Messages reply lacks content"))?
        .iter()
        .filter_map(|p| match p["type"].as_str() {
            Some("text") => Some(json!({"type":"text","text":p["text"]})),
            Some("tool_use") => Some(
                json!({"type":"toolCall","id":p["id"],"name":p["name"],"arguments":p["input"]}),
            ),
            _ => None,
        })
        .collect::<Vec<_>>();
    let usage = &raw["usage"];
    base::wire::parse_response(json!({"role":"assistant","content":parts,
        "stop": match raw["stop_reason"].as_str() { Some("tool_use") => "toolUse", Some("max_tokens") => "length", _ => "finished" },
        "usage":{"input":usage["input_tokens"],"output":usage["output_tokens"],"cacheRead":usage["cache_read_input_tokens"],"cacheWrite":usage["cache_creation_input_tokens"]}
    })).map_err(other)
}

async fn stream(
    vendor: Vendor,
    response: reqwest::Response,
    cx: &ProviderContext,
) -> std::result::Result<Value, ModelError> {
    let mut bytes = response.bytes_stream();
    let mut buffer = Vec::new();
    let mut data = String::new();
    let mut message = Value::Null;
    let mut blocks: Vec<(Value, String)> = vec![];
    while let Some(chunk) = bytes.next().await {
        buffer.extend(chunk.map_err(|_| ModelError::new(Kind::Temporary, "model stream lost"))?);
        if buffer.len() + data.len() > 16 * 1024 * 1024 {
            return Err(other("model stream event is too large"));
        }
        let mut consumed = 0;
        while let Some(end) = buffer[consumed..].iter().position(|b| *b == b'\n') {
            let end = consumed + end;
            let line = std::str::from_utf8(&buffer[consumed..end])
                .map_err(other)?
                .trim_end_matches('\r');
            consumed = end + 1;
            if let Some(p) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(p.trim_start());
            } else if line.is_empty() && !data.is_empty() {
                if data == "[DONE]" {
                    data.clear();
                    continue;
                }
                let e: Value = serde_json::from_str(&data).map_err(other)?;
                data.clear();
                if e["type"] == "error" {
                    return Err(failure(0, &e["error"]));
                }
                match vendor {
                    Vendor::OpenAi => match e["type"].as_str() {
                        Some("response.output_text.delta") => cx
                            .piece(Piece::Text, e["delta"].as_str().unwrap_or_default(), None)
                            .await
                            .map_err(other)?,
                        Some("response.reasoning_summary_text.delta") => cx
                            .piece(
                                Piece::Reasoning,
                                e["delta"].as_str().unwrap_or_default(),
                                None,
                            )
                            .await
                            .map_err(other)?,
                        Some("response.completed" | "response.incomplete") => {
                            return Ok(e["response"].clone());
                        }
                        Some("response.failed") => return Err(failure(0, &e["response"]["error"])),
                        _ => (),
                    },
                    Vendor::Anthropic => match e["type"].as_str() {
                        Some("message_start") => message = e["message"].clone(),
                        Some("content_block_start") => {
                            if e["index"].as_u64() != Some(blocks.len() as u64) {
                                return Err(other("out of order Messages content"));
                            }
                            blocks.push((e["content_block"].clone(), String::new()));
                        }
                        Some("content_block_delta") => {
                            let (block, input) = e["index"]
                                .as_u64()
                                .and_then(|i| blocks.get_mut(i as usize))
                                .ok_or_else(|| other("unknown Messages block"))?;
                            let delta = &e["delta"];
                            match delta["type"].as_str() {
                                Some("text_delta") => {
                                    let text = delta["text"].as_str().unwrap_or_default();
                                    cx.piece(Piece::Text, text, None).await.map_err(other)?;
                                    block["text"] = json!(format!(
                                        "{}{text}",
                                        block["text"].as_str().unwrap_or_default()
                                    ));
                                }
                                Some("input_json_delta") => {
                                    let text = delta["partial_json"].as_str().unwrap_or_default();
                                    cx.piece(Piece::ToolInput, text, block["id"].as_str())
                                        .await
                                        .map_err(other)?;
                                    input.push_str(text);
                                }
                                _ => (),
                            }
                        }
                        Some("message_delta") => {
                            message["stop_reason"] = e["delta"]["stop_reason"].clone();
                            if let Some(usage) = e["usage"].as_object() {
                                for (k, v) in usage {
                                    message["usage"][k] = v.clone();
                                }
                            }
                        }
                        Some("message_stop") => {
                            let mut parts = Vec::new();
                            for (mut block, input) in blocks {
                                if !input.is_empty() {
                                    block["input"] = serde_json::from_str(&input).map_err(other)?;
                                }
                                parts.push(block);
                            }
                            message["content"] = json!(parts);
                            return Ok(message);
                        }
                        _ => (),
                    },
                }
            }
        }
        buffer.drain(..consumed);
    }
    Err(ModelError::new(
        Kind::Temporary,
        "model stream ended without a response",
    ))
}
