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
pub mod policy;
pub mod prompt;
pub mod script;
pub mod sink;
pub mod skills;
pub mod terminal;

use anyhow::{Result, anyhow};
use modular_agent::{
    Agent, AgentBuilder, ChatGptOptions, ClaudeOptions, ClientIdentity, Durability,
    FilesConfiguration, History, Plugin, chatgpt, claude,
};
use modular_agent_mcp::Mcp;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub const PROVIDERS: [&str; 3] = ["chatgpt", "grok", "claude"];
const ALIASES: &[(&str, &str)] = &[("openai-codex", "chatgpt"), ("xai", "grok")];

pub fn canonical_provider(id: &str) -> &str {
    ALIASES
        .iter()
        .find_map(|(old, new)| (*old == id).then_some(*new))
        .unwrap_or(id)
}

pub fn canonical_model(model: &str) -> String {
    if let Some((provider, model)) = model.split_once('/') {
        format!("{}/{model}", canonical_provider(provider))
    } else {
        model.to_string()
    }
}

#[derive(Clone)]
pub struct Standard {
    pub limits: modular_agent::ResourceLimits,
    pub byte_limits: modular_agent::ByteLimits,
    pub tenant_scopes: bool,
    /// Settings, sign-ins, MCP servers, skills and the person's AGENTS.md.
    pub config: PathBuf,
    /// Sessions and working files.
    pub state: PathBuf,
    pub durable: bool,
    /// Start the Claude sidecar. It costs a process, so it is started only
    /// when a Claude model is wanted or the catalog is being listed.
    pub claude: bool,
    /// The label for ChatGPT requests and ChatGPT and Grok sign-ins.
    pub client_identity: ClientIdentity,
    /// A scripted Provider in place of the real ones, for tests.
    pub scripted: Option<script::Script>,
    pub conformance: bool,
    /// The code tool's limits.
    pub code: tools_code::CodeTool,
}

impl Standard {
    pub fn from_env(client_identity: ClientIdentity) -> Result<Self> {
        let home =
            PathBuf::from(std::env::var_os("HOME").ok_or_else(|| anyhow!("HOME is not set"))?);
        let dir = |variable: &str, fallback: &str, under: &str| {
            std::env::var_os(variable)
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
                .unwrap_or_else(|| home.join(fallback))
                .join(under)
        };
        // The ACP binding's directory holds both, so a host can isolate an agent.
        let (config, state) = match std::env::var_os("MODULAR_AGENT_DATA_DIR") {
            Some(base) => (PathBuf::from(&base), PathBuf::from(base).join("state")),
            None => (
                dir("XDG_CONFIG_HOME", ".config", "modular-agent"),
                dir("XDG_STATE_HOME", ".local/state", "modular-agent").join("rust"),
            ),
        };
        Ok(Self {
            config,
            state,
            limits: policy::Bounds::default().counts(),
            byte_limits: policy::Bounds::default().bytes(),
            tenant_scopes: false,
            durable: true,
            claude: false,
            client_identity,
            scripted: std::env::var_os("MODULAR_AGENT_SCRIPT")
                .map(|file| -> Result<_> {
                    let responses = serde_json::from_slice(&std::fs::read(file)?)?;
                    Ok(script::Script::new(
                        responses,
                        std::env::var_os("MODULAR_AGENT_SCRIPT_LOG").map(PathBuf::from),
                    ))
                })
                .transpose()?,
            conformance: std::env::var("MODULAR_AGENT_CONFORMANCE").as_deref() == Ok("1"),
            code: tools_code::CodeTool::default(),
        })
    }
    pub fn settings_file(&self) -> PathBuf {
        self.config.join("settings.json")
    }
    pub fn auth(&self) -> credentials_auth::AuthFile {
        credentials_auth::AuthFile::new(self.config.join("auth.json"), &PROVIDERS)
            .with_aliases(ALIASES)
    }
    pub fn configuration(&self) -> FilesConfiguration {
        FilesConfiguration {
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
            Ok(bytes) => {
                let mut catalog: Value = serde_json::from_slice(&bytes)
                    .map_err(|e| anyhow!("{}: {e}", path.display()))?;
                if let Some(providers) = catalog.as_object_mut() {
                    for &(old, canonical) in ALIASES {
                        if let Some(old) = providers.remove(old) {
                            // Canonical entries win if the same model appears twice.
                            if let Some(new) = providers.get_mut(canonical) {
                                let old = old.as_array().ok_or_else(|| {
                                    anyhow!("models for {canonical} must be an array")
                                })?;
                                let new = new.as_array_mut().ok_or_else(|| {
                                    anyhow!("models for {canonical} must be an array")
                                })?;
                                new.splice(..0, old.iter().cloned());
                            } else {
                                providers.insert(canonical.into(), old);
                            }
                        }
                    }
                }
                Ok(catalog)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
            Err(e) => Err(e.into()),
        }
    }
    pub fn history(&self) -> Result<History> {
        Ok(match modular_agent::http_history_from_env()? {
            Some(history) => history,
            None => modular_agent::file_history(self.state.join("sessions"))?,
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

/// One SDK composition serves one project, with that project's trust.
pub fn builder(
    standard: &Standard,
    project: &Path,
    mcp: &Mcp,
    extra: Vec<Plugin>,
) -> Result<AgentBuilder> {
    let project = project.canonicalize()?;
    let mut configuration = standard.configuration();
    if standard.conformance {
        configuration.defaults.as_mut().unwrap()["model_tools"] = Value::Null;
    }
    let mcp_config = mcp::McpConfig {
        global: standard.config.join("mcp.json"),
        project_trusted: configuration.trusted(&project)?,
    };
    let (servers, problems) = mcp_config.servers(&project);
    for problem in problems {
        eprintln!("MCP: {problem}");
    }
    let skills = standard.skills();
    let mut b = Agent::builder()
        .project(&project)
        .model_provider_aliases(ALIASES)
        .data_dir(&standard.state)
        .durability(if standard.durable {
            Durability::Durable
        } else {
            Durability::Kept
        })
        .configuration(configuration)
        .resource_limits(standard.limits.clone())
        .byte_limits(standard.byte_limits)
        .credentials(standard.auth())
        .history(standard.history()?)
        .default_prompt(false)
        .compaction(true)
        .job_reports_start_turns(true)
        .plugin_host(true)
        .plugin(mcp.plugin(servers))
        .plugin(standard.code.plugin())
        .plugin(skills.clone().plugin(project))
        .plugin(
            prompt::PromptPlugin {
                global: standard.config.join("AGENTS.md"),
            }
            .plugin(skills),
        );
    if standard.tenant_scopes
        && let Some(tenants) = std::env::var_os("MODULAR_AGENT_TENANTS")
    {
        let raw = tenants
            .to_str()
            .ok_or_else(|| anyhow!("invalid MODULAR_AGENT_TENANTS"))?;
        b = b.tenants(serde_json::from_str(raw)?);
    }
    if !standard.conformance || standard.scripted.is_some() {
        b = b.plugin(modular_agent_files::files(standard.state.join("output")));
    }
    if let Some(scripted) = &standard.scripted {
        b = b
            .provider(scripted.provider())
            .model(modular_agent::testing::SCRIPTED_MODEL);
    } else if standard.conformance {
        b = modular_agent::testing::acp_conformance(b);
    } else {
        let overrides = standard.model_overrides()?;
        let logins = standard.auth().subscription_logins();
        let mut options = ChatGptOptions::new(logins.clone());
        options.client_identity = Some(standard.client_identity.as_str().to_owned());
        b = b
            .provider(chatgpt(options)?.with_catalog_overrides(
                provider_responses::model_overrides(&overrides, "chatgpt")?,
            ))
            .provider(provider_responses::provider(
                logins,
                standard.client_identity.clone(),
                provider_responses::model_overrides(&overrides, "grok")?,
            )?);
        if standard.claude {
            b = b.claude_provider(claude(ClaudeOptions::default())?);
        }
    }
    for plugin in extra {
        b = b.plugin(plugin);
    }
    Ok(b)
}

/// The model to start with when settings name none: the first Provider that
/// is signed in.
pub async fn default_model(standard: &Standard) -> Option<&'static str> {
    let auth = standard.auth();
    let signed_in = |provider: &str| auth.login(provider).ok().flatten().is_some();
    if signed_in("chatgpt") {
        Some("chatgpt/gpt-6.1-sol")
    } else if signed_in("grok") {
        Some("grok/grok-4.7")
    } else if let Ok(provider) = claude(ClaudeOptions::default())
        && provider.available().await
    {
        Some("claude/claude-sonnet-5-5")
    } else {
        None
    }
}
