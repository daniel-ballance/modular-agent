use futures_util::StreamExt;
use modular_agent::{
    Agent, AssistantMessage, Code, CredentialStore, Error, Event, ModelError, ModelErrorKind,
    ModelInfo, ModelRef, ModelRequest, Piece, Provider, ProviderAvailability, ProviderContext,
    ProviderSupport, Result,
};
use modular_agent::{CatalogNotifier, Plugin};
use serde_json::json;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

#[path = "fixtures/git_project.rs"]
mod git_project;
use git_project::git_project;

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
        cx.emit("beacon.audio", json!({"clip":"sample"})).await?;
        cx.piece(Piece::Text, "Beacon ", None).await?;
        cx.piece(Piece::Text, "ready.", None).await?;
        Ok(AssistantMessage::text("Beacon ready."))
    }
}

#[tokio::test]
async fn provider_audio_arrives_as_a_custom_session_event() -> Result<()> {
    for served in [false, true] {
        let plugin = Plugin::new("beacon").provider(Beacon);
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
        let session = agent.session().await?;
        let mut events = session.events(None)?;
        assert_eq!(
            session.prompt("Check the beacon.").await?.text,
            "Beacon ready."
        );
        let kind = if served {
            "plugin.beacon.beacon.audio"
        } else {
            "beacon.audio"
        };
        let event = tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(event) = events.next().await.transpose()? {
                if event.event_type == kind {
                    return Ok::<_, Error>(Some(event));
                }
            }
            Ok(None)
        })
        .await
        .unwrap_or_else(|_| panic!("Timed out waiting for {kind}"))?
        .unwrap_or_else(|| panic!("Session stream ended before {kind}"));
        assert!(matches!(event, Event::Custom(info) if info.data == json!({"clip":"sample"})));
        agent.close().await?;
    }
    Ok(())
}

struct DynamicBeacon {
    ready: Arc<AtomicBool>,
    reason: Option<&'static str>,
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

    async fn availability(&self) -> ProviderAvailability {
        if self.ready.load(Ordering::Relaxed) {
            ProviderAvailability::Available
        } else {
            ProviderAvailability::Unavailable {
                reason: self.reason.map(str::to_owned),
            }
        }
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
        assert!(
            self.availability().await.is_available(),
            "unavailable Provider received a request"
        );
        Beacon.request(model, request, cx).await
    }
}

#[tokio::test]
async fn sdk_server_reports_the_exact_availability_shape() -> Result<()> {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    use tokio_util::sync::CancellationToken;

    async fn rpc(
        conn: &mut transport_websocket::Connection,
        id: u32,
        method: &str,
        params: serde_json::Value,
    ) -> serde_json::Value {
        let request = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        conn.outgoing.send(request.to_string()).await.unwrap();
        let mut reply: serde_json::Value =
            serde_json::from_str(&conn.incoming.recv().await.unwrap()).unwrap();
        assert_eq!(reply["id"], id, "{reply}");
        assert!(reply["result"].is_object(), "{reply}");
        reply["result"].take()
    }

    let dir = tempfile::tempdir()?;
    let token = dir.path().join("token");
    writeln!(
        std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&token)?,
        "disposable-beacon-test-credential"
    )?;
    for (ready, reason, expected) in [
        (true, None, json!({"available":true})),
        (false, None, json!({"available":false})),
        (false, Some(""), json!({"available":false})),
        (false, Some("   "), json!({"available":false})),
        (
            false,
            Some("Beacon is offline"),
            json!({"available":false,"reason":"Beacon is offline"}),
        ),
    ] {
        let service = modular_agent::serve_websocket(
            Plugin::new("beacon").provider(DynamicBeacon {
                ready: Arc::new(AtomicBool::new(ready)),
                reason,
                notifier: Arc::new(Mutex::new(None)),
            }),
            modular_agent::ServeOptions {
                listen: "127.0.0.1:0".into(),
                token_file: token.clone(),
                tls: None,
                projects: vec![],
            },
        )
        .await?;
        let socket =
            transport_websocket::connect(&service.url, &token, transport_websocket::PLUGIN).await?;
        let init = json!({"binding":"modular-agent-plugin/1","host":{"name":"test","version":"1"},
            "project":dir.path(),"home":dir.path(),"config":{}});
        let run =
            transport_websocket::run(socket, CancellationToken::new(), |mut conn| async move {
                let reply = rpc(&mut conn, 1, "plugin/initialize", init).await;
                assert_eq!(reply["binding"], "modular-agent-plugin/1");
                let reply = rpc(
                    &mut conn,
                    2,
                    "provider/available",
                    json!({"provider":"beacon"}),
                )
                .await;
                assert_eq!(reply, expected);
            });
        tokio::time::timeout(Duration::from_secs(5), run)
            .await
            .expect("availability query timed out");
        service.close().await;
    }
    Ok(())
}

#[tokio::test]
async fn dynamic_catalog_and_readiness() -> Result<()> {
    for (served, reason) in [false, true].into_iter().flat_map(|served| {
        [
            None,
            Some(""),
            Some("   "),
            Some("Beacon is waiting for its operator"),
        ]
        .map(|reason| (served, reason))
    }) {
        let ready = Arc::new(AtomicBool::new(false));
        let notifier = Arc::new(Mutex::new(None));
        let plugin = Plugin::new("beacon").provider(DynamicBeacon {
            ready: ready.clone(),
            reason,
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
        let fallback = if served {
            "external Provider is unavailable"
        } else {
            "Provider is unavailable"
        };
        let expected = reason
            .filter(|reason| !reason.trim().is_empty())
            .unwrap_or(fallback);
        assert!(
            matches!(unavailable.outcome,
            Some(modular_agent::Outcome::Failed { ref error }) if error.contains(expected)),
            "expected {expected}, got {:?}",
            unavailable.outcome
        );
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
        let project = git_project();
        let agent = if served {
            modular_agent::testing::test_agent()
                .model("beacon/demo")
                .credentials(TestKey(key))
                .over_wire(Plugin::new("beacon").provider(Beacon))
                .build()
                .await?
        } else {
            Agent::builder()
                .project(project.path())
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
