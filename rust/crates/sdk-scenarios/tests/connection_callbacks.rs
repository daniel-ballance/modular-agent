use futures_util::StreamExt;
use modular_agent::{
    Code, EnvironmentContext, EnvironmentDeclaration, EnvironmentPart, Error, Event, ExecResult,
    InterruptedTurn, Outcome, OutputDecision, Plugin, ProcessPlugin, Result, RuntimeCall,
    RuntimeContext, RuntimeDeclaration, RuntimeOutcome, RuntimePart, RuntimeTurn, ServeOptions,
    ServicePlugin, Tool, ToolContext, ToolSource, ToolStatus, ToolsChanged, async_trait,
    serve_websocket,
    testing::{scripted_provider, test_agent},
};
use serde_json::{Value, json};
use std::{
    io::Write,
    os::unix::fs::OpenOptionsExt,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

#[path = "support/callback_progress.rs"]
mod fixture;
use fixture::{preview, progress_plugin};

const DEADLINE: Duration = Duration::from_secs(5);

#[tokio::test]
async fn stdio_job_progress_passes_through_its_own_gate_in_order() -> Result<()> {
    let launch = ProcessPlugin::new([env!("CARGO_BIN_EXE_sdk-callback-plugin")]);
    tokio::time::timeout(DEADLINE, async {
        let agent = test_agent().process_plugin(launch).build().await?;
        check_job_progress(&agent).await?;
        agent.close().await
    })
    .await
    .expect("stdio job progress, call or shutdown stalled")
}

#[tokio::test]
async fn websocket_job_progress_passes_through_its_own_gate_in_order() -> Result<()> {
    tokio::time::timeout(DEADLINE, async {
        let dir = tempfile::tempdir()?;
        let (service, token_file) = callback_service(progress_plugin(), dir.path()).await?;
        let agent = test_agent()
            .service_plugin(ServicePlugin {
                url: service.url.clone(),
                token_file,
                config: json!({}),
            })
            .build()
            .await?;
        check_job_progress(&agent).await?;
        agent.close().await?;
        service.close().await;
        Ok(())
    })
    .await
    .expect("WebSocket job progress, call or shutdown stalled")
}

async fn callback_service(
    plugin: Plugin,
    dir: &std::path::Path,
) -> Result<(modular_agent::WebSocketServer, std::path::PathBuf)> {
    let token_file = dir.join("token");
    writeln!(
        std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&token_file)?,
        "preview-test-4d76a58523f445a1a06fd749e89f4a42"
    )?;
    let service = serve_websocket(
        plugin,
        ServeOptions {
            listen: "127.0.0.1:0".into(),
            token_file: token_file.clone(),
            tls: None,
        },
    )
    .await?;
    Ok((service, token_file))
}

async fn check_job_progress(agent: &modular_agent::Agent) -> Result<()> {
    let session = agent.session().await?;
    let mut events = session.events(None)?;
    let call = session.call_tool("preview", json!({})).await?;
    assert_eq!(call.status, ToolStatus::Completed, "{}", call.text());
    assert!(!call.text().is_empty());
    let mut seen = Vec::new();
    while let Some(event) = events.next().await.transpose()? {
        let job_id = event.job_id.clone();
        match event {
            Event::JobProgress(event) => {
                assert_eq!(job_id.as_deref(), Some(call.text()));
                seen.push(event.data);
            }
            Event::JobEnded(_) => break,
            _ => {}
        }
    }
    assert_eq!(
        seen,
        ["first", "second"].map(|text| preview(&format!("gated {text}")))
    );
    Ok(())
}

struct StreamingEnvironment;

#[async_trait]
impl EnvironmentPart for StreamingEnvironment {
    fn declaration(&self) -> EnvironmentDeclaration {
        EnvironmentDeclaration::default()
    }
    async fn read(&self, _: EnvironmentContext, path: &str) -> Result<Vec<u8>> {
        assert_eq!(path, "result");
        Ok(b"contents".to_vec())
    }
    async fn write(&self, _: EnvironmentContext, _: &str, _: &[u8]) -> Result<()> {
        Err(Error::new(Code::NotSupported, "read-only fixture"))
    }
    async fn exec(
        &self,
        cx: EnvironmentContext,
        command: &str,
        _: Option<Duration>,
    ) -> Result<ExecResult> {
        assert_eq!(command, "inspect");
        cx.output("working").await?;
        Ok(ExecResult {
            exit_code: Some(0),
            output: "done".into(),
            ..Default::default()
        })
    }
}

#[derive(Default)]
struct Catalog {
    changed: AtomicBool,
    refreshed: AtomicBool,
    notifier: Mutex<Option<ToolsChanged>>,
}

struct Source(Arc<Catalog>);
impl ToolSource for Source {
    fn per_session(&self) -> bool {
        false
    }
    fn catalog_notifier(&self, notifier: ToolsChanged) {
        *self.0.notifier.lock().unwrap() = Some(notifier);
    }
    fn tools(&self, _: &str) -> Vec<Tool> {
        let state = self.0.clone();
        let mut tools = vec![Tool::new("inspect", "Inspect the fixture").run(
            move |_: Value, cx: ToolContext| {
                let state = state.clone();
                async move {
                    let env = cx.environment();
                    assert_eq!(env.exec("inspect", None).await?.output, "done");
                    assert_eq!(env.read("result").await?, b"contents");
                    cx.progress(preview("tool")).await?;
                    for value in ["first", "second"] {
                        cx.emit("catalog.updated", json!(value)).await?;
                    }
                    state.changed.store(true, Ordering::Release);
                    state.notifier.lock().unwrap().as_ref().unwrap().changed();
                    Ok("updated")
                }
            },
        )];
        if self.0.changed.load(Ordering::Acquire) {
            self.0.refreshed.store(true, Ordering::Release);
            tools.push(
                Tool::new("added", "A new tool").run(|_: Value, _| async { Ok("available") }),
            );
        }
        tools
    }
}

#[tokio::test]
async fn same_peer_tool_and_environment_progress_custom_events_and_catalog_refresh() -> Result<()> {
    tokio::time::timeout(DEADLINE, async {
        const CUSTOM: &str = "plugin.inspection.catalog.updated";
        let catalog = Arc::new(Catalog::default());
        let state = catalog.clone();
        let plugin = Plugin::new("inspection")
            .replaces("working-environment")
            .setup(|r| r.environment_part(StreamingEnvironment))
            .tool_source("inspection", Source(state))
            .on_output(|output| async move {
                let mut v = output.value;
                match v["type"].as_str() {
                    Some("toolOutput") => {
                        let data = &mut v["data"];
                        let chunk = data["chunk"].as_str().unwrap();
                        let gated = format!("gated {chunk}");
                        if chunk == "tool" {
                            assert_eq!(data["content"], json!(preview("tool")));
                            data["content"][0]["text"] = json!(gated);
                        }
                        data["chunk"] = json!(gated);
                    }
                    Some(CUSTOM) => {
                        assert!(!output.context.history(None).await?.entries.is_empty());
                        v["data"] = json!(format!("gated {}", v["data"].as_str().unwrap()));
                    }
                    _ => return Ok(OutputDecision::Allow),
                }
                Ok(OutputDecision::Redact(v))
            });
        let agent = test_agent().over_wire(plugin).build().await?;
        let session = agent.session().await?;
        let mut events = session.events(None)?;
        let result = session.call_tool("inspect", json!({})).await?;
        assert_eq!(result.text(), "updated");
        assert!(
            catalog.refreshed.load(Ordering::Acquire),
            "refresh before the triggering call returns"
        );
        assert_eq!(
            session.call_tool("added", json!({})).await?.text(),
            "available"
        );

        let mut chunks = Vec::new();
        let mut custom = Vec::new();
        while chunks.len() < 2 || custom.len() < 2 {
            let event = events.next().await.expect("events follower closed")?;
            match event {
                Event::ToolOutput(output) => chunks.push((output.data.chunk, output.data.content)),
                Event::Custom(event) if event.event_type == CUSTOM => custom.push(event.data),
                _ => {}
            }
        }
        assert_eq!(
            chunks,
            [
                ("gated working".into(), None),
                ("gated tool".into(), Some(preview("gated tool")))
            ]
        );
        assert_eq!(custom, [json!("gated first"), json!("gated second")]);
        agent.close().await
    })
    .await
    .expect("tool, environment, catalog or custom event stalled")
}

struct ReportingRuntime;

#[async_trait]
impl RuntimePart for ReportingRuntime {
    fn declaration(&self) -> RuntimeDeclaration {
        RuntimeDeclaration {
            id: "reporting".into(),
            supports: Default::default(),
        }
    }
    async fn run_turn(&self, _: RuntimeTurn, cx: RuntimeContext) -> Result<RuntimeOutcome> {
        let step = cx.new_id().await?;
        let request = cx.prepare_step(&step, Default::default()).await?;
        let response = cx.model(&step, request).await?;
        let row = cx
            .record(json!({"kind":"response","stepId":step,"visible":true,"message":response}))
            .await?;
        cx.hook("step.after", json!({"stepId":step,"response":response}))
            .await?;
        cx.emit("inference.verified", json!("answer")).await?;
        Ok(RuntimeOutcome {
            outcome: Outcome::Completed,
            result: json!({"text":response.0["content"].as_array().unwrap().iter().find(|p| p["type"] == "text").unwrap()["text"],"openToolCalls":[]}),
            entries: vec![row["id"].as_str().unwrap().into()],
            usage: Default::default(),
        })
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
        _: RuntimeTurn,
        _: Vec<RuntimeCall>,
        _: RuntimeContext,
    ) -> Result<RuntimeOutcome> {
        unreachable!()
    }
}

#[tokio::test]
async fn same_peer_runtime_model_callback_stream_and_report() -> Result<()> {
    tokio::time::timeout(DEADLINE, async {
        let plugin = Plugin::new("reporting")
            .replaces("runtime")
            .setup(|r| {
                r.provider(scripted_provider(
                    json!([{"reasoning":"thought","text":"answer"}]),
                ));
                r.runtime(ReportingRuntime)
            })
            .on_output(|output| async move {
                let mut v = output.value;
                match v["type"].as_str() {
                    Some("text" | "reasoning") => {
                        v["data"]["delta"] =
                            json!(format!("gated {}", v["data"]["delta"].as_str().unwrap()));
                    }
                    Some("inference.verified") => {
                        assert!(!output.context.history(None).await?.entries.is_empty());
                        v["data"] = json!("gated report");
                    }
                    _ => return Ok(OutputDecision::Allow),
                }
                Ok(OutputDecision::Redact(v))
            });
        let project = tempfile::tempdir()?;
        let (service, token_file) = callback_service(plugin, project.path()).await?;
        let agent = modular_agent::Agent::builder()
            .project(project.path())
            .environment(modular_agent::testing::memory_environment())
            .model(modular_agent::testing::SCRIPTED_MODEL)
            .service_plugin(ServicePlugin {
                url: service.url.clone(),
                token_file,
                config: json!({}),
            })
            .build()
            .await?;
        let session = agent.session().await?;
        let mut events = session.events(None)?;
        let result = session.prompt("Generate an answer").await?;
        assert_eq!(result.outcome, Some(Outcome::Completed), "{result:?}");
        assert_eq!(result.text, "answer");
        let mut seen = Vec::new();
        while let Some(event) = events.next().await.transpose()? {
            match event {
                Event::Text { delta, .. } | Event::Reasoning { delta, .. } => seen.push(delta),
                Event::Custom(event) if event.event_type == "inference.verified" => {
                    seen.push(event.data.as_str().unwrap().to_owned());
                }
                Event::TurnEnded(_) => break,
                _ => {}
            }
        }
        assert_eq!(seen, ["gated thought", "gated answer", "gated report"]);
        agent.close().await?;
        service.close().await;
        Ok(())
    })
    .await
    .expect("Runtime, model callback, stream or report stalled")
}
