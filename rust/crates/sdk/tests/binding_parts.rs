use futures_util::StreamExt;
use modular_agent::{
    Code, DirEntry, DirEntryKind, EnvironmentContext, EnvironmentDeclaration, EnvironmentPart,
    Event, ExecResult, Plugin, Result, StepChange, Tool, ToolContext, async_trait,
    testing::test_agent,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Clone, Default)]
struct Environment {
    files: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
    closed: Arc<Mutex<Vec<String>>>,
}
#[async_trait]
impl EnvironmentPart for Environment {
    fn declaration(&self) -> EnvironmentDeclaration {
        EnvironmentDeclaration {
            confines_files: true,
            ..EnvironmentDeclaration::default()
        }
    }
    async fn read(&self, _cx: EnvironmentContext, path: &str) -> Result<Vec<u8>> {
        self.files
            .lock()
            .unwrap()
            .get(path)
            .cloned()
            .ok_or_else(|| modular_agent::Error::new(Code::NotFound, "not present"))
    }
    async fn write(&self, cx: EnvironmentContext, path: &str, bytes: &[u8]) -> Result<()> {
        assert!(!cx.session_id.is_empty());
        assert!(cx.cwd.is_absolute());
        self.files
            .lock()
            .unwrap()
            .insert(path.into(), bytes.to_vec());
        Ok(())
    }
    async fn list(&self, _: EnvironmentContext, path: &str) -> Result<Vec<DirEntry>> {
        assert_eq!(path, ".");
        Ok(self
            .files
            .lock()
            .unwrap()
            .keys()
            .map(|name| DirEntry {
                name: name.clone(),
                kind: DirEntryKind::File,
                extra: Default::default(),
            })
            .collect())
    }
    async fn exec(
        &self,
        cx: EnvironmentContext,
        command: &str,
        timeout: Option<Duration>,
    ) -> Result<ExecResult> {
        assert_eq!(command, "fixture command");
        assert_eq!(timeout, Some(Duration::from_millis(100)));
        cx.output("working").await?;
        Ok(ExecResult {
            exit_code: Some(0),
            output: "done".into(),
            ..ExecResult::default()
        })
    }
    async fn session_ended(&self, session: &str) -> Result<()> {
        self.closed.lock().unwrap().push(session.into());
        Ok(())
    }
}

#[tokio::test]
async fn binding_shaped_environment_and_content_progress() -> Result<()> {
    for served in [false, true] {
        let env = Environment::default();
        let installed = env.clone();
        let plugin = Plugin::new("binding-environment")
            .replaces("working-environment")
            .setup(move |r| r.environment_part(installed.clone()))
            .tool(Tool::new("measure", "Measure a fixture").run(
                |_: Value, cx: ToolContext| async move {
                    let files = cx.environment();
                    assert_eq!(
                        files.read("measurement").await.unwrap_err().code(),
                        Code::NotFound
                    );
                    files.write("measurement", &[0, 240, 255]).await?;
                    assert_eq!(files.read("measurement").await?, [0, 240, 255]);
                    assert_eq!(files.list(".").await?, ["measurement"]);
                    let out = files
                        .exec("fixture command", Some(Duration::from_millis(100)))
                        .await?;
                    assert_eq!(out.output, "done");
                    assert!(!out.timed_out);
                    cx.progress(vec![
                        json!({"type":"text","text":"image follows"}),
                        json!({"type":"image","data":"AA==","mimeType":"image/png"}),
                    ])
                    .await?;
                    Ok("done")
                },
            ));
        let b = test_agent();
        let agent = if served {
            b.over_wire(plugin)
        } else {
            b.plugin(plugin)
        }
        .build()
        .await?;
        let session = agent.session().await?;
        let mut events = session.events(None)?;
        let result = session.call_tool("measure", json!({})).await?;
        assert_eq!(result.text(), "done", "{result:?}");
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut chunks = Vec::new();
            while let Some(event) = events.next().await {
                if let Event::ToolOutput(e) = event? {
                    if let Some(content) = e.data.content {
                        assert_eq!(e.data.chunk, "image follows");
                        assert_eq!(
                            content[1],
                            json!({"type":"image","data":"AA==","mimeType":"image/png"})
                        );
                        assert_eq!(chunks, ["working"]);
                        return Ok::<_, modular_agent::Error>(());
                    }
                    chunks.push(e.data.chunk);
                }
            }
            panic!("progress stream ended early");
        })
        .await
        .expect("tool progress reached the actor")?;
        session.close().await?;
        assert_eq!(*env.closed.lock().unwrap(), [session.id()]);
        agent.close().await?;
    }
    Ok(())
}

struct LocalToolsProvider(Arc<Mutex<Vec<String>>>);
#[async_trait]
impl modular_agent::Provider for LocalToolsProvider {
    fn id(&self) -> &str {
        "local-tools"
    }
    fn models(&self) -> Vec<modular_agent::ModelInfo> {
        vec![modular_agent::ModelInfo {
            model: modular_agent::ModelRef {
                provider: "local-tools".into(),
                id: "demo".into(),
            },
            context_window: 32_000,
            max_output: 1024,
            thinking: vec![],
            extra: Default::default(),
        }]
    }
    fn provider_tools(&self) -> Vec<modular_agent::ToolDefinition> {
        ["one", "two"]
            .into_iter()
            .map(|name| {
                serde_json::from_value(
                    json!({"name":name,"description":"fixture","parameters":{"type":"object"}}),
                )
                .unwrap()
            })
            .collect()
    }
    async fn request(
        &self,
        _: modular_agent::ModelRef,
        request: modular_agent::ModelRequest,
        cx: modular_agent::ProviderContext,
    ) -> Result<modular_agent::AssistantMessage> {
        assert!(request.0.get("providerTools").is_none());
        self.0
            .lock()
            .unwrap()
            .extend(cx.provider_tools().iter().map(|d| d.name.clone()));
        Ok(modular_agent::AssistantMessage(
            json!({"role":"assistant","stop":"finished","content":[{"type":"text","text":"answer"}],"usage":{}}),
        ))
    }
}

struct OneStep;
#[async_trait]
impl modular_agent::RuntimePart for OneStep {
    fn declaration(&self) -> modular_agent::RuntimeDeclaration {
        modular_agent::RuntimeDeclaration {
            id: "one-step".into(),
            supports: Default::default(),
        }
    }
    async fn run_turn(
        &self,
        _: modular_agent::RuntimeTurn,
        cx: modular_agent::RuntimeContext,
    ) -> Result<modular_agent::RuntimeOutcome> {
        let step = cx.new_id().await?;
        let request = cx.prepare_step(&step, Default::default()).await?;
        assert!(request.0.get("providerTools").is_none());
        let response = cx.model(&step, request).await?;
        cx.record(json!({"kind":"response","stepId":step,"visible":true,"message":response}))
            .await?;
        cx.hook("step.after", json!({"stepId":step,"response":response}))
            .await?;
        Ok(modular_agent::RuntimeOutcome {
            outcome: modular_agent::Outcome::Completed,
            result: json!({"text":response.0["content"][0]["text"],"openToolCalls":[]}),
            entries: vec![],
            usage: Default::default(),
        })
    }
    async fn resume_turn(
        &self,
        _: modular_agent::RuntimeTurn,
        _: modular_agent::InterruptedTurn,
        _: modular_agent::RuntimeContext,
    ) -> Result<modular_agent::RuntimeOutcome> {
        unreachable!()
    }
    async fn continue_open_calls(
        &self,
        _: modular_agent::RuntimeTurn,
        _: Vec<modular_agent::RuntimeCall>,
        _: modular_agent::RuntimeContext,
    ) -> Result<modular_agent::RuntimeOutcome> {
        unreachable!()
    }
}

#[tokio::test]
async fn local_step_hook_narrows_provider_tool_allowance_without_putting_it_on_the_wire()
-> Result<()> {
    for bridge in [false, true] {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let builder = modular_agent::Agent::builder()
            .provider(LocalToolsProvider(seen.clone()))
            .plugin(
                Plugin::new("step-allowance").on_step_before_change(|step| async move {
                    let mut tools = step.provider_tools.unwrap();
                    assert_eq!(tools.len(), 2);
                    tools.remove(0);
                    Ok(StepChange {
                        provider_tools: Some(tools),
                        ..StepChange::default()
                    })
                }),
            );
        let builder = if bridge {
            builder.plugin(
                Plugin::new("runtime-test")
                    .replaces("runtime")
                    .setup(|r| r.runtime(OneStep)),
            )
        } else {
            builder
        };
        let agent = builder.build().await?;
        let session = agent.session().await?;
        assert_eq!(session.prompt("test allowance").await?.text, "answer");
        assert_eq!(*seen.lock().unwrap(), ["two"]);
        agent.close().await?;
    }
    Ok(())
}
