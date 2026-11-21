use futures_util::StreamExt;
use modular_agent::{
    Agent, AssistantMessage, Code, CredentialStore, Error, ModelError, ModelErrorKind, ModelInfo,
    ModelRef, ModelRequest, Piece, Provider, ProviderContext, ProviderSupport, Result,
};
use modular_agent::{CatalogNotifier, Plugin};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
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

struct DynamicBeacon {
    ready: Arc<AtomicBool>,
    notifier: Arc<Mutex<Option<CatalogNotifier>>>,
}

#[modular_agent::async_trait]
impl Provider for DynamicBeacon {
    fn id(&self) -> &str {
        Beacon.id()
    }

    fn models(&self) -> Vec<ModelInfo> {
        let mut models = Beacon.models();
        if self.ready.load(Ordering::Relaxed) {
            let mut second = models[0].clone();
            second.model.id = "second".into();
            models.push(second);
        }
        models
    }

    fn available(&self) -> bool {
        self.ready.load(Ordering::Relaxed)
    }

    fn catalog_notifier(&self, notifier: CatalogNotifier) {
        *self.notifier.lock().unwrap() = Some(notifier);
    }

    async fn request(
        &self,
        model: ModelRef,
        request: ModelRequest,
        cx: ProviderContext,
    ) -> Result<AssistantMessage> {
        assert!(self.available(), "unavailable Provider received a request");
        Beacon.request(model, request, cx).await
    }
}

#[tokio::test]
async fn dynamic_catalog_and_readiness() -> Result<()> {
    for served in [false, true] {
        let ready = Arc::new(AtomicBool::new(false));
        let notifier = Arc::new(Mutex::new(None));
        let plugin = Plugin::new("beacon").provider(DynamicBeacon {
            ready: ready.clone(),
            notifier: notifier.clone(),
        });
        let builder = modular_agent::testing::test_agent()
            .model("beacon/demo")
            .credentials(TestKey("offline-key"));
        let agent = if served {
            builder.over_wire(plugin)
        } else {
            builder.plugin(plugin)
        }
        .build()
        .await?;
        let mut updates = if served {
            None
        } else {
            Some(agent.model_changes("beacon")?)
        };
        let unavailable = agent.session().await?.prompt("Check the beacon.").await?;
        assert!(matches!(
            unavailable.outcome,
            Some(modular_agent::Outcome::Failed { .. })
        ));
        assert!(unavailable.text.is_empty());
        ready.store(true, Ordering::Relaxed);
        notifier.lock().unwrap().as_ref().unwrap().changed();
        if let Some(updates) = &mut updates {
            assert!(updates.has_changed().unwrap());
            assert!(agent.models()?.iter().any(|m| m.model.id == "second"));
        }
        let turn = agent.session().await?.prompt("Check the beacon.").await?;
        assert_eq!(turn.text, "Beacon ready.");
        agent.close().await?;
    }
    Ok(())
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
    for (served, key) in [
        (false, "offline-key"),
        (false, "rejected"),
        (true, "offline-key"),
        (true, "rejected"),
    ] {
        let agent = if served {
            modular_agent::testing::test_agent()
                .model("beacon/demo")
                .credentials(TestKey(key))
                .over_wire(Plugin::new("beacon").provider(Beacon))
                .build()
                .await?
        } else {
            Agent::builder()
                .credentials(TestKey(key))
                .provider(Beacon)
                .build()
                .await?
        };
        assert!(
            agent
                .models()?
                .iter()
                .any(|m| m.model.to_string() == "beacon/demo")
        );
        let session = agent.session().await?;
        let mut events = session.prompt_stream("Check the beacon.").await?;
        let mut pieces = Vec::new();
        while let Some(event) = events.next().await.transpose()? {
            if event.event_type == "text" {
                pieces.push(event.data["delta"].as_str().unwrap().to_owned());
            }
        }
        let turn = session.last_turn().await?.expect("prompt settled");
        if key == "offline-key" {
            assert_eq!(pieces, ["Beacon ", "ready."]);
            assert_eq!(turn.text, "Beacon ready.");
        } else {
            assert!(pieces.is_empty());
            assert!(matches!(
                turn.outcome,
                Some(modular_agent::Outcome::Failed { .. })
            ));
            let history = session.history().await?;
            let response = history.iter().find(|e| e["kind"] == "response").unwrap();
            assert_eq!(response["message"]["stop"], "failed");
            assert_eq!(response["message"]["error"]["kind"], "credentials");
        }
        agent.close().await?;
    }
    Ok(())
}
