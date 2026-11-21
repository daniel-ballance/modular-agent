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

tokio::task_local! { static CATALOG_PARENT: Value; }

/// Serve a plugin on stdin and stdout until the agent closes the connection. A plugin
/// program writes nothing else to stdout.
pub async fn serve(plugin: Plugin) -> Result<()> {
    if let Some(item) = plugin.local_items.first() {
        return Err(cannot_serve(item));
    }
    let endpoint = Served::new(plugin);
    let peer = Peer::start(tokio::io::stdin(), tokio::io::stdout(), endpoint.clone());
    peer.finished.cancelled().await;
    endpoint.startup_error().map_or(Ok(()), Err)
}

/// Options for serving a plugin as an authenticated service.
#[derive(Clone, Debug)]
pub struct ServeOptions {
    pub listen: String,
    pub token_file: std::path::PathBuf,
    pub tls: Option<crate::TlsOptions>,
}

/// Serve a fresh plugin instance on each authenticated WebSocket connection.
pub async fn serve_websocket(
    plugin: Plugin,
    options: ServeOptions,
) -> Result<crate::WebSocketServer> {
    if let Some(item) = plugin.local_items.first() {
        return Err(cannot_serve(item));
    }
    Ok(plugin_stdio::server::serve_websocket(
        &options.listen,
        options.token_file,
        options.tls,
        move || Served::new(plugin.clone()),
    )
    .await?)
}

/// Build fresh plugin state for each authenticated connection. Static registrations
/// are checked during that connection's initialize, not by calling the factory twice.
pub async fn serve_websocket_factory(
    factory: impl Fn() -> Plugin + Send + Sync + 'static,
    options: ServeOptions,
) -> Result<crate::WebSocketServer> {
    Ok(plugin_stdio::server::serve_websocket(
        &options.listen,
        options.token_file,
        options.tls,
        move || Served::new(factory()),
    )
    .await?)
}

pub(crate) struct Served {
    plugin: Plugin,
    registered: Mutex<Option<Arc<Registrar>>>,
    initializing: tokio::sync::Mutex<()>,
    startup: Mutex<Option<Error>>,
    environment: Mutex<Option<Arc<plugin_stdio::server::EnvironmentServer>>>,
}

impl Served {
    pub(crate) fn new(plugin: Plugin) -> Arc<Self> {
        Arc::new(Self {
            plugin,
            registered: Mutex::default(),
            initializing: tokio::sync::Mutex::new(()),
            startup: Mutex::default(),
            environment: Mutex::default(),
        })
    }
    pub(crate) fn startup_error(&self) -> Option<Error> {
        self.startup.lock().unwrap().take()
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
    if let Some(env) = &r.environment {
        let native = env.declaration();
        let containment = match native["containment"].as_str() {
            Some("strong" | "processGroup") => native["containment"].clone(),
            _ => json!("none"),
        };
        let mut registration = json!({
            "containment":containment,
            "points":native["rewinding"] == true,
            "confinesFiles":native["confines_files"] == true,
        });
        // A native declaration applies to the current platform.
        let platform = match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            platform => platform,
        };
        if containment != "none" {
            registration["platforms"] = json!([platform]);
        }
        v["workingEnvironment"] = registration;
    }
    if !r.providers.is_empty() {
        v["providers"] = json!(r.providers.iter().map(|p| {
            let support = p.supports();
            json!({"id":p.id(),"models":p.models(),"supports":{"keepsState":support.keeps_state,"runsTools":false,"safeToRepeat":support.safe_to_repeat}})
        }).collect::<Vec<_>>());
    }
    let mut sources = Vec::new();
    if !r.tools.is_empty() {
        sources.push(json!({"id": SOURCE, "tools": definitions(&r.tools), "perSession": false}));
    }
    for (id, source) in &r.sources {
        let per_session = source.per_session();
        let tools = if per_session {
            vec![]
        } else {
            definitions(&source.tools(""))
        };
        sources.push(json!({"id": id, "tools": tools, "perSession": per_session}));
    }
    if !sources.is_empty() {
        v["toolSources"] = json!(sources);
    }
    let mut hooks = r
        .hooks
        .iter()
        .enumerate()
        .map(|(i, hook)| json!({"hook":hook.point,"handlerId":i + 1,"order":hook.order.name()}))
        .collect::<Vec<_>>();
    if r.jobs.as_ref().is_some_and(crate::jobs::Owner::can_resume) {
        hooks.push(json!({"hook":"session.start","handlerId":hooks.len()+1}));
    }
    if !hooks.is_empty() {
        v["hooks"] = json!(hooks);
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

fn definitions(tools: &[crate::Tool]) -> Vec<Value> {
    tools.iter().map(|t| t.definition()).collect()
}

fn tools(r: &Registrar, params: &Value) -> std::result::Result<Vec<crate::Tool>, Fault> {
    if params["toolSource"] == SOURCE && !r.tools.is_empty() {
        return Ok(r.tools.clone());
    }
    let (_, source) = r
        .sources
        .iter()
        .find(|(name, _)| params["toolSource"] == *name)
        .ok_or_else(|| Fault::new("invalid_request", "unknown tool source"))?;
    let session = if source.per_session() {
        params["sessionId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| Fault::new("invalid_request", "session required for tool source"))?
    } else {
        ""
    };
    let list = source.tools(session);
    if let Some(tool) = list.iter().find(|tool| tool.in_process_only) {
        return Err(Fault::new(
            "not_supported",
            format!("tool:{} is in-process only", tool.name()),
        ));
    }
    Ok(list)
}

#[async_trait::async_trait]
impl Endpoint for Served {
    async fn disconnected(&self) {
        self.environment.lock().unwrap().take();
        let loaded = self.registered.lock().unwrap().take().is_some();
        if loaded
            && let Some(stop) = &self.plugin.stop
            && let Err(e) = stop().await
        {
            eprintln!("plugin {} failed to stop: {e}", self.plugin.name());
        }
    }

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
                if let Some(item) = self.plugin.local_items.first() {
                    let e = cannot_serve(item);
                    let fault = Fault::new(e.code().as_str(), e.message());
                    *self.startup.lock().unwrap() = Some(e);
                    return Err(fault);
                }
                let _initializing = self.initializing.lock().await;
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
                if let Err(e) = r.check_servable() {
                    let fault = Fault::new(e.code().as_str(), e.message());
                    *self.startup.lock().unwrap() = Some(e);
                    return Err(fault);
                }
                // The binding has no catalog-changed notification. The host can
                // re-read provider/models; do not invent a private wire message.
                for provider in &r.providers {
                    provider.catalog_notifier(crate::CatalogNotifier::default());
                }
                for (name, source) in &r.sources {
                    let (name, peer) = (name.clone(), Arc::downgrade(&peer));
                    source.catalog_notifier(crate::ToolsChanged(Arc::new(move || {
                        if let Some(peer) = peer.upgrade() {
                            let mut params = json!({"toolSource":name});
                            if let Ok(id) = CATALOG_PARENT.try_with(Clone::clone) {
                                params["parentRequestId"] = id;
                            }
                            peer.notify("tools/changed", params);
                        }
                    })));
                }
                let v = registration(&self.plugin.name, &self.plugin.replaces, &r);
                if r.environment.is_some() {
                    let env = plugin_stdio::server::EnvironmentServer::new(peer, &p).await?;
                    *self.environment.lock().unwrap() = Some(Arc::new(env));
                }
                *self.registered.lock().unwrap() = Some(Arc::new(r));
                Ok(v)
            }
            "plugin/shutdown" => Ok(json!({})),
            "env/read" | "env/exists" | "env/write" | "env/list" | "env/exec" | "env/save"
            | "env/checkPoint" | "env/restore" | "env/sessionEnded" => {
                let r = self.registered()?;
                let env = r
                    .environment
                    .as_ref()
                    .ok_or_else(|| Fault::new("not_supported", "no environment registered"))?;
                let server =
                    self.environment.lock().unwrap().clone().ok_or_else(|| {
                        Fault::new("invalid_request", "environment not initialized")
                    })?;
                server.request(env.clone(), &id, method, &p, cancel).await
            }
            "provider/models" | "provider/available" | "provider/discard" | "provider/request" => {
                let r = self.registered()?;
                let provider = r
                    .providers
                    .iter()
                    .find(|pv| p["provider"] == pv.id())
                    .ok_or_else(|| Fault::new("invalid_request", "unknown Provider"))?;
                match method {
                    "provider/models" => Ok(json!({"models":provider.models()})),
                    "provider/available" => Ok(json!({"available":provider.available()})),
                    "provider/discard" => {
                        let session = p["sessionId"]
                            .as_str()
                            .filter(|s| !s.is_empty())
                            .ok_or_else(|| Fault::new("invalid_request", "session required"))?;
                        provider.discard_state(session).await.map_err(to_fault)?;
                        Ok(json!({}))
                    }
                    _ => {
                        let model: crate::ModelRef = serde_json::from_value(p["model"].clone())
                            .map_err(|_| Fault::new("invalid_request", "invalid ModelRef"))?;
                        if model.provider != provider.id()
                            || !provider.models().iter().any(|info| info.model == model)
                        {
                            return Err(Fault::new("invalid_request", "unknown model"));
                        }
                        if !provider.available() {
                            return Err(Fault::new("invalid_request", "Provider is unavailable"));
                        }
                        let session = p["sessionId"].as_str().filter(|s| !s.is_empty());
                        if (!p["sessionId"].is_null() && session.is_none())
                            || (provider.supports().keeps_state && session.is_none())
                            || !p["request"].is_object()
                        {
                            return Err(Fault::new("invalid_request", "invalid Provider request"));
                        }
                        let payload = json!({"sessionId":session,"provider":provider.id(),"model":model,"request":p["request"]});
                        let transformed = peer.call("host/hook", json!({"parentRequestId":id,"hook":"provider.request","payload":payload}),
                            None, cancel.clone()).await?;
                        let done = CancellationToken::new();
                        let _guard = done.clone().drop_guard();
                        let cx = crate::ProviderContext::remote(
                            peer.clone(),
                            id.clone(),
                            session.unwrap_or_default().into(),
                            provider.id().into(),
                            cancel.clone(),
                            done.clone(),
                        );
                        let message = tokio::select! {
                            biased;
                            _ = cancel.cancelled() => return Err(Fault::new("cancelled", "Provider request cancelled")),
                            message = provider.request(model.clone(), crate::ModelRequest(transformed["request"].clone()), cx) => {
                                message.unwrap_or_else(|e| crate::ModelError::new(crate::ModelErrorKind::Other, e.message()).failed()).0
                            }
                        };
                        done.cancel();
                        if cancel.is_cancelled() {
                            return Err(Fault::new("cancelled", "Provider request cancelled"));
                        }
                        peer.call("host/hook", json!({"parentRequestId":id,"hook":"provider.response",
                            "payload":{"sessionId":session,"provider":provider.id(),"model":model,"message":message}}),
                            None, cancel).await?;
                        Ok(message)
                    }
                }
            }
            "tools/list" => {
                let r = self.registered()?;
                Ok(json!({"tools": definitions(&tools(&r, &p)?)}))
            }
            "tools/call" => {
                let r = self.registered()?;
                let call = &p["call"];
                let available = tools(&r, &p)?;
                let Some(tool) = available.iter().find(|t| call["name"] == t.name()) else {
                    return Err(Fault::new("invalid_request", "unknown tool"));
                };
                let cx = ToolContext {
                    jobs: r
                        .jobs
                        .clone()
                        .map(|owner| (self.plugin.name.clone(), owner)),
                    project: p["project"].as_str().unwrap_or_default().into(),
                    session_id: p["sessionId"].as_str().unwrap_or_default().into(),
                    actor_id: call["actorId"].as_str().unwrap_or_default().into(),
                    call_id: call["id"].as_str().unwrap_or_default().into(),
                    backend: Backend::Remote {
                        peer,
                        parent: id.clone(),
                    },
                    cancelled: cancel.clone(),
                    settled: Default::default(),
                    asks: Default::default(),
                };
                let Some(settled) = CATALOG_PARENT
                    .scope(id, execute(tool, call["input"].clone(), cx))
                    .await
                else {
                    return Ok(json!({"pending":"question left open"}));
                };
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
                    "content": settled.content.unwrap_or_else(|| vec![json!({"type":"text","text":text})]),
                });
                if let Some(value) = settled.value {
                    result["value"] = value;
                }
                Ok(result)
            }
            "hook/handle" => {
                let r = self.registered()?;
                if p["hook"] == "session.start"
                    && p["handlerId"] == r.hooks.len() + 1
                    && let Some(owner) = r.jobs.as_ref().filter(|owner| owner.can_resume())
                {
                    let session = base::wire::string(&p["payload"], "sessionId")?;
                    let backend = Backend::Remote { peer, parent: id };
                    for job in owner
                        .unfinished(&backend, &self.plugin.name, session)
                        .await
                        .map_err(to_fault)?
                    {
                        owner.resume(job).await.map_err(to_fault)?;
                    }
                    return Ok(Value::Null);
                }
                let handler = p["handlerId"]
                    .as_u64()
                    .and_then(|i| r.hooks.get((i as usize).checked_sub(1)?))
                    .filter(|handler| p["hook"] == handler.point)
                    .ok_or_else(|| Fault::new("unknown_handler", "unknown handler"))?;
                let context = crate::HookContext::remote(
                    Backend::Remote { peer, parent: id },
                    &p["payload"],
                    cancel,
                );
                let _guard = context.settled.clone().drop_guard();
                match (handler.handle)(p["payload"].clone(), context).await {
                    Err(e)
                        if matches!(
                            handler.point,
                            "plugin.load" | "tool.before" | "step.after" | "turn.result"
                        ) =>
                    {
                        Ok(json!({"refuse":e.message()}))
                    }
                    Ok(reply) if handler.point == "input" && reply["command"].is_string() => Err(
                        Fault::new("not_supported", "input commands are in-process only"),
                    ),
                    Ok(reply) if reply.get("pendingQuestion").is_some() => Err(Fault::new(
                        "not_supported",
                        "tool gate questions are in-process only",
                    )),
                    result => result.map_err(to_fault),
                }
            }
            "command/run" => {
                let r = self.registered()?;
                let command = r
                    .commands
                    .iter()
                    .find(|c| p["name"] == c.name)
                    .ok_or_else(|| Fault::new("not_found", "unknown command"))?;
                let settled = CancellationToken::new();
                let _guard = settled.clone().drop_guard();
                let work = ToolContext {
                    jobs: r
                        .jobs
                        .clone()
                        .map(|owner| (self.plugin.name.clone(), owner)),
                    project: p["project"].as_str().unwrap_or_default().into(),
                    session_id: p["sessionId"].as_str().unwrap_or_default().into(),
                    actor_id: p["actorId"].as_str().unwrap_or_default().into(),
                    call_id: String::new(),
                    backend: Backend::Remote { peer, parent: id },
                    cancelled: cancel.clone(),
                    settled,
                    asks: Default::default(),
                };
                let cx = CommandContext {
                    session_id: work.session_id.clone(),
                    actor_id: work.actor_id.clone(),
                    cancelled: cancel,
                    model: None,
                    work,
                    can_ask: false,
                };
                let text = (command.run)(p["args"].as_str().unwrap_or_default().into(), cx)
                    .await
                    .map_err(to_fault)?;
                Ok(command_reply(text))
            }
            "jobs/cancel" => {
                let r = self.registered()?;
                let owner = r
                    .jobs
                    .as_ref()
                    .ok_or_else(|| Fault::new("invalid_request", "no job owner registered"))?;
                owner
                    .cancel_id(base::wire::string(&p, "jobId")?)
                    .await
                    .map_err(to_fault)?;
                Ok(json!({}))
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
