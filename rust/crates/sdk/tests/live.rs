//! Manual release checks; never provide credentials through a test file.
use futures_util::StreamExt;
use modular_agent::{Agent, ApiKeyProvider, Outcome, Result, ToolStatus, anthropic, openai};
use serde_json::json;

async fn check(
    id: &str,
    env_prefix: &str,
    default_model: &str,
    provider: fn() -> ApiKeyProvider,
) -> Result<()> {
    if std::env::var("MODULAR_AGENT_LIVE").as_deref() != Ok("1") {
        eprintln!("skip {id}: MODULAR_AGENT_LIVE is not 1");
        return Ok(());
    }
    if !std::env::var(format!("{env_prefix}_API_KEY")).is_ok_and(|key| !key.is_empty()) {
        eprintln!("skip {id}: key is absent");
        return Ok(());
    }
    let model = std::env::var(format!("MODULAR_AGENT_LIVE_{env_prefix}_MODEL"))
        .unwrap_or_else(|_| default_model.into());
    let model_ref = format!("{id}/{model}");
    let agent = Agent::builder()
        .provider(provider().model(&model, 32_768, 3072))
        .model(&model_ref)
        .tool(modular_agent::testing::fixtures::tide())
        .build()
        .await?;
    let session = agent.session().await?;
    let turn = session
        .prompt("Answer briefly: name a harbour in Yorkshire.")
        .await?;
    assert_eq!(turn.outcome, Some(Outcome::Completed));
    assert!(!turn.text.trim().is_empty());

    let session = agent.session().await?;
    let mut events = session
        .prompt_stream("Give one brief fact about tides.")
        .await?;
    let mut text = String::new();
    while let Some(event) = events.next().await.transpose()? {
        if event.event_type == "text" {
            text.push_str(event.data["delta"].as_str().unwrap());
        }
    }
    let turn = session.last_turn()?.expect("streamed turn settled");
    assert_eq!(turn.outcome, Some(Outcome::Completed));
    assert!(!text.trim().is_empty());
    assert_eq!(text, turn.text);

    let turn = agent
        .session()
        .await?
        .prompt("Call the tide tool for Whitby and report its answer, including the exact time.")
        .await?;
    assert_eq!(turn.outcome, Some(Outcome::Completed));
    assert!(
        turn.tool_results()
            .iter()
            .any(|r| r.name == "tide" && r.status == ToolStatus::Completed)
    );
    assert!(turn.text.contains("14:02"));

    let models = agent.models()?;
    let info = models
        .iter()
        .find(|m| m.model.to_string() == model_ref)
        .unwrap();
    if let Some(reasoning) = info.thinking.iter().find(|level| level.as_str() != "off") {
        let session = agent.session().await?;
        session.set_setting("reasoning", json!(reasoning))?;
        let turn = session
            .prompt("Give the sum of two and three in one sentence.")
            .await?;
        assert_eq!(turn.outcome, Some(Outcome::Completed));
        assert!(!turn.text.trim().is_empty());
    } else {
        eprintln!("skip {id} reasoning check: model does not advertise a reasoning setting");
    }
    agent.close().await
}

#[tokio::test]
async fn openai_live() -> Result<()> {
    check("openai", "OPENAI", "gpt-6-luna", openai).await
}

#[tokio::test]
async fn anthropic_live() -> Result<()> {
    check("anthropic", "ANTHROPIC", "claude-haiku-5-5", anthropic).await
}
