use agent_api::{Lease, SessionData};
use futures_util::StreamExt;
use modular_agent::{
    AcpActor, AcpServiceOptions, Actor, Code, Durability, History, HistoryStore, Result, Rights,
    Tool, ToolContext, ToolStatus, testing::test_agent,
};
use serde_json::{Value, json};
use std::{
    io::Write,
    os::unix::fs::OpenOptionsExt,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::{
    sync::mpsc,
    time::{Duration, Instant, timeout},
};
use tokio_util::sync::CancellationToken;

struct Stages {
    pending: &'static str,
    since: Instant,
    completed: Vec<(&'static str, Duration)>,
}

impl Stages {
    fn new(pending: &'static str) -> Self {
        Self {
            pending,
            since: Instant::now(),
            completed: Vec::new(),
        }
    }

    fn stage(&mut self, pending: &'static str) {
        let now = Instant::now();
        self.completed.push((self.pending, now - self.since));
        self.pending = pending;
        self.since = now;
    }

    fn diagnostic(&self) -> String {
        format!(
            "pending {} for {:?}; completed {:?}",
            self.pending,
            self.since.elapsed(),
            self.completed
        )
    }
}

/// One stage keeps the limit both interruption cycles used to share. A stall
/// in an early await could expire a later stage that had only just started.
/// A stage that itself hangs still fails at five seconds.
const INTERRUPTION_STAGE: Duration = Duration::from_secs(5);

async fn bound<T>(
    stages: &Stages,
    deadline: &'static str,
    work: impl std::future::Future<Output = T>,
) -> T {
    match timeout(INTERRUPTION_STAGE, work).await {
        Ok(value) => value,
        Err(_) => panic!("{deadline}: {}", stages.diagnostic()),
    }
}

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
    async fn recover(&self, id: &str, stages: &mut Stages, deadline: &'static str) -> Result<()> {
        self.fault.reject.store(false, Ordering::SeqCst);
        stages.stage("reopen interrupted session");
        let reopened = bound(stages, deadline, self.agent.open_session(id)).await?;
        stages.stage("read recovered turn");
        let turn = bound(stages, deadline, reopened.last_turn())
            .await?
            .expect("interrupted work settled on reopen");
        assert_eq!(turn.tool_results()[0].status, ToolStatus::OutcomeUnknown);
        stages.stage("read recovered history");
        let history = bound(stages, deadline, reopened.history()).await?;
        assert!(
            !history
                .iter()
                .any(|entry| entry["kind"] == "sessionInterrupted")
        );
        stages.stage("close recovered agent");
        bound(stages, deadline, self.agent.close()).await
    }
}

#[tokio::test]
async fn both_interruptions_reach_followers_and_settle_waiters() -> Result<()> {
    const DEADLINE: &str = "SDK interruption test timed out";
    let mut stages = Stages::new("start");
    for (reason, build) in [
        ("writerLost", "build writerLost fixture"),
        ("commitFailed", "build commitFailed fixture"),
    ] {
        stages.stage(build);
        let mut f = bound(&stages, DEADLINE, Fixture::build()).await?;
        stages.stage("create session");
        let session = bound(&stages, DEADLINE, f.agent.session()).await?;
        let id = session.id().to_owned();
        let mut follow = session.events(None)?;
        let mut agent_follow = f.agent.events();
        let other = session.clone();
        let prompting = tokio::spawn(async move { other.prompt("start").await });
        stages.stage("wait for tool entry");
        let cancelled = bound(&stages, DEADLINE, f.entered.recv()).await.unwrap();
        stages.stage("queue streaming prompt");
        let mut streaming = bound(&stages, DEADLINE, session.prompt_stream("queued")).await?;
        f.fault.trigger(reason, &f.return_from_tool);
        stages.stage("wait for prompt to fail with lost");
        let prompted = bound(&stages, DEADLINE, prompting).await;
        assert_eq!(prompted.unwrap().unwrap_err().code(), Code::Lost);
        stages.stage("wait for stream to fail with lost");
        let stream_error = bound(&stages, DEADLINE, async {
            loop {
                if let Err(error) = streaming
                    .next()
                    .await
                    .expect("interrupted prompt stream ended without an error")
                {
                    break error;
                }
            }
        })
        .await;
        assert_eq!(stream_error.code(), Code::Lost);
        stages.stage("observe tool cancellation");
        bound(&stages, DEADLINE, cancelled.cancelled()).await;
        for (stage, stream) in [
            ("observe session follower interruption", &mut follow),
            ("observe agent follower interruption", &mut agent_follow),
        ] {
            stages.stage(stage);
            bound(&stages, DEADLINE, async {
                loop {
                    let event = stream.next().await.unwrap()?;
                    if matches!(event, modular_agent::Event::SessionInterrupted(_)) {
                        assert_eq!(event.data["reason"], reason);
                        break;
                    }
                }
                Ok::<(), modular_agent::Error>(())
            })
            .await?;
        }
        stages.stage("reject input after interruption");
        let rejected = bound(
            &stages,
            DEADLINE,
            session.send("no more effects", modular_agent::Timing::Now),
        )
        .await;
        assert_eq!(rejected.unwrap_err().code(), Code::Lost);
        stages.stage("close interrupted session");
        bound(&stages, DEADLINE, session.close()).await?;
        f.recover(&id, &mut stages, DEADLINE).await?;
    }
    Ok(())
}

#[tokio::test]
async fn acp_receives_both_interruptions_and_lost_prompt_errors() -> Result<()> {
    const DEADLINE: &str = "ACP interruption test timed out";
    let mut stages = Stages::new("start");
    for (reason, build) in [
        ("writerLost", "build writerLost fixture"),
        ("commitFailed", "build commitFailed fixture"),
    ] {
        stages.stage(build);
        let mut f = bound(&stages, DEADLINE, Fixture::build()).await?;
        let token = f.project.path().join("token");
        std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&token)?
            .write_all(b"9bb7a90490c023d02c87f9123ef55837")?;
        stages.stage("start ACP listener");
        let service = bound(
            &stages,
            DEADLINE,
            f.agent.serve_acp_websocket(
                Default::default(),
                AcpServiceOptions {
                    listen: "127.0.0.1:0".into(),
                    tls: None,
                    actors: vec![AcpActor {
                        token_file: token.clone(),
                        trust_trace_context: false,
                        actor: Actor {
                            id: "user".into(),
                            kind: "user".into(),
                            rights: Rights::full(),
                        },
                        tenants: None,
                        projects: None,
                        represents: vec![],
                    }],
                },
            ),
        )
        .await?;
        stages.stage("connect ACP socket");
        let socket = bound(
            &stages,
            DEADLINE,
            transport_websocket::connect(&service.url, &token, transport_websocket::ACP),
        )
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
            let stages = &mut stages;
            async move {
                let send = |id, method, params| {
                    conn.outgoing.send(
                        json!({"jsonrpc":"2.0","method":method,"id":id,"params":params})
                            .to_string(),
                    )
                };
                stages.stage("send ACP initialize");
                bound(
                    stages,
                    DEADLINE,
                    send(1, "initialize", json!({"protocolVersion": 2})),
                )
                .await
                .unwrap();
                stages.stage("send ACP session/new");
                bound(
                    stages,
                    DEADLINE,
                    send(
                        2,
                        "session/new",
                        json!({"cwd":project.path(),"mcpServers":[]}),
                    ),
                )
                .await
                .unwrap();
                // The stage name advances when initialize is observed, but this
                // receive keeps one five-second budget.
                stages.stage("receive ACP session/new reply (initialize not observed)");
                timeout(INTERRUPTION_STAGE, async {
                    loop {
                        let v: Value =
                            serde_json::from_str(&conn.incoming.recv().await.unwrap()).unwrap();
                        if v["id"] == 1 {
                            stages.stage("receive ACP session/new reply");
                        }
                        if v["id"] == 2 {
                            *id = v["result"]["sessionId"].as_str().unwrap().to_owned();
                            break;
                        }
                    }
                })
                .await
                .unwrap_or_else(|_| panic!("{DEADLINE}: {}", stages.diagnostic()));
                stages.stage("send ACP session/prompt");
                bound(
                    stages,
                    DEADLINE,
                    send(
                        3,
                        "session/prompt",
                        json!({"sessionId":id,"prompt":[{"type":"text","text":"start"}]}),
                    ),
                )
                .await
                .unwrap();
                stages.stage("wait for tool entry");
                let cancelled = bound(stages, DEADLINE, entered.recv()).await.unwrap();
                fault.trigger(reason, return_from_tool);
                stages.stage("receive ACP lost reply and interrupted notification");
                timeout(INTERRUPTION_STAGE, async {
                    let (mut replied, mut notified) = (false, false);
                    while !replied || !notified {
                        let v: Value =
                            serde_json::from_str(&conn.incoming.recv().await.unwrap()).unwrap();
                        if v["id"] == 3 {
                            assert_eq!(v["error"]["data"]["code"], "lost", "{v}");
                            replied = true;
                            if !notified {
                                stages.stage("receive ACP interrupted notification");
                            }
                        }
                        if v["method"] == "_modular-agent/interrupted" {
                            assert_eq!(v["params"]["sessionId"], *id);
                            assert_eq!(v["params"]["reason"], reason);
                            notified = true;
                            if !replied {
                                stages.stage("receive ACP lost reply");
                            }
                        }
                    }
                })
                .await
                .unwrap_or_else(|_| panic!("{DEADLINE}: {}", stages.diagnostic()));
                stages.stage("observe tool cancellation");
                bound(stages, DEADLINE, cancelled.cancelled()).await;
                stages.stage("close ACP WebSocket");
            }
        })
        .await;
        stages.stage("close ACP service");
        bound(&stages, DEADLINE, service.close()).await;
        f.recover(&id, &mut stages, DEADLINE).await?;
    }
    Ok(())
}
