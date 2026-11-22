//! Claude runs in the TypeScript SDK's process plugin. Rust does not read or
//! pass Claude credentials, and never signs in on the caller's behalf.
use crate::{Code, Error, ProcessPlugin, Result};
use plugin_stdio::ProviderReadiness;
use std::{path::PathBuf, time::Duration};

const INSTALLED: &str = ".local/share/modular-agent/sidecars/claude/dist/main.js";
const PROGRAM_ENV: &str = "MODULAR_AGENT_CLAUDE_SIDECAR";
const READINESS: ProviderReadiness = ProviderReadiness {
    id: "claude",
    // Let the program finish its own 30-second probe (PROBE_MS in
    // typescript/packages/claude/src/provider.ts) before treating it as hung.
    guard: Duration::from_secs(35),
    fallback: "Claude Code has no available plan sign-in; run `claude auth login`",
};

#[derive(Clone, Debug, Default)]
pub struct ClaudeOptions {
    pub program: Option<PathBuf>,
}

/// A Provider supplied by a process plugin. Add it with
/// [`crate::AgentBuilder::claude_provider`].
#[derive(Clone, Debug)]
pub struct ClaudeProvider {
    launch: ProcessPlugin,
}

pub fn claude(options: ClaudeOptions) -> Result<ClaudeProvider> {
    let program = options
        .program
        .or_else(|| std::env::var_os(PROGRAM_ENV).map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(INSTALLED)));
    let program = program.and_then(|path| path.canonicalize().ok()).filter(|path| path.is_file())
        .ok_or_else(|| Error::new(Code::InvalidComposition, format!(
            "Claude program not found; set ClaudeOptions::program or {PROGRAM_ENV}, or install ~/{INSTALLED}. The program needs Node.js 22 or newer."
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
    Ok(ClaudeProvider { launch })
}

impl ClaudeProvider {
    pub fn id(&self) -> &'static str {
        READINESS.id
    }

    /// Whether the Claude program reports a Claude plan sign-in. This checks
    /// readiness without making a model request.
    pub async fn available(&self) -> bool {
        self.unavailable_reason().await.is_none()
    }

    pub async fn unavailable_reason(&self) -> Option<String> {
        self.probe(READINESS).await
    }

    async fn probe(&self, readiness: ProviderReadiness) -> Option<String> {
        let result = async {
            let state = tempfile::tempdir()?;
            readiness
                .probe(&self.launch.clone().into(), state.path())
                .await
        }
        .await;
        result.unwrap_or_else(|error| {
            Some(format!("could not check the Claude Code sign-in through the Claude program (Node.js): {error:#}"))
        })
    }

    pub(crate) fn into_launch(self) -> (ProcessPlugin, ProviderReadiness) {
        (self.launch, READINESS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_claude_program_that_never_answers_readiness_hits_the_guard() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let program = dir.path().join("claude.cjs");
        std::fs::write(
            &program,
            concat!(
                "process.argv[2] = 'hang';\n",
                include_str!("../tests/fixtures/claude.cjs")
            ),
        )?;
        let provider = claude(ClaudeOptions {
            program: Some(program),
        })?;
        let guard = Duration::from_millis(100);
        let start = std::time::Instant::now();
        let reason = provider
            .probe(ProviderReadiness { guard, ..READINESS })
            .await;
        assert!(start.elapsed() >= guard);
        assert_eq!(
            reason.as_deref(),
            Some(
                "could not check the Claude Code sign-in through the Claude program (Node.js): the claude program did not answer provider/available within 100ms"
            )
        );
        Ok(())
    }
}
