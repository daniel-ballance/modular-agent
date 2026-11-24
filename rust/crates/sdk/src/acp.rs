//! Adapter from the SDK's fixed-project agent to the base ACP Interface.
use crate::{Agent, Code, Error, Result};
use agent_api as base;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex},
};

type Sink = Arc<dyn base::EventSink>;

/// A project-aware ACP composition. The saved session ID lets a host
/// select parts using recorded settings before recovery starts.
#[async_trait::async_trait]
pub trait AcpComposition: Send + Sync + 'static {
    async fn compose(&self, project: &Path, reopening: Option<&str>) -> Result<Agent>;
    fn history(&self) -> Result<crate::History>;
    fn trust(&self, project: &Path) -> Result<()>;

    /// When provided, check project trust before invoking the composition factory.
    fn configuration(&self) -> Option<&dyn crate::Configuration> {
        None
    }

    fn project_settings(&self, project: &Path) -> Result<Value> {
        match self.configuration() {
            Some(configuration) => configuration.settings(project),
            None => Ok(serde_json::json!({})),
        }
    }

    async fn project_mcp(&self, _session: &str, _project: &Path, servers: Value) -> Result<()> {
        if servers.as_array().is_some_and(Vec::is_empty) {
            Ok(())
        } else {
            Err(Error::new(
                Code::NotSupported,
                "this agent does not accept ACP MCP servers",
            ))
        }
    }
}

/// Serve the built agent's project by default, or compose per project.
#[derive(Clone, Default)]
pub struct AcpOptions {
    pub compose: Option<Arc<dyn AcpComposition>>,
    /// Trust the launching stdio peer unless explicitly disabled.
    pub trust_trace_context: Option<bool>,
    pub actor: Option<crate::Actor>,
    pub projects: Option<Vec<std::path::PathBuf>>,
    pub tenants: Option<Vec<Option<String>>>,
    pub rights: Option<crate::Rights>,
    pub represents: Vec<String>,
}

impl AcpOptions {
    fn identity(&self) -> Result<interface_acp::Identity> {
        let mut identity = interface_acp::Identity::local();
        identity.projects = validate_scope(self.projects.clone(), &self.tenants, &self.represents)?;
        identity.tenants = self.tenants.clone();
        identity.trust_trace_context = self.trust_trace_context;
        identity.represents = self.represents.clone();
        if let Some(actor) = self.actor.clone() {
            validate_actor(&actor)?;
            identity.kind = actor.kind;
            identity.id = actor.id;
            identity.rights = actor.rights;
            identity.explicit_rights = true;
        } else {
            identity = interface_acp::stdio_identity(identity)
                .map_err(|e| Error::new(Code::InvalidComposition, e.to_string()))?;
        }
        if let Some(rights) = &self.rights {
            identity.rights = identity.rights.intersect(rights);
            identity.explicit_rights = true;
        }
        Ok(identity)
    }
}

/// A bearer-token principal. Omitted projects use the composition's scope.
/// Omitted tenants permit only tenantless sessions, as does a list of just `None`.
#[derive(Clone, Debug)]
pub struct AcpActor {
    pub token_file: std::path::PathBuf,
    pub trust_trace_context: bool,
    pub actor: crate::Actor,
    pub tenants: Option<Vec<Option<String>>>,
    pub projects: Option<Vec<std::path::PathBuf>>,
    pub represents: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct AcpServiceOptions {
    pub listen: String,
    pub actors: Vec<AcpActor>,
    pub tls: Option<crate::TlsOptions>,
}
impl AcpActor {
    /// The same operator-authorized local principal as stdio without an actor override.
    pub fn local(token_file: std::path::PathBuf) -> Self {
        Self {
            token_file,
            trust_trace_context: false,
            actor: crate::Actor {
                id: base::ACP_HOST_ACTOR.into(),
                kind: "host".into(),
                rights: crate::Rights::full(),
            },
            tenants: None,
            projects: None,
            represents: vec![],
        }
    }
}

/// Check operator token files without exposing credentials or starting a listener.
pub async fn validate_acp_token_files<'a>(paths: impl IntoIterator<Item = &'a Path>) -> Result<()> {
    let mut distinct = std::collections::BTreeSet::new();
    for path in paths {
        let token = transport_websocket::read_token_file(path)
            .await
            .map_err(|error| {
                Error::new(
                    Code::InvalidComposition,
                    format!("invalid token file {}: {error:#}", path.display()),
                )
            })?;
        if !distinct.insert(token) {
            return Err(Error::new(
                Code::InvalidComposition,
                "token files contain duplicate credentials",
            ));
        }
    }
    Ok(())
}

pub(crate) fn validate_actor(actor: &crate::Actor) -> Result<()> {
    if actor.id.is_empty()
        || actor.id.starts_with("job:")
        || !matches!(actor.kind.as_str(), "user" | "host" | "agent" | "program")
    {
        return Err(Error::new(Code::InvalidComposition, "invalid ACP actor"));
    }
    Ok(())
}

pub(crate) fn validate_scope(
    projects: Option<Vec<std::path::PathBuf>>,
    tenants: &Option<Vec<Option<String>>>,
    represents: &[String],
) -> Result<Option<Vec<std::path::PathBuf>>> {
    if tenants.iter().flatten().flatten().any(String::is_empty)
        || represents
            .iter()
            .any(|id| id.is_empty() || id.starts_with("job:"))
    {
        return Err(Error::new(
            Code::InvalidComposition,
            "invalid ACP tenant or represented actor",
        ));
    }
    projects
        .map(|projects| {
            projects
                .into_iter()
                .map(|path| {
                    path.is_absolute()
                        .then(|| path.canonicalize().ok())
                        .flatten()
                        .filter(|p| p.is_dir())
                        .ok_or_else(|| {
                            Error::new(
                                Code::InvalidComposition,
                                format!("invalid ACP project path: {}", path.display()),
                            )
                        })
                })
                .collect()
        })
        .transpose()
}

struct ProjectFactory(
    Arc<dyn AcpComposition>,
    Agent,
    Mutex<BTreeMap<usize, Agent>>,
);

fn api_key(api: &dyn base::AgentApi) -> usize {
    std::ptr::from_ref(api).cast::<()>() as usize
}

#[async_trait::async_trait]
impl interface_acp::Factory for ProjectFactory {
    async fn declaration(&self) -> base::Result<Value> {
        Ok(self.1.declaration_for(None, true)?)
    }
    fn session_declaration(&self, api: &dyn base::AgentApi, session: &str) -> base::Result<Value> {
        Ok(self.1.project_declaration(api, Some(session), true)?)
    }

    async fn build(&self, project: &Path, sink: Sink) -> base::Result<base::Api> {
        self.build_for(project, None, sink).await
    }

    async fn build_for(
        &self,
        project: &Path,
        reopening: Option<&str>,
        sink: Sink,
    ) -> base::Result<base::Api> {
        if let Some(configuration) = self.0.configuration()
            && !configuration.trusted(project)?
        {
            return Err(interface_acp::request_error("forbidden", "project is not trusted").into());
        }
        let agent = self.0.compose(project, reopening).await?;
        if !agent.inner.plugin_host {
            agent.close().await?;
            return Err(base::anyhow!("serve_acp requires a plugin host"));
        }
        if agent.inner.project != project {
            agent.close().await?;
            return Err(base::anyhow!(
                "ACP composition returned a different project"
            ));
        }
        let harness = agent.inner.harness.clone();
        harness.configure_reservations(self.1.inner.harness.reservations())?;
        harness.inherit_approval_audiences(&self.1.inner.harness);
        if let Err(error) = harness
            .load(Arc::new(interface_acp::AcpPlugin { sink }))
            .await
        {
            agent.close().await?;
            return Err(error);
        }
        self.2
            .lock()
            .unwrap()
            .insert(api_key(harness.as_ref()), agent);
        Ok(harness)
    }

    async fn dispose(&self, api: base::Api) -> base::Result<()> {
        let agent = self.2.lock().unwrap().remove(&api_key(api.as_ref()));
        if let Some(agent) = agent {
            agent.close().await?;
        }
        Ok(())
    }

    fn list(&self, project: Option<&Path>) -> base::Result<Vec<base::SessionData>> {
        self.0.history()?.0.list(project)
    }

    fn list_kept(&self, project: Option<&Path>) -> base::Result<Vec<base::SessionData>> {
        let history = self.0.history()?;
        if !history.1 {
            return Ok(vec![]);
        }
        history.0.list(project)
    }

    fn list_row(
        &self,
        data: &base::SessionData,
        principal: &interface_acp::Identity,
        in_turn: &dyn Fn(&str, bool) -> bool,
        running: bool,
    ) -> base::Result<Option<Value>> {
        self.1
            .acp_list_row(&self.0.history()?, data, principal, in_turn, running)
    }
    fn trust(&self, project: &Path) -> base::Result<()> {
        Ok(self.0.trust(project)?)
    }

    fn project_settings(&self, project: &Path) -> base::Result<Value> {
        Ok(base::portable::settings_from_wire(
            &self.0.project_settings(project)?,
        ))
    }

    async fn attach(
        &self,
        _: base::Api,
        session: &str,
        project: &Path,
        servers: Value,
    ) -> base::Result<()> {
        Ok(self.0.project_mcp(session, project, servers).await?)
    }
    async fn detach(&self, _: base::Api, _: &str) {}
}

#[derive(Default)]
pub(crate) struct Routes {
    attached: Mutex<BTreeMap<String, Sink>>,
    serving: tokio::sync::Mutex<()>,
}
impl base::EventSink for Routes {
    fn send(&self, event: base::Event) {
        if let Some(sink) = self
            .attached
            .lock()
            .unwrap()
            .get(&event.scope.session)
            .cloned()
        {
            sink.send(event);
        }
    }
}

impl Agent {
    pub(crate) fn register_acp_audience(&self, p: interface_acp::Identity) {
        self.inner.harness.register_approval_audience(
            p.approval_route(),
            p.id.clone(),
            Arc::new(move |data, actor| {
                (p.may_discover(data) && (p.id == actor || p.represents.iter().any(|s| s == actor)))
                    .then(|| p.rights.clone())
            }),
        );
    }
    /// Serve this agent's project on stdio. Build with `plugin_host(true)` before serving.
    /// Start the Interface before opening embedded sessions; stdout belongs to ACP.
    pub async fn serve_acp(&self, options: AcpOptions) -> Result<()> {
        self.check_acp_host()?;
        let identity = options.identity()?;
        let routes = self.acp_routes();
        let _serving = routes
            .serving
            .try_lock()
            .map_err(|_| Error::new(Code::Busy, "ACP is already serving"))?;
        let factory = self.acp_factory(options.compose, routes.clone()).await?;
        self.register_acp_audience(identity.clone());
        Ok(interface_acp::run_stdio(factory, identity).await?)
    }

    /// Serve ACP over WebSocket, with a new connection and actor scope per upgrade.
    pub async fn serve_acp_websocket(
        &self,
        options: AcpOptions,
        service: AcpServiceOptions,
    ) -> Result<crate::WebSocketServer> {
        self.check_acp_host()?;
        let mut entries = Vec::new();
        for token in service.actors {
            let mut actor = token.actor;
            if actor.kind == "plugin" {
                actor.kind = "program".into();
            }
            validate_actor(&actor)?;
            let projects = validate_scope(token.projects, &token.tenants, &token.represents)?;
            let join_on_open = actor.id == base::ACP_HOST_ACTOR && actor.kind == "host";
            entries.push((
                token.token_file,
                interface_acp::Identity {
                    id: actor.id,
                    kind: actor.kind,
                    rights: actor.rights,
                    tenants: token.tenants,
                    projects,
                    represents: token.represents,
                    explicit_rights: true,
                    join_on_open,
                    network: true,
                    trust_trace_context: Some(token.trust_trace_context),
                },
            ));
        }
        let routes = self.acp_routes();
        {
            let _serving = routes.serving.lock().await;
            self.acp_factory(options.compose.clone(), routes.clone())
                .await?;
        }
        for (_, identity) in &entries {
            self.register_acp_audience(identity.clone());
        }
        let agent = self.clone();
        let open_routes = Arc::new(interface_acp::OpenRoutes::default());
        Ok(transport_websocket::serve(
            &service.listen,
            service.tls,
            transport_websocket::ACP,
            entries,
            move |identity, conn| {
                let factory = agent.connection_factory(options.compose.clone(), routes.clone());
                let open_routes = open_routes.clone();
                async move {
                    let _ =
                        interface_acp::run_websocket(factory, identity, conn, open_routes).await;
                }
            },
        )
        .await?)
    }

    fn acp_list_row(
        &self,
        history: &crate::History,
        data: &base::SessionData,
        principal: &interface_acp::Identity,
        in_turn: &dyn Fn(&str, bool) -> bool,
        running: bool,
    ) -> base::Result<Option<Value>> {
        let viewer = crate::SessionViewer {
            actor: &principal.id,
            rights: &principal.rights,
            scope: &|_, _| principal.may_discover(data),
            join_on_open: principal.join_on_open,
            in_turn,
            route_id: None,
        };
        Ok(self.session_summary_from(history, data, &viewer, running)?.map(|row|
            base::json!({"sessionId":row.id, "cwd":row.project, "_meta":{"modular-agent":{"waiting":row.waiting}}})))
    }

    /// Reopen an unfinished turn in this project as the local operator. A race
    /// with another completed recovery returns None; a held writer stays held.
    /// This installs no client route and does not mark the operator present.
    pub async fn open_interrupted_session(
        &self,
        id: &str,
        local: &AcpOptions,
    ) -> Result<Option<crate::Session>> {
        let identity = local.identity()?;
        let check = identity.clone();
        let h = self.inner.harness.clone();
        let project = self.inner.project.clone();
        self.acp_factory(None, self.acp_routes()).await?;
        identity
            .as_operator(async {
                let installed = self
                    .inner
                    .harness
                    .install_recovery_if(id, move |data| {
                        base::ensure!(
                            data.project == project
                                && check.may_discover(data)
                                && h.discovery_rights(
                                    data,
                                    &check.id,
                                    &check.rights,
                                    check.join_on_open
                                )?
                                .has("watch"),
                            base::OperationError::Forbidden("session inaccessible".into())
                        );
                        Ok(base::unfinished_turns(&data.branch()).next().is_some())
                    })
                    .await?;
                if installed.is_none() {
                    return Ok(None);
                }
                self.finish_open(id).await.map(Some)
            })
            .await
    }

    pub(crate) fn check_acp_host(&self) -> Result<()> {
        if !self.inner.plugin_host {
            return Err(Error::new(
                Code::InvalidComposition,
                "serve_acp requires a plugin host",
            ));
        }
        Ok(())
    }

    pub(crate) fn acp_routes(&self) -> Arc<Routes> {
        self.inner
            .acp
            .get_or_init(|| Arc::new(Routes::default()))
            .clone()
    }

    pub(crate) fn connection_factory(
        &self,
        compose: Option<Arc<dyn AcpComposition>>,
        routes: Arc<Routes>,
    ) -> Arc<dyn interface_acp::Factory> {
        match compose {
            Some(compose) => Arc::new(ProjectFactory(compose, self.clone(), Mutex::default())),
            None => Arc::new(Factory(
                self.clone(),
                routes,
                Mutex::default(),
                Mutex::default(),
            )),
        }
    }

    pub(crate) async fn acp_factory(
        &self,
        compose: Option<Arc<dyn AcpComposition>>,
        routes: Arc<Routes>,
    ) -> Result<Arc<dyn interface_acp::Factory>> {
        if compose.is_none() {
            use base::AgentApi;
            if !self
                .inner
                .harness
                .capability_names("interface.acp")
                .iter()
                .any(|name| name == "interface.acp")
            {
                self.inner
                    .harness
                    .load(Arc::new(interface_acp::AcpPlugin {
                        sink: routes.clone(),
                    }))
                    .await
                    .map_err(|e| {
                        Error::new(
                            Code::InvalidComposition,
                            format!("cannot install ACP: {e:#}"),
                        )
                    })?;
            }
        }
        Ok(self.connection_factory(compose, routes))
    }
}

struct Factory(
    Agent,
    Arc<Routes>,
    Mutex<Option<Sink>>,
    Mutex<BTreeMap<String, Sink>>,
);
#[async_trait::async_trait]
impl interface_acp::Factory for Factory {
    async fn declaration(&self) -> base::Result<Value> {
        Ok(self.0.declaration_for(None, true)?)
    }
    fn session_declaration(&self, _: &dyn base::AgentApi, session: &str) -> base::Result<Value> {
        Ok(self.0.declaration_for(Some(session), true)?)
    }
    fn owns_session_agent(&self) -> bool {
        false
    }
    fn serves_project(&self, project: &Path) -> bool {
        project == self.0.inner.project
    }
    async fn build(&self, project: &Path, sink: Sink) -> base::Result<base::Api> {
        self.build_for(project, None, sink).await
    }
    async fn build_for(
        &self,
        project: &Path,
        reopening: Option<&str>,
        sink: Sink,
    ) -> base::Result<base::Api> {
        base::ensure!(
            project == self.0.inner.project,
            "ACP cwd must be the configured project"
        );
        if let Some(id) = reopening {
            let mut routes = self.1.attached.lock().unwrap();
            base::ensure!(
                !routes.contains_key(id)
                    && (self.0.inner.harness.max_approval_wait_ms().is_some()
                        || base::AgentApi::snapshot(self.0.inner.harness.as_ref(), id)
                            .ok()
                            .is_none_or(|d| d
                                .entries
                                .iter()
                                .any(|e| e.writer == "interface.agui"))),
                interface_acp::request_error("busy", "session is already open by another writer")
            );
            routes.insert(id.into(), sink.clone());
            self.3.lock().unwrap().insert(id.into(), sink.clone());
        }
        *self.2.lock().unwrap() = Some(sink);
        Ok(self.0.inner.harness.clone())
    }
    fn list(&self, project: Option<&Path>) -> base::Result<Vec<base::SessionData>> {
        base::AgentApi::list(self.0.inner.harness.as_ref(), project)
    }
    fn list_kept(&self, project: Option<&Path>) -> base::Result<Vec<base::SessionData>> {
        if !self.0.inner.persistent {
            return Ok(vec![]);
        }
        self.0.inner.history.0.list(project)
    }
    fn list_row(
        &self,
        data: &base::SessionData,
        principal: &interface_acp::Identity,
        in_turn: &dyn Fn(&str, bool) -> bool,
        running: bool,
    ) -> base::Result<Option<Value>> {
        self.0
            .acp_list_row(&self.0.inner.history, data, principal, in_turn, running)
    }
    fn trust(&self, _project: &Path) -> base::Result<()> {
        base::bail!("ACP cannot change project trust")
    }
    fn project_settings(&self, _: &Path) -> base::Result<Value> {
        Ok(self.0.inner.session_settings.clone())
    }
    async fn attach(
        &self,
        _: base::Api,
        session: &str,
        _: &Path,
        servers: Value,
    ) -> base::Result<()> {
        let sink = self
            .2
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| base::anyhow!("no ACP sink"))?;
        base::ensure!(
            servers.as_array().is_some_and(Vec::is_empty),
            "ACP cannot add MCP servers to a composed agent"
        );
        let mut routes = self.1.attached.lock().unwrap();
        routes.insert(session.into(), sink.clone());
        self.3.lock().unwrap().insert(session.into(), sink);
        Ok(())
    }
    async fn detach(&self, _: base::Api, session: &str) {
        let mut routes = self.1.attached.lock().unwrap();
        if self.3.lock().unwrap().remove(session).is_some() {
            routes.remove(session);
        }
    }
}
