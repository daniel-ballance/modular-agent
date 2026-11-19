//! Serving a plugin over the plugin binding on stdio (docs/sdk/placement.md).
use crate::{
    error::{Code, Error, Result},
    plugin::{Gate, Plugin, Registrar, ToolBefore},
    tool::{Backend, ToolContext, ToolStatus, execute},
};
use agent_api as base;
use plugin_stdio::rpc::{Endpoint, Fault, Peer, Reply};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

const BINDING: &str = "modular-agent-plugin/1";
const SOURCE: &str = "tools";

/// Serve a plugin on stdin and stdout until the agent closes the connection. A plugin
/// program writes nothing else to stdout.
pub async fn serve(plugin: Plugin) -> Result<()> {
    let endpoint = Arc::new(Served {
        plugin,
        registered: Mutex::default(),
    });
    let peer = Peer::start(tokio::io::stdin(), tokio::io::stdout(), endpoint);
    peer.finished.cancelled().await;
    Ok(())
}

struct Served {
    plugin: Plugin,
    registered: Mutex<Option<Arc<Registrar>>>,
}

impl Served {
    fn registered(&self) -> std::result::Result<Arc<Registrar>, Fault> {
        self.registered
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| Fault::new("invalid_request", "initialize first"))
    }
}

fn registration(name: &str, replaces: &[String], r: &Registrar) -> Value {
    let mut v = json!({"binding": BINDING, "name": name, "replaces": replaces});
    if !r.tools.is_empty() {
        v["toolSources"] = json!([{"id": SOURCE, "tools": tools(r), "perSession": false}]);
    }
    if !r.tool_before.is_empty() {
        v["hooks"] = json!(
            (0..r.tool_before.len())
                .map(|i| json!({"hook": "tool.before", "handlerId": i + 1}))
                .collect::<Vec<_>>()
        );
    }
    v
}

fn tools(r: &Registrar) -> Vec<Value> {
    r.tools.iter().map(|t| t.definition()).collect()
}

#[async_trait::async_trait]
impl Endpoint for Served {
    async fn request(
        &self,
        peer: Arc<Peer>,
        id: Value,
        method: &str,
        p: Value,
        cancel: CancellationToken,
    ) -> Reply {
        match method {
            "plugin/initialize" => {
                if p["binding"] != BINDING || p["data"] != "modular-agent-data/1" {
                    return Err(Fault::new("not_supported", "unsupported binding"));
                }
                if self.registered.lock().unwrap().is_some() {
                    return Err(Fault::new("invalid_request", "already initialized"));
                }
                let config = if p["config"].is_object() {
                    p["config"].clone()
                } else {
                    json!({})
                };
                let r = self
                    .plugin
                    .register(&config)
                    .map_err(|e| Fault::new("invalid_request", e.message()))?;
                let v = registration(&self.plugin.name, &self.plugin.replaces, &r);
                *self.registered.lock().unwrap() = Some(Arc::new(r));
                Ok(v)
            }
            "plugin/shutdown" => Ok(json!({})),
            "tools/list" => {
                let r = self.registered()?;
                if p["toolSource"] != SOURCE || r.tools.is_empty() {
                    return Err(Fault::new("invalid_request", "unknown tool source"));
                }
                Ok(json!({"tools": tools(&r)}))
            }
            "tools/call" => {
                let r = self.registered()?;
                if p["toolSource"] != SOURCE {
                    return Err(Fault::new("invalid_request", "unknown tool source"));
                }
                let call = &p["call"];
                let Some(tool) = r.tools.iter().find(|t| call["name"] == t.name()) else {
                    return Err(Fault::new("invalid_request", "unknown tool"));
                };
                let cx = ToolContext {
                    session_id: p["sessionId"].as_str().unwrap_or_default().into(),
                    actor_id: call["actorId"].as_str().unwrap_or_default().into(),
                    call_id: call["id"].as_str().unwrap_or_default().into(),
                    backend: Backend::Remote { peer, parent: id },
                    cancelled: cancel.clone(),
                };
                let settled = execute(tool, call["input"].clone(), cx).await;
                if settled.status == ToolStatus::Cancelled && cancel.is_cancelled() {
                    return Err(Fault::new("cancelled", "tool cancelled"));
                }
                let text = if settled.status == ToolStatus::Refused {
                    base::ToolResult::refusal_text(&settled.text)
                } else {
                    settled.text
                };
                let mut result = json!({
                    "status": settled.status.as_str(),
                    "content": [{"type": "text", "text": text}],
                });
                if let Some(value) = settled.value {
                    result["value"] = value;
                }
                Ok(result)
            }
            "hook/handle" => {
                let r = self.registered()?;
                let handler = p["handlerId"]
                    .as_u64()
                    .filter(|_| p["hook"] == "tool.before")
                    .and_then(|i| r.tool_before.get((i as usize).checked_sub(1)?))
                    .ok_or_else(|| Fault::new("unknown_handler", "unknown handler"))?;
                let payload = &p["payload"];
                let before = ToolBefore {
                    session_id: payload["sessionId"].as_str().unwrap_or_default().into(),
                    call_id: payload["call"]["id"].as_str().unwrap_or_default().into(),
                    name: payload["call"]["name"].as_str().unwrap_or_default().into(),
                    input: payload["call"]["input"].clone(),
                };
                match handler(before).await {
                    Ok(Gate::Allow) => Ok(Value::Null),
                    Ok(Gate::Refuse(reason)) => Ok(json!({"refuse": reason})),
                    // The host treats a failed gate as a refusal.
                    Err(e) => Err(Fault::new(e.code().as_str(), e.message())),
                }
            }
            _ => Err(Fault::unknown(method)),
        }
    }
}

/// A binding error, as an SDK error with the same code.
pub(crate) fn from_fault(f: Fault) -> Error {
    let code = match f.code.as_str() {
        "invalid_request" => Code::InvalidRequest,
        "not_found" => Code::NotFound,
        "unknown_handler" => Code::UnknownHandler,
        "cancelled" => Code::Cancelled,
        "not_supported" => Code::NotSupported,
        "result_too_large" => Code::ResultTooLarge,
        "turn_limit" => Code::TurnLimit,
        "lost" => Code::Lost,
        _ => Code::Internal,
    };
    Error::new(code, f.message)
}
