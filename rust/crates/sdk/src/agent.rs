//! Building an agent and opening sessions (docs/sdk/api.md#building-an-agent).
use crate::{
    core::CorePlugin,
    error::{Code, Error, Result},
    events::{Hub, HubPlugin, LOCAL, Question, QuestionHandler},
    history::{History, file_history, memory_history},
    plugin::{InProcess, Plugin},
    provider::{Provider, ProviderPlugin},
    session::Session,
    tool::Tool,
};
use agent_api as base;
use agent_harness::Harness;
use base::AgentApi as _;
use serde_json::{Value, json};
use std::{
    future::Future,
    path::{Path, PathBuf},
    sync::Arc,
};

/// What survives the agent's process (docs/sdk/placement.md#durability).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Durability {
    /// History in memory, transient Runtime: nothing survives.
    #[default]
    Ephemeral,
    /// History on disk, transient Runtime: sessions reopen; an interrupted turn ends failed.
    Kept,
    /// History on disk, durable Runtime: an interrupted turn carries on when reopened.
    Durable,
}

/// The approval policy recorded for new sessions. Giving one loads the approval plugin.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Approval {
    Off,
    Ask,
    All,
    Never,
}

impl Approval {
    /// The base build's own names for the shared policies.
    fn native(self) -> &'static str {
        match self {
            Approval::Off => "off",
            Approval::Ask => "ask_unless_read_only",
            Approval::All => "ask_always",
            Approval::Never => "never_ask",
        }
    }
}

/// A plugin program the agent starts and speaks to over the plugin binding.
#[derive(Clone, Debug, Default)]
pub struct ProcessPlugin {
    /// An argument vector, never a shell line. The program starts with a minimal
    /// environment, so give an interpreter's full path.
    pub command: Vec<String>,
    /// Variables to set for the program, on top of the minimal environment.
    pub env: std::collections::BTreeMap<String, String>,
    /// The plugin's settings, sent when it starts.
    pub config: Value,
}

impl ProcessPlugin {
    pub fn new<S: Into<String>>(command: impl IntoIterator<Item = S>) -> Self {
        ProcessPlugin {
            command: command.into_iter().map(Into::into).collect(),
            ..Default::default()
        }
    }
    pub fn config(mut self, config: Value) -> Self {
        self.config = config;
        self
    }
    pub fn env(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(name.into(), value.into());
        self
    }
}

impl From<ProcessPlugin> for plugin_stdio::Launch {
    fn from(plugin: ProcessPlugin) -> Self {
        Self {
            command: plugin.command,
            env: plugin.env,
            config: plugin.config,
        }
    }
}

/// A plugin service configured by its URL, bearer-token file and registration settings.
pub use plugin_stdio::ServiceLaunch as ServicePlugin;

/// An agent: parts put together, and the sessions they serve.
#[derive(Clone)]
pub struct Agent {
    pub(crate) inner: Arc<Inner>,
}

pub(crate) struct Inner {
    pub crash: tokio_util::sync::CancellationToken,
    pub workers: tokio_util::task::TaskTracker,
    pub restart: Option<AgentBuilder>,
    pub harness: Arc<Harness>,
    pub hub: Arc<Hub>,
    pub project: PathBuf,
    pub persistent: bool,
    pub history: History,
    pub plugin_host: bool,
    #[cfg(feature = "agui")]
    pub interface_sources: Vec<crate::InterfaceToolSource>,
    pub acp: std::sync::OnceLock<Arc<crate::acp::Routes>>,
    pub session_settings: Value,
    pub several_actors: bool,
    pub session_limits: bool,
    pub tenants: bool,
    pub drivers: std::sync::Mutex<
        std::collections::HashMap<String, std::sync::Weak<crate::session::Driver>>,
    >,
    pub(crate) scratch: std::sync::Mutex<Option<tempfile::TempDir>>,
    closed: tokio::sync::Mutex<bool>,
    interfaces: tokio::sync::Mutex<Vec<Arc<dyn crate::Interface>>>,
    pub kept: std::sync::Mutex<Vec<tempfile::TempDir>>,
}

/// Options for `Agent::builder()`.
#[derive(Clone, Default)]
#[must_use]
pub struct AgentBuilder {
    project: Option<PathBuf>,
    data_dir: Option<PathBuf>,
    durability: Durability,
    history: Option<History>,
    configuration: Option<crate::FilesConfiguration>,
    credentials: Option<Arc<dyn crate::CredentialStore>>,
    tenants: Option<Value>,
    resource_limits: ResourceLimits,
    byte_limits: Option<ByteLimits>,
    several_actors: bool,
    session_limits: bool,
    pub(crate) acp_conformance: bool,
    no_default_prompt: bool,
    no_compaction: bool,
    job_reports_start_turns: bool,
    providers: Vec<Arc<dyn base::Plugin>>,
    tools: Vec<Tool>,
    interface_tools: Vec<crate::InterfaceToolSource>,
    plugins: Vec<Plugin>,
    process_plugins: Vec<(ProcessPlugin, Option<plugin_stdio::ProviderReadiness>)>,
    service_plugins: Vec<ServicePlugin>,
    wire_plugins: Vec<Plugin>,
    environment: Option<crate::Environment>,
    runtime: Option<crate::Runtime>,
    plugin_host: Option<bool>,
    model: Option<String>,
    agent_name: Option<String>,
    settings: serde_json::Map<String, Value>,
    model_provider_aliases: &'static [(&'static str, &'static str)],
    approval: Option<Approval>,
    on_question: Option<QuestionHandler>,
    pub(crate) restartable: bool,
    pub(crate) omit_plugin_trace_offer: bool,
}

/// Overrides and initial membership for a new session.
#[derive(Clone, Debug, Default)]
pub struct SessionOptions {
    pub settings: serde_json::Map<String, Value>,
    pub tenant: Option<String>,
    pub actors: Vec<crate::Actor>,
}

impl Agent {
    pub fn builder() -> AgentBuilder {
        AgentBuilder::default()
    }

    /// Create a session.
    pub async fn session(&self) -> Result<Session> {
        self.session_with(SessionOptions::default()).await
    }

    pub async fn session_with(&self, options: SessionOptions) -> Result<Session> {
        self.check_crashed()?;
        if options.tenant.is_some() && !self.inner.tenants {
            return Err(Error::new(Code::NotSupported, "tenants are disabled"));
        }
        if !options.actors.is_empty() && !self.inner.several_actors {
            return Err(Error::new(
                Code::NotSupported,
                "several actors are disabled",
            ));
        }
        let mut settings = self.inner.session_settings.clone();
        let patch = base::portable::settings_from_wire(&Value::Object(options.settings));
        if patch
            .as_object()
            .is_some_and(|p| p.keys().any(|key| key.starts_with('_')))
        {
            return Err(Error::new(
                Code::InvalidParams,
                "internal settings cannot be changed",
            ));
        }
        if let Some(model) = patch.get("model") {
            require_model(
                self.inner.harness.as_ref(),
                model
                    .as_str()
                    .ok_or_else(|| Error::new(Code::InvalidParams, "invalid model"))?,
            )?;
        }
        base::merge(&mut settings, patch);
        let harness = &self.inner.harness;
        let tenant = options.tenant.as_deref();
        let id = if self.inner.persistent {
            harness
                .create_provisional(&self.inner.project, settings, tenant)
                .await?
        } else {
            harness
                .create_in_tenant(&self.inner.project, settings, tenant)
                .await?
        };
        self.attach(&id)?;
        let session = Session::new(self.inner.clone(), id);
        for actor in options.actors {
            if let Err(error) = session.join(actor).await {
                let _ = self.inner.harness.close(session.id()).await;
                return Err(error);
            }
        }
        Ok(session)
    }

    /// Reopen a kept session. Interrupted work is recovered, as the Runtime declares,
    /// before this returns.
    pub async fn open_session(&self, id: &str) -> Result<Session> {
        self.check_crashed()?;
        let harness = self.inner.harness.as_ref();
        base::AgentApi::install_recovery(harness, id).await?;
        self.finish_open(id).await
    }

    pub(crate) async fn finish_open(&self, id: &str) -> Result<Session> {
        let harness = self.inner.harness.as_ref();
        // Register the app's answerer before durable recovery can ask it.
        self.attach(id)?;
        if let Err(error) = base::AgentApi::run_recovery(harness, id).await {
            let _ = harness.close(id).await;
            return Err(error.into());
        }
        let session = Session::new(self.inner.clone(), id.to_string());
        if harness.has_interface_tools() {
            session.drive();
        }
        Ok(session)
    }

    fn check_crashed(&self) -> Result<()> {
        if self.inner.crash.is_cancelled() {
            return Err(Error::new(Code::Lost, "the agent was restarted"));
        }
        Ok(())
    }

    pub(crate) fn attach(&self, id: &str) -> Result<()> {
        if self.inner.hub.on_question.is_some() {
            base::requests(self.inner.harness.as_ref())?.presence(id, LOCAL, true);
        }
        Ok(())
    }

    /// Follow live events on this agent, including during session open and recovery.
    pub fn events(&self) -> crate::EventStream {
        let mut live = self.inner.hub.events.subscribe();
        Box::pin(async_stream::stream! {
            loop {
                match live.recv().await {
                    Ok(event) => yield Ok(event),
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        yield Err(Error::new(Code::Lost, "event reader fell behind"));
                        break;
                    }
                }
            }
        })
    }

    /// List stored sessions without opening them or starting recovery.
    pub fn sessions(&self, project: Option<&Path>) -> Result<Vec<crate::SessionInfo>> {
        self.inner.history.sessions(project)
    }

    /// Read stored session metadata without acquiring a writer lease.
    pub fn session_info(&self, id: &str) -> Result<crate::SessionInfo> {
        self.inner.history.session_info(id)
    }

    /// What this agent supports, as the ACP declaration.
    pub fn declaration(&self) -> Result<Value> {
        self.declaration_for(None, false)
    }

    pub(crate) fn declaration_for(&self, session: Option<&str>, acp: bool) -> Result<Value> {
        self.project_declaration(self.inner.harness.as_ref(), session, acp)
    }

    pub(crate) fn project_declaration(
        &self,
        api: &dyn base::AgentApi,
        session: Option<&str>,
        _acp: bool,
    ) -> Result<Value> {
        let mut declaration = interface_acp::declaration(api, session)?;
        // These core modes have no SDK 0.1 Provider operations.
        declaration["runsToolsAtProvider"] = json!(false);
        declaration["liveSessions"] = json!(false);
        declaration["portableSessions"] = json!(self.inner.persistent);
        declaration["severalActors"] = json!(self.inner.several_actors);
        declaration["sessionLimits"] = json!(self.inner.session_limits);
        declaration["tenants"] = json!(self.inner.tenants);
        declaration["mixedActorInput"] = json!("refused");
        Ok(declaration)
    }

    pub fn models(&self) -> Result<Vec<crate::ModelInfo>> {
        let api = self.inner.harness.as_ref();
        let mut models = vec![];
        for key in base::AgentApi::capability_names(api, "provider.") {
            let provider = base::capability::<dyn base::Provider>(api, &key)?;
            for info in provider.catalog() {
                let mut wire = base::wire::model_value(&info);
                if !info.name.contains('/') {
                    wire["provider"] = json!(key.trim_start_matches("provider."));
                }
                models.push(serde_json::from_value(wire)?);
            }
        }
        Ok(models)
    }

    /// Watch an in-process Provider's catalog. Re-read `models()` after a notification.
    pub fn model_changes(&self, provider: &str) -> Result<tokio::sync::watch::Receiver<u64>> {
        let h = self.inner.harness.as_ref();
        let provider = base::capability::<dyn base::Provider>(h, &format!("provider.{provider}"))
            .map_err(|_| Error::new(Code::NotFound, "unknown Provider"))?;
        provider
            .catalog_changes()
            .ok_or_else(|| Error::new(Code::NotSupported, "this Provider has no catalog notifier"))
    }

    /// Keep a folder alive as long as the agent.
    pub(crate) fn keep(&self, dir: tempfile::TempDir) {
        self.inner.kept.lock().unwrap().push(dir);
    }

    /// Close every session and stop the plugins.
    pub async fn close(&self) -> Result<()> {
        use base::AgentApi;
        let mut closed = self.inner.closed.lock().await;
        if *closed {
            return Ok(());
        }
        let mut result = Ok(());
        let interfaces = std::mem::take(&mut *self.inner.interfaces.lock().await);
        for interface in interfaces.into_iter().rev() {
            if let Err(e) = interface.stop().await
                && result.is_ok()
            {
                result = Err(e);
            }
        }
        for id in self.inner.harness.open_session_ids() {
            if let Err(e) = Session::new(self.inner.clone(), id).close_owned().await
                && result.is_ok()
            {
                result = Err(e);
            }
        }
        if let Err(e) = self.inner.harness.shutdown().await
            && result.is_ok()
        {
            result = Err(e.into());
        }
        self.inner.scratch.lock().unwrap().take();
        self.inner.kept.lock().unwrap().clear();
        *closed = true;
        result
    }
}

pub(crate) fn require_model(api: &dyn base::AgentApi, model: &str) -> Result<()> {
    let offered = api
        .capability_names("provider.")
        .into_iter()
        .filter_map(|key| base::capability::<dyn base::Provider>(api, &key).ok())
        .any(|provider| provider.catalog().iter().any(|info| info.name == model));
    if offered {
        Ok(())
    } else {
        Err(Error::new(
            Code::InvalidRequest,
            format!("unknown model {model}"),
        ))
    }
}

pub use agent_harness::{ByteCapacity, ByteLimits, Capacity, ResourceLimits};

impl AgentBuilder {
    /// Set the operator's admission bounds.
    pub fn byte_limits(mut self, limits: ByteLimits) -> Self {
        self.byte_limits = Some(limits);
        self
    }

    pub fn resource_limits(mut self, limits: ResourceLimits) -> Self {
        self.resource_limits = limits;
        self
    }
    pub fn project(mut self, project: impl Into<PathBuf>) -> Self {
        self.project = Some(project.into());
        self
    }
    pub fn data_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.data_dir = Some(dir.into());
        self
    }
    pub fn durability(mut self, durability: Durability) -> Self {
        self.durability = durability;
        self
    }
    pub fn history(mut self, history: History) -> Self {
        self.history = Some(history);
        self
    }
    /// Install the official context compaction part and its `/compact`
    /// command (enabled by default).
    pub fn compaction(mut self, enabled: bool) -> Self {
        self.no_compaction = !enabled;
        self
    }

    /// Use a settings file and an external project trust ledger.
    pub fn configuration(mut self, configuration: crate::FilesConfiguration) -> Self {
        self.configuration = Some(configuration);
        self
    }

    /// Use a local credential store instead of environment variables.
    pub fn credentials(mut self, store: impl crate::CredentialStore) -> Self {
        self.credentials = Some(Arc::new(store));
        self
    }

    /// Deployment limits and rights, in the binding's tenant configuration format.
    pub fn tenants(mut self, tenants: Value) -> Self {
        self.tenants = Some(tenants);
        self
    }

    pub fn several_actors(mut self, enabled: bool) -> Self {
        self.several_actors = enabled;
        self
    }

    pub fn session_limits(mut self, enabled: bool) -> Self {
        self.session_limits = enabled;
        self
    }

    /// Use a product's system-prompt contributions instead of the SDK's default.
    pub fn default_prompt(mut self, enabled: bool) -> Self {
        self.no_default_prompt = !enabled;
        self
    }

    pub fn job_reports_start_turns(mut self, enabled: bool) -> Self {
        self.job_reports_start_turns = enabled;
        self
    }
    pub fn provider(mut self, provider: impl Provider) -> Self {
        self.providers.push(Arc::new(ProviderPlugin {
            name: format!("provider.{}", provider.id()),
            provider: Arc::new(provider),
        }));
        self
    }
    /// A tool, wrapped in a plugin named after it.
    pub fn interface_tools(
        mut self,
        sources: impl IntoIterator<Item = crate::InterfaceToolSource>,
    ) -> Self {
        self.interface_tools.extend(sources);
        self
    }

    pub fn tool(mut self, tool: Tool) -> Self {
        self.tools.push(tool);
        self
    }
    /// A plugin, in the agent's process.
    pub fn plugin(mut self, plugin: Plugin) -> Self {
        self.plugins.push(plugin);
        self
    }
    pub(crate) fn wire_plugin(mut self, plugin: Plugin) -> Self {
        self.wire_plugins.push(plugin);
        self
    }
    pub fn environment(mut self, environment: impl Into<crate::Environment>) -> Self {
        self.environment = Some(environment.into());
        self
    }

    pub fn runtime(mut self, runtime: crate::Runtime) -> Self {
        self.runtime = Some(runtime);
        self
    }
    /// A plugin program, loaded after the agent's own plugins. Giving one makes the
    /// agent a plugin host.
    pub fn service_plugin(mut self, plugin: ServicePlugin) -> Self {
        self.service_plugins.push(plugin);
        self
    }
    pub fn process_plugin(mut self, plugin: ProcessPlugin) -> Self {
        self.process_plugins.push((plugin, None));
        self
    }
    /// Load the Claude Provider through its process plugin.
    pub fn claude_provider(mut self, provider: crate::ClaudeProvider) -> Self {
        let (launch, readiness) = provider.into_launch();
        self.process_plugins.push((launch, Some(readiness)));
        self
    }
    /// Whether the agent hosts plugin programs. A plugin host also starts the programs
    /// named in `MODULAR_AGENT_PLUGINS`. Default: when process or service plugins are given.
    /// Append a list of process plugins, in load order.
    pub fn process_plugins(mut self, plugins: impl IntoIterator<Item = ProcessPlugin>) -> Self {
        self.process_plugins
            .extend(plugins.into_iter().map(|plugin| (plugin, None)));
        self
    }

    /// Append a list of service plugins, in load order.
    pub fn service_plugins(mut self, plugins: impl IntoIterator<Item = ServicePlugin>) -> Self {
        self.service_plugins.extend(plugins);
        self
    }

    pub fn plugin_host(mut self, host: bool) -> Self {
        self.plugin_host = Some(host);
        self
    }
    /// The model new sessions use, as `provider/id`.
    /// Name the agent on telemetry spans. Use a fixed, non-sensitive name.
    pub fn agent_name(mut self, name: impl Into<String>) -> Self {
        self.agent_name = Some(name.into());
        self
    }

    pub fn model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }
    /// Accept former Provider ids when resolving saved and configured models.
    #[doc(hidden)]
    pub fn model_provider_aliases(
        mut self,
        aliases: &'static [(&'static str, &'static str)],
    ) -> Self {
        self.model_provider_aliases = aliases;
        self
    }

    /// A default setting for new sessions, by its setting key.
    pub fn setting(mut self, key: impl Into<String>, value: Value) -> Self {
        self.settings.insert(key.into(), value);
        self
    }
    pub fn approval(mut self, policy: Approval) -> Self {
        self.approval = Some(policy);
        self
    }
    /// Answer questions for the local actor. While a handler is set, the local actor
    /// is present to answer; without one, an approval no one can answer is refused.
    pub fn on_question<F, Fut, Reply>(mut self, handler: F) -> Self
    where
        F: Fn(Question) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Reply> + Send + 'static,
        Reply: crate::QuestionReply,
    {
        self.on_question = Some(Arc::new(move |q| {
            let reply = handler(q);
            Box::pin(async move { reply.await.into_answer() })
        }));
        self
    }
    /// Load every part and check the composition. Nothing runs until this succeeds.
    pub async fn build(self) -> Result<Agent> {
        if self.plugin_host == Some(false)
            && !(self.process_plugins.is_empty() && self.service_plugins.is_empty())
        {
            return Err(Error::new(
                Code::InvalidComposition,
                "external plugins require a plugin host",
            ));
        }
        let mut restart = (self.restartable
            && self.process_plugins.is_empty()
            && self.service_plugins.is_empty()
            && self.wire_plugins.is_empty()
            && self.plugin_host != Some(true))
        .then(|| self.clone());
        use crate::parts::EnvironmentKind;
        let environment = self
            .environment
            .map(|env| env.0)
            .unwrap_or(EnvironmentKind::Local(None));
        let local_root = match &environment {
            EnvironmentKind::Local(root) => root.as_ref().map(|p| p.canonicalize()).transpose()?,
            EnvironmentKind::Memory(_) => None,
        };
        let project = match (self.project, &local_root) {
            (Some(p), _) => p.canonicalize()?,
            (None, Some(root)) => root.clone(),
            (None, None) => std::env::current_dir()?.canonicalize()?,
        };
        if local_root.as_ref().is_some_and(|root| *root != project) {
            return Err(Error::new(
                Code::InvalidComposition,
                "the local environment root must match the project",
            ));
        }
        if let Some(history) = &self.history
            && history.1 != (self.durability != Durability::Ephemeral)
        {
            return Err(Error::new(
                Code::InvalidComposition,
                if self.durability == Durability::Ephemeral {
                    "persistent history requires kept or durable, not ephemeral"
                } else {
                    "kept and durable require persistent history"
                },
            ));
        }
        let has_data_dir = self.data_dir.is_some();
        let local = matches!(environment, EnvironmentKind::Local(_));
        let explicit_history = self.history.is_some();
        let explicit_credentials = self.credentials.is_some();
        let explicit_configuration = self.configuration.is_some();
        // The local environment keeps command state on disk; an ephemeral agent puts it
        // in a scratch folder that goes with the agent.
        let (state, scratch) = match &self.data_dir {
            Some(dir) => (dir.clone(), None),
            None => {
                let scratch = tempfile::Builder::new()
                    .prefix("modular-agent-")
                    .tempdir()?;
                (scratch.path().to_path_buf(), Some(scratch))
            }
        };
        std::fs::create_dir_all(&state)?;
        let History(history, persistent, store_name, portable) = match self.history {
            Some(history) => history,
            None if self.durability == Durability::Ephemeral || !has_data_dir => memory_history(),
            None => file_history(state.join("sessions"))?,
        };
        let mut saved_history = History(history.clone(), persistent, store_name, portable.clone());
        if let Some(recipe) = &mut restart {
            recipe.project = Some(project.clone());
            recipe.history = Some(History(history.clone(), persistent, store_name, portable));
        }
        let mut defaults = base::portable::settings_from_wire(&Value::Object(self.settings));
        if let Some(policy) = self.approval {
            defaults["approval"] = json!(policy.native());
        }
        let crash = tokio_util::sync::CancellationToken::new();
        let workers = tokio_util::task::TaskTracker::new();
        let hub = Hub::new(self.on_question, crash.clone(), workers.clone());
        let runtime = self
            .runtime
            .unwrap_or_else(|| match self.durability {
                Durability::Durable => crate::durable_runtime(),
                _ => crate::transient_runtime(),
            })
            .plugin();
        let mut plugins: Vec<Arc<dyn base::Plugin>> = vec![
            Arc::new(CorePlugin {
                configuration: match self.configuration {
                    Some(mut files) => {
                        let mut settings = files.defaults.take().unwrap_or(json!({}));
                        base::merge(&mut settings, defaults);
                        files.defaults = Some(settings);
                        Arc::new(files.base())
                    }
                    None => Arc::new(crate::core::Defaults(defaults)),
                },
                credentials: self.credentials,
                history,
            }),
            match environment {
                EnvironmentKind::Memory(environment) => Arc::new(environment),
                EnvironmentKind::Local(_) => Arc::new(environment_local::LocalPlugin {
                    state: state.join("commands"),
                    points: environment_local::PointStore::Git,
                }),
            },
            runtime,
            Arc::new(crate::core::SdkJobs(self.job_reports_start_turns)),
            Arc::new(feature_questions::QuestionsPlugin),
        ];
        if self.approval.is_some() {
            plugins.push(Arc::new(feature_approval::ApprovalPlugin));
        }
        if self.acp_conformance {
            plugins.push(Arc::new(tools_builtin::BuiltinTools));
            plugins.push(Arc::new(provider_fake::ConformancePlugin));
        }
        plugins.extend(self.providers);
        if !self.no_default_prompt {
            plugins.push(Arc::new(feature_prompt::PromptPlugin));
        }
        plugins.push(Arc::new(feature_model::ModelPlugin));
        if !self.no_compaction {
            plugins.push(Arc::new(feature_context::ContextPlugin));
        }
        plugins.push(Arc::new(HubPlugin(hub.clone())));
        let mut own: Vec<(Arc<dyn base::Plugin>, Vec<String>)> =
            plugins.into_iter().map(|p| (p, vec![])).collect();
        for tool in self.tools {
            let plugin = Plugin::new(tool.name().to_string()).tool(tool);
            own.push((Arc::new(InProcess::new(&plugin)?), vec![]));
        }
        let harness = Harness::for_project(project.clone());
        if let Some(name) = self.agent_name {
            harness.configure_agent_name(name);
        }
        harness.configure_model_provider_aliases(self.model_provider_aliases);
        harness.configure_reservations(Arc::new(agent_harness::ReservationPool::with_bytes(
            self.resource_limits,
            self.byte_limits,
        )))?;
        let tenants = self.tenants.as_ref().map(Value::to_string);
        harness
            .configure_tenants(tenants.as_deref())
            .map_err(|_| Error::new(Code::InvalidParams, "invalid tenant configuration"))?;
        for (plugin, replaces) in own {
            let name = plugin.name().to_string();
            let loaded = if replaces.is_empty() {
                harness.load(plugin).await
            } else {
                harness.load_replacing(plugin, &replaces).await
            };
            if let Err(e) = loaded {
                let _ = base::AgentApi::shutdown(harness.as_ref()).await;
                return Err(Error::new(
                    Code::InvalidComposition,
                    format!("plugin {name} could not load: {e:#}"),
                ));
            }
        }
        let mut interfaces = Vec::new();
        let mut replaces_default_env = false;
        for plugin in &self.plugins {
            let loaded = match InProcess::new(plugin) {
                Ok(registered) => {
                    let registrar = &registered.registered;
                    if let Some(part) = registrar.history_part()
                        && part.1
                        && self.durability == Durability::Ephemeral
                    {
                        let _ = base::AgentApi::shutdown(harness.as_ref()).await;
                        return Err(Error::new(
                            Code::InvalidComposition,
                            "persistent history requires kept or durable, not ephemeral",
                        ));
                    }
                    let collision = (explicit_history && registrar.history_part().is_some())
                        || (explicit_credentials && registrar.has_credentials())
                        || (explicit_configuration && registrar.has_configuration());
                    if collision {
                        Err(Error::new(
                            Code::InvalidComposition,
                            "plugin collides with an explicit part option",
                        ))
                    } else {
                        interfaces.extend(registrar.interfaces.iter().cloned());
                        replaces_default_env |= registrar.has_environment()
                            && plugin.replaces.iter().any(|i| i == "working-environment");
                        harness
                            .load_replacing(Arc::new(registered), &plugin.replaces)
                            .await
                            .map_err(Error::from)
                    }
                }
                Err(e) => Err(e),
            };
            if let Err(e) = loaded {
                let _ = base::AgentApi::shutdown(harness.as_ref()).await;
                return Err(Error::new(
                    Code::InvalidComposition,
                    format!("plugin {} could not load: {e}", plugin.name()),
                ));
            }
        }
        // The slash-command fallback must run after explicit input handlers.
        if let Err(e) = harness
            .load(Arc::new(feature_commands::CommandsPlugin))
            .await
        {
            let _ = base::AgentApi::shutdown(harness.as_ref()).await;
            return Err(Error::new(
                Code::InvalidComposition,
                format!("cannot load commands: {e}"),
            ));
        }
        use plugin_stdio::ExternalLaunch;
        let mut launches: Vec<_> = self
            .process_plugins
            .into_iter()
            .map(|(p, readiness)| (ExternalLaunch::Process(p.into()), readiness))
            .chain(
                self.service_plugins
                    .into_iter()
                    .map(|p| (ExternalLaunch::Service(p), None)),
            )
            .collect();
        let plugin_host = self.plugin_host.unwrap_or(!launches.is_empty());
        if plugin_host && let Some(value) = std::env::var_os("MODULAR_AGENT_PLUGINS") {
            let named: Vec<ExternalLaunch> = match serde_json::from_slice(value.as_encoded_bytes())
            {
                Ok(named) => named,
                Err(e) => {
                    let _ = base::AgentApi::shutdown(harness.as_ref()).await;
                    return Err(Error::new(
                        Code::InvalidComposition,
                        format!("MODULAR_AGENT_PLUGINS is malformed: {e}"),
                    ));
                }
            };
            launches.extend(named.into_iter().map(|p| (p, None)));
        }
        let wire_count = self.wire_plugins.len();
        for (index, plugin) in self.wire_plugins.into_iter().enumerate() {
            if let Some(item) = plugin.local_items.first() {
                let _ = base::AgentApi::shutdown(harness.as_ref()).await;
                return Err(crate::plugin::cannot_serve(item));
            }
            let name = plugin.name.clone();
            let config = plugin.config.clone();
            let endpoint = crate::serve::Served::new(plugin);
            let (host, remote) = tokio::io::duplex(64 * 1024);
            let (read, write) = tokio::io::split(remote);
            let _peer = plugin_stdio::rpc::Peer::start(read, write, endpoint.clone());
            let home = state.join("plugins").join(index.to_string());
            if let Err(error) =
                plugin_stdio::load_pipe(&harness, host, config, &project, &home, index).await
            {
                let _ = base::AgentApi::shutdown(harness.as_ref()).await;
                return Err(endpoint.startup_error().unwrap_or_else(|| {
                    Error::new(
                        Code::InvalidComposition,
                        format!("plugin {name} failed to register: {error:#}"),
                    )
                }));
            }
        }
        for (index, (launch, readiness)) in launches
            .into_iter()
            .enumerate()
            .map(|(i, l)| (i + wire_count, l))
        {
            let home = state.join("plugins").join(index.to_string());
            if let Err(e) = launch
                .load_with_options(
                    &harness,
                    &project,
                    &home,
                    index,
                    plugin_stdio::LoadOptions {
                        readiness,
                        omit_trace_offer: self.omit_plugin_trace_offer,
                    },
                )
                .await
            {
                // An agent never runs without a part it was configured to have.
                let _ = base::AgentApi::shutdown(harness.as_ref()).await;
                return Err(Error::new(
                    Code::InvalidComposition,
                    format!("external plugin {index} did not start: {e:#}"),
                ));
            }
        }
        if let Ok(custom) = base::capability::<History>(harness.as_ref(), "sdk.history.part") {
            saved_history = (*custom).clone();
            if let Some(recipe) = &mut restart {
                // The plugin installs its store again on restart.
                recipe.history = None;
            }
        }
        if saved_history.1 != (self.durability != Durability::Ephemeral) {
            let _ = base::AgentApi::shutdown(harness.as_ref()).await;
            return Err(Error::new(
                Code::InvalidComposition,
                "kept and durable require a persistent history store",
            ));
        }
        if self.durability != Durability::Ephemeral
            && !has_data_dir
            && local
            && !replaces_default_env
        {
            let _ = base::AgentApi::shutdown(harness.as_ref()).await;
            return Err(Error::new(
                Code::InvalidComposition,
                "the local working environment needs a data_dir for recovery bookkeeping",
            ));
        }
        if let Err(error) = harness
            .configure_interface_tools(self.interface_tools.clone())
            .await
        {
            let _ = base::AgentApi::shutdown(harness.as_ref()).await;
            return Err(Error::new(Code::InvalidComposition, error.to_string()));
        }
        harness.rebuild_reservations()?;
        hub.harness.set(Arc::downgrade(&harness)).ok();

        let model = match self.model {
            Some(m) => Some(m),
            None => {
                let mut models = vec![];
                for key in base::AgentApi::capability_names(harness.as_ref(), "provider.") {
                    let provider: Arc<dyn base::Provider> =
                        base::capability(harness.as_ref(), &key)?;
                    models.extend(provider.catalog().into_iter().map(|m| m.name));
                }
                (models.len() == 1).then(|| models.remove(0))
            }
        };
        let mut session_settings = json!({});
        if let Some(model) = model {
            if let Err(error) = require_model(harness.as_ref(), &model) {
                let _ = base::AgentApi::shutdown(harness.as_ref()).await;
                return Err(error);
            }
            session_settings["model"] = json!(model);
        }
        let continues = harness.declaration()?["runtime"]["continues_after_restart"] == true;
        // The offline ACP kit also installs a Runtime fixture to exercise the
        // bridge. It may select transient recovery with persistent history.
        if !self.acp_conformance && continues != (self.durability == Durability::Durable) {
            let _ = base::AgentApi::shutdown(harness.as_ref()).await;
            return Err(Error::new(
                Code::InvalidComposition,
                "runtime recovery does not match the chosen durability",
            ));
        }
        let agent = Agent {
            inner: Arc::new(Inner {
                #[cfg(feature = "agui")]
                interface_sources: self.interface_tools,
                crash,
                workers,
                restart,
                harness,
                hub,
                project,
                persistent: saved_history.1,
                history: saved_history,
                plugin_host,
                acp: Default::default(),
                session_settings,
                several_actors: self.several_actors,
                session_limits: self.session_limits,
                tenants: tenants.is_some(),
                drivers: Default::default(),
                scratch: std::sync::Mutex::new(scratch),
                closed: tokio::sync::Mutex::default(),
                interfaces: Default::default(),
                kept: Default::default(),
            }),
        };
        agent.inner.hub.inner.set(Arc::downgrade(&agent.inner)).ok();
        if agent.inner.harness.has_interface_tools() {
            let inner = Arc::downgrade(&agent.inner);
            agent.inner.harness.on_interface_work(Arc::new(move |id| {
                if let Some(inner) = inner.upgrade() {
                    Session::new(inner, id.to_owned()).drive();
                }
            }));
        }
        for interface in interfaces {
            if let Err(e) = interface.start(agent.clone()).await {
                let _ = interface.stop().await;
                let _ = agent.close().await;
                return Err(Error::new(
                    Code::InvalidComposition,
                    format!("Interface failed to start: {e}"),
                ));
            }
            agent.inner.interfaces.lock().await.push(interface);
        }
        Ok(agent)
    }
}
