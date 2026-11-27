//! Manual release checks; never provide credentials through a test file.
use futures_util::StreamExt;
use modular_agent::{Agent, Outcome, Result, ToolStatus};
use modular_agent_anthropic::anthropic;
use modular_agent_openai::{ApiKeyProvider, openai};
use serde_json::json;

#[path = "../../sdk/tests/fixtures/git_project.rs"]
mod git_project;
use git_project::git_project;

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
    let project = git_project();
    let agent = Agent::builder()
        .project(project.path())
        .provider(provider().model(&model, 32_768, 3072))
        .model(&model_ref)
        .tool(modular_agent::testing::fixtures::tide())
        .build()
        .await?;
    check_agent(id, &model_ref, agent).await
}

async fn check_agent(id: &str, model_ref: &str, agent: Agent) -> Result<()> {
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
    let turn = session.last_turn().await?.expect("streamed turn settled");
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

fn live_logins() -> Option<modular_agent::SubscriptionLogins> {
    if std::env::var("MODULAR_AGENT_LIVE").as_deref() != Ok("1") {
        eprintln!("skip subscriptions: MODULAR_AGENT_LIVE is not 1");
        return None;
    }
    let path = std::env::var_os("MODULAR_AGENT_LIVE_LOGINS").filter(|path| !path.is_empty());
    if path.is_none() {
        eprintln!("skip subscriptions: MODULAR_AGENT_LIVE_LOGINS is not set");
    }
    path.map(modular_agent::subscription_logins)
}

#[tokio::test]
async fn chatgpt_live() -> Result<()> {
    use modular_agent::{ChatGptOptions, Provider, chatgpt};
    let Some(logins) = live_logins() else {
        return Ok(());
    };
    let provider = chatgpt(ChatGptOptions::new(logins))?;
    if !provider.availability().await.is_available() {
        eprintln!("skip chatgpt: no plan sign-in");
        return Ok(());
    }
    let model =
        std::env::var("MODULAR_AGENT_LIVE_CHATGPT_MODEL").unwrap_or_else(|_| "gpt-6.1-sol".into());
    let model_ref = format!("chatgpt/{model}");
    let project = git_project();
    let agent = Agent::builder()
        .project(project.path())
        .provider(provider)
        .model(&model_ref)
        .tool(modular_agent::testing::fixtures::tide())
        .build()
        .await?;
    check_agent("chatgpt", &model_ref, agent).await
}

#[tokio::test]
async fn grok_live() -> Result<()> {
    use modular_agent::{GrokOptions, Provider, grok};
    let Some(logins) = live_logins() else {
        return Ok(());
    };
    let provider = grok(GrokOptions::new(logins))?;
    if !provider.availability().await.is_available() {
        eprintln!("skip grok: no plan sign-in");
        return Ok(());
    }
    let model =
        std::env::var("MODULAR_AGENT_LIVE_GROK_MODEL").unwrap_or_else(|_| "grok-4.7".into());
    let project = git_project();
    let agent = Agent::builder()
        .project(project.path())
        .provider(provider)
        .model(format!("grok/{model}"))
        .setting("maxOutput", json!(256))
        .build()
        .await?;
    let turn = agent
        .session()
        .await?
        .prompt("Answer briefly: name a harbour in Yorkshire.")
        .await?;
    assert_eq!(turn.outcome, Some(Outcome::Completed));
    assert!(!turn.text.trim().is_empty());
    agent.close().await
}

#[tokio::test]
async fn claude_live() -> Result<()> {
    use modular_agent::{ClaudeOptions, ProviderAvailability, claude};
    if live_logins().is_none() {
        return Ok(());
    }
    let Ok(provider) = claude(ClaudeOptions::default()) else {
        eprintln!("skip claude: TypeScript program not installed");
        return Ok(());
    };
    if let ProviderAvailability::Unavailable { reason } = provider.availability().await {
        eprintln!(
            "skip claude: {}",
            reason.as_deref().unwrap_or("no plan sign-in")
        );
        return Ok(());
    }
    let model = std::env::var("MODULAR_AGENT_LIVE_CLAUDE_MODEL")
        .unwrap_or_else(|_| "claude-haiku-5-5".into());
    let model_ref = format!("claude/{model}");
    let project = git_project();
    let agent = Agent::builder()
        .project(project.path())
        .claude_provider(provider)
        .model(&model_ref)
        .tool(modular_agent::testing::fixtures::tide())
        .build()
        .await?;
    check_agent("claude", &model_ref, agent).await
}
