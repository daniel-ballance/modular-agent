mod support;
use agent_api::*;
use provider_fake::FakePlugin;
use std::sync::Arc;
use support::*;
use tempfile::TempDir;

async fn rig(
    root: &std::path::Path,
    extra: Vec<Arc<dyn Plugin>>,
) -> (Arc<agent_harness::Harness>, Arc<FakePlugin>, String, Scope) {
    let fake = Arc::new(FakePlugin::new(vec![]));
    let h = agent_base::compose(
        agent_base::Options {
            history: root.join("sessions"),
            global_config: root.join("settings"),
            key_file: root.join("NO-KEY"),
            secrets: vec![],
        },
        fake.clone(),
        Arc::new(interface_terminal::TerminalPlugin {
            sink: Arc::new(Events::default()),
        }),
        Arc::new(runtime_durable::DurablePlugin),
    )
    .await
    .unwrap();
    for plugin in extra {
        h.load(plugin).await.unwrap();
    }
    let id = h.create(root, json!({"model":"fake"})).await.unwrap();
    let scope = Scope {
        turn: Some(agent_api::id()),
        step: Some(agent_api::id()),
        ..Scope::session(&id)
    };
    let selector: Arc<dyn ModelSelection> = capability(h.as_ref(), "model.selection").unwrap();
    let model = selector.select(h.clone(), &scope).await.unwrap().info();
    let tools: Arc<dyn ToolSource> = capability(h.as_ref(), "tools.builtin").unwrap();
    let tools = tools.tools(&h.snapshot(&id).unwrap());
    h.append(&scope,"test",Draft::new("turn.start",false,json!({"model":model,"settings":{"step_limit":3},"system":"saved prompt","tools":tools}))).unwrap();
    (h, fake, id, scope)
}
#[tokio::test]
async fn interrupted_effectful_model_requests_fail_closed_without_repeating_inference() {
    for field in ["keeps_state", "runs_tools"] {
        let root = TempDir::new().unwrap();
        let (h, fake, id, scope) = rig(root.path(), vec![]).await;
        h.append(
            &scope,
            "test",
            Draft::new("step.start", false, json!({"index":0})),
        )
        .unwrap();
        h.append(
            &scope,
            "test",
            Draft::new("model.request", false, json!({field:true})),
        )
        .unwrap();
        h.close(&id).await.unwrap();
        h.open(&id).await.unwrap();
        let data = h.snapshot(&id).unwrap();
        let end = data
            .entries
            .iter()
            .find(|e| e.kind == "turn.end")
            .unwrap()
            .content
            .as_ref()
            .unwrap();
        assert_eq!(end["outcome"], "failed");
        assert!(
            end["error"]
                .as_str()
                .unwrap()
                .contains("unknown outside effects")
        );
        assert!(fake.probe.requests.lock().unwrap().is_empty());
    }
}
#[tokio::test]
async fn saved_step_decisions_preserve_final_answer_and_limit_without_another_request() {
    for final_answer in [true, false] {
        let root = TempDir::new().unwrap();
        let (h, fake, id, scope) = rig(root.path(), vec![]).await;
        for index in 0..if final_answer { 1 } else { 3 } {
            let scope = Scope {
                step: Some(agent_api::id()),
                ..scope.clone()
            };
            h.append(
                &scope,
                "test",
                Draft::new("step.start", false, json!({"index":index})),
            )
            .unwrap();
            h.append(&scope, "test", Draft::new("model.request", false,
                json!({"model":{"provider":"fake","id":"fake"},"tools":[],"safeToRepeat":false}))).unwrap();
            let mut response = ModelResponse::text("already generated");
            response.usage = Usage {
                input_tokens: 10,
                output_tokens: 2,
                ..Usage::default()
            };
            h.append(
                &scope,
                "test",
                Draft::new("model.response", true, json!(response)),
            )
            .unwrap();
            h.append(
                &scope,
                "test",
                Draft::new(recovery::STEP_AFTER, false, json!({"decision":null})),
            )
            .unwrap();
            let result = TurnResult {
                steps: index + 1,
                text: "already generated".into(),
                ..TurnResult::default()
            };
            h.append(
                &scope,
                "test",
                Draft::new(
                    "step.end",
                    false,
                    json!({"continue":!final_answer,"result":result}),
                ),
            )
            .unwrap();
        }
        h.close(&id).await.unwrap();
        h.open(&id).await.unwrap();
        let data = h.snapshot(&id).unwrap();
        let end: TurnResult = serde_json::from_value(
            data.entries
                .iter()
                .find(|e| e.kind == "turn.end")
                .unwrap()
                .content
                .clone()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            end.outcome,
            if final_answer {
                Outcome::Completed
            } else {
                Outcome::Limit
            }
        );
        assert_eq!(end.text, "already generated");
        assert_eq!(end.steps, if final_answer { 1 } else { 3 });
        assert_eq!(end.usage.input_tokens, if final_answer { 10 } else { 30 });
        assert!(fake.probe.requests.lock().unwrap().is_empty());
        h.close(&id).await.unwrap();
        h.open(&id).await.unwrap();
        assert_eq!(
            h.snapshot(&id)
                .unwrap()
                .entries
                .iter()
                .filter(|e| e.kind == "turn.end")
                .count(),
            1
        );
    }
}
struct NoContainment;
impl Plugin for NoContainment {
    fn name(&self) -> &str {
        "test.no-containment"
    }
    fn replaces(&self) -> Option<&str> {
        Some("environment.local")
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.provide::<dyn WorkingEnvironment>("environment", Arc::new(Self))
    }
}
#[async_trait]
impl WorkingEnvironment for NoContainment {
    fn declaration(&self) -> Value {
        json!({"stops_commands_after_sigkill":false})
    }
    async fn read(&self, _: &std::path::Path, _: &str) -> Result<String> {
        bail!("must not dispatch")
    }
    async fn write(&self, _: &std::path::Path, _: &str, _: &str) -> Result<()> {
        bail!("must not dispatch")
    }
    async fn edit(&self, _: &std::path::Path, _: &str, _: &str, _: &str) -> Result<()> {
        bail!("must not dispatch")
    }
    async fn bash(
        &self,
        _: Api,
        _: Scope,
        _: std::path::PathBuf,
        _: &str,
        _: CancellationToken,
    ) -> Result<ToolResult> {
        bail!("must not dispatch")
    }
}
#[tokio::test]
async fn even_a_safe_call_is_not_repeated_without_the_environments_containment_promise() {
    let root = TempDir::new().unwrap();
    let (h, _, id, scope) = rig(root.path(), vec![Arc::new(NoContainment)]).await;
    let call = ToolCall::new("read", json!({"path":"file"}));
    let scope = Scope {
        call: Some(call.id.clone()),
        ..scope
    };
    h.append(
        &scope,
        "test",
        Draft::new("step.start", false, json!({"index":0})),
    )
    .unwrap();
    h.append(
        &scope,
        "test",
        Draft::new(
            "model.response",
            true,
            json!(ModelResponse::calls(vec![call.clone()])),
        ),
    )
    .unwrap();
    h.append(&scope, "test", Draft::new("tool.call", false, json!(call)))
        .unwrap();
    h.append(
        &scope,
        "test",
        Draft::new("tool.started", false, json!(call)),
    )
    .unwrap();
    h.close(&id).await.unwrap();
    h.open(&id).await.unwrap();
    let data = h.snapshot(&id).unwrap();
    let result: ToolResult = serde_json::from_value(
        data.entries
            .iter()
            .find(|e| e.kind == "tool.result")
            .unwrap()
            .content
            .clone()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(result.status, ToolStatus::Unknown);
    assert!(result.text.contains("Check"));
}
