use futures_util::StreamExt;
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use modular_agent::{CatalogNotifier, Plugin};
use modular_agent::{
    Agent, AssistantMessage, Code, CredentialStore, Error, ModelError, ModelErrorKind, ModelInfo,
    ModelRef, ModelRequest, Piece, Provider, ProviderContext, ProviderSupport, Result,
};

struct Beacon;

#[modular_agent::async_trait]
impl Provider for Beacon {
    fn id(&self) -> &str {
        "beacon"
    }

    fn models(&self) -> Vec<ModelInfo> {
        vec![ModelInfo {
            model: ModelRef {
                provider: self.id().into(),
                id: "demo".into(),
            },
            context_window: 4096,
            max_output: 256,
            thinking: vec![],
            extra: serde_json::from_value(serde_json::json!({"input":["text"],"reasoning":false}))
                .unwrap(),
        }]
    }

    fn available(&self) -> bool {
        true
    }

    fn supports(&self) -> ProviderSupport {
        ProviderSupport {
            keeps_state: false,
            safe_to_repeat: true,
        }
    }

    async fn request(
        &self,
        _model: ModelRef,
        _request: ModelRequest,
        cx: ProviderContext,
    ) -> Result<AssistantMessage> {
        let key = cx.credential().await?;
        if key != "offline-key" {
            return Ok(ModelError::new(ModelErrorKind::Credentials, "Key rejected").failed());
        }
        cx.piece(Piece::Text, "Beacon ", None).await?;
        cx.piece(Piece::Text, "ready.", None).await?;
        Ok(AssistantMessage::text("Beacon ready."))
    }
}

struct TestKey(&'static str);

impl CredentialStore for TestKey {
    fn read(&self, name: &str) -> Result<String> {
        if name == "beacon" {
            Ok(self.0.into())
        } else {
            Err(Error::new(Code::NotFound, "No test key for that Provider"))
        }
    }
}

#[tokio::test]
async fn beacon_streams_and_records_failures() -> Result<()> {
    for key in ["offline-key", "rejected"] {
        let agent = Agent::builder()
            .provider(Beacon)
            .credentials(TestKey(key))
            .build()
            .await?;
        assert_eq!(agent.models()?[0].model.to_string(), "beacon/demo");
        let session = agent.session().await?;
        let mut events = session.prompt_stream("Check the beacon.").await?;
        let mut pieces = Vec::new();
        while let Some(event) = events.next().await.transpose()? {
            if event.event_type == "text" {
                pieces.push(event.data["delta"].as_str().unwrap().to_owned());
            }
        }
        let turn = session.last_turn()?.expect("prompt settled");
        if key == "offline-key" {
            assert_eq!(pieces, ["Beacon ", "ready."]);
            assert_eq!(turn.text, "Beacon ready.");
        } else {
            assert!(pieces.is_empty());
            assert!(matches!(
                turn.outcome,
                Some(modular_agent::Outcome::Failed { .. })
            ));
            let history = session.history()?;
            let response = history.iter().find(|e| e["kind"] == "response").unwrap();
            assert_eq!(response["message"]["stop"], "failed");
            assert_eq!(response["message"]["error"]["kind"], "credentials");
        }
        agent.close().await?;
    }
    Ok(())
}
