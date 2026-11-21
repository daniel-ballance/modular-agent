use agent_api::{Lease, SessionData};
use futures_util::StreamExt;
use modular_agent::{
    AcpActor, AcpServiceOptions, Actor, Code, Durability, History, HistoryStore, Result, Rights,
    Tool, ToolContext, ToolStatus, testing::test_agent,
};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::{
    sync::mpsc,
    time::{Duration, timeout},
};
use tokio_util::sync::CancellationToken;

struct Store {
    native: history_fs::FileHistory,
    fault: Arc<Fault>,
}
#[derive(Default)]
struct Fault {
    reject: AtomicBool,
    writer: Mutex<Option<CancellationToken>>,
}
struct Writer {
    _native: Box<dyn Lease>,
    lost: CancellationToken,
}
impl Lease for Writer {
    fn lost(&self) -> Option<CancellationToken> {
        Some(self.lost.clone())
    }
    fn check(&self) -> agent_api::Result<()> {
        anyhow::ensure!(!self.lost.is_cancelled(), "revoked writer");
        Ok(())
    }
}
impl HistoryStore for Store {
    fn acquire(&self, session: &str) -> agent_api::Result<Box<dyn Lease>> {
        let native = self.native.acquire(session)?;
        let lost = CancellationToken::new();
        *self.fault.writer.lock().unwrap() = Some(lost.clone());
        Ok(Box::new(Writer {
            _native: native,
            lost,
        }))
    }
    fn load(&self, session: &str) -> agent_api::Result<SessionData> {
        self.native.load(session)
    }
    fn save(&self, data: &SessionData) -> agent_api::Result<()> {
        anyhow::ensure!(!self.fault.reject.load(Ordering::SeqCst), "append refused");
        self.native.save(data)
    }
    fn list(&self, project: Option<&std::path::Path>) -> agent_api::Result<Vec<SessionData>> {
        self.native.list(project)
    }
    fn erase(&self, entries: Vec<String>, held: &[String]) -> agent_api::Result<Vec<SessionData>> {
        self.native.erase(entries, held)
    }
}

impl Fault {
    fn trigger(&self, reason: &str, return_from_tool: &CancellationToken) {
        if reason == "writerLost" {
            self.writer.lock().unwrap().as_ref().unwrap().cancel();
        } else {
            self.reject.store(true, Ordering::SeqCst);
            return_from_tool.cancel();
        }
    }
}

struct Fixture {
    agent: modular_agent::Agent,
    project: tempfile::TempDir,
    fault: Arc<Fault>,
    entered: mpsc::UnboundedReceiver<CancellationToken>,
    return_from_tool: CancellationToken,
}
impl Fixture {
    async fn build() -> Result<Self> {
        let project = tempfile::tempdir()?;
        let fault = Arc::new(Fault::default());
        let (start, entered) = mpsc::unbounded_channel();
        let return_from_tool = CancellationToken::new();
        let complete = return_from_tool.clone();
        let agent = test_agent()
            .project(project.path())
            .plugin_host(true)
            .durability(Durability::Kept)
            .history(History::from_store(
                Store {
                    native: history_fs::FileHistory::new(&project.path().join("history"))?,
                    fault: fault.clone(),
                },
                true,
            ))
            .tool(
                Tool::new("hold", "Wait while the writer is interrupted.").run(
                    move |_: Value, cx: ToolContext| {
                        let start = start.clone();
                        let complete = complete.clone();
                        async move {
                            start.send(cx.cancelled().clone()).unwrap();
                            complete.cancelled().await;
                            Ok("effect returned")
                        }
                    },
                ),
            )
            .script(json!([{"toolCalls":[{"name":"hold","input":{}}]}, {"text":"done"}]))
            .build()
            .await?;
        Ok(Self {
            agent,
            project,
            fault,
            entered,
            return_from_tool,
        })
    }
    async fn recover(&self, id: &str) -> Result<()> {
        self.fault.reject.store(false, Ordering::SeqCst);
        let reopened = self.agent.open_session(id).await?;
        let turn = reopened
            .last_turn()
            .await?
            .expect("interrupted work settled on reopen");
        assert_eq!(turn.tool_results()[0].status, ToolStatus::OutcomeUnknown);
        assert!(
            !reopened
                .history()
                .await?
                .iter()
                .any(|entry| entry["kind"] == "sessionInterrupted")
        );
        self.agent.close().await
    }
}

#[tokio::test]
async fn both_interruptions_reach_followers_and_settle_waiters() -> Result<()> {
    timeout(Duration::from_secs(5), async {
        for reason in ["writerLost", "commitFailed"] {
            let mut f = Fixture::build().await?;
            let session = f.agent.session().await?;
            let id = session.id().to_owned();
            let mut follow = session.events(None)?;
            let mut agent_follow = f.agent.events();
            let other = session.clone();
            let prompting = tokio::spawn(async move { other.prompt("start").await });
            let cancelled = f.entered.recv().await.unwrap();
            let mut streaming = session.prompt_stream("queued").await?;
            f.fault.trigger(reason, &f.return_from_tool);
            assert_eq!(prompting.await.unwrap().unwrap_err().code(), Code::Lost);
            let stream_error = loop {
                if let Err(error) = streaming
                    .next()
                    .await
                    .expect("interrupted prompt stream ended without an error")
                {
                    break error;
                }
            };
            assert_eq!(stream_error.code(), Code::Lost);
            cancelled.cancelled().await;
            for stream in [&mut follow, &mut agent_follow] {
                loop {
                    let event = stream.next().await.unwrap()?;
                    if matches!(event, modular_agent::Event::SessionInterrupted(_)) {
                        assert_eq!(event.data["reason"], reason);
                        break;
                    }
                }
            }
            assert_eq!(
                session
                    .send("no more effects", modular_agent::Timing::Now)
                    .await
                    .unwrap_err()
                    .code(),
                Code::Lost
            );
            session.close().await?;
            f.recover(&id).await?;
        }
        Ok(())
    })
    .await
    .expect("interruption was not observed")
}

#[tokio::test]
async fn acp_receives_both_interruptions_and_lost_prompt_errors() -> Result<()> {
    timeout(Duration::from_secs(5), async {
        for reason in ["writerLost", "commitFailed"] {
            let mut f = Fixture::build().await?;
            let token = f.project.path().join("token");
            std::fs::write(&token, "9bb7a90490c023d02c87f9123ef55837")?;
            let service = f
                .agent
                .serve_acp_websocket(
                    Default::default(),
                    AcpServiceOptions {
                        listen: "127.0.0.1:0".into(),
                        tls: None,
                        actors: vec![AcpActor {
                            token_file: token.clone(),
                            actor: Actor {
                                id: "user".into(),
                                kind: "user".into(),
                                rights: Rights::full(),
                            },
                            tenants: None,
                            projects: None,
                        }],
                    },
                )
                .await?;
            let socket =
                transport_websocket::connect(&service.url, &token, transport_websocket::ACP)
                    .await?;
            let mut id = String::new();
            transport_websocket::run(socket, CancellationToken::new(), |mut conn| {
                let Fixture {
                    project,
                    fault,
                    entered,
                    return_from_tool,
                    ..
                } = &mut f;
                let id = &mut id;
                async move {
                    let send = |id, method, params| {
                        conn.outgoing.send(
                            json!({"jsonrpc":"2.0","method":method,"id":id,"params":params})
                                .to_string(),
                        )
                    };
                    send(1, "initialize", json!({"protocolVersion": 2}))
                        .await
                        .unwrap();
                    send(
                        2,
                        "session/new",
                        json!({"cwd":project.path(),"mcpServers":[]}),
                    )
                    .await
                    .unwrap();
                    loop {
                        let v: Value =
                            serde_json::from_str(&conn.incoming.recv().await.unwrap()).unwrap();
                        if v["id"] == 2 {
                            *id = v["result"]["sessionId"].as_str().unwrap().to_owned();
                            break;
                        }
                    }
                    send(
                        3,
                        "session/prompt",
                        json!({"sessionId":id,"prompt":[{"type":"text","text":"start"}]}),
                    )
                    .await
                    .unwrap();
                    let cancelled = entered.recv().await.unwrap();
                    fault.trigger(reason, return_from_tool);
                    let (mut replied, mut notified) = (false, false);
                    while !replied || !notified {
                        let v: Value =
                            serde_json::from_str(&conn.incoming.recv().await.unwrap()).unwrap();
                        if v["id"] == 3 {
                            assert_eq!(v["error"]["data"]["code"], "lost", "{v}");
                            replied = true;
                        }
                        if v["method"] == "_modular-agent/interrupted" {
                            assert_eq!(v["params"]["sessionId"], *id);
                            assert_eq!(v["params"]["reason"], reason);
                            notified = true;
                        }
                    }
                    cancelled.cancelled().await;
                }
            })
            .await;
            service.close().await;
            f.recover(&id).await?;
        }
        Ok(())
    })
    .await
    .expect("ACP interruption was not observed")
}
