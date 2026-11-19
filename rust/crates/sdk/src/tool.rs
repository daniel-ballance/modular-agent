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
    pub(crate) run: RunFn,
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
    pub(crate) fn to_base(self) -> base::ToolStatus {
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
    pub(crate) backend: Backend,
    pub(crate) session_id: String,
    pub(crate) actor_id: String,
    pub(crate) call_id: String,
    pub(crate) cancelled: CancellationToken,
}

/// Where the agent is: in this process, or across the plugin binding.
#[derive(Clone)]
pub(crate) enum Backend {
    Local {
        api: base::Api,
        scope: base::Scope,
    },
    Remote {
        peer: Arc<plugin_stdio::rpc::Peer>,
        parent: Value,
    },
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
        &self.session_id
    }
    pub fn actor_id(&self) -> &str {
        &self.actor_id
    }
    pub fn call_id(&self) -> &str {
        &self.call_id
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
        match &self.backend {
            Backend::Local { api, scope } => {
                let mut question = base::Question::new(scope.clone(), ask.kind, &ask.text);
                question.options = ask.options;
                let requests = base::requests(api.as_ref())?;
                match requests
                    .ask(api.clone(), question, self.cancelled.clone())
                    .await?
                {
                    base::RequestReply::Answer(a) if a.declined => {
                        Ok(Answer::Declined { reason: None })
                    }
                    base::RequestReply::Answer(a) => Ok(match a.value {
                        Value::String(s) if s == "allow" => Answer::Allow,
                        Value::String(s) => Answer::Value(s),
                        other => Answer::Value(other.to_string()),
                    }),
                    base::RequestReply::Declined => Ok(Answer::Declined { reason: None }),
                    base::RequestReply::Waiting => Err(not_open()),
                }
            }
            Backend::Remote { peer, parent } => {
                let kind = match ask.kind {
                    base::RequestKind::Approval => "approval",
                    base::RequestKind::Choice => "choice",
                    base::RequestKind::Text => "text",
                    base::RequestKind::Secret => "secret",
                };
                let mut request = json!({"kind": kind, "question": ask.text});
                if !ask.options.is_empty() {
                    request["options"] = json!(ask.options);
                }
                let answer = peer
                    .call(
                        "host/ask",
                        json!({"parentRequestId": parent, "request": request}),
                        None,
                        self.cancelled.clone(),
                    )
                    .await
                    .map_err(crate::serve::from_fault)?;
                if answer["pending"] == true {
                    return Err(not_open());
                }
                if answer["declined"] == true {
                    return Ok(Answer::Declined {
                        reason: answer["reason"].as_str().map(str::to_string),
                    });
                }
                Ok(match answer["value"].as_str() {
                    Some("allow") if kind == "approval" => Answer::Allow,
                    Some(v) => Answer::Value(v.to_string()),
                    None => {
                        Answer::Value(answer["stored"].as_str().unwrap_or_default().to_string())
                    }
                })
            }
        }
    }
}

fn not_open() -> Error {
    Error::new(
        Code::NotSupported,
        "leaving a call open past its turn is not supported yet",
    )
}

/// How a call ended, before the agent adds the call's id. A refusal's text is the bare
/// reason; each side words it once.
pub(crate) struct Settled {
    pub status: ToolStatus,
    pub text: String,
    pub value: Option<Value>,
}

/// Run a tool's function with a context, wherever the agent is.
pub(crate) async fn execute(tool: &Tool, input: Value, cx: ToolContext) -> Settled {
    let cancel = cx.cancelled.clone();
    let run = (tool.run)(input, cx);
    let outcome = tokio::select! {
        biased;
        outcome = run => outcome,
        _ = cancel.cancelled() => {
            return Settled { status: ToolStatus::Cancelled, text: "The call was cancelled.".into(), value: None };
        }
    };
    match outcome {
        Ok(output) => Settled {
            status: output.status,
            text: output.text,
            value: output.value,
        },
        Err(e) if e.refusal => Settled {
            status: ToolStatus::Refused,
            text: e.message().to_string(),
            value: None,
        },
        Err(e) => Settled {
            status: ToolStatus::Failed,
            text: e.message().to_string(),
            value: None,
        },
    }
}
