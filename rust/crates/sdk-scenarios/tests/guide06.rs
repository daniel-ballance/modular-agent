use modular_agent::{Agent, ProcessPlugin, Result};
use serde_json::json;

#[path = "../../sdk/tests/fixtures/git_project.rs"]
mod git_project;
use git_project::git_project;

#[tokio::test]
async fn load_a_served_provider() -> Result<()> {
    let project = git_project();
    let agent = Agent::builder()
        .project(project.path())
        .process_plugin(
            ProcessPlugin::new([
                env!("CARGO_BIN_EXE_modular-agent-fixtures"),
                "provider-script",
            ])
            .config(json!({"script": [{"text": "Beacon ready."}]})),
        )
        .model("scripted/script")
        .build()
        .await?;
    let turn = agent.session().await?.prompt("Check the beacon.").await?;
    assert_eq!(turn.text, "Beacon ready.");
    agent.close().await
}
