use modular_agent::{Agent, ProcessPlugin, Result};
use serde_json::json;

#[tokio::test]
async fn load_a_served_provider() -> Result<()> {
    let agent = Agent::builder()
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
