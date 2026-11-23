//! OpenAI Responses adapter with stateless and server-kept conversation modes.
//! Only gpt-6-luna can be bound. No vendor tools are offered.
mod state;
use agent_api::*;
use futures_util::StreamExt;
use state::{Chain, Inventory, State, safe_id};
use std::{path::PathBuf, sync::Arc, time::Duration};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Stateless,
    Stateful,
}
pub struct OpenAiPlugin {
    mode: Mode,
    directory: PathBuf,
    endpoint: String,
}
impl OpenAiPlugin {
    pub fn new(mode: Mode, directory: PathBuf) -> Self {
        Self {
            mode,
            directory,
            endpoint: "https://api.openai.com/v1/responses".into(),
        }
    }
    /// Offline protocol fixtures only. Never send real credentials to a fixture.
    pub fn with_test_endpoint(mut self, endpoint: &str) -> Result<Self> {
        let url = reqwest::Url::parse(endpoint)?;
        ensure!(
            url.scheme() == "http"
                && url.host_str().is_some_and(|h| h
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())),
            "test endpoint must be loopback HTTP"
        );
        self.endpoint = endpoint.trim_end_matches('/').into();
        Ok(self)
    }
}
struct OpenAi {
    client: reqwest::Client,
    before: HookPoint,
    piece: HookPoint,
    mode: Mode,
    endpoint: String,
    state: Arc<State>,
    claim: CredentialClaim,
}
impl Plugin for OpenAiPlugin {
    fn name(&self) -> &str {
        "provider.openai"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        let before = r.define("provider.openai.before", Rule::Transform)?;
        let piece = r.define("provider.openai.piece", Rule::Observe)?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(90))
            .build()?;
        r.declare(json!({"provider_state":self.mode == Mode::Stateful,"openai":{"mode":if self.mode == Mode::Stateful {"stateful"} else {"stateless"},"remote_erasure":"known response IDs are deleted; vendor logs and requests with unknown IDs are out of reach"}}));
        let provider = Arc::new(OpenAi {
            claim: r.claim_credentials(&["openai"])?,
            client,
            before,
            piece,
            mode: self.mode,
            endpoint: self.endpoint.clone(),
            state: Arc::new(State::new(self.directory.clone())),
        });
        let prepare = provider.clone();
        r.on(
            "session.prepare",
            Order::Normal,
            handler(move |api, scope, _| {
                let prepare = prepare.clone();
                Box::pin(async move {
                    let _gate = prepare.state.gate.lock().await;
                    let mut inventory = prepare.state.load(&scope.session)?;
                    prepare
                        .reconcile_erasure(api, &scope.session, &mut inventory)
                        .await?;
                    Ok(HookResult::default())
                })
            }),
        );
        r.provide::<dyn Provider>("provider.openai", provider)
    }
}
fn info(mode: Mode) -> ModelInfo {
    ModelInfo {
        name: "gpt-6-luna".into(),
        context_window: 128000,
        output_limit: 8192,
        thinking: ["off", "minimal", "low", "medium", "high", "xhigh"]
            .map(str::to_owned)
            .to_vec(),
        keeps_state: mode == Mode::Stateful,
        runs_tools: false,
        extra: Value::Null,
    }
}
#[async_trait]
impl Provider for OpenAi {
    fn invalidate(&self, session: &str) {
        self.state.invalidate(session);
    }
    async fn erase_copies(&self, api: Api, sessions: &[String]) -> Result<Vec<String>> {
        let _gate = self.state.gate.lock().await;
        let mut reports = vec![];
        for session in sessions {
            self.state.invalidate(session);
            let mut inventory = self.state.load(session)?;
            if self.mode == Mode::Stateful
                || !inventory.responses.is_empty()
                || !inventory.uncertain.is_empty()
            {
                inventory.purge_pending = true;
                self.state.save(session, &inventory)?;
                self.purge(api.clone(), session, &mut inventory).await?;
                if !inventory.uncertain.is_empty() {
                    reports.push(format!("OpenAI requests without a received response ID: {} in session {session}; cannot delete by ID", inventory.uncertain.len()));
                }
                reports.push(
                    "OpenAI service-side logs and retention outside the response deletion API"
                        .into(),
                );
            }
        }
        reports.sort();
        reports.dedup();
        Ok(reports)
    }
    fn catalog(&self) -> Vec<ModelInfo> {
        vec![info(self.mode)]
    }
    fn bind(&self, model: &str) -> Result<Arc<dyn ModelAccess>> {
        ensure!(model == "gpt-6-luna", "only gpt-6-luna is allowed");
        Ok(Arc::new(Self {
            claim: self.claim.clone(),
            client: self.client.clone(),
            before: self.before.clone(),
            piece: self.piece.clone(),
            mode: self.mode,
            endpoint: self.endpoint.clone(),
            state: self.state.clone(),
        }))
    }
}
/// Official format: https://developers.openai.com/api/docs/guides/function-calling
pub fn request_body(request: &ModelRequest) -> Result<Value> {
    let mut input = vec![];
    for message in &request.messages {
        if message.role == "assistant" {
            if let Some(output) = message.opaque["output"].as_array() {
                input.extend(output.iter().cloned());
                continue;
            }
            let text = message.text_content();
            if !text.is_empty() {
                input.push(json!({"role":"assistant","content":text}));
            }
            for part in &message.parts {
                if let Part::ToolCall { call } = part {
                    input.push(json!({"type":"function_call","call_id":call.id,"name":call.name,"arguments":serde_json::to_string(&call.input)?}));
                }
            }
        } else if message.role == "tool" {
            input.push(json!({"type":"function_call_output","call_id":message.call,"output":message.text_content()}));
        } else {
            input.push(json!({"role":message.role,"content":message.text_content()}));
        }
    }
    let tools:Vec<_>=request.tools.iter().map(|t|json!({"type":"function","name":t.name,"description":t.description,"parameters":strict_schema(&t.input),"strict":true})).collect();
    // Keep shared levels in the catalog and history. Only the Responses API calls off "none".
    let effort = match request.thinking.as_str() {
        "" | "off" => "none",
        level => level,
    };
    Ok(
        json!({"model":"gpt-6-luna","instructions":request.system,"input":input,"tools":tools,"stream":true,"store":false,"include":["reasoning.encrypted_content"],"reasoning":{"effort":effort},"max_output_tokens":request.output_limit}),
    )
}
/// Vendor schema requirements stay inside this adapter. Null means omitted for
/// optional fields in the standard definition, not a new tool-source contract.
/// https://developers.openai.com/api/docs/guides/function-calling#strict-mode
fn strict_schema(schema: &Value) -> Value {
    let mut result = schema.clone();
    if let Some(properties) = schema["properties"].as_object() {
        let required = schema["required"].as_array().cloned().unwrap_or_default();
        let mut converted = serde_json::Map::new();
        for (name, field) in properties {
            let mut field = strict_schema(field);
            if !required.contains(&json!(name)) {
                field = json!({"anyOf":[field,{"type":"null"}]});
            }
            converted.insert(name.clone(), field);
        }
        result["properties"] = json!(converted);
        result["required"] = json!(properties.keys().collect::<Vec<_>>());
        result["additionalProperties"] = json!(false);
    }
    if schema.get("items").is_some() {
        result["items"] = strict_schema(&schema["items"]);
    }
    for key in ["anyOf", "oneOf", "allOf"] {
        if let Some(items) = schema[key].as_array() {
            result[key] = json!(items.iter().map(strict_schema).collect::<Vec<_>>());
        }
    }
    result
}
fn omit_optional_nulls(value: &mut Value, schema: &Value) {
    if let Some(object) = value.as_object_mut() {
        let required = schema["required"].as_array().cloned().unwrap_or_default();
        object.retain(|name, value| !value.is_null() || required.contains(&json!(name)));
        for (name, value) in object {
            omit_optional_nulls(value, &schema["properties"][name]);
        }
    } else if let Some(items) = value.as_array_mut() {
        for item in items {
            omit_optional_nulls(item, &schema["items"]);
        }
    }
}
pub fn normalize_for(request: &ModelRequest, response: &Value) -> Result<ModelResponse> {
    let mut result = normalize(response)?;
    for part in &mut result.parts {
        if let Part::ToolCall { call } = part
            && let Some(def) = request.tools.iter().find(|d| d.name == call.name)
        {
            omit_optional_nulls(&mut call.input, &def.input);
        }
    }
    Ok(result)
}
pub fn normalize(response: &Value) -> Result<ModelResponse> {
    let output = response["output"]
        .as_array()
        .ok_or_else(|| anyhow!("OpenAI response lacks output"))?;
    let mut parts = vec![];
    for item in output {
        match item["type"].as_str().unwrap_or("") {
            "message" => {
                for part in item["content"].as_array().into_iter().flatten() {
                    match part["type"].as_str().unwrap_or("") {
                        "output_text" => parts.push(Part::Text {
                            text: part["text"].as_str().unwrap_or("").into(),
                        }),
                        "refusal" => parts.push(Part::Text {
                            text: part["refusal"].as_str().unwrap_or("model refused").into(),
                        }),
                        other => parts.push(Part::Other {
                            name: other.into(),
                            data: part.clone(),
                        }),
                    }
                }
            }
            "function_call" => parts.push(Part::ToolCall {
                call: ToolCall {
                    id: item["call_id"]
                        .as_str()
                        .ok_or_else(|| anyhow!("missing tool call id"))?
                        .into(),
                    name: item["name"]
                        .as_str()
                        .ok_or_else(|| anyhow!("missing tool name"))?
                        .into(),
                    input: serde_json::from_str(item["arguments"].as_str().unwrap_or("{}"))?,
                    started_by: "model".into(),
                    extra: Value::Null,
                },
            }),
            "reasoning" => parts.push(Part::Reasoning { data: item.clone() }),
            other => parts.push(Part::Other {
                name: other.into(),
                data: item.clone(),
            }),
        }
    }
    let stop = if response["status"] == "incomplete" {
        "limit"
    } else if parts.iter().any(|p| matches!(p, Part::ToolCall { .. })) {
        "tools"
    } else {
        "finished"
    };
    Ok(ModelResponse {
        parts,
        opaque: json!({"output":output}),
        stop: stop.into(),
        usage_reported: response["usage"].is_object(),
        usage: Usage {
            input_tokens: response["usage"]["input_tokens"].as_u64().unwrap_or(0),
            output_tokens: response["usage"]["output_tokens"].as_u64().unwrap_or(0),
            cached_tokens: response["usage"]["input_tokens_details"]["cached_tokens"]
                .as_u64()
                .unwrap_or(0),
            ..Usage::default()
        },
    })
}
fn failure(error: &Value) -> ModelFailure {
    let code = error["code"].as_str().unwrap_or("");
    let kind = match code {
        "context_length_exceeded" | "context_window_exceeded" => FailureKind::ContextTooLarge,
        "invalid_api_key" | "authentication_error" => FailureKind::Credentials,
        "rate_limit_exceeded" | "server_error" => FailureKind::Temporary,
        "content_policy_violation" => FailureKind::Refused,
        _ => FailureKind::Other,
    };
    ModelFailure {
        kind,
        message: error["message"]
            .as_str()
            .unwrap_or("OpenAI request failed")
            .into(),
    }
}
mod client;
