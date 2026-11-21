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
    pub(crate) in_process_only: bool,
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
    in_process_only: bool,
    input: Option<Value>,
    output: Option<Value>,
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
            in_process_only: false,
            input: None,
            output: None,
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
    /// Mark a tool that uses a context operation unavailable over the plugin binding.
    pub fn in_process_only(mut self) -> Self {
        self.in_process_only = true;
        self
    }
    /// Override the generated input schema. The checked input is still deserialized as `I`.
    pub fn input_schema(mut self, schema: Value) -> Self {
        self.input = Some(schema);
        self
    }
    /// Declare a completed result's value using a Rust type.
    pub fn output<T: JsonSchema>(self) -> Self {
        self.output_schema(type_schema::<T>())
    }
    /// Declare a completed result's value using Draft 2020-12 JSON Schema.
    pub fn output_schema(mut self, schema: Value) -> Self {
        self.output = Some(schema);
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
        let schema = self.input.unwrap_or_else(type_schema::<I>);
        let validator = Arc::new(base::schema::compile(&schema).map_err(|e| e.to_string()));
        let mut definition = base::ToolDefinition {
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
        let mut wire = base::wire::definition(&definition);
        if let Some(output) = self.output {
            wire["returns"] = output;
        }
        definition.hints["_wire"] = wire;
        let f = Arc::new(f);
        Tool {
            definition,
            in_process_only: self.in_process_only,
            run: Arc::new(move |input, cx| {
                let f = f.clone();
                let validator = validator.clone();
                Box::pin(async move {
                    let invalid = |message: &str| {
                        Error::new(
                            Code::InvalidParams,
                            format!("the input does not match the tool's schema: {message}"),
                        )
                    };
                    if !input.is_object() {
                        return Err(invalid("expected a JSON object"));
                    }
                    validator
                        .as_ref()
                        .as_ref()
                        .map_err(|e| invalid(e))?
                        .validate(&input)
                        .map_err(|e| invalid(&format!("at {}: {e}", e.instance_path())))?;
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

fn type_schema<T: JsonSchema>() -> Value {
    let mut schema = serde_json::to_value(schemars::schema_for!(T)).expect("schema is JSON");
    if let Some(object) = schema.as_object_mut() {
        object.remove("$schema");
        object.remove("title");
    }
    schema
}

/// What a tool returns, when plain text is not enough.
#[derive(Clone, Debug)]
pub struct ToolOutput {
    pub status: ToolStatus,
    pub text: String,
    pub value: Option<Value>,
    /// Shared Content parts, if the result is not just text.
    pub content: Option<Vec<Value>>,
}

impl ToolOutput {
    /// A completed structured value, with its JSON encoding as text content.
    pub fn value(value: impl serde::Serialize) -> Result<Self> {
        let value = serde_json::to_value(value)?;
        Ok(Self {
            status: ToolStatus::Completed,
            text: value.to_string(),
            value: Some(value),
            content: None,
        })
    }

    pub fn with_content(mut self, content: Vec<Value>) -> Self {
        self.content = Some(content);
        self
    }
}

impl From<Vec<Value>> for ToolOutput {
    fn from(content: Vec<Value>) -> Self {
        Self::from(String::new()).with_content(content)
    }
}

impl From<String> for ToolOutput {
    fn from(text: String) -> Self {
        ToolOutput {
            status: ToolStatus::Completed,
            text,
            value: None,
            content: None,
        }
    }
}
impl From<&str> for ToolOutput {
    fn from(text: &str) -> Self {
        text.to_string().into()
    }
}

/// How a call ended (docs/bindings/data.md#tools).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
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
    pub(crate) jobs: Option<(String, crate::jobs::Owner)>,
    pub(crate) session_id: String,
    pub(crate) actor_id: String,
    pub(crate) call_id: String,
    pub(crate) project: std::path::PathBuf,
    pub(crate) cancelled: CancellationToken,
    pub(crate) settled: CancellationToken,
    pub(crate) asks: Arc<std::sync::atomic::AtomicU64>,
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
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Ask {
    kind: base::RequestKind,
    text: String,
    options: Vec<String>,
    credential: Option<String>,
    link: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    wait_ms: Option<u64>,
}

/// An unanswered tool question remains open when this wait ends.
#[derive(Clone, Copy, Debug)]
pub struct AskWait {
    pub wait: std::time::Duration,
}

impl Ask {
    pub(crate) fn into_question(self, scope: base::Scope) -> base::Question {
        let mut question = base::Question::new(scope, self.kind, &self.text);
        question.options = self.options;
        question.credential = self.credential;
        if let Some(ms) = self.wait_ms {
            question.timeout_ms = Some(ms);
            question.extra["whenTimeLimit"] = json!("leaveOpen");
        }
        if self.link {
            question.extra["kind"] = json!("link");
        }
        question
    }
    pub fn choice(question: impl Into<String>, options: &[&str]) -> Self {
        Ask {
            kind: base::RequestKind::Choice,
            text: question.into(),
            options: options.iter().map(|o| o.to_string()).collect(),
            credential: None,
            link: false,
            wait_ms: None,
        }
    }
    pub fn approval(question: impl Into<String>) -> Self {
        Ask {
            kind: base::RequestKind::Approval,
            text: question.into(),
            options: vec![],
            credential: None,
            link: false,
            wait_ms: None,
        }
    }
    pub fn text(question: impl Into<String>) -> Self {
        Ask {
            kind: base::RequestKind::Text,
            text: question.into(),
            options: vec![],
            credential: None,
            link: false,
            wait_ms: None,
        }
    }
    pub fn link(question: impl Into<String>) -> Self {
        Self {
            link: true,
            ..Self::text(question)
        }
    }
    pub fn secret(question: impl Into<String>, credential: impl Into<String>) -> Self {
        Self {
            kind: base::RequestKind::Secret,
            credential: Some(credential.into()),
            ..Self::text(question)
        }
    }
}

/// The answer to a tool's question.
#[derive(Clone, PartialEq, Eq)]
pub enum Answer {
    Allow,
    Value(String),
    Secret(String),
    Declined { reason: Option<String> },
}
impl std::fmt::Debug for Answer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Allow => f.write_str("Allow"),
            Self::Value(v) => f.debug_tuple("Value").field(v).finish(),
            Self::Secret(_) => f.write_str("Secret([redacted])"),
            Self::Declined { reason } => {
                f.debug_struct("Declined").field("reason", reason).finish()
            }
        }
    }
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
    pub(crate) fn check(&self) -> Result<()> {
        if self.settled.is_cancelled() {
            Err(Error::new(
                Code::InvalidRequest,
                "the tool call has settled",
            ))
        } else if self.cancelled.is_cancelled() {
            Err(Error::new(Code::Cancelled, "the tool call was cancelled"))
        } else {
            Ok(())
        }
    }

    /// Operator diagnostics. Never part of the tool result or model context.
    pub fn log(&self, message: impl std::fmt::Display) {
        eprintln!("tool {}: {message}", self.call_id);
    }

    /// Publish live text progress, not a result or history record.
    pub async fn progress(&self, text: impl Into<String>) -> Result<()> {
        self.check()?;
        let text = text.into();
        match &self.backend {
            Backend::Local { api, scope } => {
                api.emit(base::Event::new(scope, "tool.progress", json!(text)))
                    .await?
            }
            Backend::Remote { peer, parent } => peer.notify(
                "tools/progress",
                json!({
                    "parentRequestId": parent, "content": [{"type":"text","text":text}],
                }),
            ),
        }
        Ok(())
    }

    /// The session's working environment, scoped to this call and project.
    pub fn environment(&self) -> ToolEnvironment<'_> {
        ToolEnvironment(self)
    }

    /// List tools available to a nested call, or make one through its own gates.
    pub fn tools(&self) -> NestedTools<'_> {
        NestedTools(self)
    }

    pub async fn start_job(
        &self,
        kind: &str,
        detail: Value,
        key: Option<&str>,
    ) -> Result<crate::JobStart> {
        self.check()?;
        let (name, owner) = self.jobs.as_ref().ok_or_else(|| {
            Error::new(
                Code::InvalidRequest,
                "this plugin did not register a job owner",
            )
        })?;
        owner.start(self, name, kind, detail, key).await
    }

    pub async fn history(&self, after: Option<&str>) -> Result<crate::HistoryPage> {
        self.check()?;
        crate::context::history(&self.backend, &self.session_id, after).await
    }

    pub async fn emit(&self, kind: &str, data: Value) -> Result<()> {
        self.check()?;
        crate::context::emit(&self.backend, &self.session_id, kind, data).await
    }

    /// Invoke a plugin-defined point using the token returned at setup.
    pub async fn call_hook(
        &self,
        hook: &crate::DefinedHook,
        value: Value,
    ) -> Result<crate::HookReply> {
        self.check()?;
        crate::context::call_hook(&self.backend, hook, value).await
    }

    /// Ask an actor, suspending the invocation if the wait ends before an answer.
    /// `Error::is_left_open` identifies the signal; propagate it to let the SDK
    /// run this tool again from the top after the question is answered.
    pub async fn ask_with(&self, mut ask: Ask, options: AskWait) -> Result<Answer> {
        let ms = options.wait.as_millis();
        if ask.kind == base::RequestKind::Approval || ms > 9_007_199_254_740_991 {
            return Err(Error::new(
                Code::InvalidRequest,
                "leaveOpen needs a representable wait and a non-approval question",
            ));
        }
        ask.wait_ms = Some(ms as u64);
        self.ask(ask).await
    }

    /// Ask an actor and wait for the answer.
    pub async fn ask(&self, ask: Ask) -> Result<Answer> {
        self.check()?;
        let approval = ask.kind == base::RequestKind::Approval;
        match &self.backend {
            Backend::Local { api, scope } => {
                if ask.wait_ms.is_some() && api.declaration()?["questions_outlast_turn"] != true {
                    return Err(Error::new(
                        Code::NotSupported,
                        "this agent does not leave questions open",
                    ));
                }
                let mut question = ask.into_question(scope.clone());
                let n = self.asks.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                question.key = scope.call.as_ref().map(|call| format!("call:{call}:{n}"));
                if approval {
                    let data = api.snapshot(&scope.session)?;
                    if let Some(call) = data
                        .entries
                        .iter()
                        .rev()
                        .find(|e| e.kind == "tool.call" && e.scope.call == scope.call)
                        .and_then(|e| {
                            serde_json::from_value::<base::ToolCall>(e.content.clone()?).ok()
                        })
                    {
                        question.extra["approvalCall"] = base::wire::call(&call, scope);
                    }
                }
                let requests = base::requests(api.as_ref())?;
                match requests
                    .ask(api.clone(), question, self.cancelled.clone())
                    .await?
                {
                    base::RequestReply::Answer(a) if a.declined => {
                        Ok(Answer::Declined { reason: a.reason })
                    }
                    base::RequestReply::Answer(a) => Ok(match a.value {
                        Value::String(s) if approval && s == "allow" => Answer::Allow,
                        Value::String(s) => Answer::Value(s),
                        other => {
                            Answer::Value(other["credential"].as_str().unwrap_or_default().into())
                        }
                    }),
                    base::RequestReply::Declined => Ok(Answer::Declined { reason: None }),
                    base::RequestReply::Waiting => Err(left_open()),
                }
            }
            Backend::Remote { peer, parent } => {
                let kind = match ask.kind {
                    base::RequestKind::Approval => "approval",
                    base::RequestKind::Choice => "choice",
                    base::RequestKind::Text if ask.link => "link",
                    base::RequestKind::Text => "text",
                    base::RequestKind::Secret => "secret",
                };
                let mut request = json!({"kind": kind, "question": ask.text});
                if let Some(name) = ask.credential {
                    request["credential"] = json!(name);
                }
                if !ask.options.is_empty() {
                    request["options"] = json!(ask.options);
                }
                if let Some(ms) = ask.wait_ms {
                    request["timeLimitMs"] = json!(ms);
                    request["whenTimeLimit"] = json!("leaveOpen");
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
                    return Err(left_open());
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

/// Call-scoped file and command operations.
pub struct ToolEnvironment<'a>(&'a ToolContext);

#[derive(Clone, Debug)]
pub struct CommandOutput {
    pub exit_code: Option<i64>,
    pub output: String,
    pub timed_out: bool,
    pub status: ToolStatus,
}

impl ToolEnvironment<'_> {
    fn local(&self) -> Result<(base::Api, base::Scope, Arc<dyn base::WorkingEnvironment>)> {
        let cx = self.0;
        let Backend::Local { api, scope } = &cx.backend else {
            unreachable!()
        };
        base::require(api.as_ref(), scope, "tools")
            .map_err(|_| Error::new(Code::InvalidRequest, "environment requires tool authority"))?;
        let env = base::capability::<dyn base::WorkingEnvironment>(api.as_ref(), "environment")?;
        let env = env
            .scoped(api.clone(), scope.clone(), cx.cancelled.clone())
            .unwrap_or(env);
        Ok((api.clone(), scope.clone(), env))
    }

    async fn remote(&self, method: &str, mut params: Value) -> Result<Value> {
        let cx = self.0;
        let Backend::Remote { peer, parent } = &cx.backend else {
            unreachable!()
        };
        params["parentRequestId"] = parent.clone();
        params["sessionId"] = json!(cx.session_id);
        params["cwd"] = json!(cx.project);
        peer.call(method, params, None, cx.cancelled.clone())
            .await
            .map_err(crate::serve::from_fault)
    }

    pub async fn read(&self, path: &str) -> Result<Vec<u8>> {
        use base64::Engine;
        self.0.check()?;
        let bytes = match self.0.backend {
            Backend::Local { .. } => self.local()?.2.read_bytes(&self.0.project, path).await?,
            Backend::Remote { .. } => {
                let reply = self.remote("host/env/read", json!({"path":path})).await?;
                base64::prelude::BASE64_STANDARD
                    .decode(reply["data"].as_str().unwrap_or_default())
                    .map_err(|e| Error::new(Code::InvalidRequest, e.to_string()))?
            }
        };
        Ok(bytes)
    }

    pub async fn write(&self, path: &str, bytes: &[u8]) -> Result<()> {
        use base64::Engine;
        self.0.check()?;
        match self.0.backend {
            Backend::Local { .. } => {
                self.local()?
                    .2
                    .write_bytes(&self.0.project, path, bytes)
                    .await?
            }
            Backend::Remote { .. } => {
                self.remote(
                    "host/env/write",
                    json!({
                        "path":path,"data":base64::prelude::BASE64_STANDARD.encode(bytes)
                    }),
                )
                .await?;
            }
        }
        Ok(())
    }

    pub async fn exists(&self, path: &str) -> Result<bool> {
        self.0.check()?;
        match self.0.backend {
            Backend::Local { .. } => Ok(self.local()?.2.exists(&self.0.project, path).await?),
            Backend::Remote { .. } => {
                Ok(self.remote("host/env/exists", json!({"path":path})).await?["exists"] == true)
            }
        }
    }

    pub async fn list(&self, path: &str) -> Result<Vec<String>> {
        self.0.check()?;
        match self.0.backend {
            Backend::Local { .. } => Ok(self.local()?.2.list_dir(&self.0.project, path).await?),
            Backend::Remote { .. } => {
                let reply = self.remote("host/env/list", json!({"path":path})).await?;
                Ok(base::wire::dir_names(&reply["entries"])?)
            }
        }
    }

    /// A native ignore-aware walk, when the local environment provides one.
    /// There is no walk operation on the plugin binding.
    pub async fn walk_files(&self, path: &str) -> Result<Vec<String>> {
        self.0.check()?;
        match self.0.backend {
            Backend::Local { .. } => Ok(self.local()?.2.walk_files(&self.0.project, path).await?),
            Backend::Remote { .. } => Err(Error::new(
                Code::NotSupported,
                "the binding has no native file walk",
            )),
        }
    }

    pub async fn exec(
        &self,
        command: &str,
        timeout: Option<std::time::Duration>,
    ) -> Result<CommandOutput> {
        self.0.check()?;
        let cx = self.0;
        match cx.backend {
            Backend::Local { .. } => {
                let (api, scope, env) = self.local()?;
                let out = env
                    .exec(
                        api,
                        scope,
                        cx.project.clone(),
                        command,
                        timeout,
                        cx.cancelled.clone(),
                    )
                    .await?;
                Ok(CommandOutput {
                    exit_code: out.value.as_ref().and_then(|v| v["exit_code"].as_i64()),
                    output: out.text,
                    timed_out: out.value.as_ref().is_some_and(|v| v["timed_out"] == true),
                    status: ToolStatus::from_base(&out.status),
                })
            }
            Backend::Remote { .. } => {
                let mut params = json!({"command":command});
                if let Some(duration) = timeout {
                    params["timeoutMs"] = json!((duration.as_millis() as u64).max(1));
                }
                let out = self.remote("host/env/exec", params).await?;
                let exit_code = out["exitCode"].as_i64();
                let timed_out = out["timedOut"] == true;
                Ok(CommandOutput {
                    exit_code,
                    output: out["output"].as_str().unwrap_or_default().into(),
                    timed_out,
                    status: if exit_code == Some(0) && !timed_out {
                        ToolStatus::Completed
                    } else {
                        ToolStatus::Failed
                    },
                })
            }
        }
    }
}

/// Call-scoped access to other tools. The core limits nesting to four levels.
pub struct NestedTools<'a>(&'a ToolContext);

impl NestedTools<'_> {
    pub async fn list(&self) -> Result<Vec<Value>> {
        let cx = self.0;
        cx.check()?;
        match &cx.backend {
            Backend::Local { api, scope } => {
                let data = api.snapshot(&scope.session)?;
                Ok(base::nested_tool_definitions(api.as_ref(), &data)?
                    .iter()
                    .map(base::wire::definition)
                    .collect())
            }
            Backend::Remote { peer, parent } => {
                let reply = peer
                    .call(
                        "host/tools/list",
                        json!({"parentRequestId":parent}),
                        None,
                        cx.cancelled.clone(),
                    )
                    .await
                    .map_err(crate::serve::from_fault)?;
                serde_json::from_value(reply["tools"].clone()).map_err(Error::from)
            }
        }
    }

    pub async fn call(&self, name: &str, input: Value) -> Result<crate::ToolResult> {
        let cx = self.0;
        cx.check()?;
        if name.is_empty() || !input.is_object() {
            return Err(Error::new(
                Code::InvalidRequest,
                "nested calls need a tool name and an input object",
            ));
        }
        let result = match &cx.backend {
            Backend::Local { api, scope } => {
                let data = api.snapshot(&scope.session)?;
                let runtime = base::session_runtime(api.as_ref(), &data)?;
                let result = runtime
                    .nested_tool(
                        api.clone(),
                        scope.clone(),
                        base::ToolCall::new(name, input),
                        cx.cancelled.clone(),
                    )
                    .await?;
                base::wire::result(&result)
            }
            Backend::Remote { peer, parent } => peer
                .call(
                    "host/tools/call",
                    json!({
                        "parentRequestId":parent, "name":name, "input":input,
                    }),
                    None,
                    cx.cancelled.clone(),
                )
                .await
                .map_err(crate::serve::from_fault)?,
        };
        let id = result["callId"].as_str().unwrap_or_default().to_owned();
        let native = base::wire::parse_result(result, &id)?;
        Ok(crate::ToolResult::from_base(name.into(), native))
    }
}

fn left_open() -> Error {
    let mut error = Error::new(Code::Internal, "question left open");
    error.left_open = true;
    error
}

/// How a call ended, before the agent adds the call's id. A refusal's text is the bare
/// reason; each side words it once.
pub(crate) struct Settled {
    pub status: ToolStatus,
    pub text: String,
    pub value: Option<Value>,
    pub content: Option<Vec<Value>>,
}

/// Run a tool's function with a context, wherever the agent is.
pub(crate) async fn execute(tool: &Tool, input: Value, cx: ToolContext) -> Option<Settled> {
    let cancel = cx.cancelled.clone();
    let _settled = cx.settled.clone().drop_guard();
    let run = (tool.run)(input, cx);
    let outcome = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            return Some(Settled { status: ToolStatus::Cancelled, text: "The call was cancelled.".into(), value: None, content: None });
        }
        outcome = run => outcome,
    };
    Some(match outcome {
        Err(ref e) if e.is_left_open() => return None,
        Ok(output) => Settled {
            status: match output.status {
                ToolStatus::NotStarted | ToolStatus::Cancelled => ToolStatus::Failed,
                other => other,
            },
            text: if output.text.is_empty() && output.status != ToolStatus::Completed {
                format!("The tool reported {}.", output.status.as_str())
            } else {
                output.text
            },
            value: output.value,
            content: output.content,
        },
        Err(e) if e.refusal => Settled {
            status: ToolStatus::Refused,
            text: e.message().to_string(),
            value: None,
            content: None,
        },
        Err(e) => Settled {
            status: ToolStatus::Failed,
            text: e.message().to_string(),
            value: None,
            content: None,
        },
    })
}
