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
use serde_json::{Value, json};
use std::{future::Future, path::PathBuf, sync::Arc};

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
    pub harness: Arc<Harness>,
    pub hub: Arc<Hub>,
    pub project: PathBuf,
    pub persistent: bool,
    pub plugin_host: bool,
    pub acp: std::sync::OnceLock<Arc<crate::acp::Routes>>,
    pub session_settings: Value,
    pub drivers: std::sync::Mutex<
        std::collections::HashMap<String, std::sync::Weak<crate::session::Driver>>,
    >,
    pub _scratch: Option<tempfile::TempDir>,
    pub kept: std::sync::Mutex<Vec<tempfile::TempDir>>,
}

/// Options for `Agent::builder()`.
#[derive(Default)]
#[must_use]
pub struct AgentBuilder {
    project: Option<PathBuf>,
    data_dir: Option<PathBuf>,
    durability: Durability,
    history: Option<History>,
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
}

impl Agent {
    pub fn builder() -> AgentBuilder {
        AgentBuilder::default()
    }

    /// Create a session.
    pub async fn session(&self) -> Result<Session> {
        let id = self
            .inner
            .harness
            .create(&self.inner.project, self.inner.session_settings.clone())
            .await?;
        self.attach(&id)?;
        Ok(Session::new(self.inner.clone(), id))
    }

    /// Reopen a kept session. Interrupted work is recovered, as the Runtime declares,
    /// before this returns.
    pub async fn open_session(&self, id: &str) -> Result<Session> {
        self.inner.harness.open(id).await.map_err(|e| {
            let e = Error::from(e);
            if matches!(e.code(), Code::NotFound | Code::Held | Code::Lost) {
                e
            } else {
                Error::new(Code::Busy, e.message())
            }
        })?;
        self.attach(id)?;
        Ok(Session::new(self.inner.clone(), id.to_string()))
    }

    pub(crate) fn attach(&self, id: &str) -> Result<()> {
        if self.inner.hub.on_question.is_some() {
            base::requests(self.inner.harness.as_ref())?.presence(id, LOCAL, true);
        }
        Ok(())
    }

    /// What this agent supports, as the ACP declaration.
    pub fn declaration(&self) -> Result<Value> {
        self.declaration_for(None, false)
    }

    pub(crate) fn declaration_for(&self, session: Option<&str>, acp: bool) -> Result<Value> {
        let api = self.inner.harness.as_ref();
        let mut declaration = interface_acp::declaration(api, session)?;
        let native = api.declaration()?;
        declaration["confinesFiles"] = json!(native["environment"]["confines_files"] == true);
        declaration["portableSessions"] = json!(self.inner.persistent);
        declaration["erasure"] = json!(self.inner.persistent);
        if !acp {
            declaration["severalActors"] = json!(false);
            declaration["sessionLimits"] = json!(false);
            declaration["tenants"] = json!(false);
            declaration["mixedActorInput"] = json!("refused");
        }
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
        if self.durability != Durability::Ephemeral
            && self.data_dir.is_none()
            && self.history.is_none()
        {
            return Err(Error::new(
                Code::InvalidComposition,
                format!(
                    "durability {:?} keeps sessions on disk and needs a data_dir",
                    self.durability
                ),
            ));
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
        let History(history, persistent) = match self.history {
            Some(history) => history,
            None if self.durability == Durability::Ephemeral => memory_history(),
            None => file_history(state.join("sessions"))?,
        };
        let mut defaults = base::portable::settings_from_wire(&Value::Object(self.settings));
        if let Some(policy) = self.approval {
            defaults["approval"] = json!(policy.native());
        }
        let hub = Hub::new(self.on_question);
        let runtime: Arc<dyn base::Plugin> = match self.durability {
            Durability::Durable => Arc::new(runtime_durable::DurablePlugin),
            _ => Arc::new(runtime_transient::TransientPlugin),
        };
        let mut plugins: Vec<Arc<dyn base::Plugin>> = vec![
            Arc::new(CorePlugin {
                settings: defaults,
                history,
            }),
            match self.environment {
                Some(environment) => Arc::new(environment),
                None => Arc::new(environment_local::LocalPlugin {
                    state: state.join("commands"),
                }),
            },
            runtime,
            Arc::new(crate::core::SdkJobs(self.job_reports_start_turns)),
            Arc::new(feature_questions::QuestionsPlugin),
        ];
        if self.approval.is_some() {
            plugins.push(Arc::new(feature_approval::ApprovalPlugin));
        }
        plugins.extend(self.providers);
        plugins.extend([
            Arc::new(feature_model::ModelPlugin) as Arc<dyn base::Plugin>,
            Arc::new(feature_prompt::PromptPlugin),
            Arc::new(feature_context::ContextPlugin),
            Arc::new(feature_commands::CommandsPlugin),
        ]);
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

        let harness = Harness::for_project(project.clone());
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
        if plugin_host && let Ok(value) = std::env::var("MODULAR_AGENT_PLUGINS") {
            let named: Vec<plugin_stdio::Launch> = serde_json::from_str(&value).map_err(|e| {
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
            let valid = base::AgentApi::capability_names(harness.as_ref(), "provider.")
                .into_iter()
                .filter_map(|key| {
                    base::capability::<dyn base::Provider>(harness.as_ref(), &key).ok()
                })
                .any(|provider| provider.bind(&model).is_ok());
            if !valid {
                let _ = base::AgentApi::shutdown(harness.as_ref()).await;
                return Err(Error::new(
                    Code::InvalidComposition,
                    format!("unknown model {model}"),
                ));
            }
            session_settings["model"] = json!(model);
        }
        Ok(Agent {
            inner: Arc::new(Inner {
                harness,
                hub,
                project,
                persistent,
                plugin_host,
                acp: Default::default(),
                session_settings,
                drivers: Default::default(),
                _scratch: scratch,
                kept: Default::default(),
            }),
        })
    }
}
