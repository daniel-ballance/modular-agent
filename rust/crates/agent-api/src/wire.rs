//! Shared data translations. Opaque wire envelopes retain unknown fields.
use crate::*;
mod json;
pub use self::json::{JsonError, decode_json, json_eq, number_eq};
pub fn stream_id() -> String {
    crate::id()
}
fn merge_content(old: &Value, new: Vec<Value>) -> Value {
    json!(
        new.into_iter()
            .enumerate()
            .map(|(i, n)| {
                let mut v = old
                    .get(i)
                    .filter(|v| v["type"] == n["type"])
                    .cloned()
                    .unwrap_or(json!({}));
                merge(&mut v, n);
                v
            })
            .collect::<Vec<_>>()
    )
}
// Shared optional fields accept JSON null without stripping unknown fields.
pub fn optional<'a>(v: &'a Value, field: &str) -> Option<&'a Value> {
    v.get(field).filter(|value| !value.is_null())
}

pub fn string<'a>(v: &'a Value, field: &str) -> Result<&'a str> {
    v[field]
        .as_str()
        .ok_or_else(|| anyhow!("missing string {field}"))
}
pub fn content(parts: &[Part]) -> Vec<Value> {
    parts
        .iter()
        .map(|p| match p {
            Part::Text { text } => json!({"type":"text","text":text}),
            Part::ToolCall { call: c } => {
                let mut v = if c.extra.is_object() {
                    c.extra.clone()
                } else {
                    json!({})
                };
                merge(
                    &mut v,
                    json!({"type":"toolCall","id":c.id,"name":c.name,"arguments":c.input}),
                );
                v
            }
            Part::Reasoning { data } => {
                if data["type"] == "reasoning" {
                    data.clone()
                } else {
                    let mut part = json!({"type":"reasoning","providerData":data});
                    let readable: String = data["summary"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|s| s["text"].as_str())
                        .collect();
                    if !readable.is_empty() {
                        part["text"] = json!(readable);
                    }
                    part
                }
            }
            Part::Other { data, .. } => data.clone(),
        })
        .collect()
}
pub fn parts(content: &Value) -> Result<Vec<Part>> {
    content
        .as_array()
        .ok_or_else(|| anyhow!("content must be an array"))?
        .iter()
        .map(|p| {
            Ok(match p["type"].as_str() {
                Some("text") => Part::Text {
                    text: string(p, "text")?.into(),
                },
                Some("toolCall") => Part::ToolCall {
                    call: ToolCall {
                        id: string(p, "id")?.into(),
                        name: string(p, "name")?.into(),
                        input: p["arguments"].clone(),
                        started_by: "model".into(),
                        extra: p.clone(),
                    },
                },
                Some("reasoning") => Part::Reasoning {
                    data: p
                        .get("providerData")
                        .filter(|v| v["type"] == "reasoning" && v.get("summary").is_some())
                        .cloned()
                        .unwrap_or_else(|| p.clone()),
                },
                Some(kind) => Part::Other {
                    name: kind.into(),
                    data: p.clone(),
                },
                None => bail!("content part requires type"),
            })
        })
        .collect()
}
pub fn text(content: &Value) -> String {
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["type"] == "text")
        .filter_map(|p| p["text"].as_str())
        .collect()
}
/// Names from `WorkingEnvironment::list_dir` as shared DirEntry values. A
/// directory's name ends in '/'.
pub fn dir_entries(names: &[String]) -> Vec<Value> {
    names
        .iter()
        .map(|name| match name.strip_suffix('/') {
            Some(directory) => json!({"name":directory,"kind":"directory"}),
            None => json!({"name":name,"kind":"file"}),
        })
        .collect()
}
/// The reverse, for an environment reached over the wire.
pub fn dir_names(entries: &Value) -> Result<Vec<String>> {
    entries
        .as_array()
        .ok_or_else(|| anyhow!("entries must be an array"))?
        .iter()
        .map(|entry| {
            let name = string(entry, "name")?;
            Ok(if entry["kind"] == "directory" {
                format!("{name}/")
            } else {
                name.to_owned()
            })
        })
        .collect()
}
pub fn definition(d: &ToolDefinition) -> Value {
    let mut v = d
        .hints
        .get("_wire")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or(json!({}));
    v["name"] = json!(d.name);
    v["description"] = json!(d.description);
    v["parameters"] = d.input.clone();
    if !v["hints"].is_object() {
        v["hints"] = json!({});
    }
    if d.open_world() {
        v["hints"]["openWorld"] = json!(true);
    }
    v["hints"]["readOnly"] = json!(d.read_only);
    v["hints"]["safeToRepeat"] = json!(d.safe_to_repeat);
    v["parallel"] = json!(d.parallel);
    v
}
/// Preserve the registration as announced, including omitted optional fields.
pub fn registered_definition(d: &ToolDefinition) -> Value {
    d.hints
        .get("_wire")
        .cloned()
        .unwrap_or_else(|| definition(d))
}
pub fn parse_definition(v: &Value) -> Result<ToolDefinition> {
    Ok(ToolDefinition {
        name: string(v, "name")?.into(),
        description: string(v, "description")?.into(),
        input: v["parameters"].clone(),
        read_only: v["hints"]["readOnly"] == true,
        safe_to_repeat: v["hints"]["safeToRepeat"] == true,
        parallel: v["parallel"] == true,
        hints: json!({"_wire":v}),
    })
}
pub fn call(c: &ToolCall, scope: &Scope) -> Value {
    let mut v = if c.extra.is_object() {
        c.extra.clone()
    } else {
        json!({})
    };
    v.as_object_mut().unwrap().remove("type");
    v.as_object_mut().unwrap().remove("arguments");
    merge(
        &mut v,
        json!({"id":c.id,"name":c.name,"input":c.input,"startedBy":match c.started_by.as_str() {"model"|"provider"|"ui"|"plugin"|"tool"=>c.started_by.as_str(),_=>"ui"},"actorId":scope.actor,"stepId":scope.step}),
    );
    v
}
pub fn parse_call(v: &Value) -> Result<ToolCall> {
    Ok(ToolCall {
        id: string(v, "id")?.into(),
        name: string(v, "name")?.into(),
        input: v["input"].clone(),
        started_by: v["startedBy"].as_str().unwrap_or("plugin").into(),
        extra: v.clone(),
    })
}
pub fn status(s: &ToolStatus) -> &'static str {
    match s {
        ToolStatus::Waiting => "pending",
        ToolStatus::Completed => "completed",
        ToolStatus::Failed => "failed",
        ToolStatus::Refused => "refused",
        ToolStatus::Cancelled => "cancelled",
        ToolStatus::NotStarted => "notStarted",
        ToolStatus::Unknown => "outcomeUnknown",
    }
}
pub fn result(r: &ToolResult) -> Value {
    let mut v = r
        .value
        .as_ref()
        .and_then(|v| v.get("_pluginWire"))
        .cloned()
        .unwrap_or(json!({}));
    v["callId"] = json!(r.call);
    v["status"] = json!(status(&r.status));
    if v["content"].is_null() || text(&v["content"]) != r.text {
        v["content"] = json!([{"type":"text","text":r.text}]);
    }
    if v["value"].is_null()
        && r.value
            .as_ref()
            .is_none_or(|v| v.get("_pluginWire").is_none())
        && let Some(value) = &r.value
    {
        v["value"] = value.clone();
    }
    v
}
pub fn parse_result(v: Value, id: &str) -> Result<ToolResult> {
    if v["pending"].is_string() {
        return Ok(ToolResult {
            call: id.into(),
            status: ToolStatus::Waiting,
            text: v["pending"].as_str().unwrap().into(),
            value: None,
        });
    }
    ensure!(
        v["callId"].is_null() || v["callId"] == id,
        "tool result names a different call"
    );
    let status = match string(&v, "status")? {
        "completed" => ToolStatus::Completed,
        "failed" => ToolStatus::Failed,
        "refused" => ToolStatus::Refused,
        "cancelled" => ToolStatus::Cancelled,
        "notStarted" => ToolStatus::NotStarted,
        "outcomeUnknown" => ToolStatus::Unknown,
        _ => bail!("unknown tool status"),
    };
    Ok(ToolResult {
        call: id.into(),
        status,
        text: text(&v["content"]),
        value: Some(json!({"_pluginWire":v})),
    })
}
pub fn model(v: &Value, supports: &Value) -> Result<ModelInfo> {
    Ok(ModelInfo {
        name: format!("{}/{}", string(v, "provider")?, string(v, "id")?),
        context_window: v["contextWindow"].as_u64().unwrap_or(0),
        output_limit: v["maxOutput"].as_u64().unwrap_or(0),
        thinking: v["thinking"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_else(|| vec!["off".into()]),
        keeps_state: supports["keepsState"] == true,
        runs_tools: supports["runsTools"] == true,
        extra: v.clone(),
    })
}
pub fn model_value(m: &ModelInfo) -> Value {
    let (provider, id) = m.name.split_once('/').unwrap_or((&m.name, &m.name));
    let mut v = if m.extra.is_object() {
        m.extra.clone()
    } else {
        json!({"input":["text"]})
    };
    let reasoning = v["reasoning"]
        .as_bool()
        .unwrap_or_else(|| m.thinking.iter().any(|s| s != "off"));
    merge(
        &mut v,
        json!({"provider":provider,"id":id,"contextWindow":m.context_window,"maxOutput":m.output_limit,"reasoning":reasoning,"thinking":m.thinking}),
    );
    v
}
pub fn response(r: &ModelResponse) -> Value {
    let mut v = r.opaque.get("_pluginWire").cloned().unwrap_or(json!({}));
    v["role"] = json!("assistant");
    if v.get("providerData").is_none() {
        let mut data = r.opaque.clone();
        if let Some(fields) = data.as_object_mut() {
            fields.remove("_pluginWire");
            if !fields.is_empty() {
                v["providerData"] = data;
            }
        }
    }
    v["content"] = merge_content(&v["content"], content(&r.parts));
    v["stop"] = json!(match r.stop.as_str() {
        "tools" => "toolUse",
        "limit" => "length",
        s => s,
    });
    if !v["usage"].is_object() {
        v["usage"] = json!({});
    }
    merge(
        &mut v["usage"],
        json!({"input":r.usage.input_tokens,"output":r.usage.output_tokens,"cacheRead":r.usage.cached_tokens,"cacheWrite":r.usage.cache_write_tokens,"cost":r.usage.cost}),
    );
    v
}
pub fn parse_response(v: Value) -> Result<ModelResponse> {
    Ok(ModelResponse {
        parts: parts(&v["content"])?,
        opaque: {
            let mut data = v
                .get("providerData")
                .filter(|v| v.is_object())
                .cloned()
                .unwrap_or(json!({}));
            data["_pluginWire"] = v.clone();
            data
        },
        stop: match v["stop"].as_str().unwrap_or("finished") {
            "toolUse" => "tools",
            "length" => "limit",
            s => s,
        }
        .into(),
        usage: Usage {
            input_tokens: v["usage"]["input"].as_u64().unwrap_or(0),
            output_tokens: v["usage"]["output"].as_u64().unwrap_or(0),
            cached_tokens: v["usage"]["cacheRead"].as_u64().unwrap_or(0),
            cache_write_tokens: v["usage"]["cacheWrite"].as_u64().unwrap_or(0),
            cost: v["usage"]["cost"].as_f64().unwrap_or(0.0),
        },
    })
}
pub fn request(r: &ModelRequest, data: Option<&SessionData>) -> Value {
    project_request(r, data, ProviderData::Keep)
}

/// Project a request for the specified Provider, retaining opaque state
/// only when its recorded owner matches.
pub fn request_for_provider(r: &ModelRequest, data: Option<&SessionData>, provider: &str) -> Value {
    project_request(r, data, ProviderData::OwnedBy(provider))
}

enum ProviderData<'a> {
    Keep,
    OwnedBy(&'a str),
}
fn project_request(
    r: &ModelRequest,
    data: Option<&SessionData>,
    policy: ProviderData<'_>,
) -> Value {
    let mut calls = std::collections::BTreeMap::new();
    let messages: Vec<_> = r
        .messages
        .iter()
        .map(|m| {
            let mut v = m.opaque.get("_pluginWire").cloned().unwrap_or(json!({}));
            for part in &m.parts {
                if let Part::ToolCall { call } = part {
                    calls.insert(call.id.clone(), call.name.clone());
                }
            }
            v["role"] = json!(if m.role == "tool" {
                "toolResult"
            } else {
                &m.role
            });
            v["content"] = merge_content(&v["content"], content(&m.parts));
            let keep = match policy {
                ProviderData::Keep => true,
                ProviderData::OwnedBy(provider) => {
                    m.opaque["_providerOwner"].as_str() == Some(provider)
                }
            };
            // Native Providers store opaque state separately from their wire template.
            if m.role == "assistant"
                && keep
                && matches!(policy, ProviderData::OwnedBy(_))
                && v.get("providerData").is_none()
                && let Some(mut opaque) = m.opaque.as_object().cloned()
            {
                opaque.remove("_providerOwner");
                opaque.remove("_pluginWire");
                if !opaque.is_empty() {
                    v["providerData"] = Value::Object(opaque);
                }
            }
            if m.role == "assistant" && v["stop"].is_null() {
                v["stop"] = json!(
                    if m.parts.iter().any(|p| matches!(p, Part::ToolCall { .. })) {
                        "toolUse"
                    } else {
                        "finished"
                    }
                );
            }
            if m.role == "assistant" && !keep {
                omit_provider_data(&mut v);
            }
            if m.role == "tool" {
                v["toolCallId"] = json!(m.call);
                v["toolName"] = json!(m.call.as_ref().and_then(|id| calls.get(id)));
                if let Some(result) = data
                    .and_then(|d| {
                        d.entries
                            .iter()
                            .find(|e| e.kind == "tool.result" && e.scope.call == m.call)
                    })
                    .and_then(|e| e.content.clone())
                    .and_then(|v| serde_json::from_value::<ToolResult>(v).ok())
                {
                    v["content"] = self::result(&result)["content"].clone();
                    v["isError"] = json!(result.status != ToolStatus::Completed);
                } else {
                    v["isError"] = json!(false);
                }
            }
            v
        })
        .collect();
    let mut v = if r.extra.is_object() {
        r.extra.clone()
    } else {
        json!({})
    };
    v["systemPrompt"] = json!(r.system);
    v["messages"] = json!(messages);
    v["tools"] = json!(r.tools.iter().map(definition).collect::<Vec<_>>());
    if !v["settings"].is_object() {
        v["settings"] = json!({});
    }
    v["settings"]["reasoning"] = json!(r.thinking);
    v["settings"]["maxOutput"] = json!(r.output_limit);
    v
}
pub fn parse_request(v: &Value, session: &str) -> Result<ModelRequest> {
    let messages = v["messages"]
        .as_array()
        .ok_or_else(|| anyhow!("messages required"))?
        .iter()
        .map(|v| {
            Ok(Message {
                role: if v["role"] == "toolResult" {
                    "tool".into()
                } else {
                    string(v, "role")?.into()
                },
                parts: parts(&v["content"])?,
                call: v["toolCallId"].as_str().map(str::to_string),
                opaque: json!({"_pluginWire":v}),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(ModelRequest {
        session: session.into(),
        system: string(v, "systemPrompt")?.into(),
        messages,
        tools: v["tools"]
            .as_array()
            .into_iter()
            .flatten()
            .map(parse_definition)
            .collect::<Result<_>>()?,
        thinking: v["settings"]["reasoning"].as_str().unwrap_or("off").into(),
        output_limit: v["settings"]["maxOutput"].as_u64().unwrap_or(8192),
        extra: v.clone(),
    })
}
pub fn parse_usage(v: &Value) -> Usage {
    Usage {
        input_tokens: v["input"].as_u64().unwrap_or(0),
        output_tokens: v["output"].as_u64().unwrap_or(0),
        cached_tokens: v["cacheRead"].as_u64().unwrap_or(0),
        cache_write_tokens: v["cacheWrite"].as_u64().unwrap_or(0),
        cost: v["cost"].as_f64().unwrap_or(0.0),
    }
}
pub fn lower_reasoning<'a>(chosen: &str, accepted: &'a [String]) -> &'a str {
    const LEVELS: &[&str] = &["off", "minimal", "low", "medium", "high", "xhigh"];
    if let Some(level) = accepted.iter().find(|s| *s == chosen) {
        return level;
    }
    let rank = LEVELS.iter().position(|s| *s == chosen).unwrap_or(0);
    LEVELS[..rank]
        .iter()
        .rev()
        .find_map(|l| accepted.iter().find(|s| s == l).map(String::as_str))
        .unwrap_or("off")
}

pub fn turn_outcome(r: &TurnResult) -> Value {
    let mut outcome = json!({"kind":r.outcome});
    if let Some(error) = &r.error {
        outcome["error"] = json!(error);
    }
    if let Some(limit) = &r.limit {
        outcome["limit"] = json!(limit);
    }
    let mut result = json!({"text":r.text,"openToolCalls":r.open_calls.iter().map(|c| &c.id).collect::<Vec<_>>()});
    if let Some(value) = &r.value {
        result["value"] = value.clone();
    }
    json!({"outcome":outcome,"result":result})
}

pub fn parse_outcome(v: &Value, r: &Value, usage: &Value) -> Result<TurnResult> {
    Ok(TurnResult {
        outcome: match string(v, "kind")? {
            "completed" => Outcome::Completed,
            "cancelled" => Outcome::Cancelled,
            "failed" => Outcome::Failed,
            "limit" => Outcome::Limit,
            _ => bail!("unrecognized turn outcome"),
        },
        error: v["error"].as_str().map(str::to_owned),
        limit: v["limit"].as_str().map(str::to_owned),
        text: r["text"].as_str().unwrap_or_default().into(),
        value: r.get("value").cloned(),
        usage: parse_usage(usage),
        ..TurnResult::default()
    })
}
pub fn failure(error: &ModelFailure) -> Value {
    json!({"kind":match error.kind {
        FailureKind::Temporary=>"temporary",FailureKind::ContextTooLarge=>"contextTooLarge",FailureKind::Credentials=>"credentials",FailureKind::Refused=>"refused",_=>"other",
    },"message":error.message})
}
pub fn parse_failure(v: &Value) -> ModelFailure {
    ModelFailure {
        kind: match v["kind"].as_str() {
            Some("temporary") => FailureKind::Temporary,
            Some("contextTooLarge") => FailureKind::ContextTooLarge,
            Some("credentials") => FailureKind::Credentials,
            Some("refused") => FailureKind::Refused,
            _ => FailureKind::Other,
        },
        message: v["message"].as_str().unwrap_or_default().into(),
    }
}
pub fn model_request_record(info: &ModelInfo) -> Value {
    let (provider, id) = info
        .name
        .split_once('/')
        .unwrap_or((crate::portable::native_provider(&info.name), &info.name));
    json!({"model":{"provider":provider,"id":id},"safeToRepeat":!info.keeps_state && !info.runs_tools,"keeps_state":info.keeps_state,"runs_tools":info.runs_tools})
}
/// Remove only reserved Provider data, not arbitrary tool inputs or values.
pub fn omit_provider_data(message: &mut Value) {
    if let Some(fields) = message.as_object_mut() {
        fields.remove("providerData");
    }
    if let Some(content) = message["content"].as_array_mut() {
        content.retain_mut(|part| {
            if part["type"] != "reasoning" {
                return true;
            }
            if let Some(fields) = part.as_object_mut() {
                fields.remove("providerData");
            }
            part["text"].is_string()
        });
    }
}

pub use crate::portable::{entry, public_entry};
