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

/// Operator-selected principal and scope for a single ACP connection.
#[derive(Clone)]
pub struct Identity {
    pub id: String,
    pub kind: String,
    pub rights: Authority,
    pub tenants: Option<Vec<Option<String>>>,
    pub projects: Option<Vec<PathBuf>>,
    pub represents: Vec<String>,
    pub explicit_rights: bool,
    pub join_on_open: bool,
    pub network: bool,
    /// None uses the transport default: trust stdio, not network peers.
    pub trust_trace_context: Option<bool>,
}
impl Identity {
    pub fn local() -> Self {
        Self {
            id: ACP_HOST_ACTOR.into(),
            kind: "host".into(),
            rights: Authority::full(),
            tenants: None,
            projects: None,
            represents: vec![],
            explicit_rights: false,
            join_on_open: true,
            network: false,
            trust_trace_context: None,
        }
    }
    fn trusts_trace(&self) -> bool {
        self.trust_trace_context.unwrap_or(!self.network)
    }
    /// Stable binding route; the socket instance is separate and never persisted.
    pub fn approval_route(&self) -> String {
        // Distinguish operator scopes for the same actor, without a socket
        // identifier, a token, or a project path in the saved decision.
        let scope = json!([
            self.network,
            self.id,
            self.projects,
            self.tenants,
            self.represents,
            self.rights
        ]);
        format!(
            "acp:{}",
            transport_websocket::scope_fingerprint(scope.to_string().as_bytes())
        )
    }
    pub fn may_discover(&self, data: &SessionData) -> bool {
        sessions::discoverable(self, data)
    }
    /// Apply the local operator identity to a reopen without a client route.
    pub async fn as_operator<T>(self, work: impl std::future::Future<Output = T>) -> T {
        let ceiling = self.connection_ceiling();
        with_principal(Arc::new(self), ceiling, work).await
    }
    fn connection_ceiling(&self) -> Option<Arc<ConnectionCeiling>> {
        self.has_ceiling()
            .then(|| Arc::new(ConnectionCeiling::new(self.id.clone(), self.rights.clone())))
    }
    fn has_ceiling(&self) -> bool {
        self.network || self.explicit_rights
    }

    fn allows_project(&self, path: &Path) -> bool {
        self.projects
            .as_ref()
            .is_none_or(|projects| projects.iter().any(|project| path == project))
    }
    fn allows_tenant(&self, tenant: Option<&str>) -> bool {
        self.tenants.as_ref().map_or(tenant.is_none(), |list| {
            list.iter().any(|name| name.as_deref() == tenant)
        })
    }
}

tokio::task_local! { static PRINCIPAL: Arc<Identity>; }

async fn with_principal<T>(
    identity: Arc<Identity>,
    ceiling: Option<Arc<ConnectionCeiling>>,
    work: impl std::future::Future<Output = T>,
) -> T {
    if let Some(ceiling) = ceiling {
        CONNECTION_CEILING
            .scope(ceiling, PRINCIPAL.scope(identity, work))
            .await
    } else {
        PRINCIPAL.scope(identity, work).await
    }
}

fn connection_actor() -> String {
    PRINCIPAL.try_with(|id| id.id.clone()).unwrap_or_else(|_| {
        std::env::var("MODULAR_AGENT_ACTOR").unwrap_or_else(|_| ACP_HOST_ACTOR.into())
    })
}

fn represented_actors() -> Vec<String> {
    PRINCIPAL
        .try_with(|id| id.represents.clone())
        .unwrap_or_default()
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
    /// Kept data only. In-memory compositions can still support ordinary opens.
    fn list_kept(&self, project: Option<&Path>) -> Result<Vec<SessionData>> {
        self.list(project)
    }
    /// SDK factories inspect the committed record. A base build with no
    /// inspector may omit the optional waiting summary.
    fn list_row(
        &self,
        data: &SessionData,
        _principal: &Identity,
        _in_turn: &dyn Fn(&str, bool) -> bool,
        _running: bool,
    ) -> Result<Option<Value>> {
        Ok(Some(json!({"sessionId": data.id, "cwd": data.project})))
    }
    fn trust(&self, project: &Path) -> Result<()>;
    fn serves_project(&self, _project: &Path) -> bool {
        true
    }
    /// The usual Factory builds one agent per session; an embedded agent shares one.
    fn owns_session_agent(&self) -> bool {
        true
    }
    /// Release a composition, including resources owned outside its Harness.
    async fn dispose(&self, api: Api) -> Result<()> {
        if self.owns_session_agent() {
            api.shutdown().await?;
        }
        Ok(())
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
                    // Another Interface on this agent is not an ACP connection.
                    if PRINCIPAL.try_with(|_| ()).is_ok() {
                        sessions::join_host(api.as_ref(), &scope.session)?;
                    }
                    Ok(HookResult::default())
                })
            }),
        );
        r.declare(json!({"acp":{"version":1,"text":true,"permissions":true,"elicitation_form":true,"secret_answers":false,"actor":{"id":connection_actor().as_str(),"kind":"host"},"client_filesystem":false,"client_terminal":false}}));
        Ok(())
    }
}
mod routes;
pub use routes::OpenRoutes;

struct State {
    routes: Arc<OpenRoutes>,
    principal: Arc<Identity>,
    ceiling: Option<Arc<ConnectionCeiling>>,
    factory: Arc<dyn Factory>,
    launch_declaration: Option<Value>,
    client: Mutex<Option<Value>>,
    binding_v2: std::sync::atomic::AtomicBool,
    sessions: Mutex<BTreeMap<String, Arc<Session>>>,
    delivery_views: Mutex<BTreeMap<String, std::sync::Weak<Session>>>,
}
impl State {
    fn delivery_view(&self, id: &str) -> Option<Vec<String>> {
        let session = self.delivery_views.lock().unwrap().get(id)?.upgrade()?;
        if session.stop.is_cancelled()
            || session.drive_stop.is_cancelled()
            || !self.principal.rights.has("watch")
        {
            return None;
        }
        let data = session.api.snapshot(id).ok()?;
        if !self.factory.serves_project(&data.project)
            || !sessions::in_scope(&self.principal, &data)
            || !session
                .api
                .authority(id, &self.principal.id)
                .ok()?
                .has("watch")
        {
            return None;
        }
        Some(
            data.entries
                .into_iter()
                .filter(|e| e.kind == "erasure")
                .map(|e| e.id)
                .collect(),
        )
    }
    fn session(&self, p: &Value) -> Result<Arc<Session>> {
        let id = string(p, "sessionId")?;
        let attached = self.sessions.lock().unwrap().get(id).cloned();
        if let Some(session) = attached {
            session.check_view()?;
            return Ok(session);
        }
        if self.factory.list(None)?.iter().any(|data| {
            data.id == id
                && self.factory.serves_project(&data.project)
                && sessions::discoverable(&self.principal, data)
        }) {
            return Err(request_error("not_open", "session is not attached").into());
        }
        Err(request_error("forbidden", "session inaccessible").into())
    }
    fn project_in_use(&self, project: &Path, except: &str) -> bool {
        self.routes
            .sessions
            .lock()
            .unwrap()
            .values()
            .filter_map(std::sync::Weak::upgrade)
            .any(|s| s.id != except && s.project == project)
    }
    async fn shutdown(&self) {
        let sessions = std::mem::take(&mut *self.sessions.lock().unwrap());
        let _setup = self.routes.setup.lock().await;
        for (_, session) in sessions {
            if session.detach_route().await {
                let _ = session.close().await;
                self.routes.sessions.lock().unwrap().remove(&session.id);
            }
        }
    }
    async fn dispatch(
        &self,
        request: UntypedMessage,
        cx: ConnectionTo<acp::Client>,
    ) -> Result<Value> {
        let context = if self.principal.trusts_trace()
            && matches!(
                request.method.as_str(),
                "session/prompt"
                    | "session/new"
                    | "session/load"
                    | "session/resume"
                    | "session/close"
                    | "_modular/submit"
                    | "_modular/answer"
                    | "_modular-agent/input"
                    | "_modular-agent/requests/answer"
                    | "_modular-agent/answer"
            ) {
            telemetry::extract(&request.params["_meta"]).unwrap_or_default()
        } else {
            telemetry::Context::new()
        };
        telemetry::within(context, self.dispatch_work(request, cx)).await
    }

    async fn dispatch_work(
        &self,
        request: UntypedMessage,
        cx: ConnectionTo<acp::Client>,
    ) -> Result<Value> {
        let method = request.method.clone();
        let prompt = method == "session/prompt";
        let before = if request.params["sessionId"].is_string()
            && !matches!(method.as_str(), "session/load" | "session/resume")
        {
            self.session(&request.params).ok()
        } else {
            None
        };
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
        if result.as_ref().err().is_some_and(|e| {
            e.is::<acp::Error>()
                || e.is::<LostPart>()
                || matches!(
                    e.downcast_ref::<OperationError>(),
                    Some(
                        OperationError::Busy(_)
                            | OperationError::Forbidden(_)
                            | OperationError::Unavailable(_)
                    )
                )
        }) || matches!(
            method.as_str(),
            "session/load" | "session/resume" | "session/new"
        ) {
            return result;
        }
        let session = before.or_else(|| result.as_ref().ok().and_then(|v| self.session(v).ok()));
        if let Some(session) = session {
            let failed = result.is_err();
            let value = result.unwrap_or_else(|error| json!({"error":error.to_string()}));
            // Withdraw only this connection's delivery when a re-poll is withheld.
            if method == "_modular-agent/requests" {
                let waiting = questions(&session.api.snapshot(&session.id)?)?
                    .into_iter()
                    .filter(Question::waits_for_approval)
                    .map(|q| q.id)
                    .collect::<std::collections::BTreeSet<_>>();
                session
                    .approval_views
                    .lock()
                    .unwrap()
                    .retain(|(_, id)| !waiting.contains(id));
            }
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
            session.check_view()?;
            let mut value = gated["result"].clone();
            if method == "_modular-agent/requests"
                && let Some(questions) = value["requests"].as_array_mut()
            {
                binding::mark_poll_view(&session, &payload["result"]["requests"], questions)
                    .await?;
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
                json!({"protocolVersion":1,"agentInfo":{"name":"modular-agent-rs","version":env!("CARGO_PKG_VERSION")},"authMethods":[],
                "agentCapabilities":{"loadSession":true,"mcpCapabilities":{"http":true,"sse":false},"promptCapabilities":{"image":false,"audio":false,"embeddedContext":false},"sessionCapabilities":{"list":{},"resume":{},"close":{}}},
                "_meta":{"modular-agent":{"binding":binding,"declaration":declaration,"extensions":binding::EXTENSIONS,"actor":{"id":self.principal.id,"kind":self.principal.kind,"rights":self.principal.rights}}}}),
            );
        }
        if method == "$/ping" && self.principal.network {
            ensure!(
                p.as_object().is_some_and(|object| object.is_empty()),
                "ping expects empty params"
            );
            return Ok(json!({}));
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
                    let _setup = self.routes.setup.lock().await;
                    let s = self.session(&p)?;
                    require(s.api.as_ref(), &actor_scope(&s.id), "settings")?;
                    if self.project_in_use(&s.project, &s.id) {
                        return Err(
                            request_error("conflict", "cannot rewind a shared project").into()
                        );
                    }
                    let result =
                        binding::extension(self.factory.as_ref(), s.clone(), name, &p).await;
                    if s.api.rewind_pending(&s.id).unwrap_or(false) {
                        self.routes
                            .rewind_blocks
                            .lock()
                            .unwrap()
                            .insert(s.project.clone(), s.id.clone());
                    }
                    return result;
                }
                return binding::extension(self.factory.as_ref(), self.session(&p)?, name, &p)
                    .await;
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
                let project = p["cwd"]
                    .as_str()
                    .map(|cwd| -> Result<_> {
                        let path = Path::new(cwd);
                        ensure!(path.is_absolute(), "cwd must be absolute");
                        Ok(path.canonicalize()?)
                    })
                    .transpose()?;
                if let Some(path) = &project
                    && (!self.principal.allows_project(path) || !self.factory.serves_project(path))
                {
                    return Ok(json!({"sessions": []}));
                }
                let mut rows = Vec::new();
                for data in self.factory.list_kept(project.as_deref())? {
                    if !self.factory.serves_project(&data.project)
                        || !sessions::discoverable(&self.principal, &data)
                    {
                        continue;
                    }
                    let attached = self.sessions.lock().unwrap().get(&data.id).cloned();
                    let in_turn = |id: &str, approval: bool| {
                        attached.as_ref().is_some_and(|s| {
                            !approval
                                || s.approval_views
                                    .lock()
                                    .unwrap()
                                    .contains(&(self.principal.id.clone(), id.to_owned()))
                        })
                    };
                    if let Some(row) = self.factory.list_row(
                        &data,
                        &self.principal,
                        &in_turn,
                        self.routes.is_running(&data.id),
                    )? {
                        rows.push(row);
                    }
                }
                Ok(json!({"sessions":rows}))
            }
            "session/close" => {
                let _: CloseSessionRequest = serde_json::from_value(p.clone())?;
                let session = self.session(&p)?;
                session.begin_close(true)?;
                let result = session.finish_close().await;
                self.routes.sessions.lock().unwrap().remove(&session.id);
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
                    "approvalWait" => {
                        ensure!(
                            session.api.declaration()?["approvals_outlast_turns"] == true,
                            request_error("not_supported", "waiting approvals are disabled")
                        );
                        session
                            .api
                            .settings(&actor_scope(&session.id), json!({"approvalWait":value}))?;
                        session.wake.notify_one();
                    }
                    "approval" => {
                        ensure!(
                            session.api.declaration()?["approval_policies"].is_array(),
                            request_error("not_supported", "approval is disabled")
                        );
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
                ensure!(
                    self.factory.serves_project(&project.canonicalize()?)
                        && self.principal.allows_project(&project.canonicalize()?)
                        && self.principal.rights.has("settings"),
                    request_error("forbidden", "cannot change project trust")
                );
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
/// A Factory refusal with a stable ACP error code.
pub fn request_error(code: &str, message: &str) -> acp::Error {
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
    let mut identity = Identity::local();
    // The base executable's operator-owned tenant configuration grants its
    // local ACP launcher access. SDK callers provide the names explicitly.
    if let Some(raw) = std::env::var_os("MODULAR_AGENT_TENANTS") {
        let configured: BTreeMap<String, Value> = serde_json::from_str(
            raw.to_str()
                .ok_or_else(|| anyhow!("invalid tenant configuration"))?,
        )?;
        identity.tenants = Some(
            std::iter::once(None)
                .chain(configured.into_keys().map(Some))
                .collect(),
        );
    }
    if let Some(configured) = std::env::var_os("MODULAR_AGENT_ACP_REPRESENTS") {
        identity.represents = serde_json::from_str(
            configured
                .to_str()
                .ok_or_else(|| anyhow!("invalid ACP representation"))?,
        )?;
    }
    run_stdio(factory, stdio_identity(identity)?).await
}

pub fn stdio_identity(mut identity: Identity) -> Result<Identity> {
    if let Some(actor) = std::env::var_os("MODULAR_AGENT_ACTOR") {
        identity.id = actor
            .into_string()
            .ok()
            .filter(|id| !id.is_empty() && !id.starts_with("job:"))
            .ok_or_else(|| anyhow!("MODULAR_AGENT_ACTOR must be a nonempty UTF-8 id"))?;
    }
    ensure!(
        identity
            .represents
            .iter()
            .all(|id| !id.is_empty() && !id.starts_with("job:")),
        "invalid ACP representation"
    );
    Ok(identity)
}

pub async fn run_stdio(factory: Arc<dyn Factory>, identity: Identity) -> Result<()> {
    let delivery = Arc::new(transport::Delivery::default());
    run_connection(
        factory,
        identity,
        Arc::default(),
        transport::stdio(delivery.clone()),
        delivery,
    )
    .await
}

pub async fn run_websocket(
    factory: Arc<dyn Factory>,
    identity: Identity,
    connection: transport_websocket::Connection,
    routes: Arc<OpenRoutes>,
) -> Result<()> {
    let delivery = Arc::new(transport::Delivery::default());
    run_connection(
        factory,
        identity,
        routes,
        transport::websocket(connection, delivery.clone()),
        delivery,
    )
    .await
}

async fn run_connection(
    factory: Arc<dyn Factory>,
    identity: Identity,
    routes: Arc<OpenRoutes>,
    wire: impl acp::ConnectTo<acp::Agent>,
    delivery: Arc<transport::Delivery>,
) -> Result<()> {
    // Validate configured plugin startup before opening the ACP connection.
    // A failed launch must exit, not leave a connection with a substitute.
    let launch_declaration = if std::env::var_os("MODULAR_AGENT_PLUGINS").is_some() {
        Some(factory.declaration().await?)
    } else {
        None
    };
    let ceiling = identity.connection_ceiling();
    let state = Arc::new(State {
        routes,
        principal: Arc::new(identity),
        ceiling,
        factory,
        launch_declaration,
        client: Mutex::new(None),
        binding_v2: false.into(),
        sessions: Mutex::default(),
        delivery_views: Mutex::default(),
    });
    let state_ref = Arc::downgrade(&state);
    *delivery.check.lock().unwrap() =
        Some(Arc::new(move |id| state_ref.upgrade()?.delivery_view(id)));
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
                cx.spawn(with_principal(
                    requests.principal.clone(),
                    requests.ceiling.clone(),
                    async move {
                        let result = requests.dispatch(request, connection).await.map_err(|e| {
                            if let Some(error) = e.downcast_ref::<acp::Error>() {
                                error.clone()
                            } else if let Some(lost) = e.downcast_ref::<LostPart>() {
                                acp::Error::new(-32000, lost.to_string())
                                    .data(json!({"code":"lost"}))
                            } else if let Some(held) = e.downcast_ref::<HistoryHeld>() {
                                acp::Error::new(-32000, held.to_string())
                                    .data(json!({"code":"held","retryAfterMs":held.retry_after_ms}))
                            } else if e.to_string() == "method not found" {
                                acp::Error::method_not_found()
                            } else {
                                let message = e.to_string();
                                let code = if matches!(
                                    e.downcast_ref::<OperationError>(),
                                    Some(OperationError::Unavailable(_))
                                ) {
                                    "unavailable"
                                } else if matches!(
                                    e.downcast_ref::<OperationError>(),
                                    Some(OperationError::Busy(_))
                                ) {
                                    "busy"
                                } else if message.starts_with("actor lacks ")
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
                    },
                ))
            },
            acp::on_receive_request!(),
        )
        .on_receive_notification(
            async move |notification: UntypedMessage, _cx| {
                with_principal(
                    notifications.principal.clone(),
                    notifications.ceiling.clone(),
                    async {
                        if notification.method == "session/cancel"
                            && let Ok(session) = notifications.session(&notification.params)
                            && require(session.api.as_ref(), &actor_scope(&session.id), "cancel")
                                .is_ok()
                        {
                            let _ = session.cancel().await;
                        }
                        Ok(())
                    },
                )
                .await
            },
            acp::on_receive_notification!(),
        )
        .on_close(async move |_cx| {
            PRINCIPAL
                .scope(closed.principal.clone(), closed.shutdown())
                .await;
            Ok(())
        })
        .connect_to(wire)
        .await;
    PRINCIPAL
        .scope(state.principal.clone(), state.shutdown())
        .await;
    result.map_err(Into::into)
}
