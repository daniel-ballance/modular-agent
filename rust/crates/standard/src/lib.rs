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
mod hidden;
pub mod mcp;
pub mod policy;
pub mod prompt;
pub mod script;
pub mod sink;
pub mod skills;
pub mod terminal;

use anyhow::{Result, anyhow};
use modular_agent::{
    Agent, AgentBuilder, Approval, ChatGptOptions, ClaudeOptions, ClientIdentity, Durability,
    FilesConfiguration, GrokOptions, History, Plugin, chatgpt, claude, grok,
    responses::ResponsesModel,
};
use modular_agent_mcp::Mcp;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub const PROVIDERS: [&str; 3] = ["chatgpt", "grok", "claude"];
#[derive(Clone)]
pub struct Standard {
    pub approval: Option<Approval>,
    pub approval_wait_max_ms: Option<u64>,
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
            approval: None,
            approval_wait_max_ms: None,
            config,
            state,
            limits: policy::Bounds::default().counts(),
            byte_limits: policy::Bounds::default().bytes(),
            tenant_scopes: false,
            durable: true,
            claude: false,
            client_identity,
            scripted: std::env::var_os("MODULAR_AGENT_SCRIPT")
                .filter(|file| !file.is_empty())
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
    pub fn resume_open(&self) -> Result<bool> {
        self.configuration()
            .global_settings()?
            .get("resume_open")
            .map_or(Ok(false), |v| {
                v.as_bool().ok_or_else(|| {
                    anyhow!(
                        "{}: resume_open must be boolean",
                        self.settings_file().display()
                    )
                })
            })
    }
    pub fn auth(&self) -> credentials_auth::AuthFile {
        credentials_auth::AuthFile::new(self.config.join("auth.json"), &PROVIDERS)
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
                serde_json::from_slice(&bytes).map_err(|e| anyhow!("{}: {e}", path.display()))
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

pub fn approval_policy(value: &str) -> Result<Approval> {
    match value {
        "off" => Ok(Approval::Off),
        "ask" => Ok(Approval::Ask),
        "all" => Ok(Approval::All),
        "never" => Ok(Approval::Never),
        _ => Err(anyhow!("approval must be off, ask, all or never")),
    }
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
    let mut settings = configuration.settings(&project)?;
    let mut b = Agent::builder()
        .agent_name("ma")
        .project(&project)
        .data_dir(&standard.state)
        .durability(if standard.durable {
            Durability::Durable
        } else {
            Durability::Kept
        })
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
    // Only the operator may load approval or choose its defaults. Do not pass a
    // second, unfiltered file configuration to the SDK after making this choice.
    for key in ["approval", "approval_wait", "approvalWait"] {
        settings.as_object_mut().unwrap().remove(key);
    }
    for (key, value) in settings.as_object().unwrap() {
        b = b.setting(key, value.clone());
    }
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
            .model(modular_agent::testing::SCRIPTED_MODEL)
            .plugin(script::test_tools_plugin());
    } else if standard.conformance {
        b = modular_agent::testing::acp_conformance(b);
    } else {
        let overrides = standard.model_overrides()?;
        let logins = standard.auth().subscription_logins();
        let identity = standard.client_identity.as_str().to_owned();
        let mut chatgpt_options = ChatGptOptions::new(logins.clone());
        chatgpt_options.client_identity = Some(identity.clone());
        let mut grok_options = GrokOptions::new(logins);
        grok_options.client_identity = Some(identity);
        b = b
            .provider(
                chatgpt(chatgpt_options)?
                    .with_catalog_overrides(catalog_overrides(&overrides, "chatgpt")?),
            )
            .provider(
                grok(grok_options)?.with_catalog_overrides(catalog_overrides(&overrides, "grok")?),
            );
        if standard.claude {
            b = b.claude_provider(claude(ClaudeOptions::default())?);
        }
    }
    let global = configuration.global_settings()?;
    let approval = match standard.approval {
        Some(policy) => Some(policy),
        None => global
            .get("approval")
            .map(|v| approval_policy(v.as_str().unwrap_or("")))
            .transpose()
            .map_err(|e| anyhow!("{}: {e}", standard.settings_file().display()))?,
    };
    let wait = match global.get("approval_wait") {
        None => "live",
        Some(v) if matches!(v.as_str(), Some("live" | "untilDeadline")) => v.as_str().unwrap(),
        _ => {
            return Err(anyhow!(
                "{}: approval_wait must be live or untilDeadline",
                standard.settings_file().display()
            ));
        }
    };
    if let Some(policy) = approval {
        b = b.approval(policy).approval_covers_nested(true);
        if let Some(max) = standard.approval_wait_max_ms {
            b = b
                .max_approval_wait_ms(max)
                .setting("approvalWait", json!(wait));
        }
    }
    for plugin in extra {
        b = b.plugin(plugin);
    }
    Ok(b)
}

fn catalog_overrides(catalog: &Value, provider: &str) -> Result<Vec<ResponsesModel>> {
    let models = &catalog[provider];
    if models.is_null() {
        return Ok(vec![]);
    }
    serde_json::from_value(models.clone()).map_err(|e| anyhow!("models for {provider}: {e}"))
}

/// The model to start with when settings name none: the first Provider that
/// is signed in.
pub async fn default_model(standard: &Standard) -> Option<&'static str> {
    let auth = standard.auth().subscription_logins();
    let signed_in = |provider: &str| auth.login(provider).ok().flatten().is_some();
    if signed_in("chatgpt") {
        Some("chatgpt/gpt-6.1-sol")
    } else if signed_in("grok") {
        Some("grok/grok-4.7")
    } else if let Ok(provider) = claude(ClaudeOptions::default())
        && provider.availability().await.is_available()
    {
        Some("claude/claude-sonnet-5-5")
    } else {
        None
    }
}
