mod support;
use agent_api::*;
use provider_fake::FakePlugin;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use support::*;
use tempfile::TempDir;

async fn agent(
    root: &std::path::Path,
    durable: bool,
    fake: Arc<FakePlugin>,
    plugins: Vec<Arc<dyn Plugin>>,
) -> Arc<agent_harness::Harness> {
    let h = agent_base::compose(
        agent_base::Options {
            history: root.join("sessions"),
            global_config: root.join("settings"),
            key_file: root.join("NO-KEY"),
            secrets: vec![],
        },
        fake,
        Arc::new(interface_terminal::TerminalPlugin {
            sink: Arc::new(Events::default()),
        }),
        if durable {
            Arc::new(runtime_durable::DurablePlugin)
        } else {
            Arc::new(runtime_transient::TransientPlugin)
        },
    )
    .await
    .unwrap();
    for p in plugins {
        h.load(p).await.unwrap();
    }
    h
}
async fn start_checkpoint(h: &Arc<agent_harness::Harness>, session: &str) -> Scope {
    let selector: Arc<dyn ModelSelection> = capability(h.as_ref(), "model.selection").unwrap();
    let scope = Scope {
        turn: Some(id()),
        step: Some(id()),
        ..Scope::session(session)
    };
    let info = selector.select(h.clone(), &scope).await.unwrap().info();
    let source: Arc<dyn ToolSource> = capability(h.as_ref(), "tools.builtin").unwrap();
    let tools = source.tools(&h.snapshot(session).unwrap());
    h.append(
        &scope,
        "test",
        Draft::new(
            "turn.start",
            false,
            json!({"model":info,"settings":{"step_limit":8},"tools":tools,"system":"test"}),
        ),
    )
    .unwrap();
    h.append(
        &scope,
        "test",
        Draft::new("step.start", false, json!({"index":0})),
    )
    .unwrap();
    scope
}
async fn checkpoint(h: &Arc<agent_harness::Harness>, session: &str, calls: Vec<ToolCall>) -> Scope {
    let scope = start_checkpoint(h, session).await;
    let data = h.snapshot(session).unwrap();
    let start = data
        .entries
        .iter()
        .find(|e| e.kind == "turn.start")
        .unwrap();
    let start = start.content.as_ref().unwrap();
    let model: ModelInfo = serde_json::from_value(start["model"].clone()).unwrap();
    let mut intent = wire::model_request_record(&model);
    intent["tools"] = json!(
        start["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["name"].clone())
            .collect::<Vec<_>>()
    );
    h.append(&scope, "test", Draft::new("model.request", false, intent))
        .unwrap();
    h.append(
        &scope,
        "test",
        Draft::new("model.response", true, json!(ModelResponse::calls(calls))),
    )
    .unwrap();
    scope
}
fn record_call(
    h: &Arc<agent_harness::Harness>,
    scope: &Scope,
    call: &ToolCall,
    started: bool,
) -> Scope {
    let s = Scope {
        call: Some(call.id.clone()),
        ..scope.clone()
    };
    h.append(&s, "test", Draft::new("tool.call", false, json!(call)))
        .unwrap();
    if started {
        h.append(&s, "test", Draft::new("tool.started", false, json!(call)))
            .unwrap();
    }
    s
}
fn results(h: &Arc<agent_harness::Harness>, id: &str) -> Vec<ToolResult> {
    h.snapshot(id)
        .unwrap()
        .branch()
        .iter()
        .filter(|e| e.kind == "tool.result")
        .map(|e| serde_json::from_value(e.content.clone().unwrap()).unwrap())
        .collect()
}
#[tokio::test]
async fn recovery_reconstructs_missing_calls_preserves_completions_and_never_repeats_unsafe_calls()
{
    for durable in [false, true] {
        let root = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        let fake = Arc::new(FakePlugin::new(vec![text("carried on")]));
        let h = agent(root.path(), durable, fake.clone(), vec![]).await;
        let id = h
            .create(project.path(), json!({"model":"fake","approval":"off"}))
            .await
            .unwrap();
        h.settings(&Scope::session(&id), json!({"approval":"off"}))
            .unwrap();
        let done = ToolCall::new("write", json!({"path":"done","content":"do not repeat"}));
        let unsafe_call = ToolCall::new("bash", json!({"command":"touch MUST-NOT-RUN"}));
        let missing = ToolCall::new("write", json!({"path":"new","content":"executed"}));
        let scope = checkpoint(
            &h,
            &id,
            vec![done.clone(), unsafe_call.clone(), missing.clone()],
        )
        .await;
        let s = record_call(&h, &scope, &done, true);
        h.append(
            &s,
            "test",
            Draft::new(
                "tool.completed",
                false,
                json!(ToolResult::new(
                    &done,
                    ToolStatus::Completed,
                    "already done"
                )),
            ),
        )
        .unwrap();
        record_call(&h, &scope, &unsafe_call, true);
        // The third call exists only in the committed response.
        h.close(&id).await.unwrap();
        h.open(&id).await.unwrap();
        let r = results(&h, &id);
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].status, ToolStatus::Completed);
        assert_eq!(r[1].status, ToolStatus::Unknown);
        assert!(r[1].text.contains("did not finish") && r[1].text.contains("Check"));
        assert!(!project.path().join("done").exists());
        assert!(!project.path().join("MUST-NOT-RUN").exists());
        let end = h
            .snapshot(&id)
            .unwrap()
            .entries
            .into_iter()
            .find(|e| e.kind == "turn.end")
            .unwrap();
        assert_eq!(
            end.content.unwrap()["outcome"],
            if durable { "completed" } else { "failed" }
        );
        if durable {
            assert_eq!(
                std::fs::read_to_string(project.path().join("new")).unwrap(),
                "executed"
            );
            assert_eq!(fake.probe.requests.lock().unwrap().len(), 1);
            let requests = fake.probe.requests.lock().unwrap();
            assert!(
                serde_json::to_string(&requests[0])
                    .unwrap()
                    .contains("did not finish")
            );
        } else {
            assert!(!project.path().join("new").exists());
        }
        h.close(&id).await.unwrap();
        h.open(&id).await.unwrap();
        assert_eq!(results(&h, &id).len(), r.len());
    }
}

#[tokio::test]
async fn duplicate_call_ids_are_refused_before_any_tool_is_dispatched() {
    let root = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();
    let call = ToolCall::new("write", json!({"path":"must-not-exist","content":"no"}));
    let h = agent(
        root.path(),
        true,
        Arc::new(FakePlugin::new(vec![calls(vec![call.clone(), call])])),
        vec![],
    )
    .await;
    let id = h
        .create(project.path(), json!({"model":"fake"}))
        .await
        .unwrap();
    h.submit(&id, "user", "start", Timing::Now, None)
        .await
        .unwrap();
    let result = h.run_next(&id).await.unwrap().unwrap();
    assert_eq!(result.outcome, Outcome::Failed);
    assert!(result.error.unwrap().contains("duplicate tool call id"));
    assert!(!project.path().join("must-not-exist").exists());
    assert_eq!(results(&h, &id).len(), 1);
}

#[tokio::test]
async fn swapping_runtime_changes_no_other_plugin_or_standard_hook_rule() {
    let mut setups = vec![];
    for durable in [false, true] {
        let root = TempDir::new().unwrap();
        let h = agent(
            root.path(),
            durable,
            Arc::new(FakePlugin::new(vec![])),
            vec![],
        )
        .await;
        let id = h
            .create(root.path(), json!({"model":"fake"}))
            .await
            .unwrap();
        let plugins = h
            .snapshot(&id)
            .unwrap()
            .plugins
            .into_iter()
            .filter(|name| !name.starts_with("runtime."))
            .collect::<Vec<_>>();
        let mut hooks = h.declaration().unwrap()["hook_points"].clone();
        for point in hooks.as_array_mut().unwrap() {
            if point["owner"].as_str().unwrap().starts_with("runtime.") {
                point["owner"] = json!("runtime");
            }
        }
        setups.push((plugins, hooks));
    }
    assert_eq!(setups[0], setups[1]);
}

struct Overlap {
    active: AtomicUsize,
    max: AtomicUsize,
    barrier: tokio::sync::Barrier,
    exclusive: bool,
}
impl Plugin for Overlap {
    fn name(&self) -> &str {
        "test.overlap"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        // Shared instance is supplied by the wrapper below.
        r.provide::<dyn ToolSource>(
            "tools.overlap",
            Arc::new(Self {
                active: AtomicUsize::new(0),
                max: AtomicUsize::new(0),
                barrier: tokio::sync::Barrier::new(2),
                exclusive: self.exclusive,
            }),
        )
    }
}
#[async_trait]
impl ToolSource for Overlap {
    fn tools(&self, _: &SessionData) -> Vec<ToolDefinition> {
        ["first", "second"]
            .into_iter()
            .map(|name| ToolDefinition {
                name: name.into(),
                description: "test".into(),
                input: json!({}),
                read_only: true,
                safe_to_repeat: true,
                parallel: !(self.exclusive && name == "first"),
                hints: json!({}),
            })
            .collect()
    }
    async fn run(&self, _: Api, _: Scope, call: ToolCall, _: CancellationToken) -> ToolResult {
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.max.fetch_max(active, Ordering::SeqCst);
        if !self.exclusive {
            tokio::time::timeout(std::time::Duration::from_secs(2), self.barrier.wait())
                .await
                .expect("tools did not overlap");
        }
        if call.name == "first" {
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        }
        self.active.fetch_sub(1, Ordering::SeqCst);
        ToolResult::new(
            &call,
            ToolStatus::Completed,
            self.max.load(Ordering::SeqCst).to_string(),
        )
    }
}
#[tokio::test]
async fn tools_publish_as_ready_but_reach_the_model_in_call_order() {
    for durable in [false, true] {
        for exclusive in [false, true] {
            let root = TempDir::new().unwrap();
            let project = TempDir::new().unwrap();
            let first = ToolCall::new("first", json!({}));
            let second = ToolCall::new("second", json!({}));
            let fake = Arc::new(FakePlugin::new(vec![
                calls(vec![first.clone(), second.clone()]),
                text("done"),
            ]));
            let h = agent(
                root.path(),
                durable,
                fake.clone(),
                vec![Arc::new(Overlap {
                    active: AtomicUsize::new(0),
                    max: AtomicUsize::new(0),
                    barrier: tokio::sync::Barrier::new(2),
                    exclusive,
                })],
            )
            .await;
            let id = h
                .create(project.path(), json!({"model":"fake"}))
                .await
                .unwrap();
            h.submit(&id, "user", "start", Timing::Now, None)
                .await
                .unwrap();
            assert_eq!(
                h.run_next(&id).await.unwrap().unwrap().outcome,
                Outcome::Completed
            );
            let r = results(&h, &id);
            let expected = if exclusive {
                [&first.id, &second.id]
            } else {
                [&second.id, &first.id]
            };
            assert_eq!(r.iter().map(|r| &r.call).collect::<Vec<_>>(), expected);
            assert_eq!(r[0].text, if exclusive { "1" } else { "2" });
            let requests = fake.probe.requests.lock().unwrap();
            let model_order: Vec<_> = requests[1]
                .messages
                .iter()
                .filter_map(|m| m.call.as_ref())
                .collect();
            assert_eq!(model_order, [&first.id, &second.id]);
        }
    }
}
