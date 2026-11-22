//! Claude runs in the TypeScript SDK's process plugin. Rust does not read or
//! pass Claude credentials, and never signs in on the caller's behalf.
use crate::{Code, Error, ProcessPlugin, Result};
use std::path::{Path, PathBuf};

const INSTALLED: &str = ".local/share/modular-agent/sidecars/claude/dist/main.js";
const PROGRAM_ENV: &str = "MODULAR_AGENT_CLAUDE_SIDECAR";

#[derive(Clone, Debug, Default)]
pub struct ClaudeOptions {
    pub program: Option<PathBuf>,
    /// An alternate Claude Code executable for offline fixtures.
    #[doc(hidden)]
    pub status_program: Option<PathBuf>,
}

/// A Provider supplied by a process plugin. Add it with
/// [`crate::AgentBuilder::claude_provider`].
#[derive(Clone, Debug)]
pub struct ClaudeProvider {
    launch: ProcessPlugin,
    status_program: PathBuf,
}

pub fn claude(options: ClaudeOptions) -> Result<ClaudeProvider> {
    let program = options
        .program
        .or_else(|| std::env::var_os(PROGRAM_ENV).map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(INSTALLED)));
    let program = program.and_then(|path| path.canonicalize().ok()).filter(|path| path.is_file())
        .ok_or_else(|| Error::new(Code::InvalidComposition, format!(
            "Claude program not found; set ClaudeOptions::program or {PROGRAM_ENV}, or install ~/{INSTALLED}"
        )))?;
    let script = program
        .to_str()
        .ok_or_else(|| Error::new(Code::InvalidComposition, "Claude program path is not UTF-8"))?;
    let mut launch = ProcessPlugin::new(["node", script]);
    // The process starts with an empty environment. It needs no API key or
    // token from Rust. Claude Code manages its own sign-in.
    for name in ["HOME", "PATH", "CLAUDE_CONFIG_DIR"] {
        if let Ok(value) = std::env::var(name) {
            launch = launch.env(name, value);
        }
    }
    Ok(ClaudeProvider {
        launch,
        status_program: options.status_program.unwrap_or_else(|| "claude".into()),
    })
}

impl ClaudeProvider {
    pub fn id(&self) -> &'static str {
        "claude"
    }

    /// Whether Claude Code reports a Claude plan sign-in. This checks status,
    /// not a model endpoint. The plugin binding also checks its own readiness.
    pub async fn available(&self) -> bool {
        self.unavailable_reason().await.is_none()
    }

    pub async fn unavailable_reason(&self) -> Option<String> {
        self.status().await
    }

    async fn status(&self) -> Option<String> {
        status(&self.status_program).await
    }

    pub(crate) fn into_launch(self) -> (ProcessPlugin, plugin_stdio::ProviderReadiness) {
        let executable = self.status_program;
        let check = std::sync::Arc::new(move || {
            let executable = executable.clone();
            Box::pin(async move { status(&executable).await })
                as futures_util::future::BoxFuture<'static, _>
        });
        (
            self.launch,
            plugin_stdio::ProviderReadiness {
                id: "claude",
                check,
            },
        )
    }
}

async fn status(executable: &Path) -> Option<String> {
    // `auth status` reports JSON without opening a model request. See
    // https://code.claude.com/docs/en/cli-reference#cli-commands
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::process::Command::new(executable)
            .args(["auth", "status"])
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await;
    let Ok(Ok(output)) = output else {
        return Some("Could not check Claude Code sign-in with `claude auth status`.".into());
    };
    let auth = serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap_or_default();
    let method = auth["authMethod"].as_str();
    let source = auth["apiKeySource"]
        .as_str()
        .filter(|source| !source.is_empty() && *source != "none");
    if source.is_some() || matches!(method, Some("api_key" | "api_key_helper")) {
        let source = match (source, method) {
            (Some("ANTHROPIC_API_KEY"), _) => "ANTHROPIC_API_KEY",
            (Some("ANTHROPIC_AUTH_TOKEN"), _) => "ANTHROPIC_AUTH_TOKEN",
            (Some("apiKeyHelper"), _) | (_, Some("api_key_helper")) => "apiKeyHelper",
            (Some("user" | "console"), _) => "the stored Anthropic Console sign-in",
            _ => "Claude Code's configured API credential",
        };
        return Some(format!(
            "Claude Code is using an API key from {source}; sign in to a Claude plan with `claude auth login`."
        ));
    }
    if output.status.success()
        && auth["loggedIn"] == true
        && method == Some("claude.ai")
        && auth["apiProvider"]
            .as_str()
            .is_none_or(|provider| provider == "firstParty")
    {
        return None;
    }
    Some("Claude Code is not signed in to a Claude plan; run `claude auth login`.".into())
}
