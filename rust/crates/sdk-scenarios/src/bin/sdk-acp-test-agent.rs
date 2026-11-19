//! Offline fixture for the SDK ACP integration test.
use modular_agent::{
    Agent, AssistantMessage, Durability, ModelInfo, ModelRef, ModelRequest, Provider,
    ProviderContext, ProviderSupport, Result, testing::scripted_provider,
};
use serde_json::json;

#[tokio::main]
async fn main() -> Result<()> {
    let builder = Agent::builder().plugin_host(true);
    let builder = if let Some(state) = std::env::args_os().nth(1) {
        builder
            .data_dir(state)
            .durability(Durability::Durable)
            .provider(Held)
    } else {
        builder.provider(scripted_provider(json!([{"text":"Hello over ACP."}])))
    };
    let agent = builder.build().await?;
    agent.serve_acp(Default::default()).await?;
    agent.close().await
}

struct Held;

#[modular_agent::async_trait]
impl Provider for Held {
    fn id(&self) -> &str {
        "scripted"
    }

    fn models(&self) -> Vec<ModelInfo> {
        scripted_provider(json!([])).models()
    }

    fn supports(&self) -> ProviderSupport {
        ProviderSupport {
            safe_to_repeat: true,
            keeps_state: false,
        }
    }

    async fn request(
        &self,
        _: ModelRef,
        _: ModelRequest,
        cx: ProviderContext,
    ) -> Result<AssistantMessage> {
        // Hold both the original attempt and the recovered one until cancellation.
        cx.piece(modular_agent::Piece::Text, "attempt is live", None)
            .await?;
        cx.cancelled().cancelled().await;
        Err(modular_agent::Error::new(
            modular_agent::Code::Cancelled,
            "held attempt cancelled",
        ))
    }
}
