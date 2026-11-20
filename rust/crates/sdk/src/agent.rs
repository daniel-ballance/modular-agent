//! Building an agent and opening sessions (docs/sdk/api.md#building-an-agent).
use crate::{
    core::CorePlugin,
    error::{Code, Error, Result},
    events::{Hub, HubPlugin, LOCAL, Question, QuestionHandler},
    history::{History, file_history, memory_history},
    plugin::{InProcess, Plugin},
    provider::{Provider, ProviderPlugin},
    session::Session,
    tool::{Answer, Tool},
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
    pub acp: std::sync::OnceLock<Arc<crate::acp::Routes>>,
    pub session_settings: Value,
    pub several_actors: bool,
    pub session_limits: bool,
    pub tenants: bool,
    pub drivers: std::sync::Mutex<
        std::collections::HashMap<String, std::sync::Weak<crate::session::Driver>>,
    >,
    pub _scratch: Option<tempfile::TempDir>,
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
    several_actors: bool,
    session_limits: bool,
    pub(crate) acp_conformance: bool,
    no_default_prompt: bool,
    no_compaction: bool,
    job_reports_start_turns: bool,
    providers: Vec<Arc<dyn base::Plugin>>,
    tools: Vec<Tool>,
    plugins: Vec<Plugin>,
    process_plugins: Vec<ProcessPlugin>,
    wire_plugins: Vec<Plugin>,
    environment: Option<crate::testing::MemoryEnvironment>,
    plugin_host: Option<bool>,
    model: Option<String>,
    settings: serde_json::Map<String, Value>,
    approval: Option<Approval>,
    on_question: Option<QuestionHandler>,
    pub(crate) restartable: bool,
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
        let id = self
            .inner
            .harness
            .create_in_tenant(&self.inner.project, settings, options.tenant.as_deref())
            .await?;
        self.attach(&id)?;
        let session = Session::new(self.inner.clone(), id);
        for actor in options.actors {
            if let Err(error) = session.join(actor) {
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
        // Register the app's answerer before durable recovery can ask it.
        self.attach(id)?;
        if let Err(error) = base::AgentApi::run_recovery(harness, id).await {
            let _ = harness.close(id).await;
            return Err(error.into());
        }
        Ok(Session::new(self.inner.clone(), id.to_string()))
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
        provider.catalog_changes().ok_or_else(|| Error::new(Code::NotSupported, "this Provider has no catalog notifier"))
    }

    /// Keep a folder alive as long as the agent.
    pub(crate) fn keep(&self, dir: tempfile::TempDir) {
        self.inner.kept.lock().unwrap().push(dir);
    }

    /// Close every session and stop the plugins.
    pub async fn close(&self) -> Result<()> {
        use base::AgentApi;
        Ok(self.inner.harness.shutdown().await?)
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

impl AgentBuilder {
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
    pub fn environment(mut self, environment: crate::testing::MemoryEnvironment) -> Self {
        self.environment = Some(environment);
        self
    }
    /// A plugin program, loaded after the agent's own plugins. Giving one makes the
    /// agent a plugin host.
    pub fn process_plugin(mut self, plugin: ProcessPlugin) -> Self {
        self.process_plugins.push(plugin);
        self
    }
    /// Whether the agent hosts plugin programs. A plugin host also starts the programs
    /// named in `MODULAR_AGENT_PLUGINS`. Default: only when process plugins are given.
    pub fn plugin_host(mut self, host: bool) -> Self {
        self.plugin_host = Some(host);
        self
    }
    /// The model new sessions use, as `provider/id`.
    pub fn model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
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
    pub fn on_question<F, Fut>(mut self, handler: F) -> Self
    where
        F: Fn(Question) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Answer> + Send + 'static,
    {
        self.on_question = Some(Arc::new(move |q| Box::pin(handler(q))));
        self
    }
    /// Load every part and check the composition. Nothing runs until this succeeds.
    pub async fn build(self) -> Result<Agent> {
        if self.plugin_host == Some(false) && !self.process_plugins.is_empty() {
            return Err(Error::new(
                Code::InvalidComposition,
                "process plugins require a plugin host",
            ));
        }
        let mut restart = (self.restartable
            && self.process_plugins.is_empty()
            && self.wire_plugins.is_empty()
            && self.plugin_host != Some(true))
        .then(|| self.clone());
        let project = match self.project {
            Some(p) => p,
            None => std::env::current_dir()?,
        }
        .canonicalize()?;
        if let Some(history) = &self.history
            && history.1 != (self.durability != Durability::Ephemeral)
        {
            return Err(Error::new(
                Code::InvalidComposition,
                "history persistence must match durability",
            ));
        }
        if self.durability != Durability::Ephemeral && self.data_dir.is_none() {
            if self.history.is_none() {
                return Err(Error::new(
                    Code::InvalidComposition,
                    "kept and durable agents need a persistent history store",
                ));
            }
            if self.environment.is_none() {
                return Err(Error::new(
                    Code::InvalidComposition,
                    "the local working environment needs a data_dir for recovery bookkeeping",
                ));
            }
        }
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
        let History(history, persistent, store_name) = match self.history {
            Some(history) => history,
            None if self.durability == Durability::Ephemeral => memory_history(),
            None => file_history(state.join("sessions"))?,
        };
        let saved_history = History(history.clone(), persistent, store_name);
        if let Some(recipe) = &mut restart {
            recipe.project = Some(project.clone());
            recipe.history = Some(History(history.clone(), persistent, store_name));
        }
        let mut defaults = base::portable::settings_from_wire(&Value::Object(self.settings));
        if let Some(policy) = self.approval {
            defaults["approval"] = json!(policy.native());
        }
        let crash = tokio_util::sync::CancellationToken::new();
        let workers = tokio_util::task::TaskTracker::new();
        let hub = Hub::new(self.on_question, crash.clone(), workers.clone());
        let runtime: Arc<dyn base::Plugin> = match self.durability {
            Durability::Durable => Arc::new(runtime_durable::DurablePlugin),
            _ => Arc::new(runtime_transient::TransientPlugin),
        };
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
            match self.environment {
                Some(environment) => Arc::new(environment),
                None => Arc::new(environment_local::LocalPlugin {
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
        for plugin in &self.plugins {
            own.push((Arc::new(InProcess::new(plugin)?), plugin.replaces.clone()));
        }

        own.push((Arc::new(feature_commands::CommandsPlugin), vec![]));
        let harness = Harness::for_project(project.clone());
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
            loaded.map_err(|e| {
                Error::new(
                    Code::InvalidComposition,
                    format!("plugin {name} could not load: {e:#}"),
                )
            })?;
        }
        let mut launches: Vec<plugin_stdio::Launch> = self
            .process_plugins
            .into_iter()
            .map(|p| plugin_stdio::Launch {
                command: p.command,
                env: p.env,
                config: if p.config.is_null() {
                    json!({})
                } else {
                    p.config
                },
            })
            .collect();
        let plugin_host = self.plugin_host.unwrap_or(!launches.is_empty());
        if plugin_host && let Some(value) = std::env::var_os("MODULAR_AGENT_PLUGINS") {
            let named: Vec<plugin_stdio::Launch> = serde_json::from_slice(value.as_encoded_bytes())
                .map_err(|e| {
                    Error::new(
                        Code::InvalidComposition,
                        format!("MODULAR_AGENT_PLUGINS is malformed: {e}"),
                    )
                })?;
            launches.extend(named);
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
        for (index, launch) in launches
            .into_iter()
            .enumerate()
            .map(|(i, l)| (i + wire_count, l))
        {
            let command = launch.command.join(" ");
            let home = state.join("plugins").join(index.to_string());
            if let Err(e) = plugin_stdio::load(&harness, launch, &project, &home, index).await {
                // An agent never runs without a part it was configured to have.
                let _ = base::AgentApi::shutdown(harness.as_ref()).await;
                return Err(Error::new(
                    Code::InvalidComposition,
                    format!("plugin program {command} did not start: {e:#}"),
                ));
            }
        }
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
        Ok(Agent {
            inner: Arc::new(Inner {
                crash,
                workers,
                restart,
                harness,
                hub,
                project,
                persistent,
                history: saved_history,
                plugin_host,
                acp: Default::default(),
                session_settings,
                several_actors: self.several_actors,
                session_limits: self.session_limits,
                tenants: tenants.is_some(),
                drivers: Default::default(),
                _scratch: scratch,
                kept: Default::default(),
            }),
        })
    }
}
