//! Serving a plugin over the plugin binding on stdio (docs/sdk/placement.md).
use crate::{
    error::{Code, Error, Result},
    plugin::{CommandContext, Plugin, Registrar, cannot_serve, command_reply},
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
    if let Some(item) = plugin.local_items.first() {
        return Err(cannot_serve(item));
    }
    let endpoint = Served::new(plugin);
    let peer = Peer::start(tokio::io::stdin(), tokio::io::stdout(), endpoint.clone());
    peer.finished.cancelled().await;
    endpoint.startup.lock().unwrap().take().map_or(Ok(()), Err)
}

pub(crate) struct Served {
    plugin: Plugin,
    registered: Mutex<Option<Arc<Registrar>>>,
    startup: Mutex<Option<Error>>,
}

impl Served {
    pub(crate) fn new(plugin: Plugin) -> Arc<Self> {
        Arc::new(Self {
            plugin,
            registered: Mutex::default(),
            startup: Mutex::default(),
        })
    }
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
    if !r.hooks.is_empty() {
        v["hooks"] = json!(
            r.hooks
                .iter()
                .enumerate()
                .map(|(i, hook)| {
                    json!({"hook":hook.point,"handlerId":i + 1,"order":hook.order.name()})
                })
                .collect::<Vec<_>>()
        );
    }
    if !r.commands.is_empty() {
        v["commands"] = json!(
            r.commands
                .iter()
                .map(|c| json!({"name":c.name,"description":c.description}))
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
                let mut registered = self.registered.lock().unwrap();
                if registered.is_some() {
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
                if let Err(e) = r.check_servable() {
                    let fault = Fault::new(e.code().as_str(), e.message());
                    *self.startup.lock().unwrap() = Some(e);
                    return Err(fault);
                }
                let v = registration(&self.plugin.name, &self.plugin.replaces, &r);
                *registered = Some(Arc::new(r));
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
                    settled: Default::default(),
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
                    .and_then(|i| r.hooks.get((i as usize).checked_sub(1)?))
                    .filter(|handler| p["hook"] == handler.point)
                    .ok_or_else(|| Fault::new("unknown_handler", "unknown handler"))?;
                (handler.handle)(p["payload"].clone())
                    .await
                    .map_err(to_fault)
            }
            "command/run" => {
                let r = self.registered()?;
                let command = r
                    .commands
                    .iter()
                    .find(|c| p["name"] == c.name)
                    .ok_or_else(|| Fault::new("not_found", "unknown command"))?;
                let cx = CommandContext {
                    session_id: p["sessionId"].as_str().unwrap_or_default().into(),
                    actor_id: p["actorId"].as_str().unwrap_or_default().into(),
                    cancelled: cancel,
                };
                let text = (command.run)(p["args"].as_str().unwrap_or_default().into(), cx)
                    .await
                    .map_err(to_fault)?;
                Ok(command_reply(text))
            }
            _ => Err(Fault::unknown(method)),
        }
    }
}

fn to_fault(e: Error) -> Fault {
    Fault::new(e.code().as_str(), e.message())
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
        "message_too_large" => Code::MessageTooLarge,
        "turn_limit" => Code::TurnLimit,
        "lost" => Code::Lost,
        _ => Code::Internal,
    };
    Error::new(code, f.message)
}
