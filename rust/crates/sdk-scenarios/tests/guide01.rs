use modular_agent::{Agent, Result};
use modular_agent_anthropic::anthropic;
use modular_agent_openai::openai;

#[path = "../../sdk/tests/fixtures/git_project.rs"]
mod git_project;

#[tokio::test]
async fn guide_01_provider_imports_build_without_a_key() -> Result<()> {
    let project = git_project::git_project();
    let agent = Agent::builder()
        .project(project.path())
        .provider(openai())
        .model("openai/gpt-6-luna")
        .build()
        .await?;
    agent.close().await?;

    let agent = Agent::builder()
        .project(project.path())
        .provider(anthropic())
        .model("anthropic/claude-sonnet-4-6")
        .build()
        .await?;
    agent.close().await
}
