use futures_util::StreamExt;
use modular_agent::{Agent, ClaudeOptions, Code, Outcome, Plugin, claude};
use std::{os::unix::fs::PermissionsExt, path::PathBuf};

fn options(dir: &std::path::Path, status: &str) -> ClaudeOptions {
    let executable = dir.join("claude-status");
    std::fs::write(
        &executable,
        format!("#!/bin/sh\nprintf '%s\\n' '{status}'\n"),
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    ClaudeOptions {
        program: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/claude.cjs")),
        status_program: Some(executable),
    }
}

#[tokio::test]
async fn claude_runs_as_a_process_plugin_and_the_host_runs_its_tool() -> modular_agent::Result<()> {
    let dir = tempfile::tempdir()?;
    let provider = claude(options(
        dir.path(),
        r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}"#,
    ))?;
    assert!(provider.available().await);
    let agent = Agent::builder()
        .claude_provider(provider)
        .model("claude/claude-haiku-5-5")
        .tool(modular_agent::testing::fixtures::tide())
        .plugin(Plugin::new("system").on_turn_before(|_| async {
            Ok(modular_agent::TurnAddition {
                system: Some("Host prompt.".into()),
                ..Default::default()
            })
        }))
        .build()
        .await?;
    assert_eq!(agent.models()?.len(), 2);
    let session = agent.session().await?;
    let mut events = session.prompt_stream("When is the tide?").await?;
    let mut text = String::new();
    let mut reasoned = false;
    while let Some(event) = events.next().await.transpose()? {
        if event.event_type == "text" {
            text.push_str(event.data["delta"].as_str().unwrap());
        }
        if event.event_type == "reasoning" {
            reasoned = true;
        }
    }
    let turn = session.last_turn().await?.unwrap();
    assert_eq!(turn.outcome, Some(Outcome::Completed));
    assert_eq!(text, "14:02");
    assert!(reasoned);
    assert_eq!(turn.tool_results()[0].name, "tide");
    assert_eq!(agent.models()?.len(), 1);
    agent.close().await
}

#[tokio::test]
async fn a_claude_api_key_is_not_a_plan_sign_in() -> modular_agent::Result<()> {
    let dir = tempfile::tempdir()?;
    let provider = claude(options(
        dir.path(),
        r#"{"loggedIn":true,"authMethod":"api_key","apiKeySource":"ANTHROPIC_API_KEY"}"#,
    ))?;
    assert!(!provider.available().await);
    assert!(
        provider
            .unavailable_reason()
            .await
            .unwrap()
            .contains("ANTHROPIC_API_KEY")
    );
    let agent = Agent::builder()
        .claude_provider(provider)
        .model("claude/claude-haiku-5-5")
        .build()
        .await?;
    let session = agent.session().await?;
    let result = session.prompt("Do not send this").await?;
    assert!(
        matches!(result.outcome, Some(Outcome::Failed { error }) if error.contains("ANTHROPIC_API_KEY"))
    );
    agent.close().await
}

#[test]
fn a_missing_program_names_both_configuration_sources() {
    let dir = tempfile::tempdir().unwrap();
    let err = claude(ClaudeOptions {
        program: Some(dir.path().join("missing.cjs")),
        ..Default::default()
    })
    .unwrap_err();
    assert_eq!(err.code(), Code::InvalidComposition);
    assert!(err.message().contains("ClaudeOptions::program"));
    assert!(err.message().contains("MODULAR_AGENT_CLAUDE_SIDECAR"));
}
