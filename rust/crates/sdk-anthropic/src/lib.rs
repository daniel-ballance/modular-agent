//! A stateless Provider for the Anthropic Messages API.
use agent_api as base;
use modular_agent::ModelErrorKind as Kind;
use modular_agent::{ModelError, Piece, ProviderContext, async_trait};
pub use sdk_api_key::ApiKeyProvider;
use sdk_api_key::{Protocol, StreamDecoder, other};
use serde_json::{Value, json};

/// Use the Anthropic Messages API with `ANTHROPIC_API_KEY` from the default credential store.
pub fn anthropic() -> ApiKeyProvider {
    ApiKeyProvider::new(
        "anthropic",
        "https://api.anthropic.com/v1/messages",
        Messages,
    )
}

struct Messages;

impl Protocol for Messages {
    fn encode(&self, request: &base::ModelRequest) -> Result<Value, ModelError> {
        Ok(request_body(request))
    }

    fn authenticate(&self, request: reqwest::RequestBuilder, key: &str) -> reqwest::RequestBuilder {
        request
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
    }

    fn decode(
        &self,
        _: &base::ModelRequest,
        response: Value,
    ) -> Result<base::ModelResponse, ModelError> {
        normalize(response)
    }

    fn stream_decoder(&self) -> Box<dyn StreamDecoder> {
        Box::new(MessagesStream::default())
    }
}

fn request_body(r: &base::ModelRequest) -> Value {
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
fn normalize(raw: Value) -> Result<base::ModelResponse, ModelError> {
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

#[derive(Default)]
struct MessagesStream {
    message: Value,
    blocks: Vec<(Value, String)>,
}

#[async_trait]
impl StreamDecoder for MessagesStream {
    async fn event(
        &mut self,
        event: Value,
        cx: &ProviderContext,
    ) -> Result<Option<Value>, ModelError> {
        match event["type"].as_str() {
            Some("message_start") => self.message = event["message"].clone(),
            Some("content_block_start") => {
                if event["index"].as_u64() != Some(self.blocks.len() as u64) {
                    return Err(other("out of order Messages content"));
                }
                self.blocks
                    .push((event["content_block"].clone(), String::new()));
            }
            Some("content_block_delta") => {
                let (block, input) = event["index"]
                    .as_u64()
                    .and_then(|i| self.blocks.get_mut(i as usize))
                    .ok_or_else(|| other("unknown Messages block"))?;
                let delta = &event["delta"];
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
                self.message["stop_reason"] = event["delta"]["stop_reason"].clone();
                if let Some(usage) = event["usage"].as_object() {
                    for (k, v) in usage {
                        self.message["usage"][k] = v.clone();
                    }
                }
            }
            Some("message_stop") => {
                let mut parts = Vec::new();
                for (mut block, input) in self.blocks.drain(..) {
                    if !input.is_empty() {
                        block["input"] = serde_json::from_str(&input).map_err(other)?;
                    }
                    parts.push(block);
                }
                self.message["content"] = json!(parts);
                return Ok(Some(std::mem::take(&mut self.message)));
            }
            _ => (),
        }
        Ok(None)
    }
}
