//! Building an agent and opening sessions (docs/sdk/api.md#building-an-agent).
use crate::{
    core::{CorePlugin, MemoryHistory},
    error::{Code, Error, Result},
    events::{Hub, HubPlugin, LOCAL, Question, QuestionHandler},
    plugin::{InProcess, Plugin},
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

/// Reaches models. Made by a Provider crate, or by `testing::scripted_provider`.
#[derive(Clone)]
pub struct Provider(pub(crate) Arc<dyn base::Plugin>);

impl Provider {
    /// Wrap a plugin of the base build that provides a Provider.
    #[doc(hidden)]
    pub fn from_base(plugin: Arc<dyn base::Plugin>) -> Self {
        Provider(plugin)
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
    providers: Vec<Provider>,
    tools: Vec<Tool>,
    plugins: Vec<Plugin>,
    process_plugins: Vec<ProcessPlugin>,
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
            if e.code() == Code::NotFound {
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
        Ok(self.inner.harness.declaration()?)
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
    pub fn provider(mut self, provider: Provider) -> Self {
        self.providers.push(provider);
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
        if self.durability != Durability::Ephemeral && self.data_dir.is_none() {
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
        let history: Arc<dyn base::HistoryStore> = match self.durability {
            Durability::Ephemeral => Arc::new(MemoryHistory::default()),
            _ => Arc::new(history_fs::FileHistory::new(&state.join("sessions"))?),
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
            Arc::new(environment_local::LocalPlugin {
                state: state.join("commands"),
            }),
            runtime,
            Arc::new(feature_jobs::JobsPlugin),
            Arc::new(feature_questions::QuestionsPlugin),
        ];
        if self.approval.is_some() {
            plugins.push(Arc::new(feature_approval::ApprovalPlugin));
        }
        plugins.extend(self.providers.iter().map(|p| p.0.clone()));
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
        if self.plugin_host.unwrap_or(!launches.is_empty())
            && let Ok(value) = std::env::var("MODULAR_AGENT_PLUGINS")
        {
            let named: Vec<plugin_stdio::Launch> = serde_json::from_str(&value).map_err(|e| {
                Error::new(
                    Code::InvalidComposition,
                    format!("MODULAR_AGENT_PLUGINS is malformed: {e}"),
                )
            })?;
            launches.extend(named);
        }
        for (index, launch) in launches.into_iter().enumerate() {
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
            session_settings["model"] = json!(model);
        }
        Ok(Agent {
            inner: Arc::new(Inner {
                harness,
                hub,
                project,
                session_settings,
                drivers: Default::default(),
                _scratch: scratch,
                kept: Default::default(),
            }),
        })
    }
}
