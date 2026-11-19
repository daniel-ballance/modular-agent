//! The standard configuration: the Harness with the plugin set that makes a
//! coding agent in Pi's shape. Nothing here is special to the Harness. Every
//! line of behaviour is a plugin that another configuration could swap.
//!
//! - Providers: ChatGPT and Grok subscriptions (Responses API), and Claude
//!   through the Agent SDK sidecar, a plugin in its own process.
//! - Tools: read, exec, edit, write, find and list, plus MCP servers. The
//!   model is offered one tool, `codemode`, and reaches the rest as Python
//!   functions in a Monty sandbox.
//! - Agent Skills, instruction files, compaction, model selection, commands.
pub mod acp;
pub mod mcp;
pub mod prompt;
pub mod sink;
pub mod skills;

use agent_api::*;
use agent_harness::Harness;
use provider_responses::{ResponsesPlugin, Vendor};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

pub const PROVIDERS: [&str; 3] = ["openai-codex", "xai", "claude"];

#[derive(Clone)]
pub struct Standard {
    /// Settings, sign-ins, MCP servers, skills and the person's AGENTS.md.
    pub config: PathBuf,
    /// Sessions and working files.
    pub state: PathBuf,
    pub durable: bool,
    /// Start the Claude sidecar. It costs a process, so it is started only
    /// when a Claude model is wanted or the catalog is being listed.
    pub claude: bool,
    /// A scripted Provider in place of the real ones, for tests.
    pub scripted: Option<Arc<dyn Plugin>>,
    /// The code tool's limits.
    pub code: tools_code::CodeTool,
}

impl Standard {
    pub fn from_env() -> Result<Self> {
        let home = PathBuf::from(std::env::var_os("HOME").ok_or_else(|| anyhow!("HOME is not set"))?);
        let dir = |variable: &str, fallback: &str, under: &str| {
            std::env::var_os(variable)
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
                .unwrap_or_else(|| home.join(fallback))
                .join(under)
        };
        // The ACP binding's directory holds both, so a host can isolate an agent.
        let (config, state) = match std::env::var_os("MODULAR_AGENT_DATA_DIR") {
            Some(base) => (PathBuf::from(&base), PathBuf::from(base)),
            None => (
                dir("XDG_CONFIG_HOME", ".config", "modular-agent"),
                dir("XDG_STATE_HOME", ".local/state", "modular-agent"),
            ),
        };
        Ok(Self {
            config,
            state,
            durable: true,
            claude: false,
            scripted: None,
            code: tools_code::CodeTool::default(),
        })
    }
    pub fn settings_file(&self) -> PathBuf {
        self.config.join("settings.json")
    }
    pub fn auth(&self) -> credentials_auth::AuthFile {
        credentials_auth::AuthFile::new(self.config.join("auth.json"), &PROVIDERS)
    }
    pub fn configuration(&self) -> config_files::FilesConfiguration {
        config_files::FilesConfiguration {
            global: self.settings_file(),
            defaults: Some(defaults()),
        }
    }
    pub fn skills(&self) -> skills::SkillsPlugin {
        let mut global = vec![self.config.join("skills")];
        if let Some(home) = std::env::var_os("HOME") {
            global.push(PathBuf::from(home).join(".agents/skills"));
        }
        skills::SkillsPlugin { global }
    }
    /// Model catalog additions and replacements, by Provider.
    pub fn model_overrides(&self) -> Result<Value> {
        let path = self.config.join("models.json");
        match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| anyhow!("{}: {e}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
            Err(e) => Err(e.into()),
        }
    }
    pub fn history(&self) -> Result<Arc<dyn Plugin>> {
        Ok(match history_http::HttpHistory::from_env()? {
            Some(http) => Arc::new(history_http::HttpPlugin(http)),
            None => Arc::new(history_fs::HistoryPlugin {
                root: self.state.join("sessions"),
            }),
        })
    }
    pub fn list(&self, project: Option<&Path>) -> Result<Vec<SessionData>> {
        match history_http::HttpHistory::from_env()? {
            Some(http) => http.list(project),
            None => history_fs::FileHistory::new(&self.state.join("sessions"))?.list(project),
        }
    }
    pub fn load(&self, session: &str) -> Result<SessionData> {
        match history_http::HttpHistory::from_env()? {
            Some(http) => http.load(session),
            None => history_fs::FileHistory::new(&self.state.join("sessions"))?.load(session),
        }
    }
    /// How to start the Claude sidecar, if it is installed.
    pub fn claude_launch(&self) -> Option<plugin_stdio::Launch> {
        let script = std::env::var_os("MODULAR_AGENT_CLAUDE_SIDECAR")
            .map(PathBuf::from)
            .into_iter()
            .chain(std::env::current_exe().ok().and_then(|exe| {
                // A development build: rust/target/<profile>/ma beside sidecars/.
                Some(exe.parent()?.parent()?.parent()?.parent()?.join("sidecars/claude/dist/main.js"))
            }))
            .chain(std::env::var_os("HOME").map(|home| {
                PathBuf::from(home).join(".local/share/modular-agent/sidecars/claude/dist/main.js")
            }))
            .find(|path| path.is_file())?;
        // A plugin starts with an empty environment. The sidecar needs these
        // to find node and Claude Code's own sign-in. No credential is passed.
        let env = ["HOME", "PATH", "CLAUDE_CONFIG_DIR"]
            .into_iter()
            .filter_map(|name| Some((name.to_owned(), std::env::var(name).ok()?)))
            .collect();
        Some(plugin_stdio::Launch {
            command: vec!["node".into(), script.to_string_lossy().into_owned()],
            env,
            config: Value::Null,
        })
    }
}

/// Session defaults, beneath `settings.json` and a project's
/// `.modular-agent.json`. No model: it is chosen from what is signed in.
pub fn defaults() -> Value {
    json!({
        "thinking": "medium",
        "step_limit": 500,
        "output_limit": 32000,
        "model_tools": [tools_code::TOOL],
    })
}

/// One composition serves one project, with that project's trust.
pub async fn compose(
    standard: &Standard,
    interface: Arc<dyn Plugin>,
    project: &Path,
) -> Result<Arc<Harness>> {
    let project = project.canonicalize()?;
    let configuration = standard.configuration();
    let trusted = configuration.trusted(&project)?;
    let mcp = Arc::new(tools_mcp::Mcp::default());
    let overrides = standard.model_overrides()?;
    let runtime: Arc<dyn Plugin> = if standard.durable {
        Arc::new(runtime_durable::DurablePlugin)
    } else {
        Arc::new(runtime_transient::TransientPlugin)
    };
    let mut plugins: Vec<Arc<dyn Plugin>> = vec![
        Arc::new(configuration),
        standard.history()?,
        Arc::new(standard.auth()),
        Arc::new(environment_local::LocalPlugin {
            state: standard.state.join("commands"),
        }),
        Arc::new(tools_files::FileTools::new(standard.state.join("output"))),
        Arc::new(tools_mcp::McpPlugin {
            servers: vec![],
            service: mcp.clone(),
        }),
        Arc::new(mcp::McpConfig {
            service: mcp,
            global: standard.config.join("mcp.json"),
            project_trusted: trusted,
        }),
        Arc::new(standard.code.clone()),
        runtime,
        Arc::new(feature_jobs::JobsPlugin),
        Arc::new(feature_questions::QuestionsPlugin),
    ];
    match &standard.scripted {
        Some(provider) => plugins.push(provider.clone()),
        None => {
            for vendor in [Vendor::Codex, Vendor::Xai] {
                plugins.push(Arc::new(ResponsesPlugin::new(
                    vendor,
                    provider_responses::catalog(vendor, &overrides)?,
                )));
            }
        }
    }
    plugins.extend([
        Arc::new(feature_model::ModelPlugin) as Arc<dyn Plugin>,
        // Skills see input before the command handler does.
        Arc::new(standard.skills()),
        Arc::new(prompt::PromptPlugin {
            global: standard.config.join("AGENTS.md"),
        }),
        Arc::new(feature_context::ContextPlugin),
        Arc::new(feature_commands::CommandsPlugin),
        interface,
        Arc::new(ProjectComposition(project.clone())),
    ]);
    let harness = Harness::for_project(project.clone());
    harness.configure_tenants(std::env::var("MODULAR_AGENT_TENANTS").ok().as_deref())?;
    let loaded: Result<()> = async {
        for plugin in plugins {
            harness.load(plugin).await?;
        }
        if standard.claude && standard.scripted.is_none() {
            let launch = standard.claude_launch().ok_or_else(|| {
                anyhow!("the Claude sidecar is not installed; build sidecars/claude or set MODULAR_AGENT_CLAUDE_SIDECAR")
            })?;
            plugin_stdio::load(&harness, launch, &project, &standard.state.join("plugins/claude"), 0)
                .await
                .map_err(|e| anyhow!("the Claude sidecar did not start: {e:#}"))?;
        }
        Ok(())
    }
    .await;
    if let Err(error) = loaded {
        let _ = harness.shutdown().await;
        return Err(error);
    }
    Ok(harness)
}

struct ProjectComposition(PathBuf);
impl Plugin for ProjectComposition {
    fn name(&self) -> &str {
        "composition.project"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        let project = self.0.clone();
        r.on(
            "session.prepare",
            Order::First,
            handler(move |api, scope, _| {
                let project = project.clone();
                Box::pin(async move {
                    ensure!(
                        api.snapshot(&scope.session)?.project == project,
                        "this composition belongs to a different project"
                    );
                    Ok(HookResult::default())
                })
            }),
        );
        Ok(())
    }
}

/// Every model the composition offers, as `provider/id`.
pub fn models(api: &dyn AgentApi) -> Result<Vec<ModelInfo>> {
    let mut models = vec![];
    for key in api.capability_names("provider.") {
        models.extend(capability::<dyn Provider>(api, &key)?.catalog());
    }
    Ok(models)
}

/// The model to start with when settings name none: the first Provider that
/// is signed in.
pub fn default_model(standard: &Standard) -> Option<&'static str> {
    let auth = standard.auth();
    let signed_in = |provider: &str| auth.login(provider).ok().flatten().is_some();
    if signed_in("openai-codex") {
        Some("openai-codex/gpt-6.1-sol")
    } else if signed_in("xai") {
        Some("xai/grok-4.7")
    } else {
        None
    }
}
