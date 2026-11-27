//! ACP v1 stdio Interface. The official SDK owns framing, dispatch and requests.
//! Protocol: https://agentclientprotocol.com/protocol/v1/overview
mod binding;
mod events;
#[cfg(test)]
mod initialize_tests;
mod sessions;
mod transport;
use acp::{
    ConnectionTo, UntypedMessage,
    schema::ProtocolVersion,
    v1::schema::{
        CloseSessionRequest, CreateElicitationRequest, InitializeRequest, ListSessionsRequest,
        LoadSessionRequest, NewSessionRequest, PromptRequest, RequestPermissionRequest,
        ResumeSessionRequest, SessionNotification, SetSessionConfigOptionRequest,
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
                    | "_modular-agent/input"
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
            let (value, failure) = match result {
                Ok(value) => (value, None),
                Err(error) => (json!({"error":error.to_string()}), Some(error)),
            };
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
            if let Some(error) = failure {
                // Keep the refusal type, but expose only the gated message.
                let message = value["error"].as_str().ok_or_else(withheld)?;
                return Err(error.context(message.to_owned()));
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
        let mut p = request.params;
        let method = request.method;
        if method == "initialize" {
            // JSON Schema treats an integral number like 2.0 as an integer.
            if let Some(version) = p["protocolVersion"].as_number().filter(|n| n.is_f64())
                && let Some(version) = version.as_f64().filter(|n| n.fract() == 0.0)
            {
                p["protocolVersion"] = json!(version as i64);
            }
            let initialize: InitializeRequest =
                serde_json::from_value(p.clone()).map_err(acp::Error::from)?;
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
            if initialize.protocol_version < ProtocolVersion::V1
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
                json!({"protocolVersion":ProtocolVersion::V1,"agentInfo":{"name":"modular-agent-rs","version":env!("CARGO_PKG_VERSION")},"authMethods":[],
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
            binding::validate_history_params(name, &p)?;
            if name == "move" && p["rewind"] == true {
                // Serialize project opens with rewind across session-local Harnesses.
                let _setup = self.routes.setup.lock().await;
                let session = self.session(&p)?;
                binding::require_feature(self.factory.as_ref(), &session, "rewinding")?;
                require(session.api.as_ref(), &actor_scope(&session.id), "settings")?;
                if self.project_in_use(&session.project, &session.id) {
                    return Err(request_error("conflict", "cannot rewind a shared project").into());
                }
                let result =
                    binding::extension(self.factory.as_ref(), session.clone(), name, &p).await;
                if session.api.rewind_pending(&session.id).unwrap_or(false) {
                    self.routes
                        .rewind_blocks
                        .lock()
                        .unwrap()
                        .insert(session.project.clone(), session.id.clone());
                }
                return result;
            }
            return binding::extension(self.factory.as_ref(), self.session(&p)?, name, &p).await;
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
            _ => bail!("method not found"),
        }
    }
}
/// A Factory refusal with a stable ACP error code.
pub fn request_error(code: &str, message: &str) -> acp::Error {
    acp::Error::new(-32602, message).data(json!({"code":code}))
}
fn operation_code(error: &OperationError) -> &'static str {
    match error {
        OperationError::NotFound(_) => "not_found",
        OperationError::Busy(_) => "busy",
        OperationError::Unavailable(_) => "unavailable",
        OperationError::Forbidden(_) => "forbidden",
        OperationError::Conflict(_) => "conflict",
        OperationError::InvalidParams(_) => "invalid_params",
        OperationError::ResultTooLarge(_) => "result_too_large",
    }
}

fn rpc_error(error: anyhow::Error) -> acp::Error {
    let message = error.to_string();
    if let Some(error) = error.downcast_ref::<acp::Error>() {
        return error.clone();
    }
    if error.is::<LostPart>() {
        return acp::Error::new(-32000, message).data(json!({"code":"lost"}));
    }
    if let Some(held) = error.downcast_ref::<HistoryHeld>() {
        return acp::Error::new(-32000, message)
            .data(json!({"code":"held","retryAfterMs":held.retry_after_ms}));
    }
    let code = if let Some(issue) = error.downcast_ref::<OperationError>() {
        operation_code(issue)
    } else if let Some(issue) = error.downcast_ref::<RewindError>() {
        match issue {
            RewindError::Busy(_) => "busy",
            RewindError::Conflict(_) => "conflict",
            RewindError::NotSupported => "not_supported",
        }
    } else if error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|e| e.kind() == std::io::ErrorKind::Unsupported)
    {
        "not_supported"
    } else if message == "method not found" {
        return acp::Error::method_not_found();
    } else if message.starts_with("actor lacks ") || message.starts_with("unknown tenant ") {
        "forbidden"
    } else {
        "invalid_params"
    };
    request_error(code, &message)
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
    // The SDK's v1 builder rewrites the offered version before dispatch. Use
    // raw dispatch so the binding can validate and negotiate the original offer.
    let result = acp::Builder::new(acp::Agent)
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
                        let result = requests
                            .dispatch(request, connection)
                            .await
                            .map_err(rpc_error);
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
