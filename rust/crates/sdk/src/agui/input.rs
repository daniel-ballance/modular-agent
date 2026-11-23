use super::*;
use axum::http::HeaderMap;
use base64_oauth::Engine;

pub(super) fn string<'a>(v: &'a Value, k: &str) -> R<&'a str> {
    v[k].as_str().ok_or(Fail::Invalid)
}
fn keep(v: &Value, keys: &[&str]) -> Value {
    Value::Object(
        keys.iter()
            .filter_map(|&k| v.get(k).map(|v| (k.into(), v.clone())))
            .collect(),
    )
}
fn optional(v: &Value, k: &str, check: fn(&Value) -> bool) -> R<()> {
    if v.get(k).is_none_or(check) {
        Ok(())
    } else {
        Err(Fail::Invalid)
    }
}
fn list(v: &Value, k: &str) -> R<Vec<Value>> {
    v.get(k)
        .map(|v| v.as_array().cloned().ok_or(Fail::Invalid))
        .transpose()
        .map(Option::unwrap_or_default)
}
fn part(v: &Value) -> R<Value> {
    let ty = string(v, "type")?;
    optional(v, "id", Value::is_string)?;
    let mut p = keep(v, &["type", "id", "metadata"]);
    match ty {
        "text" => {
            p["text"] = json!(string(v, "text")?);
        }
        "image" | "audio" | "video" | "document" => {
            let s = &v["source"];
            let kind = string(s, "type")?;
            string(s, "value")?;
            optional(s, "mimeType", Value::is_string)?;
            match kind {
                "data" => {
                    string(s, "mimeType")?;
                }
                "url" => (),
                "file" => optional(s, "provider", Value::is_string)?,
                _ => return Err(Fail::Invalid),
            }
            p["source"] = keep(s, &["type", "value", "mimeType", "provider"]);
        }
        _ => return Err(Fail::Invalid),
    }
    Ok(p)
}
fn message(v: &Value) -> R<Option<Value>> {
    let role = string(v, "role")?;
    string(v, "id")?;
    if matches!(role, "activity" | "reasoning") {
        return Ok(None);
    }
    for field in ["name", "subagentRunId", "encryptedValue"] {
        optional(v, field, Value::is_string)?;
    }
    optional(v, "metadata", Value::is_object)?;
    let mut m = keep(
        v,
        &[
            "id",
            "role",
            "name",
            "subagentRunId",
            "encryptedValue",
            "metadata",
        ],
    );
    match role {
        "user" | "tool" => {
            if let Some(parts) = v["content"].as_array() {
                m["content"] = Value::Array(parts.iter().map(part).collect::<R<_>>()?);
            } else {
                m["content"] = json!(string(v, "content")?);
            }
            if role == "tool" {
                m["toolCallId"] = json!(string(v, "toolCallId")?);
                if v.get("error").is_some() {
                    m["error"] = json!(string(v, "error")?);
                }
            }
        }
        "assistant" => {
            if v.get("content").is_some() {
                m["content"] = json!(string(v, "content")?);
            }
            if v.get("toolCalls").is_some() {
                m["toolCalls"]=Value::Array(list(v,"toolCalls")?.iter().map(|c|{if c["type"]!="function"{return Err(Fail::Invalid)}Ok(json!({"id":string(c,"id")?,"type":"function","function":{"name":string(&c["function"],"name")?,"arguments":string(&c["function"],"arguments")?}}))}).collect::<R<_>>()?);
            }
        }
        "system" | "developer" => m["content"] = json!(string(v, "content")?),
        _ => return Err(Fail::Invalid),
    }
    Ok(Some(m))
}
pub(super) fn content(v: &Value) -> R<Value> {
    if let Some(s) = v.as_str() {
        return Ok(base::wire::text_content(s));
    }
    let mut out = Vec::new();
    for part in v.as_array().ok_or(Fail::Invalid)? {
        let src = &part["source"];
        match part["type"].as_str() {
            Some("text") => out.push(json!({"type":"text","text":part["text"]})),
            Some("image") if src["type"] == "data" => {
                let mime = string(src, "mimeType")?;
                let data = string(src, "value")?;
                if !mime.strip_prefix("image/").is_some_and(|t| {
                    !t.is_empty()
                        && t.bytes()
                            .all(|c| c.is_ascii_alphanumeric() || b".+-_".contains(&c))
                }) || base64_oauth::engine::general_purpose::STANDARD
                    .decode(data)
                    .is_err()
                {
                    return Err(Fail::Invalid);
                }
                out.push(json!({"type":"image","mimeType":mime,"data":data}));
            }
            _ => warn("content.source"),
        }
    }
    Ok(Value::Array(out))
}
pub(super) struct Input {
    pub thread: String,
    pub run: String,
    pub messages: Vec<Value>,
    pub resume: Vec<Value>,
    pub tools: Vec<Value>,
}
impl Input {
    pub fn parse(v: Value) -> R<Self> {
        let version = string(&v, "protocolVersion")?;
        if version != "1.0" {
            if let Some((major, minor)) = version.split_once('.')
                && !major.is_empty()
                && major.bytes().all(|c| c.is_ascii_digit())
                && !minor.is_empty()
                && minor.bytes().all(|c| c.is_ascii_digit())
                && major != "1"
            {
                return Err(Fail::Version);
            }
            warn("protocolVersion");
        }
        let thread = string(&v, "threadId")?.to_owned();
        let run = string(&v, "runId")?.to_owned();
        if thread.is_empty() || run.is_empty() {
            return Err(Fail::Invalid);
        }
        optional(&v, "parentRunId", Value::is_string)?;
        let messages = v["messages"]
            .as_array()
            .ok_or(Fail::Invalid)?
            .iter()
            .filter_map(|v| message(v).transpose())
            .collect::<R<_>>()?;
        let tools=list(&v,"tools")?.iter().map(|t|{optional(t,"metadata",Value::is_object)?;Ok(json!({"name":string(t,"name")?,"description":string(t,"description")?,"parameters":t.get("parameters").cloned().unwrap_or(json!({}))}))}).collect::<R<_>>()?;
        let context = list(&v, "context")?;
        for c in &context {
            string(c, "description")?;
            string(c, "value")?;
        }
        if !context.is_empty() {
            warn("context");
        }
        let resume = list(&v, "resume")?;
        for a in &resume {
            string(a, "interruptId")?;
            if !matches!(a["status"].as_str(), Some("resolved" | "cancelled")) {
                return Err(Fail::Invalid);
            }
            optional(a, "metadata", Value::is_object)?;
        }
        Ok(Self {
            thread,
            run,
            messages,
            resume,
            tools,
        })
    }
}
pub(super) fn trace(a: &AguiActor, h: &HeaderMap) -> base::telemetry::Context {
    if !a.trust_trace_context {
        return Default::default();
    }
    let parent = h.get("traceparent").and_then(|v| v.to_str().ok());
    let state = h.get("tracestate").and_then(|v| v.to_str().ok());
    base::telemetry::extract_allowed(
        &json!({"traceparent":parent,"tracestate":state}),
        &a.trace_state_keys,
    )
    .unwrap_or_default()
}
