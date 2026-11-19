//! Translate the SDK's shared ModelRequest and AssistantMessage to Responses API data.
use crate::{Model, Vendor};
use anyhow::{Result, anyhow};
use modular_agent::{AssistantMessage, ModelRequest};
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

fn input(vendor: Vendor, request: &ModelRequest) -> Result<Vec<Value>> {
    let mut input = vec![];
    for message in request.0["messages"].as_array().into_iter().flatten() {
        match message["role"].as_str().unwrap_or("user") {
            "assistant" => {
                let mut calls = parts(message).filter(|p| p["type"] == "toolCall");
                let data = &message["providerData"];
                if data["provider"] == vendor.id()
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
    vendor: Vendor,
    model: &Model,
    request: &ModelRequest,
    session: &str,
) -> Result<Value> {
    let mut input = input(vendor, request)?;
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
    let level = crate::LEVELS
        .iter()
        .position(|level| Some(*level) == request.0["settings"]["reasoning"].as_str())
        .and_then(|asked| {
            crate::LEVELS[..=asked]
                .iter()
                .rev()
                .find(|level| model.effort.contains_key(**level))
        });
    if let Some(effort) = level.and_then(|level| model.effort.get(*level)) {
        body["reasoning"] = json!({"effort": effort, "summary": "auto"});
    }
    match vendor {
        Vendor::Codex => {
            // The Codex backend sets its own output limit and refuses one.
            body["instructions"] = json!(if system.is_empty() {
                "You are a helpful assistant."
            } else {
                system
            });
            body["text"] = json!({"verbosity": "low"});
            body["prompt_cache_key"] = json!(session);
        }
        Vendor::Xai => {
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

pub fn response(vendor: Vendor, response: &Value) -> Result<AssistantMessage> {
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
        "providerData":{"provider":vendor.id(),"output":output},
        "usage":{
            "input":usage["input_tokens"].as_u64().unwrap_or(0),
            "output":usage["output_tokens"].as_u64().unwrap_or(0),
            "cacheRead":usage["input_tokens_details"]["cached_tokens"].as_u64().unwrap_or(0)
        }
    })))
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
    fn ask(thinking: &str, messages: Vec<Value>) -> ModelRequest {
        ModelRequest(json!({"systemPrompt":"Be brief.","messages":messages,
            "tools":[{"name":"codemode","description":"Run Python","parameters":{"type":"object"}}],
            "settings":{"reasoning":thinking,"maxOutput":4096}}))
    }
    fn message(role: &str, text: &str) -> Value {
        json!({"role":role,"content":[{"type":"text","text":text}]})
    }

    #[test]
    fn each_vendor_gets_the_request_shape_it_accepts() {
        let codex = request(
            Vendor::Codex,
            &model(Vendor::Codex, "gpt-6.1-sol"),
            &ask("minimal", vec![message("user", "hi")]),
            "s1",
        )
        .unwrap();
        assert_eq!(codex["instructions"], "Be brief.");
        assert_eq!(codex["reasoning"]["effort"], "low");
        assert_eq!(codex["prompt_cache_key"], "s1");
        assert!(codex.get("max_output_tokens").is_none());
        assert_eq!(codex["store"], false);
        assert_eq!(codex["input"], json!([{"role":"user","content":"hi"}]));
        // This model has no "off" and nothing lower: the level is left out, not raised.
        let off = request(
            Vendor::Codex,
            &model(Vendor::Codex, "gpt-6.1-sol"),
            &ask("off", vec![]),
            "s1",
        )
        .unwrap();
        assert!(off.get("reasoning").is_none());
        // Grok 4.7 lists low and up: "minimal" has nothing lower, and an
        // unknown name is left out too.
        for level in ["minimal", "max"] {
            let body = request(
                Vendor::Xai,
                &model(Vendor::Xai, "grok-4.7"),
                &ask(level, vec![]),
                "s1",
            )
            .unwrap();
            assert!(body.get("reasoning").is_none(), "{level}");
        }
        // A model with a gap takes the nearest level below it.
        let mut gapped = model(Vendor::Xai, "grok-4.7");
        gapped.effort.remove("high");
        let body = request(Vendor::Xai, &gapped, &ask("high", vec![]), "s1").unwrap();
        assert_eq!(body["reasoning"]["effort"], "medium");

        // An image in a tool result follows it as a user item.
        let result = json!({"role":"toolResult","toolCallId":"c1","content":[{"type":"text","text":"Read image file [image/png]"},{"type":"image","mimeType":"image/png","data":"AAAA"}]});
        let body = request(
            Vendor::Codex,
            &model(Vendor::Codex, "gpt-6.1-sol"),
            &ask("low", vec![result]),
            "s1",
        )
        .unwrap();
        assert_eq!(body["input"][0]["type"], "function_call_output");
        assert_eq!(body["input"][0]["output"], "Read image file [image/png]");
        assert_eq!(
            body["input"][1],
            json!({"role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,AAAA"}]})
        );

        let xai = request(
            Vendor::Xai,
            &model(Vendor::Xai, "grok-4.7"),
            &ask("high", vec![message("user", "hi")]),
            "s1",
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
        let mut assistant = response(Vendor::Codex, &raw).unwrap().0;
        assert_eq!(assistant["stop"], "toolUse");
        assert_eq!(assistant["usage"]["cacheRead"], 6);
        assert_eq!(assistant["content"][1]["arguments"], json!({"code":"1"}));
        assistant["content"][1]["id"] = json!("agent-id");
        let mut result = message("toolResult", "1");
        result["toolCallId"] = json!("agent-id");
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
