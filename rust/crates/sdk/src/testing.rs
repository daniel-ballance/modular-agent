//! The testing kit (docs/sdk/testing.md#the-testing-kit): a scripted model and an agent
//! built around it. No network and no credentials.
use crate::{
    agent::{Agent, AgentBuilder, Approval, Durability, Provider},
    error::Result,
    events::Question,
    tool::{Answer, Tool},
};
use agent_api as base;
use serde_json::{Value, json};
use std::{future::Future, path::PathBuf, sync::Arc};

/// The scripted model's id.
pub const SCRIPTED_MODEL: &str = "scripted/script";

/// A Provider that answers from a script (docs/sdk/testing.md#the-model-script).
///
/// For each request it counts the assistant messages already in the request and answers
/// with the response at that index, so a request repeated after a crash gets the same
/// answer and a turn that carries on after a restart picks up where it left off.
pub fn scripted_provider(script: Value) -> Provider {
    let script = match script {
        Value::Array(items) => items,
        other => vec![other],
    };
    Provider::from_base(Arc::new(Scripted(Arc::new(script))))
}

struct Scripted(Arc<Vec<Value>>);

fn info() -> base::ModelInfo {
    base::ModelInfo {
        name: SCRIPTED_MODEL.into(),
        context_window: 128_000,
        output_limit: 4096,
        thinking: vec![],
        keeps_state: false,
        runs_tools: false,
        extra: Value::Null,
    }
}

impl base::Plugin for Scripted {
    fn name(&self) -> &str {
        "provider.scripted"
    }
    fn install(&self, r: &mut base::Registrar<'_>) -> base::Result<()> {
        r.provide::<dyn base::Provider>(
            "provider.scripted",
            Arc::new(ScriptedProvider(self.0.clone())),
        )
    }
}

struct ScriptedProvider(Arc<Vec<Value>>);

impl base::Provider for ScriptedProvider {
    fn catalog(&self) -> Vec<base::ModelInfo> {
        vec![info()]
    }
    fn bind(&self, model: &str) -> base::Result<Arc<dyn base::ModelAccess>> {
        base::ensure!(model == SCRIPTED_MODEL, "unknown scripted model {model}");
        Ok(Arc::new(ScriptedProvider(self.0.clone())))
    }
}

#[async_trait::async_trait]
impl base::ModelAccess for ScriptedProvider {
    fn safe_to_repeat(&self) -> bool {
        true
    }
    fn info(&self) -> base::ModelInfo {
        info()
    }
    async fn generate(
        &self,
        api: base::Api,
        scope: base::Scope,
        request: base::ModelRequest,
        _cancel: base::CancellationToken,
    ) -> std::result::Result<base::ModelResponse, base::ModelFailure> {
        let index = request
            .messages
            .iter()
            .filter(|m| m.role == "assistant")
            .count();
        let fail = |message: String| base::ModelFailure {
            kind: base::FailureKind::Other,
            message,
        };
        let Some(step) = self.0.get(index) else {
            return Err(fail("script exhausted".into()));
        };
        if let Some(error) = step.get("error") {
            let kind = match error["kind"].as_str() {
                Some("temporary") => base::FailureKind::Temporary,
                Some("contextTooLarge") => base::FailureKind::ContextTooLarge,
                Some("credentials") => base::FailureKind::Credentials,
                Some("refused") => base::FailureKind::Refused,
                _ => base::FailureKind::Other,
            };
            return Err(base::ModelFailure {
                kind,
                message: error["message"]
                    .as_str()
                    .unwrap_or("scripted failure")
                    .into(),
            });
        }
        let mut parts = vec![];
        if let Some(text) = step["reasoning"].as_str() {
            parts.push(base::Part::Reasoning {
                data: json!({"text": text}),
            });
        }
        if let Some(text) = step["text"].as_str() {
            let event = base::Event::new(&scope, "model.delta", json!(text));
            api.emit(event).await.map_err(|e| fail(e.to_string()))?;
            parts.push(base::Part::Text { text: text.into() });
        }
        let mut calls = false;
        for (i, call) in step["toolCalls"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
        {
            let mut tool = base::ToolCall::new(
                call["name"].as_str().unwrap_or_default(),
                call["input"].clone(),
            );
            tool.id = format!("call-{index}-{i}");
            parts.push(base::Part::ToolCall { call: tool });
            calls = true;
        }
        Ok(base::ModelResponse {
            parts,
            stop: if calls { "tools" } else { "finished" }.into(),
            usage: serde_json::from_value(json!({
                "input_tokens": step["usage"]["input"].as_u64().unwrap_or(0),
                "output_tokens": step["usage"]["output"].as_u64().unwrap_or(0),
                "cached_tokens": step["usage"]["cacheRead"].as_u64().unwrap_or(0),
            }))
            .unwrap_or_default(),
            ..Default::default()
        })
    }
}

/// An agent for tests: the scripted Provider and its model, ephemeral durability and a
/// scratch project folder, unless told otherwise.
pub fn test_agent() -> TestAgentBuilder {
    TestAgentBuilder {
        builder: Agent::builder(),
        script: Value::Array(vec![]),
        project: None,
    }
}

#[must_use]
pub struct TestAgentBuilder {
    builder: AgentBuilder,
    script: Value,
    project: Option<PathBuf>,
}

impl TestAgentBuilder {
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
    pub fn durability(mut self, durability: Durability) -> Self {
        self.builder = self.builder.durability(durability);
        self
    }
    pub fn approval(mut self, policy: Approval) -> Self {
        self.builder = self.builder.approval(policy);
        self
    }
    pub fn on_question<F, Fut>(mut self, handler: F) -> Self
    where
        F: Fn(Question) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Answer> + Send + 'static,
    {
        self.builder = self.builder.on_question(handler);
        self
    }
    /// A question handler that answers in order from a list, and declines anything more.
    pub fn answers(self, answers: Vec<Answer>) -> Self {
        let queue = Arc::new(std::sync::Mutex::new(std::collections::VecDeque::from(
            answers,
        )));
        self.on_question(move |_| {
            let next = queue.lock().unwrap().pop_front();
            async move {
                next.unwrap_or(Answer::Declined {
                    reason: Some("the test expected no more questions".into()),
                })
            }
        })
    }
    pub fn plugin(mut self, plugin: crate::Plugin) -> Self {
        self.builder = self.builder.plugin(plugin);
        self
    }
    pub fn plugin_host(mut self, host: bool) -> Self {
        self.builder = self.builder.plugin_host(host);
        self
    }
    pub fn process_plugin(mut self, plugin: crate::ProcessPlugin) -> Self {
        self.builder = self.builder.process_plugin(plugin);
        self
    }
    pub async fn build(self) -> Result<Agent> {
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
            .provider(scripted_provider(self.script))
            .model(SCRIPTED_MODEL)
            .project(project)
            .build()
            .await?;
        if let Some(dir) = keep {
            agent.keep(dir);
        }
        Ok(agent)
    }
}

/// The fixture plugins every SDK implements identically (docs/sdk/testing.md#the-fixture-plugins).
/// Each is an ordinary plugin, so the same code runs in process and served.
pub mod fixtures {
    use super::*;
    use crate::{
        error::Error,
        plugin::{Gate, Plugin},
        tool::{Ask, ToolContext},
    };
    use schemars::JsonSchema;
    use serde::Deserialize;
    use std::path::Path;

    /// The fixture of that name. `counter` reads its count file from its config `path`.
    pub fn fixture(name: &str) -> Option<Plugin> {
        Some(match name {
            "tide" => Plugin::new("tide").tool(tide()),
            "confirm" => Plugin::new("confirm").tool(confirm()),
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

    pub fn confirm() -> Tool {
        Tool::new("confirm", "Ask whether to go ahead.").run(
            |input: ConfirmInput, cx: ToolContext| async move {
                Ok(
                    match cx.ask(Ask::choice(input.question, &["yes", "no"])).await? {
                        Answer::Value(v) => v,
                        Answer::Allow => "allow".into(),
                        Answer::Declined { .. } => "declined".into(),
                    },
                )
            },
        )
    }
}
