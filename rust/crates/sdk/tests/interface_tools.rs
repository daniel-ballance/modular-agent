use futures_util::StreamExt;
use modular_agent::{
    Actor, Agent, AgentBuilder, Answer, Approval, Code, Durability,
    InterfaceReportDisposition as Disposition, InterfaceToolSource, InterruptedTurn, Outcome,
    Plugin, Result, Rights, RuntimeCall, RuntimeContext, RuntimeDeclaration, RuntimeOutcome,
    RuntimePart, RuntimeSupport, RuntimeTurn, ServeOptions, ServicePlugin, Session, ToolChange,
    Usage, async_trait, testing::scripted_provider,
};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
};

#[path = "fixtures/git_project.rs"]
mod git_project;
use git_project::git_project;

const EXECUTOR: &str = "picker";
const ROUTE: &str = "swatch";
const WAIT: Duration = Duration::from_secs(5);

fn definition() -> Value {
    json!({"name":"pick_color","description":"Choose a color","parameters":{"type":"object"},"callers":["model"],"returns":{"type":"string"}})
}
fn sources(timeout: u64) -> Vec<InterfaceToolSource> {
    vec![InterfaceToolSource {
        source_id: "palette".into(),
        actor_id: EXECUTOR.into(),
        route_id: ROUTE.into(),
        result_timeout_ms: timeout,
        tools: vec![definition()],
    }]
}
fn builder() -> AgentBuilder {
    Agent::builder()
        .several_actors(true)
        .provider(scripted_provider(json!([
            {"toolCalls":[{"name":"pick_color","input":{"label":"argument-marker"}}]},
            {"text":"Finished."}
        ])))
}
fn rights() -> Rights {
    Rights::only(&["watch", "tools"])
}
async fn session(agent: &Agent) -> Result<Session> {
    let session = agent.session().await?;
    session
        .join(Actor {
            id: EXECUTOR.into(),
            kind: "user".into(),
            rights: rights(),
        })
        .await?;
    Ok(session)
}
fn report(id: &str, value: &str) -> Value {
    json!({"callId":id,"status":"completed","content":[{"type":"text","text":value}],"value":value})
}
async fn continuation(session: &Session, origin: &str) -> Result<Vec<Value>> {
    let mut events = session.events(None)?;
    tokio::time::timeout(WAIT, async {
        let mut continuation = None;
        while let Some(event) = events.next().await {
            let event = event?;
            // The turn may already have ended when we subscribe. Its committed
            // entries are replayable, but the live turnEnded event is not.
            let row = &event.data["entry"];
            if row["kind"] == "turnStart" && row["continuesTurnId"] == origin {
                continuation = row["turnId"].as_str().map(str::to_owned);
            } else if row["kind"] == "turnEnd"
                && continuation
                    .as_deref()
                    .is_some_and(|id| row["turnId"] == id)
            {
                session.wait_idle().await?;
                return Ok::<_, modular_agent::Error>(());
            }
        }
        panic!("events ended before the continuation")
    })
    .await
    .expect("continuation did not end")?;
    session.history().await
}
fn entry<'a>(rows: &'a [Value], kind: &str) -> &'a Value {
    rows.iter()
        .find(|r| r["kind"] == kind)
        .unwrap_or_else(|| panic!("missing {kind}: {rows:?}"))
}

async fn round_trip(builder: AgentBuilder) -> Result<String> {
    let project = git_project();
    let agent = builder
        .project(project.path())
        .interface_tools(sources(30_000))
        .plugin(Plugin::new("checked-report").on_tool_after(|_| async {
            Ok(ToolChange {
                content: Some(vec![json!({"type":"text","text":"checked"})].into()),
                value: Some(json!("blue")),
            })
        }))
        .build()
        .await?;
    let session = session(&agent).await?;
    assert_eq!(session.declaration()?["interfaceTools"], true);
    assert!(
        session
            .connect_interface_tools(ROUTE, "user", rights())
            .is_err()
    );
    assert!(
        session
            .connect_interface_tools("other", EXECUTOR, rights())
            .is_err()
    );
    let mut connection = session.connect_interface_tools(ROUTE, EXECUTOR, rights())?;
    assert!(
        connection
            .advertise(&[json!({"name":"pick_color"})])
            .is_err()
    );
    connection.advertise(&[definition()])?;
    let turn = session.prompt("Choose a color").await?;
    assert_eq!(turn.outcome, Some(Outcome::Completed), "{turn:?}");
    let id = &turn.open_tool_calls[0];
    let origin = turn.turn_id.as_deref().unwrap();
    let call = tokio::time::timeout(WAIT, connection.next_call())
        .await
        .unwrap()?
        .unwrap();
    assert_eq!(call["id"], *id);
    assert_eq!(call["input"]["label"], "argument-marker");
    drop(connection);
    assert!(
        session
            .history()
            .await?
            .iter()
            .all(|row| row["kind"] != "toolResult")
    );
    let a = session.connect_interface_tools(ROUTE, EXECUTOR, rights())?;
    let b = session.connect_interface_tools(ROUTE, EXECUTOR, rights())?;
    let (a, b) = tokio::join!(
        a.report_tool_result(report(id, "raw-a")),
        b.report_tool_result(report(id, "raw-b"))
    );
    let (a, b) = (a?, b?);
    assert!(matches!(
        (a, b),
        (Disposition::Accepted, Disposition::AlreadySettled)
            | (Disposition::AlreadySettled, Disposition::Accepted)
    ));
    let history = continuation(&session, origin).await?;
    let result = entry(&history, "toolResult");
    assert_eq!(result["actorId"], EXECUTOR);
    assert_eq!(result["turnId"], origin);
    assert_eq!(result["message"]["content"][0]["text"], "checked");
    assert_eq!(result["data"]["value"], "blue");
    let next = history
        .iter()
        .find(|r| r["continuesTurnId"] == origin)
        .unwrap();
    assert_eq!(
        next["data"]["startedBy"],
        json!({"kind":"toolResult","id":result["id"]})
    );
    assert_eq!(
        history
            .iter()
            .filter(|r| r["kind"] == "toolStarted")
            .count(),
        1
    );
    assert_eq!(history.iter().filter(|r| r["kind"] == "input").count(), 1);
    let checkpoint = entry(&history, "modular-agent.interfaceHandoff");
    assert!(checkpoint.get("data").is_none());
    assert!(
        result["sources"]
            .as_array()
            .unwrap()
            .contains(&checkpoint["id"])
    );
    assert!(!json!(history).to_string().contains("raw-"));
    agent.close().await?;
    Ok(session.id().to_owned())
}

#[tokio::test]
async fn a_new_connection_reports_once_and_continues_without_dispatch() -> Result<()> {
    round_trip(builder()).await.map(|_| ())
}

#[tokio::test]
async fn expiry_or_cancellation_closes_a_started_call_as_unknown() -> Result<()> {
    for cancel in [false, true] {
        let project = git_project();
        let agent = builder()
            .project(project.path())
            .interface_tools(sources(if cancel { 30_000 } else { 300 }))
            .build()
            .await?;
        let session = session(&agent).await?;
        let mut connection = session.connect_interface_tools(ROUTE, EXECUTOR, rights())?;
        connection.advertise(&[definition()])?;
        let (turn, call) = tokio::join!(
            session.prompt("Choose"),
            tokio::time::timeout(WAIT, connection.next_call())
        );
        let turn = turn?;
        let call = call.unwrap()?.unwrap();
        let id = call["id"].as_str().unwrap();
        if cancel {
            session.cancel().await?;
        }
        continuation(&session, turn.turn_id.as_deref().unwrap()).await?;
        assert_eq!(
            connection.report_tool_result(report(id, "late")).await?,
            Disposition::Refused { reason: None }
        );
        let rows = session.history().await?;
        let result = entry(&rows, "toolResult");
        assert_eq!(result["data"]["status"], "outcomeUnknown");
        assert!(result.get("actorId").is_none());
        assert_eq!(
            rows.iter().filter(|r| r["kind"] == "toolStarted").count(),
            1
        );
        agent.close().await?;
    }
    Ok(())
}

#[tokio::test]
async fn approval_denial_and_missing_advertisement_do_not_start_a_tool() -> Result<()> {
    for advertises in [false, true] {
        let project = git_project();
        let agent = builder()
            .project(project.path())
            .interface_tools(sources(30_000))
            .approval(Approval::All)
            .on_question(|_| async { Answer::Declined { reason: None } })
            .build()
            .await?;
        let session = session(&agent).await?;
        let connection = session.connect_interface_tools(ROUTE, EXECUTOR, rights())?;
        if advertises {
            connection.advertise(&[definition()])?;
        }
        let turn = session.prompt("Choose").await?;
        assert!(turn.open_tool_calls.is_empty());
        let rows = session.history().await?;
        assert_eq!(entry(&rows, "toolResult")["data"]["status"], "refused");
        assert!(rows.iter().all(|r| r["kind"] != "toolStarted"));
        assert_eq!(rows.iter().any(|r| r["kind"] == "inputRequest"), advertises);
        agent.close().await?;
    }
    Ok(())
}

#[tokio::test]
async fn ordinary_agents_do_not_declare_the_feature() -> Result<()> {
    let project = git_project();
    let agent = builder().project(project.path()).build().await?;
    let session = agent.session().await?;
    assert!(agent.declaration()?.get("interfaceTools").is_none());
    assert!(
        session
            .connect_interface_tools(ROUTE, EXECUTOR, rights())
            .is_err()
    );
    assert!(session.prompt("Choose").await?.open_tool_calls.is_empty());
    assert!(
        session
            .history()
            .await?
            .iter()
            .all(|r| r["kind"] != "modular-agent.interfaceHandoff")
    );
    agent.close().await
}

struct ServedRuntime;
#[async_trait]
impl RuntimePart for ServedRuntime {
    fn declaration(&self) -> RuntimeDeclaration {
        RuntimeDeclaration {
            id: "served-interface-runtime".into(),
            supports: RuntimeSupport {
                interface_tools: true,
                ..Default::default()
            },
        }
    }
    async fn run_turn(&self, _: RuntimeTurn, cx: RuntimeContext) -> Result<RuntimeOutcome> {
        step(cx, false).await
    }
    async fn resume_turn(
        &self,
        _: RuntimeTurn,
        _: InterruptedTurn,
        _: RuntimeContext,
    ) -> Result<RuntimeOutcome> {
        unreachable!()
    }
    async fn continue_open_calls(
        &self,
        turn: RuntimeTurn,
        calls: Vec<RuntimeCall>,
        cx: RuntimeContext,
    ) -> Result<RuntimeOutcome> {
        assert!(calls.is_empty());
        assert_eq!(turn.started_by["kind"], "toolResult");
        step(cx, true).await
    }
}
async fn step(cx: RuntimeContext, continues: bool) -> Result<RuntimeOutcome> {
    let step = cx.new_id().await?;
    let request = cx.prepare_step(&step, Usage::default()).await?;
    if continues {
        assert!(
            request.0["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["role"] == "toolResult" && m["content"][0]["text"] == "checked")
        );
    }
    let response = cx.model(&step, request).await?;
    cx.record(json!({"kind":"response","stepId":step,"visible":true,"message":response}))
        .await?;
    let mut open = Vec::new();
    if !continues {
        let part = &response.0["content"][0];
        let call = json!({"id":part["id"],"name":"pick_color","input":part["arguments"],"startedBy":"model","stepId":step});
        let definition = cx.definition("pick_color").await?.unwrap();
        cx.hook(
            "tool.before",
            json!({"call":call,"definition":definition,"stepId":step}),
        )
        .await?;
        let result = cx.run_tool_call(call).await?;
        assert!(result["pending"].is_string(), "{result}");
        open.push(part["id"].clone());
    }
    cx.hook("step.after", json!({"stepId":step,"response":response}))
        .await?;
    Ok(RuntimeOutcome {
        outcome: Outcome::Completed,
        result: json!({"text":"Done","openToolCalls":open}),
        entries: vec![],
        usage: response
            .0
            .get("usage")
            .cloned()
            .map(serde_json::from_value)
            .transpose()?
            .unwrap_or_default(),
    })
}

#[tokio::test]
async fn a_runtime_in_another_process_runs_the_result_only_continuation() -> Result<()> {
    if let Some(root) = std::env::var_os("SDK_INTERFACE_RUNTIME_FIXTURE") {
        let token_file = std::path::PathBuf::from(root).join("token");
        let plugin = Plugin::new("served-interface-runtime")
            .setup(|r| r.runtime(ServedRuntime))
            .replaces("runtime");
        let service = modular_agent::serve_websocket(
            plugin,
            ServeOptions {
                listen: "127.0.0.1:0".into(),
                token_file,
                tls: None,
                projects: vec![],
            },
        )
        .await?;
        println!("fixture-ready={}", service.url);
        return std::future::pending().await;
    }
    let root = tempfile::tempdir()?;
    let token = root.path().join("token");
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(&token, "76925ba0b1fb4d29cfbfd0084e50c666")?;
    std::fs::set_permissions(&token, std::fs::Permissions::from_mode(0o600))?;
    let (mut child, url) = fixture(
        "a_runtime_in_another_process_runs_the_result_only_continuation",
        "SDK_INTERFACE_RUNTIME_FIXTURE",
        root.path(),
    )
    .await?;
    let result = round_trip(builder().service_plugin(ServicePlugin::new(url, token)))
        .await
        .map(|_| ());
    child.kill().await?;
    result
}

async fn fixture(test: &str, key: &str, root: &Path) -> Result<(Child, String)> {
    let mut child = Command::new(std::env::current_exe()?)
        .args(["--exact", test, "--nocapture"])
        .env(key, root)
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let ready = tokio::time::timeout(WAIT, async {
        while let Some(line) = lines.next_line().await? {
            if let Some(value) = line.split_once("fixture-ready=") {
                return Ok::<_, std::io::Error>(value.1.to_owned());
            }
        }
        panic!("fixture exited before readiness")
    })
    .await
    .expect("fixture did not report readiness")?;
    Ok((child, ready))
}

#[tokio::test]
async fn a_handoff_survives_sigkill_without_replay() -> Result<()> {
    fn kept(root: &Path) -> AgentBuilder {
        builder()
            .project(root)
            .data_dir(root.join("agent"))
            .durability(Durability::Kept)
            .interface_tools(sources(30_000))
    }
    if let Some(root) = std::env::var_os("SDK_INTERFACE_CRASH_FIXTURE") {
        let agent = kept(Path::new(&root)).build().await?;
        let session = session(&agent).await?;
        let mut connection = session.connect_interface_tools(ROUTE, EXECUTOR, rights())?;
        connection.advertise(&[definition()])?;
        let turn = session.prompt("Choose").await?;
        let call = connection.next_call().await?.unwrap();
        println!(
            "fixture-ready={}",
            json!([session.id(), turn.turn_id, call["id"]])
        );
        return std::future::pending().await;
    }
    let root = tempfile::tempdir()?;
    let (mut child, ready) = fixture(
        "a_handoff_survives_sigkill_without_replay",
        "SDK_INTERFACE_CRASH_FIXTURE",
        root.path(),
    )
    .await?;
    child.kill().await?;
    let [id, origin, call]: [String; 3] = serde_json::from_str(&ready)?;
    let agent = kept(root.path()).build().await?;
    let session = agent.open_session(&id).await?;
    let connection = session.connect_interface_tools(ROUTE, EXECUTOR, rights())?;
    assert_eq!(
        connection.report_tool_result(report(&call, "blue")).await?,
        Disposition::Accepted
    );
    let rows = continuation(&session, &origin).await?;
    assert_eq!(
        rows.iter().filter(|r| r["kind"] == "toolStarted").count(),
        1
    );
    agent.close().await
}

#[tokio::test]
async fn composition_refuses_bad_sources() -> Result<()> {
    for sources in [
        sources(0),
        sources(MAX_TIMEOUT),
        [sources(9), sources(9)].concat(),
    ] {
        let Err(error) = builder().interface_tools(sources).build().await else {
            panic!("invalid composition was accepted")
        };
        assert_eq!(error.code(), Code::InvalidComposition);
    }
    Ok(())
}
const MAX_TIMEOUT: u64 = u64::MAX;

#[tokio::test]
async fn erasing_arguments_invalidates_a_staged_call_and_accounts_for_the_copy() -> Result<()> {
    for pending in [false, true] {
        let root = tempfile::tempdir()?;
        let store = root.path().join("history");
        let agent = builder()
            .project(root.path())
            .history(modular_agent::file_history(&store)?)
            .data_dir(root.path().join("agent"))
            .durability(Durability::Kept)
            .interface_tools(sources(30_000))
            .build()
            .await?;
        let session = session(&agent).await?;
        let connection = session.connect_interface_tools(ROUTE, EXECUTOR, rights())?;
        connection.advertise(&[definition()])?;
        let turn = session.prompt("Choose").await?;
        let id = &turn.open_tool_calls[0];
        let rows = session.history().await?;
        let start = entry(&rows, "toolStarted");
        assert!(
            session
                .move_to(start["id"].as_str().unwrap())
                .await
                .is_err()
        );
        let target = entry(&rows, "response")["id"].as_str().unwrap().to_owned();
        if pending {
            use agent_api::HistoryStore;
            history_fs::FileHistory::new(&store)?.mark_erasure(session.id(), &[target])?;
            session.history().await?;
        } else {
            assert!(!session.erase(vec![target]).await?.out_of_reach.is_empty());
        }
        assert_eq!(
            connection
                .report_tool_result(report(id, "invalidated"))
                .await
                .expect("refuse the erased call"),
            Disposition::Refused { reason: None }
        );
        session.wait_idle().await.expect("no erased continuation");
        let rows = session.history().await.expect("history remains available");
        assert!(!json!(rows).to_string().contains("argument-marker"));
        assert!(!rows.iter().any(|r| r["continuesTurnId"].is_string()));
        assert_eq!(entry(&rows, "toolResult")["erased"], true);
        assert_eq!(entry(&rows, "toolResult")["toolCallId"], *id);
        agent.close().await?;
    }
    Ok(())
}

#[tokio::test]
async fn withheld_or_changed_executable_output_never_commits_a_start() -> Result<()> {
    for redact in [false, true] {
        let gate = Plugin::new("executor-gate").on_output(move |output| async move {
            use modular_agent::OutputDecision;
            if output.recipient != EXECUTOR || output.value["name"] != "pick_color" {
                return Ok(OutputDecision::Allow);
            }
            if redact {
                let mut changed = output.value;
                changed["input"]["label"] = json!("redacted");
                Ok(OutputDecision::Redact(changed))
            } else {
                Ok(OutputDecision::Block)
            }
        });
        let project = git_project();
        let agent = builder()
            .project(project.path())
            .interface_tools(sources(30_000))
            .plugin(gate)
            .build()
            .await?;
        let session = session(&agent).await?;
        let connection = session.connect_interface_tools(ROUTE, EXECUTOR, rights())?;
        connection.advertise(&[definition()])?;
        let turn = session.prompt("Choose").await?;
        assert!(turn.open_tool_calls.is_empty());
        let rows = session.history().await?;
        assert!(!rows.iter().any(|r| r["kind"] == "toolStarted"));
        assert_eq!(entry(&rows, "toolResult")["data"]["status"], "refused");
        agent.close().await?;
    }
    Ok(())
}

#[tokio::test]
async fn a_report_is_not_ready_until_the_origin_ends_and_rights_are_current() -> Result<()> {
    use std::sync::Arc;
    let release = Arc::new(tokio::sync::Notify::new());
    let gate = Plugin::new("pause-at-step-after").on_step_after({
        let release = release.clone();
        move |_| {
            let release = release.clone();
            async move {
                release.notified().await;
                Ok(modular_agent::Gate::Allow)
            }
        }
    });
    let project = git_project();
    let agent = builder()
        .project(project.path())
        .interface_tools(sources(30_000))
        .plugin(gate)
        .build()
        .await?;
    let session = session(&agent).await?;
    let mut connection = session.connect_interface_tools(ROUTE, EXECUTOR, rights())?;
    connection.advertise(&[definition()])?;
    let turn = tokio::spawn({
        let session = session.clone();
        async move { session.prompt("Choose").await }
    });
    let call = tokio::time::timeout(WAIT, connection.next_call())
        .await
        .unwrap()?
        .unwrap();
    let id = call["id"].as_str().unwrap();
    assert_eq!(
        connection
            .report_tool_result(report(id, "too early"))
            .await?,
        Disposition::Refused {
            reason: Some("notReady")
        }
    );
    release.notify_one();
    assert_eq!(turn.await.unwrap()?.open_tool_calls, vec![id]);
    session.leave(EXECUTOR).await?;
    assert_eq!(
        connection
            .report_tool_result(report(id, "no rights"))
            .await?,
        Disposition::Refused { reason: None }
    );
    agent.close().await
}

#[tokio::test]
async fn handoff_and_settlement_are_separate_metadata_only_spans() -> Result<()> {
    use opentelemetry::{KeyValue, global};
    use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};
    let exporter = InMemorySpanExporter::default();
    let tracer = SdkTracerProvider::builder()
        .with_simple_exporter(exporter.clone())
        .build();
    global::set_tracer_provider(tracer.clone());
    let conversation = KeyValue::new("gen_ai.conversation.id", round_trip(builder()).await?);
    let spans = exporter.get_finished_spans().unwrap();
    let tool = spans
        .iter()
        .find(|s| s.name == "execute_tool pick_color" && s.attributes.contains(&conversation))
        .unwrap();
    assert!(
        tool.attributes
            .contains(&KeyValue::new("modular_agent.tool.status", "pending"))
    );
    let settlement = spans
        .iter()
        .find(|s| s.name == "modular_agent.tool.settle" && s.attributes.contains(&conversation))
        .unwrap();
    assert!(
        settlement
            .attributes
            .contains(&KeyValue::new("modular_agent.tool.status", "completed"))
    );
    assert!(
        settlement
            .links
            .links
            .iter()
            .any(|link| link.span_context.span_id() == tool.span_context.span_id())
    );
    for payload in ["argument-marker", "raw-a", "raw-b", "blue", ROUTE] {
        assert!(!format!("{:?}{:?}", tool.attributes, settlement.attributes).contains(payload));
    }
    tracer.shutdown().unwrap();
    Ok(())
}
