use modular_agent::{
    Code, InterruptedTurn, Outcome, Plugin, Result, RuntimeCall, RuntimeContext,
    RuntimeDeclaration, RuntimeOutcome, RuntimePart, RuntimeSupport, RuntimeTurn, Usage,
    async_trait, testing::test_agent,
};
use serde_json::json;
use tokio::sync::mpsc;

struct OneStep(mpsc::UnboundedSender<RuntimeContext>);
#[async_trait]
impl RuntimePart for OneStep {
    fn declaration(&self) -> RuntimeDeclaration {
        RuntimeDeclaration {
            id: "one-step".into(),
            supports: RuntimeSupport::default(),
        }
    }
    async fn run_turn(&self, turn: RuntimeTurn, cx: RuntimeContext) -> Result<RuntimeOutcome> {
        assert_eq!(turn.turn_id, cx.turn_id);
        assert_eq!(turn.model.model.provider, "scripted");
        let history = cx.history(None).await?;
        assert!(
            history
                .entries
                .iter()
                .any(|e| e["kind"] == "turnStart" && e["turnId"] == turn.turn_id)
        );
        let step = cx.new_id().await?;
        let request = cx.prepare_step(&step, Usage::default()).await?;
        let response = cx.model(&step, request).await?;
        let entry = cx
            .record(json!({"kind":"response","stepId":step,"visible":true,"message":response}))
            .await?;
        let usage: Usage = serde_json::from_value(response.0["usage"].clone())?;
        let text = response.0["content"][0]["text"].as_str().unwrap();
        cx.hook("step.after", json!({"stepId":step,"response":response}))
            .await?;
        self.0.send(cx).ok().unwrap();
        Ok(RuntimeOutcome {
            outcome: Outcome::Completed,
            result: json!({"text":text,"openToolCalls":[]}),
            entries: vec![entry["id"].as_str().unwrap().into()],
            usage,
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
async fn the_same_sdk_runtime_requests_and_records_a_step_in_both_placements() -> Result<()> {
    for served in [false, true] {
        let (send, mut contexts) = mpsc::unbounded_channel();
        let plugin = Plugin::new("custom-runtime")
            .replaces("runtime")
            .setup(move |r| r.runtime(OneStep(send.clone())));
        let builder = test_agent()
            .script(json!([{"text":"Hello from a custom Runtime","usage":{"input":3,"output":6}}]));
        let agent = if served {
            builder.over_wire(plugin)
        } else {
            builder.plugin(plugin)
        }
        .build()
        .await?;
        let session = agent.session().await?;
        let answer = session.prompt("Hello").await?;
        assert!(
            matches!(answer.outcome, Some(Outcome::Completed)),
            "served={served}: {answer:?}"
        );
        assert_eq!(answer.text, "Hello from a custom Runtime");
        assert_eq!(
            contexts
                .try_recv()
                .unwrap()
                .new_id()
                .await
                .unwrap_err()
                .code(),
            Code::InvalidRequest
        );
        agent.close().await?;
    }
    Ok(())
}

struct RecoveringRuntime {
    crash: bool,
    pending: bool,
}

fn success(text: &str, open: Vec<String>) -> RuntimeOutcome {
    RuntimeOutcome {
        outcome: Outcome::Completed,
        result: json!({"text":text,"openToolCalls":open}),
        entries: vec![],
        usage: Usage::default(),
    }
}

#[async_trait]
impl RuntimePart for RecoveringRuntime {
    fn declaration(&self) -> RuntimeDeclaration {
        RuntimeDeclaration {
            id: "recovering".into(),
            supports: RuntimeSupport {
                continues_after_restart: true,
                waiting_through_restart: true,
                ..RuntimeSupport::default()
            },
        }
    }
    async fn run_turn(&self, _: RuntimeTurn, cx: RuntimeContext) -> Result<RuntimeOutcome> {
        assert!(self.crash, "reopen must not run a fresh turn");
        let step = cx.new_id().await?;
        let request = cx.prepare_step(&step, Usage::default()).await?;
        let response = cx.model(&step, request).await?;
        cx.record(json!({"kind":"response","stepId":step,"visible":true,"message":response}))
            .await?;
        let mut open = vec![];
        if self.pending {
            let call = &response.0["content"][0];
            assert_eq!(call["type"], "toolCall");
            let call = json!({"id":call["id"], "name":call["name"], "input":call["arguments"], "startedBy":"model", "stepId":step});
            let definition = cx.definition("palette").await?.unwrap();
            cx.hook(
                "tool.before",
                json!({"call":call,"definition":definition,"stepId":step}),
            )
            .await?;
            let result = cx.run_tool_call(call.clone()).await?;
            assert!(result["pending"].is_string(), "{result}");
            open.push(call["id"].as_str().unwrap().into());
        }
        cx.hook("step.after", json!({"stepId":step,"response":response}))
            .await?;
        if self.pending {
            Ok(success("Left open", open))
        } else {
            std::process::exit(71)
        }
    }
    async fn resume_turn(
        &self,
        turn: RuntimeTurn,
        interrupted: InterruptedTurn,
        cx: RuntimeContext,
    ) -> Result<RuntimeOutcome> {
        assert!(!self.crash && !self.pending);
        assert_eq!(turn.turn_id, interrupted.turn_id);
        assert_eq!(turn.turn_id, cx.turn_id);
        assert!(interrupted.calls.is_empty());
        let last = interrupted.last_step.expect("committed step");
        assert_eq!(last.decision, Some(serde_json::Value::Null));
        assert!(
            cx.history(None)
                .await?
                .entries
                .iter()
                .any(|e| e["kind"] == "response" && e["stepId"] == last.step_id)
        );
        Ok(success("Resumed", vec![]))
    }
    async fn continue_open_calls(
        &self,
        turn: RuntimeTurn,
        calls: Vec<RuntimeCall>,
        cx: RuntimeContext,
    ) -> Result<RuntimeOutcome> {
        assert!(!self.crash && self.pending);
        assert_eq!(calls.len(), 1);
        let call = &calls[0];
        assert_eq!(call.name, "palette");
        assert!(call.started);
        let history = cx.history(None).await?;
        assert!(history.entries.iter().any(|e| {
            e["kind"] == "turnEnd"
                && e["turnId"] != turn.turn_id
                && e["data"]["result"]["openToolCalls"]
                    .as_array()
                    .is_some_and(|ids| ids.contains(&json!(call.id)))
        }));
        let call = json!({"id":call.id, "name":call.name,"input":call.input,"stepId":call.step_id,"startedBy":"model"});
        let definition = cx.definition("palette").await?.unwrap();
        cx.hook(
            "tool.before",
            json!({"call":call,"definition":definition,"stepId":call["stepId"]}),
        )
        .await?;
        let result = cx.run_tool_call(call.clone()).await?;
        assert_eq!(result["content"][0]["text"], "blue palette", "{result}");
        cx.hook(
            "tool.after",
            json!({"call":call,"result":result,"stepId":call["stepId"]}),
        )
        .await?;
        Ok(success("Continued", vec![]))
    }
}

#[tokio::test]
async fn custom_runtime_recovers_and_continues_after_process_exit() -> Result<()> {
    use modular_agent::{
        Agent, Answer, Ask, AskWait, Durability, Tool, ToolContext, testing::scripted_provider,
    };
    use std::{fs, path::Path, process::Command, time::Duration};

    async fn build(root: &Path, crash: bool, pending: bool) -> Result<Agent> {
        let script = if pending {
            json!([{"toolCalls":[{"name":"palette","input":{}}]}])
        } else {
            json!([{"text":"original"}])
        };
        let plugin = Plugin::new("custom-recovery")
            .replaces("runtime")
            .setup(move |r| r.runtime(RecoveringRuntime { crash, pending }))
            .tool(Tool::new("palette", "Choose a palette").run(
                |_: serde_json::Value, cx: ToolContext| async move {
                    let answer = cx
                        .ask_with(
                            Ask::text("Palette?"),
                            AskWait {
                                wait: Duration::from_millis(10),
                            },
                        )
                        .await?;
                    assert!(matches!(answer, Answer::Value(value) if value == "blue"));
                    Ok("blue palette")
                },
            ));
        Agent::builder()
            .project(root)
            .data_dir(root.join("data"))
            .durability(Durability::Durable)
            .provider(scripted_provider(script))
            .plugin(plugin)
            .build()
            .await
    }
    if let Some(root) = std::env::var_os("SDK_RUNTIME_CRASH_ROOT") {
        let root = std::path::PathBuf::from(root);
        let pending = std::env::var("SDK_RUNTIME_CRASH_PENDING").unwrap() == "yes";
        let agent = build(&root, true, pending).await?;
        let session = agent.session().await?;
        fs::write(root.join("session"), session.id())?;
        let turn = session.prompt("Begin").await?;
        assert!(pending);
        assert_eq!(turn.open_tool_calls.len(), 1, "{turn:?}");
        std::process::exit(71);
    }
    for pending in [false, true] {
        let root = tempfile::tempdir()?;
        let status = Command::new(std::env::current_exe()?)
            .args([
                "--exact",
                "custom_runtime_recovers_and_continues_after_process_exit",
            ])
            .env("SDK_RUNTIME_CRASH_ROOT", root.path())
            .env(
                "SDK_RUNTIME_CRASH_PENDING",
                if pending { "yes" } else { "no" },
            )
            .status()?;
        assert_eq!(status.code(), Some(71), "pending={pending}");
        let agent = build(root.path(), false, pending).await?;
        let session = agent
            .open_session(&fs::read_to_string(root.path().join("session"))?)
            .await?;
        if pending {
            let question = session.questions()?.pop().expect("open question");
            use futures_util::StreamExt;
            let mut events = session.events(None)?;
            session
                .answer(&question.id, Answer::Value("blue".into()))
                .await?;
            tokio::time::timeout(Duration::from_secs(5), async {
                while let Some(event) = events.next().await {
                    if event?.event_type == "turnEnded" {
                        return Ok::<_, modular_agent::Error>(());
                    }
                }
                panic!("stream ended before the continuation settled");
            })
            .await
            .expect("continuation settled")?;
        }
        assert_eq!(
            session.last_turn().await?.unwrap().text,
            if pending { "Continued" } else { "Resumed" }
        );
        agent.close().await?;
    }
    Ok(())
}
