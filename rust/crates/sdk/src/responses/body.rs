//! Translate the SDK's shared ModelRequest and AssistantMessage to Responses API data.
use super::{LEVELS, ResponsesFormat, ResponsesModel};
use crate::{AssistantMessage, ModelRequest};
use anyhow::{Result, anyhow};
use serde_json::{Value, json};

fn parts(message: &Value) -> impl Iterator<Item = &Value> {
    message["content"].as_array().into_iter().flatten()
}

fn text(message: &Value) -> String {
    parts(message)
        .filter(|p| p["type"] == "text")
        .filter_map(|p| p["text"].as_str())
        .collect::<Vec<_>>()
        .join("")
}

fn images(message: &Value) -> Vec<Value> {
    parts(message).filter(|p| p["type"] == "image")
        .filter_map(|p| Some(json!({"type":"input_image","image_url":format!("data:{};base64,{}", p["mimeType"].as_str()?, p["data"].as_str()?)})))
        .collect()
}

fn input(id: &str, request: &ModelRequest) -> Result<Vec<Value>> {
    let mut input = vec![];
    for message in request.0["messages"].as_array().into_iter().flatten() {
        match message["role"].as_str().unwrap_or("user") {
            "assistant" => {
                let mut calls = parts(message).filter(|p| p["type"] == "toolCall");
                let data = &message["providerData"];
                if data["provider"] == id
                    && let Some(output) = data["output"].as_array()
                {
                    for item in output {
                        let mut item = item.clone();
                        if item["type"] == "function_call"
                            && let Some(call) = calls.next()
                        {
                            item["call_id"] = call["id"].clone();
                        }
                        input.push(item);
                    }
                    continue;
                }
                let text = text(message);
                if !text.is_empty() {
                    input.push(json!({"role":"assistant","content":text}));
                }
                for call in calls {
                    input.push(json!({"type":"function_call","call_id":call["id"],"name":call["name"],"arguments":serde_json::to_string(&call["arguments"])?}));
                }
            }
            "toolResult" => {
                input.push(json!({"type":"function_call_output","call_id":message["toolCallId"],"output":text(message)}));
                let images = images(message);
                if !images.is_empty() {
                    input.push(json!({"role":"user","content":images}));
                }
            }
            role => {
                let mut images = images(message);
                let text = text(message);
                if images.is_empty() {
                    input.push(json!({"role":role,"content":text}));
                } else {
                    images.insert(0, json!({"type":"input_text","text":text}));
                    input.push(json!({"role":role,"content":images}));
                }
            }
        }
    }
    Ok(input)
}
pub fn request(
    id: &str,
    format: ResponsesFormat,
    model: &ResponsesModel,
    request: &ModelRequest,
    session: &str,
) -> Result<Value> {
    let mut input = input(id, request)?;
    let tools: Vec<_> = request.0["tools"].as_array().into_iter().flatten()
        .map(|t| json!({"type":"function","name":t["name"],"description":t["description"],"parameters":t["parameters"],"strict":false}))
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
    // A level the model does not list is lowered to the nearest it does, or
    // left out if there is none. It is never raised.
    let system = request.0["systemPrompt"].as_str().unwrap_or_default();
    let max_output = request.0["settings"]["maxOutput"]
        .as_u64()
        .unwrap_or_default();
    let level = LEVELS
        .iter()
        .position(|level| Some(*level) == request.0["settings"]["reasoning"].as_str())
        .and_then(|asked| {
            LEVELS[..=asked]
                .iter()
                .rev()
                .find(|level| model.effort.contains_key(**level))
        });
    if let Some(effort) = level.and_then(|level| model.effort.get(*level)) {
        body["reasoning"] = json!({"effort": effort, "summary": "auto"});
    }
    match format {
        ResponsesFormat::ChatGpt => {
            // The Codex backend sets its own output limit and refuses one.
            body["instructions"] = json!(if system.is_empty() {
                "You are a helpful assistant."
            } else {
                system
            });
            body["text"] = json!({"verbosity": "low"});
            body["prompt_cache_key"] = json!(session);
        }
        ResponsesFormat::SystemMessage => {
            if !system.is_empty() {
                input.insert(0, json!({"role":"system","content":system}));
            }
            if max_output > 0 {
                body["max_output_tokens"] = json!(max_output.min(model.max_tokens));
            }
        }
    }
    body["input"] = json!(input);
    Ok(body)
}

pub fn response(id: &str, response: &Value) -> Result<AssistantMessage> {
    let output = response["output"]
        .as_array()
        .ok_or_else(|| anyhow!("the model response has no output"))?;
    let mut parts = vec![];
    for item in output {
        match item["type"].as_str().unwrap_or("") {
            "message" => {
                for part in item["content"].as_array().into_iter().flatten() {
                    parts.push(match part["type"].as_str().unwrap_or("") {
                        "output_text" => json!({"type":"text","text":part["text"].as_str().unwrap_or("")}),
                        "refusal" => json!({"type":"text","text":part["refusal"].as_str().unwrap_or("model refused")}),
                        _ => part.clone(),
                    });
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
                let id = item["call_id"]
                    .as_str()
                    .ok_or_else(|| anyhow!("missing tool call id"))?;
                let name = item["name"]
                    .as_str()
                    .ok_or_else(|| anyhow!("missing tool name"))?;
                parts.push(json!({"type":"toolCall","id":id,"name":name,"arguments":input}));
            }
            "reasoning" => parts.push(json!({"type":"reasoning","data":item})),
            _ => parts.push(item.clone()),
        }
    }
    let stop = if response["status"] == "incomplete" {
        "length"
    } else if parts.iter().any(|p| p["type"] == "toolCall") {
        "toolUse"
    } else {
        "finished"
    };
    let usage = &response["usage"];
    Ok(AssistantMessage(json!({
        "role":"assistant", "content":parts, "stop":stop,
        "providerData":{"provider":id,"output":output},
        "usage":{
            "input":usage["input_tokens"].as_u64().unwrap_or(0),
            "output":usage["output_tokens"].as_u64().unwrap_or(0),
            "cacheRead":usage["input_tokens_details"]["cached_tokens"].as_u64().unwrap_or(0)
        }
    })))
}
