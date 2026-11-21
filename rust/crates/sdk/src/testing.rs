//! The testing kit (docs/sdk/testing.md#the-testing-kit): a scripted model and an agent
//! built around it. No network and no credentials.
use crate::{
    AssistantMessage, ModelError, ModelErrorKind, ModelInfo, ModelRef, ModelRequest, Piece,
    Provider, ProviderContext, ProviderSupport,
    agent::{Agent, AgentBuilder, Approval, Durability},
    error::Result,
    events::Question,
    tool::{Answer, Tool},
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    future::Future,
    path::PathBuf,
    sync::{Arc, Mutex},
};

mod environment;
pub use environment::{ExecOutput, MemoryEnvironment, memory_environment, memory_environment_with};

/// Add the offline fixtures required by the ACP kit.
pub fn acp_conformance(mut builder: crate::AgentBuilder) -> crate::AgentBuilder {
    builder.acp_conformance = true;
    builder.approval(crate::Approval::Off)
}

/// The scripted model's id.
pub const SCRIPTED_MODEL: &str = "scripted/script";

/// A Provider that answers from a script (docs/sdk/testing.md#the-model-script).
///
/// For each request it counts the assistant messages already in the request and answers
/// with the response at that index, so a request repeated after a crash gets the same
/// answer and a turn that carries on after a restart picks up where it left off.
pub fn scripted_provider(script: Value) -> impl Provider {
    Scripted(match script {
        Value::Array(items) => items,
        other => vec![other],
    })
}

struct Scripted(Vec<Value>);

#[async_trait::async_trait]
impl Provider for Scripted {
    fn id(&self) -> &str {
        "scripted"
    }
    fn models(&self) -> Vec<ModelInfo> {
        vec![ModelInfo {
            model: ModelRef {
                provider: "scripted".into(),
                id: "script".into(),
            },
            context_window: 128_000,
            max_output: 4096,
            thinking: vec![],
            extra: Default::default(),
        }]
    }
    fn supports(&self) -> ProviderSupport {
        ProviderSupport {
            safe_to_repeat: true,
            keeps_state: false,
        }
    }
    async fn request(
        &self,
        _: ModelRef,
        request: ModelRequest,
        cx: ProviderContext,
    ) -> Result<AssistantMessage> {
        let index = request.0["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|m| m["role"] == "assistant")
            .count();
        let Some(step) = self.0.get(index) else {
            return Ok(ModelError::new(ModelErrorKind::Other, "script exhausted").failed());
        };
        if let Some(error) = step.get("error") {
            let kind =
                serde_json::from_value(error["kind"].clone()).unwrap_or(ModelErrorKind::Other);
            return Ok(ModelError::new(
                kind,
                error["message"].as_str().unwrap_or("scripted failure"),
            )
            .failed());
        }
        let mut parts = vec![];
        if let Some(text) = step["reasoning"].as_str() {
            cx.piece(Piece::Reasoning, text, None).await?;
            parts.push(json!({"type":"reasoning","data":{"text":text}}));
        }
        if let Some(text) = step["text"].as_str() {
            cx.piece(Piece::Text, text, None).await?;
            parts.push(json!({"type":"text","text":text}));
        }
        let mut calls = false;
        for (i, call) in step["toolCalls"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
        {
            parts.push(
                json!({"type":"toolCall","name":call["name"],"id":format!("call-{index}-{i}"),
                "arguments":call["input"]}),
            );
            calls = true;
        }
        Ok(AssistantMessage(
            json!({"role":"assistant","content":parts,"stop":if calls {"toolUse"} else {"finished"},
            "usage":step["usage"]}),
        ))
    }
}

/// A shared answer queue and its verification handle. Pass a clone to the handler
/// and call `assert_done` on the original after the agent has finished asking.
#[derive(Clone)]
pub struct Answers(Arc<Mutex<AnswerQueue>>);

struct AnswerQueue {
    pending: VecDeque<Answer>,
    unexpected: Vec<Question>,
}

pub fn answers(list: impl IntoIterator<Item = Answer>) -> Answers {
    Answers(Arc::new(Mutex::new(AnswerQueue {
        pending: list.into_iter().collect(),
        unexpected: Vec::new(),
    })))
}

impl Answers {
    pub fn answer(&self, question: Question) -> Answer {
        let mut queue = self.0.lock().unwrap();
        queue.pending.pop_front().unwrap_or_else(|| {
            queue.unexpected.push(question);
            Answer::Declined {
                reason: Some("the test expected no more questions".into()),
            }
        })
    }

    pub fn assert_done(&self) -> Result<()> {
        let queue = self.0.lock().unwrap();
        if queue.pending.is_empty() && queue.unexpected.is_empty() {
            return Ok(());
        }
        Err(crate::Error::msg(format!(
            "{} unused answers; unexpected questions: {:?}",
            queue.pending.len(),
            queue.unexpected,
        )))
    }
}

/// An agent for tests: the scripted Provider and its model, ephemeral durability and a
/// scratch project folder, unless told otherwise.
pub fn test_agent() -> TestAgentBuilder {
    TestAgentBuilder {
        builder: Agent::builder(),
        script: Value::Array(vec![]),
        model: None,
        project: None,
        environment: memory_environment(),
    }
}

#[must_use]
pub struct TestAgentBuilder {
    builder: AgentBuilder,
    script: Value,
    model: Option<String>,
    project: Option<PathBuf>,
    environment: MemoryEnvironment,
}

impl TestAgentBuilder {
    pub fn model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }
    pub fn script(mut self, script: Value) -> Self {
        self.script = script;
        self
    }
    pub fn tool(mut self, tool: Tool) -> Self {
        self.builder = self.builder.tool(tool);
        self
    }
    pub fn project(mut self, project: impl Into<PathBuf>) -> Self {
        self.project = Some(project.into());
        self
    }
    pub fn data_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.builder = self.builder.data_dir(dir);
        self
    }
    pub fn history(mut self, history: crate::History) -> Self {
        self.builder = self.builder.history(history);
        self
    }
    pub fn durability(mut self, durability: Durability) -> Self {
        self.builder = self.builder.durability(durability);
        self
    }
    pub fn several_actors(mut self, enabled: bool) -> Self {
        self.builder = self.builder.several_actors(enabled);
        self
    }
    pub fn session_limits(mut self, enabled: bool) -> Self {
        self.builder = self.builder.session_limits(enabled);
        self
    }
    pub fn tenants(mut self, tenants: Value) -> Self {
        self.builder = self.builder.tenants(tenants);
        self
    }
    pub fn setting(mut self, key: impl Into<String>, value: Value) -> Self {
        self.builder = self.builder.setting(key, value);
        self
    }
    pub fn approval(mut self, policy: Approval) -> Self {
        self.builder = self.builder.approval(policy);
        self
    }
    pub fn on_question<F, Fut, Reply>(mut self, handler: F) -> Self
    where
        F: Fn(Question) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Reply> + Send + 'static,
        Reply: crate::QuestionReply,
    {
        self.builder = self.builder.on_question(handler);
        self
    }
    /// Use a shared answer queue. Keep a clone to verify it with `Answers::assert_done`.
    pub fn answers(self, queue: Answers) -> Self {
        self.on_question(move |question| std::future::ready(queue.answer(question)))
    }
    pub fn credentials(mut self, store: impl crate::CredentialStore) -> Self {
        self.builder = self.builder.credentials(store);
        self
    }
    pub fn plugin(mut self, plugin: crate::Plugin) -> Self {
        self.builder = self.builder.plugin(plugin);
        self
    }
    pub fn plugin_host(mut self, host: bool) -> Self {
        self.builder = self.builder.plugin_host(host);
        self
    }
    pub fn environment(mut self, environment: MemoryEnvironment) -> Self {
        self.environment = environment;
        self
    }
    pub fn over_wire(mut self, plugin: crate::Plugin) -> Self {
        self.builder = self.builder.wire_plugin(plugin);
        self
    }
    pub fn process_plugin(mut self, plugin: crate::ProcessPlugin) -> Self {
        self.builder = self.builder.process_plugin(plugin);
        self
    }
    pub fn service_plugin(mut self, plugin: crate::ServicePlugin) -> Self {
        self.builder = self.builder.service_plugin(plugin);
        self
    }
    pub async fn build(mut self) -> Result<Agent> {
        self.builder.restartable = true;
        let (project, keep) = match self.project {
            Some(p) => (p, None),
            None => {
                let dir = tempfile::Builder::new()
                    .prefix("modular-agent-project-")
                    .tempdir()?;
                (dir.path().to_path_buf(), Some(dir))
            }
        };
        let agent = self
            .builder
            .environment(self.environment)
            .provider(scripted_provider(self.script))
            .model(self.model.as_deref().unwrap_or(SCRIPTED_MODEL))
            .project(project)
            .build()
            .await?;
        if let Some(dir) = keep {
            agent.keep(dir);
        }
        Ok(agent)
    }
}

/// Simulate a crash without cancelling or settling the interrupted turn. Rebuild a
/// test agent over its original store; reopen sessions explicitly on the returned agent.
/// This cannot stop work a plugin detached from its call or kill external processes.
pub async fn restart(agent: Agent) -> Result<Agent> {
    let recipe = agent.inner.restart.clone().ok_or_else(|| {
        crate::Error::new(
            crate::Code::NotSupported,
            "restart requires an in-process test agent",
        )
    })?;
    agent.inner.crash.cancel();
    agent.inner.workers.close();
    agent.inner.workers.wait().await;
    agent.inner.harness.abandon_sessions_for_test();
    let kept = std::mem::take(&mut *agent.inner.kept.lock().unwrap());
    let next = recipe.build().await?;
    for dir in kept {
        next.keep(dir);
    }
    Ok(next)
}

/// The fixture plugins every SDK implements identically (docs/sdk/testing.md#the-fixture-plugins).
/// Each is an ordinary plugin, so the same code runs in process and served.
pub mod fixtures {
    use super::*;
    use crate::{
        Gate, Plugin,
        error::Error,
        tool::{Ask, ToolContext},
    };
    use schemars::JsonSchema;
    use serde::Deserialize;
    use std::path::Path;

    /// The fixture of that name. `counter` reads its count file from its config `path`.
    pub fn fixture(name: &str) -> Option<Plugin> {
        Some(match name {
            "tide" => Plugin::new("tide").tool(tide()),
            "quay" => Plugin::new("quay").tool(Tool::new("moor", "Moor at a harbour.").run(
                |_: TideInput, cx: ToolContext| async move {
                    Err::<String, _>(cx.refuse("the quay is closed"))
                },
            )),
            "pilot" => {
                Plugin::new("pilot").tool(Tool::new("pilot", "Ask the pilot about a harbour.").run(
                    |input: TideInput, cx: ToolContext| async move {
                        let result = cx
                            .tools()
                            .call("tide", json!({"harbour":input.harbour}))
                            .await?;
                        Ok(format!("Pilot: {}", result.text()))
                    },
                ))
            }
            "confirm" => Plugin::new("confirm").tool(confirm()),
            "note" => Plugin::new("note").tool(note()),
            "gate" => Plugin::new("gate").on_tool_before(|before| async move {
                Ok(if before.input.to_string().contains("forbidden") {
                    Gate::Refuse("the gate refused it".into())
                } else {
                    Gate::Allow
                })
            }),
            "counter" => Plugin::new("counter").setup(|r| {
                let path = r.config()["path"].as_str().ok_or_else(|| {
                    Error::new(crate::Code::InvalidParams, "counter needs a config path")
                })?;
                r.tool(counter(PathBuf::from(path)));
                Ok(())
            }),
            _ => return None,
        })
    }

    /// The `counter` fixture's count: zero if its file is missing.
    pub fn count(path: &Path) -> u64 {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0)
    }

    #[derive(Deserialize, JsonSchema)]
    struct TideInput {
        /// The harbour to look up.
        harbour: String,
    }

    pub fn tide() -> Tool {
        Tool::new("tide", "Today's high tide at a harbour.")
            .read_only()
            .run(|input: TideInput, _: ToolContext| async move {
                Ok(format!("High tide at {} is 14:02.", input.harbour))
            })
    }

    #[derive(Deserialize, JsonSchema)]
    struct CounterInput {
        /// Wait after counting until cancelled, so a crash lands after the effect.
        #[serde(default)]
        hold: bool,
        #[serde(default)]
        #[allow(dead_code)]
        note: Option<String>,
    }

    pub fn counter(path: PathBuf) -> Tool {
        Tool::new("bump", "Add one to a count kept in a file.").run(
            move |input: CounterInput, cx: ToolContext| {
                let path = path.clone();
                async move {
                    let next = count(&path) + 1;
                    let tmp = path.with_extension("tmp");
                    std::fs::write(&tmp, next.to_string())?;
                    std::fs::rename(&tmp, &path)?;
                    if input.hold {
                        cx.cancelled().cancelled().await;
                        return Err(Error::msg("cancelled while holding"));
                    }
                    Ok(next.to_string())
                }
            },
        )
    }

    #[derive(Deserialize, JsonSchema)]
    struct ConfirmInput {
        question: String,
    }

    pub fn note() -> Tool {
        Tool::new("note", "Ask for a note.").run(
            |input: ConfirmInput, cx: ToolContext| async move {
                Ok(match cx.ask(Ask::text(input.question)).await? {
                    Answer::Value(value) => format!("value: {value}"),
                    _ => "declined".into(),
                })
            },
        )
    }

    pub fn confirm() -> Tool {
        Tool::new("confirm", "Ask whether to go ahead.").run(
            |input: ConfirmInput, cx: ToolContext| async move {
                Ok(
                    match cx.ask(Ask::choice(input.question, &["yes", "no"])).await? {
                        Answer::Value(v) => v,
                        Answer::Allow => "allow".into(),
                        Answer::Secret(_) => unreachable!("a choice has no secret value"),
                        Answer::Declined { .. } => "declined".into(),
                    },
                )
            },
        )
    }
}
