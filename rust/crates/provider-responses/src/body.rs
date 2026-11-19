//! The Responses API request and response, to and from the agent's shapes.
use crate::{Model, Vendor};
use agent_api::*;

/// The vendor's own output items are kept on the assistant message so its
/// reasoning can be sent back as it was. They are only ever returned to the
/// vendor that wrote them.
fn replayable(message: &Message, vendor: Vendor) -> Option<&Vec<Value>> {
    (message.opaque["provider"] == vendor.id())
        .then(|| message.opaque["output"].as_array())
        .flatten()
}

fn input(vendor: Vendor, request: &ModelRequest) -> Result<Vec<Value>> {
    let mut input = vec![];
    for message in &request.messages {
        match message.role.as_str() {
            "assistant" => {
                let calls: Vec<&ToolCall> = message
                    .parts
                    .iter()
                    .filter_map(|part| match part {
                        Part::ToolCall { call } => Some(call),
                        _ => None,
                    })
                    .collect();
                if let Some(output) = replayable(message, vendor) {
                    // The agent may have given a call its own id. The result
                    // that follows uses that id, so the call must too.
                    let mut calls = calls.iter();
                    for item in output {
                        let mut item = item.clone();
                        if item["type"] == "function_call"
                            && let Some(call) = calls.next()
                        {
                            item["call_id"] = json!(call.id);
                        }
                        input.push(item);
                    }
                    continue;
                }
                let text = message.text_content();
                if !text.is_empty() {
                    input.push(json!({"role":"assistant","content":text}));
                }
                for call in calls {
                    input.push(json!({"type":"function_call","call_id":call.id,"name":call.name,"arguments":serde_json::to_string(&call.input)?}));
                }
            }
            "tool" => input.push(
                json!({"type":"function_call_output","call_id":message.call,"output":message.text_content()}),
            ),
            role => input.push(json!({"role":role,"content":message.text_content()})),
        }
    }
    Ok(input)
}

pub fn request(vendor: Vendor, model: &Model, request: &ModelRequest) -> Result<Value> {
    let mut input = input(vendor, request)?;
    let tools: Vec<_> = request
        .tools
        .iter()
        .map(|t| json!({"type":"function","name":t.name,"description":t.description,"parameters":t.input,"strict":false}))
        .collect();
    let mut body = json!({
        "model": model.id,
        "stream": true,
        "store": false,
        "include": ["reasoning.encrypted_content"],
        "tool_choice": "auto",
        "parallel_tool_calls": true,
    });
    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }
    // A level the model does not accept is left out, never raised.
    if let Some(effort) = model.effort.get(&request.thinking) {
        body["reasoning"] = json!({"effort": effort, "summary": "auto"});
    }
    match vendor {
        Vendor::Codex => {
            // The Codex backend sets its own output limit and refuses one.
            body["instructions"] = json!(if request.system.is_empty() {
                "You are a helpful assistant."
            } else {
                request.system.as_str()
            });
            body["text"] = json!({"verbosity": "low"});
            body["prompt_cache_key"] = json!(request.session);
        }
        Vendor::Xai => {
            if !request.system.is_empty() {
                input.insert(0, json!({"role":"system","content":request.system}));
            }
            if request.output_limit > 0 {
                body["max_output_tokens"] = json!(request.output_limit.min(model.max_tokens));
            }
        }
    }
    body["input"] = json!(input);
    Ok(body)
}

pub fn response(vendor: Vendor, response: &Value) -> Result<ModelResponse> {
    let output = response["output"]
        .as_array()
        .ok_or_else(|| anyhow!("the model response has no output"))?;
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
            "function_call" => {
                let arguments = item["arguments"].as_str().unwrap_or("{}");
                let input: Value = if arguments.trim().is_empty() {
                    json!({})
                } else {
                    serde_json::from_str(arguments).map_err(|e| {
                        anyhow!("the model sent tool arguments that are not JSON: {e}")
                    })?
                };
                parts.push(Part::ToolCall {
                    call: ToolCall {
                        id: item["call_id"]
                            .as_str()
                            .ok_or_else(|| anyhow!("missing tool call id"))?
                            .into(),
                        name: item["name"]
                            .as_str()
                            .ok_or_else(|| anyhow!("missing tool name"))?
                            .into(),
                        input,
                        started_by: "model".into(),
                        extra: Value::Null,
                    },
                })
            }
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
    let usage = &response["usage"];
    Ok(ModelResponse {
        parts,
        opaque: json!({"provider": vendor.id(), "output": output}),
        stop: stop.into(),
        usage: Usage {
            input_tokens: usage["input_tokens"].as_u64().unwrap_or(0),
            output_tokens: usage["output_tokens"].as_u64().unwrap_or(0),
            cached_tokens: usage["input_tokens_details"]["cached_tokens"]
                .as_u64()
                .unwrap_or(0),
            ..Usage::default()
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog;

    fn model(vendor: Vendor, id: &str) -> Model {
        catalog(vendor, &Value::Null)
            .unwrap()
            .into_iter()
            .find(|m| m.id == id)
            .unwrap()
    }
    fn ask(thinking: &str, messages: Vec<Message>) -> ModelRequest {
        ModelRequest {
            session: "s1".into(),
            system: "Be brief.".into(),
            messages,
            tools: vec![ToolDefinition {
                name: "codemode".into(),
                description: "Run Python".into(),
                input: json!({"type":"object","properties":{"code":{"type":"string"}},"required":["code"]}),
                read_only: false,
                safe_to_repeat: false,
                parallel: false,
                hints: json!({}),
            }],
            thinking: thinking.into(),
            output_limit: 4096,
            extra: Value::Null,
        }
    }

    #[test]
    fn each_vendor_gets_the_request_shape_it_accepts() {
        let codex = request(
            Vendor::Codex,
            &model(Vendor::Codex, "gpt-6.1-sol"),
            &ask("minimal", vec![Message::text("user", "hi")]),
        )
        .unwrap();
        assert_eq!(codex["instructions"], "Be brief.");
        assert_eq!(codex["reasoning"]["effort"], "low");
        assert_eq!(codex["prompt_cache_key"], "s1");
        assert!(codex.get("max_output_tokens").is_none());
        assert_eq!(codex["store"], false);
        assert_eq!(codex["input"], json!([{"role":"user","content":"hi"}]));
        // This model has no "off": the level is left out, not raised.
        let off = request(
            Vendor::Codex,
            &model(Vendor::Codex, "gpt-6.1-sol"),
            &ask("off", vec![]),
        )
        .unwrap();
        assert!(off.get("reasoning").is_none());

        let xai = request(
            Vendor::Xai,
            &model(Vendor::Xai, "grok-4.7"),
            &ask("high", vec![Message::text("user", "hi")]),
        )
        .unwrap();
        assert!(xai.get("instructions").is_none());
        assert_eq!(
            xai["input"][0],
            json!({"role":"system","content":"Be brief."})
        );
        assert_eq!(xai["max_output_tokens"], 4096);
        assert_eq!(xai["tools"][0]["name"], "codemode");
    }

    #[test]
    fn vendor_items_return_only_to_their_vendor() {
        let raw = json!({"status":"completed","output":[
            {"type":"reasoning","id":"rs_1","encrypted_content":"opaque"},
            {"type":"function_call","call_id":"vendor-id","name":"codemode","arguments":"{\"code\":\"1\"}"}
        ],"usage":{"input_tokens":10,"output_tokens":4,"input_tokens_details":{"cached_tokens":6}}});
        let answer = response(Vendor::Codex, &raw).unwrap();
        assert_eq!(answer.stop, "tools");
        assert_eq!(answer.usage.cached_tokens, 6);
        let mut call = answer.tool_calls().remove(0);
        assert_eq!(call.input, json!({"code":"1"}));
        // The agent renames the call; the replayed item must follow.
        call.id = "agent-id".into();
        let assistant = Message {
            role: "assistant".into(),
            parts: vec![Part::ToolCall { call }],
            call: None,
            opaque: answer.opaque.clone(),
        };
        let mut result = Message::text("tool", "1");
        result.call = Some("agent-id".into());
        let history = vec![assistant, result];
        let same = input(Vendor::Codex, &ask("low", history.clone())).unwrap();
        assert_eq!(same[0]["encrypted_content"], "opaque");
        assert_eq!(same[1]["call_id"], "agent-id");
        assert_eq!(same[2]["call_id"], "agent-id");
        let other = input(Vendor::Xai, &ask("low", history)).unwrap();
        assert_eq!(other.len(), 2);
        assert_eq!(other[0]["type"], "function_call");
        assert_eq!(other[0]["call_id"], "agent-id");
        assert!(
            other
                .iter()
                .all(|item| item.get("encrypted_content").is_none())
        );
    }
}
