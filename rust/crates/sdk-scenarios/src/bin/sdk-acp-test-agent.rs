//! Offline fixture for the SDK ACP integration test.
use modular_agent::{Agent, Result, testing::scripted_provider};
use serde_json::json;

#[tokio::main]
async fn main() -> Result<()> {
    let agent = Agent::builder()
        .plugin_host(true)
        .provider(scripted_provider(json!([{"text":"Hello over ACP."}])))
        .build()
        .await?;
    agent.serve_acp().await?;
    agent.close().await
}
