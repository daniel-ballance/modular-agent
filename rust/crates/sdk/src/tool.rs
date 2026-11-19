//! Tools: a name, a description, a typed input and a function (docs/sdk/api.md#tools).
use crate::error::{Code, Error, Result};
use agent_api as base;
use futures_util::future::BoxFuture;
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::{future::Future, sync::Arc};
use tokio_util::sync::CancellationToken;

type RunFn =
    Arc<dyn Fn(Value, ToolContext) -> BoxFuture<'static, Result<ToolOutput>> + Send + Sync>;

/// A tool the model or a plugin can call.
#[derive(Clone)]
pub struct Tool {
    pub(crate) definition: base::ToolDefinition,
    run: RunFn,
}

/// The definition of a tool, before its function is given.
pub struct ToolBuilder {
    name: String,
    description: String,
    read_only: bool,
    destructive: bool,
    open_world: bool,
    safe_to_repeat: bool,
    parallel: bool,
}

impl Tool {
    /// Start a tool with its name and description. Hints take the shared defaults:
    /// not read-only, destructive, open-world, not safe to repeat, not parallel.
    #[allow(clippy::new_ret_no_self)]
    pub fn new(name: impl Into<String>, description: impl Into<String>) -> ToolBuilder {
        ToolBuilder {
            name: name.into(),
            description: description.into(),
            read_only: false,
            destructive: true,
            open_world: true,
            safe_to_repeat: false,
            parallel: false,
        }
    }
    pub fn name(&self) -> &str {
        &self.definition.name
    }
    /// The definition as shared data has it: `parameters`, `hints`, `parallel`.
    pub fn definition(&self) -> Value {
        base::wire::definition(&self.definition)
    }
}

impl ToolBuilder {
    /// The tool changes nothing. Sets only `readOnly`; every other hint stays as set.
    pub fn read_only(mut self) -> Self {
        self.read_only = true;
        self
    }
    pub fn destructive(mut self, destructive: bool) -> Self {
        self.destructive = destructive;
        self
    }
    pub fn open_world(mut self, open_world: bool) -> Self {
        self.open_world = open_world;
        self
    }
    /// An explicit promise that running the call again has no further effect.
    pub fn safe_to_repeat(mut self) -> Self {
        self.safe_to_repeat = true;
        self
    }
    pub fn parallel(mut self) -> Self {
        self.parallel = true;
        self
    }
    /// Give the function. `I` is the input: its JSON Schema is the tool's `parameters`.
    pub fn run<I, O, F, Fut>(self, f: F) -> Tool
    where
        I: DeserializeOwned + JsonSchema + Send + 'static,
        O: Into<ToolOutput>,
        F: Fn(I, ToolContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<O>> + Send + 'static,
    {
        let mut schema = serde_json::to_value(schemars::schema_for!(I)).expect("schema is JSON");
        if let Some(object) = schema.as_object_mut() {
            object.remove("$schema");
            object.remove("title");
        }
        let definition = base::ToolDefinition {
            name: self.name,
            description: self.description,
            input: schema,
            read_only: self.read_only,
            safe_to_repeat: self.safe_to_repeat,
            parallel: self.parallel,
            hints: json!({"_wire": {"hints": {
                "readOnly": self.read_only,
                "destructive": self.destructive,
                "openWorld": self.open_world,
                "safeToRepeat": self.safe_to_repeat,
            }}}),
        };
        let f = Arc::new(f);
        Tool {
            definition,
            run: Arc::new(move |input, cx| {
                let f = f.clone();
                Box::pin(async move {
                    let input: I = serde_json::from_value(input).map_err(|e| {
                        Error::new(
                            Code::InvalidParams,
                            format!("the input does not match the tool's schema: {e}"),
                        )
                    })?;
                    f(input, cx).await.map(Into::into)
                })
            }),
        }
    }
}

/// What a tool returns, when plain text is not enough.
#[derive(Clone, Debug)]
pub struct ToolOutput {
    pub status: ToolStatus,
    pub text: String,
    pub value: Option<Value>,
}

impl From<String> for ToolOutput {
    fn from(text: String) -> Self {
        ToolOutput {
            status: ToolStatus::Completed,
            text,
            value: None,
        }
    }
}
impl From<&str> for ToolOutput {
    fn from(text: &str) -> Self {
        text.to_string().into()
    }
}

/// How a call ended (docs/bindings/data.md#tools).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolStatus {
    Completed,
    Failed,
    Refused,
    Cancelled,
    NotStarted,
    OutcomeUnknown,
}

impl ToolStatus {
    pub(crate) fn from_base(status: &base::ToolStatus) -> Self {
        match status {
            base::ToolStatus::Completed => ToolStatus::Completed,
            base::ToolStatus::Failed => ToolStatus::Failed,
            base::ToolStatus::Refused => ToolStatus::Refused,
            base::ToolStatus::Cancelled => ToolStatus::Cancelled,
            base::ToolStatus::NotStarted => ToolStatus::NotStarted,
            base::ToolStatus::Unknown | base::ToolStatus::Waiting => ToolStatus::OutcomeUnknown,
        }
    }
    fn to_base(self) -> base::ToolStatus {
        match self {
            ToolStatus::Completed => base::ToolStatus::Completed,
            ToolStatus::Failed => base::ToolStatus::Failed,
            ToolStatus::Refused => base::ToolStatus::Refused,
            ToolStatus::Cancelled => base::ToolStatus::Cancelled,
            ToolStatus::NotStarted => base::ToolStatus::NotStarted,
            ToolStatus::OutcomeUnknown => base::ToolStatus::Unknown,
        }
    }
    /// The shared name, such as `outcomeUnknown`.
    pub fn as_str(self) -> &'static str {
        match self {
            ToolStatus::Completed => "completed",
            ToolStatus::Failed => "failed",
            ToolStatus::Refused => "refused",
            ToolStatus::Cancelled => "cancelled",
            ToolStatus::NotStarted => "notStarted",
            ToolStatus::OutcomeUnknown => "outcomeUnknown",
        }
    }
}

/// What a running call can ask of the agent (docs/sdk/api.md#contexts).
#[derive(Clone)]
pub struct ToolContext {
    api: base::Api,
    scope: base::Scope,
    call: base::ToolCall,
    cancelled: CancellationToken,
}

/// A question a tool asks.
#[derive(Clone, Debug)]
pub struct Ask {
    kind: base::RequestKind,
    text: String,
    options: Vec<String>,
}

impl Ask {
    pub fn choice(question: impl Into<String>, options: &[&str]) -> Self {
        Ask {
            kind: base::RequestKind::Choice,
            text: question.into(),
            options: options.iter().map(|o| o.to_string()).collect(),
        }
    }
    pub fn text(question: impl Into<String>) -> Self {
        Ask {
            kind: base::RequestKind::Text,
            text: question.into(),
            options: vec![],
        }
    }
}

/// The answer to a tool's question.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answer {
    Allow,
    Value(String),
    Declined { reason: Option<String> },
}

impl ToolContext {
    pub fn session_id(&self) -> &str {
        &self.scope.session
    }
    pub fn actor_id(&self) -> &str {
        &self.scope.actor
    }
    pub fn call_id(&self) -> &str {
        &self.call.id
    }
    /// Fires when the call is cancelled.
    pub fn cancelled(&self) -> &CancellationToken {
        &self.cancelled
    }
    /// End the call as `refused`: `return Err(cx.refuse("reason"))`.
    pub fn refuse(&self, reason: impl Into<String>) -> Error {
        Error::refusal(reason)
    }
    /// Ask an actor and wait for the answer.
    pub async fn ask(&self, ask: Ask) -> Result<Answer> {
        let mut question = base::Question::new(self.scope.clone(), ask.kind, &ask.text);
        question.options = ask.options;
        let requests = base::requests(self.api.as_ref())?;
        match requests
            .ask(self.api.clone(), question, self.cancelled.clone())
            .await?
        {
            base::RequestReply::Answer(a) if a.declined => Ok(Answer::Declined { reason: None }),
            base::RequestReply::Answer(a) => Ok(match a.value {
                Value::String(s) if s == "allow" => Answer::Allow,
                Value::String(s) => Answer::Value(s),
                other => Answer::Value(other.to_string()),
            }),
            base::RequestReply::Declined => Ok(Answer::Declined { reason: None }),
            base::RequestReply::Waiting => Err(Error::new(
                Code::NotSupported,
                "leaving a call open past its turn is not supported yet",
            )),
        }
    }
}

/// The tools given to an agent, as one of the base's tool sources.
pub(crate) struct ToolsPlugin {
    pub name: String,
    pub tools: Vec<Tool>,
}

impl base::Plugin for ToolsPlugin {
    fn name(&self) -> &str {
        &self.name
    }
    fn install(&self, r: &mut base::Registrar<'_>) -> base::Result<()> {
        r.provide::<dyn base::ToolSource>(
            &format!("tools.{}", self.name),
            Arc::new(Source(self.tools.clone())),
        )
    }
}

struct Source(Vec<Tool>);

#[async_trait::async_trait]
impl base::ToolSource for Source {
    fn tools(&self, _: &base::SessionData) -> Vec<base::ToolDefinition> {
        self.0.iter().map(|t| t.definition.clone()).collect()
    }
    async fn run(
        &self,
        api: base::Api,
        scope: base::Scope,
        call: base::ToolCall,
        cancel: CancellationToken,
    ) -> base::ToolResult {
        let Some(tool) = self.0.iter().find(|t| t.definition.name == call.name) else {
            return base::ToolResult::new(
                &call,
                base::ToolStatus::Failed,
                format!("no tool named {}", call.name),
            );
        };
        let cx = ToolContext {
            api,
            scope,
            call: call.clone(),
            cancelled: cancel.clone(),
        };
        let run = (tool.run)(call.input.clone(), cx);
        let outcome = tokio::select! {
            biased;
            outcome = run => outcome,
            _ = cancel.cancelled() => {
                return base::ToolResult::new(&call, base::ToolStatus::Cancelled, "The call was cancelled.");
            }
        };
        match outcome {
            Ok(output) => {
                let mut result = base::ToolResult::new(&call, output.status.to_base(), output.text);
                result.value = output.value;
                result
            }
            Err(e) if e.refusal => {
                base::ToolResult::new(&call, base::ToolStatus::Refused, e.message())
            }
            Err(e) => base::ToolResult::new(&call, base::ToolStatus::Failed, e.message()),
        }
    }
}
