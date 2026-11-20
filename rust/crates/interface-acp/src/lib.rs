//! ACP v1 stdio Interface. The official SDK owns framing, dispatch and requests.
//! Protocol: https://agentclientprotocol.com/protocol/v1/overview
mod binding;
mod events;
mod sessions;
mod transport;
use acp::{
    UntypedMessage,
    v1::{
        ConnectionTo,
        schema::{
            CloseSessionRequest, CreateElicitationRequest, InitializeRequest, ListSessionsRequest,
            LoadSessionRequest, NewSessionRequest, PromptRequest, RequestPermissionRequest,
            ResumeSessionRequest, SessionNotification, SetSessionConfigOptionRequest,
        },
    },
};
use agent_api::*;
use agent_client_protocol as acp;
pub use binding::{declaration, shared_question};
use sessions::Session;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

fn connection_actor() -> String {
    std::env::var("MODULAR_AGENT_ACTOR").unwrap_or_else(|_| ACP_HOST_ACTOR.into())
}

fn actor_scope(session: &str) -> Scope {
    Scope {
        actor: connection_actor().as_str().into(),
        ..Scope::session(session)
    }
}

/// The executable supplies composition and durable discovery, never turn logic.
#[async_trait]
pub trait Factory: Send + Sync {
    async fn declaration(&self) -> Result<Value>;
    async fn build(&self, project: &Path, sink: Arc<dyn EventSink>) -> Result<Api>;
    async fn build_for(
        &self,
        project: &Path,
        _session: Option<&str>,
        sink: Arc<dyn EventSink>,
    ) -> Result<Api> {
        self.build(project, sink).await
    }
    fn list(&self, project: Option<&Path>) -> Result<Vec<SessionData>>;
    fn trust(&self, project: &Path) -> Result<()>;
    /// The usual Factory builds one agent per session; an embedded agent shares one.
    fn owns_session_agent(&self) -> bool {
        true
    }
    fn session_declaration(&self, api: &dyn AgentApi, session: &str) -> Result<Value> {
        binding::declaration(api, Some(session))
    }
    fn project_settings(&self, _project: &Path) -> Result<Value> {
        Ok(json!({}))
    }
    async fn attach(&self, api: Api, session: &str, project: &Path, servers: Value) -> Result<()>;
    async fn detach(&self, api: Api, session: &str);
}
pub struct AcpPlugin {
    pub sink: Arc<dyn EventSink>,
}
impl Plugin for AcpPlugin {
    fn name(&self) -> &str {
        "interface.acp"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.provide::<dyn EventSink>("interface.acp", self.sink.clone())?;
        // Record the connection's authority before any durable turn recovers.
        r.on(
            "session.prepare",
            Order::First,
            handler(|api, scope, _| {
                Box::pin(async move {
                    sessions::join_host(api.as_ref(), &scope.session)?;
                    Ok(HookResult::default())
                })
            }),
        );
        r.declare(json!({"acp":{"version":1,"text":true,"permissions":true,"elicitation_form":true,"secret_answers":false,"actor":{"id":connection_actor().as_str(),"kind":"host"},"client_filesystem":false,"client_terminal":false}}));
        Ok(())
    }
}
struct State {
    factory: Arc<dyn Factory>,
    launch_declaration: Option<Value>,
    client: Mutex<Option<Value>>,
    binding_v2: std::sync::atomic::AtomicBool,
    sessions: Mutex<BTreeMap<String, Arc<Session>>>,
    rewind_blocks: Mutex<BTreeMap<PathBuf, String>>,
    setup: tokio::sync::Mutex<()>,
    opening: Mutex<std::collections::BTreeSet<String>>,
}
impl State {
    fn session(&self, p: &Value) -> Result<Arc<Session>> {
        self.sessions
            .lock()
            .unwrap()
            .get(string(p, "sessionId")?)
            .cloned()
            .ok_or_else(|| anyhow!("session not open on this connection"))
    }
    fn project_in_use(&self, project: &Path, except: &str) -> bool {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .any(|s| s.id != except && s.project == project)
    }
    async fn shutdown(&self) {
        let sessions = std::mem::take(&mut *self.sessions.lock().unwrap());
        for (_, session) in sessions {
            let _ = session.close().await;
            self.factory.detach(session.api.clone(), &session.id).await;
        }
    }
    async fn dispatch(
        &self,
        request: UntypedMessage,
        cx: ConnectionTo<acp::Client>,
    ) -> Result<Value> {
        let method = request.method.clone();
        let prompt = method == "session/prompt";
        let before = self.session(&request.params).ok();
        if request.method == "session/close"
            && let Some(session) = &before
        {
            let value = session
                .api
                .output(
                    &actor_scope(&session.id),
                    Output {
                        recipient: "interface.acp".into(),
                        value: json!({"method":method,"result":{}}),
                        stream: None,
                        end: true,
                    },
                )
                .await;
            self.request(request, cx).await?;
            return value
                .ok()
                .flatten()
                .and_then(|v| v.get("result").cloned())
                .ok_or_else(|| withheld().into());
        }
        let result = self.request(request, cx).await;
        if result.as_ref().err().is_some_and(|e| e.is::<acp::Error>())
            || matches!(
                method.as_str(),
                "session/load" | "session/resume" | "session/new"
            )
        {
            return result;
        }
        let session = before.or_else(|| result.as_ref().ok().and_then(|v| self.session(v).ok()));
        if let Some(session) = session {
            let failed = result.is_err();
            let value = result.unwrap_or_else(|error| json!({"error":error.to_string()}));
            let payload = json!({"method":method,"result":value});
            let gated = session
                .api
                .output(
                    &actor_scope(&session.id),
                    Output {
                        recipient: "interface.acp".into(),
                        value: payload.clone(),
                        stream: None,
                        end: true,
                    },
                )
                .await
                .ok()
                .flatten()
                .filter(|v| v.get("result").is_some())
                .ok_or_else(withheld)?;
            let mut value = gated["result"].clone();
            if method == "_modular-agent/requests"
                && let Some(questions) = value["requests"].as_array_mut()
            {
                binding::mark_poll_view(&session, &payload["result"]["requests"], questions)?;
                let mut routes = session.approval_views.lock().unwrap();
                for view in questions
                    .iter()
                    .filter(|q| q["kind"] == "approval" && q["answerable"] == true)
                {
                    if let Some(id) = view["id"].as_str() {
                        routes.insert((connection_actor().as_str().into(), id.into()));
                    }
                }
            } else if method == "_modular-agent/history" {
                binding::mark_history_views(&session, &payload["result"], &mut value)?;
            }
            if failed {
                let error = value["error"].as_str().ok_or_else(withheld)?;
                bail!("{error}");
            }
            let outcome = &value["_meta"]["modular-agent"]["outcome"];
            if prompt
                && self.binding_v2.load(std::sync::atomic::Ordering::Acquire)
                && outcome["kind"] == "failed"
            {
                return Err(acp::Error::new(
                    -32000,
                    outcome["error"].as_str().unwrap_or("turn failed"),
                )
                .data(json!({"_meta":value["_meta"]}))
                .into());
            }
            return Ok(value);
        }
        result
    }
    async fn request(
        &self,
        request: UntypedMessage,
        cx: ConnectionTo<acp::Client>,
    ) -> Result<Value> {
        let p = request.params;
        let mut method = request.method;
        if method == "initialize" {
            let _: InitializeRequest = serde_json::from_value(p.clone())?;
            if self.client.lock().unwrap().is_some() {
                return Err(
                    request_error("already_initialized", "connection already initialized").into(),
                );
            }
            if p["_meta"]
                .get("modular-agent")
                .is_some_and(|v| !v.is_object())
            {
                return Err(request_error("invalid_params", "invalid binding metadata").into());
            }
            let binding = p["_meta"]["modular-agent"]
                .get("binding")
                .map(|v| {
                    v.as_str()
                        .ok_or_else(|| request_error("invalid_params", "binding must be a string"))
                })
                .transpose()?
                .unwrap_or("modular-agent-acp/1");
            if p["protocolVersion"] != 1
                || !matches!(binding, "modular-agent-acp/1" | "modular-agent-acp/2")
            {
                return Err(request_error(
                    "unsupported_version",
                    "unsupported ACP or agent binding version",
                )
                .into());
            }
            let declaration = match &self.launch_declaration {
                Some(declaration) => declaration.clone(),
                None => self.factory.declaration().await?,
            };
            let mut client = self.client.lock().unwrap();
            if client.is_some() {
                return Err(
                    request_error("already_initialized", "connection already initialized").into(),
                );
            }
            self.binding_v2.store(
                binding == "modular-agent-acp/2",
                std::sync::atomic::Ordering::Release,
            );
            *client = Some(p["clientCapabilities"].clone());
            return Ok(
                json!({"protocolVersion":1,"agentInfo":{"name":"modular-agent-rs","version":"0.1.0"},"authMethods":[],
                "agentCapabilities":{"loadSession":true,"mcpCapabilities":{"http":true,"sse":false},"promptCapabilities":{"image":false,"audio":false,"embeddedContext":false},"sessionCapabilities":{"list":{},"resume":{},"close":{}}},
                "_meta":{"modular-agent":{"binding":binding,"declaration":declaration,"extensions":binding::EXTENSIONS,"actor":{"id":connection_actor().as_str(),"kind":"host","rights":Authority::full()}}}}),
            );
        }
        if self.client.lock().unwrap().is_none() {
            return Err(request_error("not_initialized", "initialize first").into());
        }
        if let Some(name) = method.strip_prefix("_modular-agent/") {
            if [
                "history",
                "input",
                "requests",
                "actors",
                "join",
                "leave",
                "release",
                "proposals",
                "withdraw",
                "limit",
                "tenant",
                "answer",
                "fork",
                "move",
                "erase",
                "jobs",
                "cancel-job",
                "declaration",
            ]
            .contains(&name)
            {
                if name == "move" && p["rewind"] == true {
                    // ACP may compose a different Harness for each session.
                    // Serialize project opens with rewind across those Harnesses.
                    let _setup = self.setup.lock().await;
                    let s = self.session(&p)?;
                    require(s.api.as_ref(), &actor_scope(&s.id), "settings")?;
                    if self.project_in_use(&s.project, &s.id) {
                        return Err(
                            request_error("conflict", "cannot rewind a shared project").into()
                        );
                    }
                    let result = binding::extension(s.clone(), name, &p).await;
                    if s.api.rewind_pending(&s.id).unwrap_or(false) {
                        self.rewind_blocks
                            .lock()
                            .unwrap()
                            .insert(s.project.clone(), s.id.clone());
                    }
                    return result;
                }
                return binding::extension(self.session(&p)?, name, &p).await;
            }
            // Build-specific extras retain their old shapes, now in the binding namespace.
            // Like every binding extension, they are scoped to an open session.
            self.session(&p)?;
            method = format!("_modular/{}", name.replace('-', "_"));
        }
        match method.as_str() {
            "session/new" | "session/load" | "session/resume" => {
                self.setup_session(&method, p, cx).await
            }
            "session/list" => {
                let _: ListSessionsRequest = serde_json::from_value(p.clone())?;
                ensure!(
                    p["cursor"].is_null(),
                    "no pagination cursor is issued by this agent"
                );
                let project = p["cwd"].as_str().map(PathBuf::from);
                if let Some(project) = &project {
                    ensure!(project.is_absolute(), "cwd must be absolute");
                }
                let mut sessions: BTreeMap<String, SessionData> = self
                    .factory
                    .list(project.as_deref())?
                    .into_iter()
                    .map(|s| (s.id.clone(), s))
                    .collect();
                for s in self.sessions.lock().unwrap().values() {
                    let data = s.api.snapshot(&s.id)?;
                    if data.entries.iter().all(|e| {
                        matches!(e.kind.as_str(), "command" | "plugins.changed" | "tenant")
                            || (e.kind == "actor.grant" && e.writer == "interface.acp")
                    }) {
                        continue;
                    }
                    if project
                        .as_ref()
                        .is_none_or(|p| p.canonicalize().ok().as_ref() == Some(&data.project))
                    {
                        sessions.insert(data.id.clone(), data);
                    }
                }
                Ok(
                    json!({"sessions":sessions.values().map(|s|json!({"sessionId":s.id,"cwd":s.project})).collect::<Vec<_>>()}),
                )
            }
            "session/close" => {
                let _: CloseSessionRequest = serde_json::from_value(p.clone())?;
                let session = self
                    .session(&p)
                    .map_err(|_| request_error("not_open", "session is not attached"))?;
                session.begin_close(true)?;
                let result = session.finish_close().await;
                self.factory.detach(session.api.clone(), &session.id).await;
                self.sessions.lock().unwrap().remove(&session.id);
                result?;
                Ok(json!({}))
            }
            "session/prompt" => {
                let _: PromptRequest = serde_json::from_value(p.clone())?;
                let session = self.session(&p)?;
                let parts = p["prompt"]
                    .as_array()
                    .ok_or_else(|| anyhow!("prompt must be an array"))?;
                ensure!(
                    parts.iter().all(|c| c["type"] == "text"),
                    "only text prompts are supported"
                );
                let text = parts
                    .iter()
                    .map(|c| c["text"].as_str().unwrap_or(""))
                    .collect::<Vec<_>>()
                    .join("\n");
                let key = p["_meta"]["modular-agent"]["key"]
                    .as_str()
                    .or_else(|| p["_meta"]["modular-agent-rs/inputKey"].as_str())
                    .map(str::to_string);
                session.prompt(&text, key).await
            }
            "session/set_config_option" => {
                let _: SetSessionConfigOptionRequest = serde_json::from_value(p.clone())?;
                let session = self.session(&p)?;
                ensure!(
                    !session.api.is_running(&session.id),
                    "settings cannot change during a turn"
                );
                // A driver flushing an already finished turn is not a running turn.
                let _guard = session.gate.lock().await;
                let name = string(&p, "configId")?;
                let value = string(&p, "value")?;
                match name {
                    "model" => {
                        let mut selected = None;
                        for key in session.api.capability_names("provider.") {
                            for info in
                                capability::<dyn Provider>(session.api.as_ref(), &key)?.catalog()
                            {
                                if binding::model_id(&key, &info.name) == value {
                                    selected = Some(info);
                                }
                            }
                        }
                        let info =
                            selected.ok_or_else(|| anyhow!("model not in Provider catalog"))?;
                        let thinking = session.api.snapshot(&session.id)?.settings["thinking"]
                            .as_str()
                            .unwrap_or("low")
                            .to_string();
                        let thinking = wire::lower_reasoning(&thinking, &info.thinking);
                        session.api.settings(
                            &actor_scope(&session.id),
                            json!({"model":info.name,"thinking":thinking}),
                        )?;
                    }
                    "approval" => {
                        let policy = match value {
                            "off" => "off",
                            "ask" => "ask_unless_read_only",
                            "all" => "ask_always",
                            "never" => "never_ask",
                            _ => bail!("unknown approval policy"),
                        };
                        session
                            .api
                            .settings(&actor_scope(&session.id), json!({"approval":policy}))?;
                    }
                    "thinking" => {
                        let model = capability::<dyn ModelSelection>(
                            session.api.as_ref(),
                            "model.selection",
                        )?
                        .select(session.api.clone(), &actor_scope(&session.id))
                        .await?;
                        ensure!(
                            model.info().thinking.iter().any(|level| level == value),
                            "unsupported thinking level"
                        );
                        session
                            .api
                            .settings(&actor_scope(&session.id), json!({"thinking":value}))?;
                    }
                    _ => bail!("unknown configuration option"),
                }
                let config = sessions::config(session.api.as_ref(), &session.id)?;
                let declaration = self
                    .factory
                    .session_declaration(session.api.as_ref(), &session.id)?;
                let update = session.api.output(&actor_scope(&session.id),Output {
                    recipient:"interface.acp".into(), value:json!({"sessionUpdate":"config_option_update","configOptions":config,"_meta":{"modular-agent":{"declaration":declaration}}}), stream:None, end:true,
                }).await?;
                if let Some(update) = update {
                    events::notify(&cx, &session.id, update)?;
                }
                Ok(
                    json!({"configOptions":config,"_meta":{"modular-agent":{"declaration":declaration}}}),
                )
            }
            "_modular/trust_project" => {
                ensure!(p["confirm"] == true, "trust requires explicit confirm=true");
                let project = Path::new(string(&p, "cwd")?);
                ensure!(project.is_absolute(), "cwd must be absolute");
                self.factory.trust(project)?;
                Ok(json!({"trusted":true,"applies":"new or reopened sessions"}))
            }
            method if method.starts_with("_modular/") => {
                let session = self.session(&p)?;
                let scope = actor_scope(&session.id);
                match method {
                    "_modular/declaration" => session.api.declaration(),
                    "_modular/history" => {
                        let mut view = session.api.history_view(&session.id).await?;
                        if let Some(after) = p["after"].as_str() {
                            let entries = view["entries"]
                                .as_array_mut()
                                .ok_or_else(|| anyhow!("history unavailable"))?;
                            let i = entries
                                .iter()
                                .position(|e| e["id"] == after)
                                .ok_or_else(|| anyhow!("unknown history point"))?;
                            entries.drain(..=i);
                        }
                        Ok(view)
                    }
                    "_modular/submit" => {
                        let timing: Timing = serde_json::from_value(
                            wire::optional(&p, "timing")
                                .cloned()
                                .unwrap_or(json!("after")),
                        )?;
                        Ok(json!(
                            session
                                .api
                                .submit(
                                    &session.id,
                                    connection_actor().as_str(),
                                    string(&p, "text")?,
                                    timing,
                                    p["key"].as_str().map(str::to_string)
                                )
                                .await?
                        ))
                    }
                    "_modular/withdraw" => Ok(json!(
                        session
                            .api
                            .withdraw(&session.id, string(&p, "input")?)
                            .await?
                    )),
                    "_modular/drain" => session.drain().await,
                    "_modular/commands" => Ok(json!(session.api.commands())),
                    "_modular/command" => {
                        let name = string(&p, "name")?;
                        let value = session
                            .api
                            .command(&scope, name, p["args"].as_str().unwrap_or(""))
                            .await?;
                        if name == "fork"
                            && let Some(id) = value["session"].as_str()
                        {
                            session.api.close(id).await?;
                        }
                        Ok(value)
                    }
                    "_modular/move" => {
                        ensure!(
                            p["rewind"] != true,
                            "rewinding outside state is not supported"
                        );
                        session
                            .api
                            .move_position(&scope, p["position"].as_str().map(str::to_string))?;
                        Ok(json!({"moved":true}))
                    }
                    "_modular/fork" => {
                        let _guard = session
                            .gate
                            .try_lock()
                            .map_err(|_| anyhow!("session busy"))?;
                        let fork = session
                            .api
                            .fork(&scope, p["position"].as_str().map(str::to_string))?;
                        session.api.close(&fork).await?;
                        Ok(json!({"sessionId":fork,"openWith":"session/resume"}))
                    }
                    "_modular/erase" => Ok(json!(
                        session
                            .api
                            .erase(&scope, serde_json::from_value(p["entries"].clone())?)
                            .await?
                    )),
                    "_modular/questions" => Ok(json!(requests(session.api.as_ref())?.visible(
                        session.api.as_ref(),
                        &session.id,
                        connection_actor().as_str()
                    )?)),
                    "_modular/answer" => {
                        let id = string(&p, "request")?;
                        let questions = requests(session.api.as_ref())?.visible(
                            session.api.as_ref(),
                            &session.id,
                            connection_actor().as_str(),
                        )?;
                        ensure!(
                            !questions
                                .iter()
                                .any(|q| q.id == id && q.kind == RequestKind::Secret),
                            "ACP does not accept secret answers"
                        );
                        requests(session.api.as_ref())?
                            .answer(
                                session.api.clone(),
                                &session.id,
                                connection_actor().as_str(),
                                id,
                                p["value"].clone(),
                                p["declined"] == true,
                            )
                            .await?;
                        Ok(json!({"accepted":true}))
                    }
                    "_modular/jobs" => Ok(json!(jobs(&session.api.snapshot(&session.id)?)?)),
                    "_modular/cancel_job" => Ok(json!(
                        job_service(session.api.as_ref())?
                            .cancel(
                                session.api.clone(),
                                &session.id,
                                connection_actor().as_str(),
                                string(&p, "job")?
                            )
                            .await?
                    )),
                    "_modular/tool" => {
                        let _guard = session
                            .gate
                            .try_lock()
                            .map_err(|_| anyhow!("session busy"))?;
                        let runtime: Arc<dyn Runtime> =
                            capability(session.api.as_ref(), "runtime")?;
                        let mut call: ToolCall = serde_json::from_value(p["call"].clone())?;
                        call.started_by = "ui".into();
                        let result = runtime.tool(session.api.clone(), scope, call).await?;
                        session.flush().await?;
                        Ok(json!(result))
                    }
                    _ => bail!("method not found"),
                }
            }
            _ => bail!("method not found"),
        }
    }
}
fn request_error(code: &str, message: &str) -> acp::Error {
    acp::Error::new(-32602, message).data(json!({"code":code}))
}
fn withheld() -> acp::Error {
    acp::Error::new(-32000, "response withheld by output gate").data(json!({"code":"withheld"}))
}
pub(crate) fn string<'a>(p: &'a Value, key: &str) -> Result<&'a str> {
    p[key]
        .as_str()
        .ok_or_else(|| anyhow!("missing or invalid {key}"))
}

/// Stdio is exclusively protocol output. Diagnostics belong on stderr.
pub async fn run(factory: Arc<dyn Factory>) -> Result<()> {
    if let Some(actor) = std::env::var_os("MODULAR_AGENT_ACTOR") {
        ensure!(
            actor.to_str().is_some_and(|id| !id.is_empty()),
            "MODULAR_AGENT_ACTOR must be a nonempty UTF-8 id"
        );
    }
    // Validate configured plugin startup before opening the ACP connection.
    // A failed launch must exit, not leave a connection with a substitute.
    let launch_declaration = if std::env::var_os("MODULAR_AGENT_PLUGINS").is_some() {
        Some(factory.declaration().await?)
    } else {
        None
    };
    let state = Arc::new(State {
        factory,
        launch_declaration,
        client: Mutex::new(None),
        binding_v2: false.into(),
        sessions: Mutex::default(),
        rewind_blocks: Mutex::default(),
        setup: tokio::sync::Mutex::new(()),
        opening: Mutex::default(),
    });
    let requests = state.clone();
    let notifications = state.clone();
    let closed = state.clone();
    let result = acp::Agent
        .v1()
        .on_receive_request(
            async move |request: UntypedMessage, responder, cx: ConnectionTo<acp::Client>| {
                // SDK callbacks are ordered dispatch work. Never await a turn here:
                // its permissions and cancel notifications must still be dispatched.
                // https://docs.rs/agent-client-protocol/5.3.0/agent_client_protocol/struct.ConnectionTo.html#method.spawn
                let requests = requests.clone();
                let connection = cx.clone();
                cx.spawn(async move {
                    let result = requests.dispatch(request, connection).await.map_err(|e| {
                        if let Some(error) = e.downcast_ref::<acp::Error>() {
                            error.clone()
                        } else if let Some(held) = e.downcast_ref::<HistoryHeld>() {
                            acp::Error::new(-32000, held.to_string())
                                .data(json!({"code":"held","retryAfterMs":held.retry_after_ms}))
                        } else if e.to_string() == "method not found" {
                            acp::Error::method_not_found()
                        } else {
                            let message = e.to_string();
                            let code = if message.starts_with("actor lacks ")
                                || message.starts_with("unknown tenant ")
                            {
                                "forbidden"
                            } else if message == "initial history append is too large" {
                                "result_too_large"
                            } else if matches!(
                                message.as_str(),
                                "session busy" | "settle pending work before moving or forking"
                            ) {
                                "busy"
                            } else {
                                "invalid_params"
                            };
                            acp::Error::new(-32602, message).data(json!({"code":code}))
                        }
                    });
                    responder.respond_with_result(result)
                })
            },
            acp::on_receive_request!(),
        )
        .on_receive_notification(
            async move |notification: UntypedMessage, _cx| {
                if notification.method == "session/cancel"
                    && let Ok(session) = notifications.session(&notification.params)
                    && require(session.api.as_ref(), &actor_scope(&session.id), "cancel").is_ok()
                {
                    let _ = session.cancel().await;
                }
                Ok(())
            },
            acp::on_receive_notification!(),
        )
        .on_close(async move |_cx| {
            closed.shutdown().await;
            Ok(())
        })
        .connect_to(transport::stdio())
        .await;
    state.shutdown().await;
    result.map_err(Into::into)
}
