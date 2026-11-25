use modular_agent::{Agent, ProcessPlugin, Result, testing::scripted_provider};
use serde_json::json;

#[path = "../../sdk/tests/fixtures/git_project.rs"]
mod git_project;
use git_project::git_project;

#[tokio::test]
async fn loads_the_tide_plugin_as_a_program() -> Result<()> {
    let project = git_project();
    let agent = Agent::builder()
        .project(project.path())
        .provider(scripted_provider(json!([
            {"toolCalls":[{"name":"tide","input":{"harbour":"Whitby"}}]},
            {"text":"High tide is at 14:02."}
        ])))
        .model("scripted/script")
        .process_plugin(ProcessPlugin::new([
            env!("CARGO_BIN_EXE_modular-agent-fixtures"),
            "tide",
        ]))
        .build()
        .await?;
    let turn = agent
        .session()
        .await?
        .prompt("When is high tide at Whitby?")
        .await?;
    assert_eq!(
        turn.tool_results()[0].text(),
        "High tide at Whitby is 14:02."
    );
    agent.close().await
}
