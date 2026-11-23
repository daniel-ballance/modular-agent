use crate::*;

/// Common agent failures distinguishable without interpreting diagnostics.
#[derive(Debug)]
pub enum OperationError {
    NotFound(String),
    Busy(String),
    Unavailable(String),
    Forbidden(String),
    Conflict(String),
    InvalidParams(String),
}

impl std::fmt::Display for OperationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(message)
            | Self::Busy(message)
            | Self::Unavailable(message)
            | Self::Forbidden(message)
            | Self::Conflict(message)
            | Self::InvalidParams(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for OperationError {}

/// A portable session is held longer than this open can wait.
#[derive(Debug)]
pub struct HistoryHeld {
    pub retry_after_ms: u64,
}
impl std::fmt::Display for HistoryHeld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("history session is still held, retry later")
    }
}
impl std::error::Error for HistoryHeld {}
use std::{
    any::Any,
    path::{Path, PathBuf},
    sync::Arc,
};

pub struct Capability<T: ?Sized + Send + Sync + 'static>(pub Arc<T>);
pub fn capability<T: ?Sized + Send + Sync + 'static>(
    api: &dyn AgentApi,
    name: &str,
) -> Result<Arc<T>> {
    let value = api.capability(name)?;
    Ok(value
        .downcast_ref::<Capability<T>>()
        .ok_or_else(|| anyhow!("wrong type for capability {name}"))?
        .0
        .clone())
}
#[derive(Debug)]
pub enum RewindError {
    Busy(String),
    Conflict(String),
    NotSupported,
}
impl std::fmt::Display for RewindError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Busy(message) | Self::Conflict(message) => f.write_str(message),
            Self::NotSupported => f.write_str("environment does not support rewinding"),
        }
    }
}
impl std::error::Error for RewindError {}

#[async_trait]
pub trait AgentApi: Send + Sync {
    async fn provider_request(
        &self,
        _scope: &Scope,
        _model: &ModelInfo,
        request: ModelRequest,
    ) -> Result<ModelRequest> {
        Ok(request)
    }
    async fn provider_response(
        &self,
        _scope: &Scope,
        _model: &ModelInfo,
        _response: &ModelResponse,
    ) -> Result<()> {
        Ok(())
    }
    async fn shutdown(&self) -> Result<()> {
        Ok(())
    }
    async fn create(&self, project: &Path, settings: Value) -> Result<String>;
    async fn create_in_tenant(
        &self,
        project: &Path,
        settings: Value,
        tenant: Option<&str>,
    ) -> Result<String> {
        ensure!(tenant.is_none(), "tenants are not supported");
        self.create(project, settings).await
    }
    /// Create a session whose setup is not kept until input is admitted.
    async fn create_provisional(
        &self,
        project: &Path,
        settings: Value,
        tenant: Option<&str>,
    ) -> Result<String> {
        self.create_in_tenant(project, settings, tenant).await
    }
    fn tenant(&self, _session: &str) -> Result<Value> {
        Ok(json!({"tenant":null,"rights":null,"tokens":null}))
    }
    fn tenant_budget_reached(&self, session: &str) -> Result<bool> {
        let info = self.tenant(session)?;
        Ok(info["tokens"]["budget"]
            .as_u64()
            .is_some_and(|budget| info["tokens"]["used"].as_u64().unwrap_or(0) >= budget))
    }
    async fn open(&self, session: &str) -> Result<()>;
    /// Open without waiting for an interrupted turn. Returns inputs handed
    /// back on recovery, in admission order.
    async fn install_recovery(&self, session: &str) -> Result<Vec<Input>>;
    /// Drive installed recovery. The interface must keep routing authorized
    /// reads, answers and cancellation while this runs.
    async fn run_recovery(&self, session: &str) -> Result<()>;
    async fn close(&self, session: &str) -> Result<()>;
    async fn submit(
        &self,
        session: &str,
        actor: &str,
        text: &str,
        timing: Timing,
        key: Option<String>,
    ) -> Result<Receipt>;
    async fn submit_as(
        &self,
        scope: &Scope,
        _sponsor: &str,
        text: &str,
        timing: Timing,
        key: Option<String>,
    ) -> Result<Receipt> {
        self.submit(&scope.session, &scope.actor, text, timing, key)
            .await
    }
    async fn release(
        &self,
        _scope: &Scope,
        _input: &str,
        _timing: Timing,
        _declined: bool,
    ) -> Result<&'static str> {
        bail!("proposed input is not supported")
    }
    async fn withdraw_proposal(&self, _scope: &Scope, _sponsor: &str, _input: &str) -> Result<()> {
        bail!("proposed input is not supported")
    }
    async fn next_turn(&self, session: &str) -> Result<Option<TurnResult>>;
    async fn cancel(&self, session: &str) -> Result<Vec<Input>>;
    async fn withdraw(&self, session: &str, input: &str) -> Result<Input>;
    async fn history_view(&self, session: &str) -> Result<Value>;
    fn declaration(&self) -> Result<Value>;
    /// Signals that the open session's writer can no longer commit.
    fn writer_interruption(&self, _session: &str) -> Result<CancellationToken> {
        Ok(CancellationToken::new())
    }
    fn check_writer(&self, _session: &str) -> Result<()> {
        Ok(())
    }
    fn cancellation(&self, session: &str) -> Result<CancellationToken>;
    fn capability(&self, name: &str) -> Result<Arc<dyn Any + Send + Sync>>;
    fn capability_names(&self, prefix: &str) -> Vec<String>;
    fn provider_credential(&self, name: &str) -> bool {
        self.capability_names("provider.")
            .iter()
            .any(|key| key.strip_prefix("provider.") == Some(name))
    }
    fn tool_registration(&self, capability: &str) -> Value {
        json!({"plugin":capability,"toolSource":capability.strip_prefix("tools.").unwrap_or(capability)})
    }
    fn snapshot(&self, session: &str) -> Result<SessionData>;
    fn question_trace(&self, _session: &str, _question: &str) -> Option<String> {
        None
    }
    fn authority(&self, session: &str, actor: &str) -> Result<Authority>;
    fn grant(&self, scope: &Scope, actor: &str, authority: Authority) -> Result<()>;
    /// One history-store commit, optionally admitting input in that same commit.
    fn publish(
        &self,
        scope: &Scope,
        writer: &str,
        drafts: Vec<Draft>,
        input: Option<(String, String)>,
        key: Option<String>,
    ) -> Result<Vec<Entry>>;
    fn append(&self, scope: &Scope, writer: &str, draft: Draft) -> Result<Entry>;
    fn reserve_response_calls(&self, _scope: &Scope, _response: &ModelResponse) -> Result<()> {
        Ok(())
    }
    fn take_steering(&self, scope: &Scope) -> Result<Vec<Input>>;
    fn take_final_steering(&self, scope: &Scope) -> Result<Vec<Input>> {
        self.take_steering(scope)
    }
    fn has_steering(&self, _session: &str) -> Result<bool> {
        Ok(false)
    }
    fn is_running(&self, session: &str) -> bool;
    /// Lost writer access is an interruption even before the driver has exited.
    fn is_driving_turn(&self, session: &str) -> bool {
        self.is_running(session)
            && self
                .writer_interruption(session)
                .is_ok_and(|w| !w.is_cancelled())
    }
    fn settings(&self, scope: &Scope, patch: Value) -> Result<Value>;
    fn move_position(&self, scope: &Scope, position: Option<String>) -> Result<()>;
    async fn rewind(&self, _scope: &Scope, _position: String) -> Result<Vec<String>> {
        Err(RewindError::NotSupported.into())
    }
    fn rewind_pending(&self, session: &str) -> Result<bool> {
        Ok(self.snapshot(session)?.unresolved_rewind().is_some())
    }
    /// Hold a reservation across an out-of-turn operation that may use the project.
    fn begin_environment_work(&self, _session: &str) -> Result<Box<dyn Send>> {
        Ok(Box::new(()))
    }
    fn fork(&self, scope: &Scope, position: Option<String>) -> Result<String>;
    fn list(&self, project: Option<&Path>) -> Result<Vec<SessionData>>;
    async fn erase(&self, scope: &Scope, entries: Vec<String>) -> Result<ErasureReport>;
    async fn invoke(&self, point: &HookPoint, scope: &Scope, value: Value) -> Result<HookResult>;
    async fn emit(&self, event: Event) -> Result<()>;
    /// Hold buffer capacity until the recipient queue consumes or drops the item.
    fn reserve_output(&self, _session: &str, _bytes: u64) -> Result<Box<dyn Send>> {
        Ok(Box::new(()))
    }
    async fn output(&self, scope: &Scope, output: Output) -> Result<Option<Value>>;
    async fn command(&self, scope: &Scope, name: &str, args: &str) -> Result<Value>;
    fn commands(&self) -> Vec<String>;
    fn interface_available(&self, _session: &SessionData, _name: &str) -> bool {
        true
    }
    async fn handoff_interface_tool(
        &self,
        _scope: &Scope,
        _call: &ToolCall,
        _start: Draft,
    ) -> Result<Option<ToolResult>> {
        Ok(None)
    }
    fn finish_interface_calls(&self, _scope: &Scope, _result: &mut TurnResult) -> Result<()> {
        Ok(())
    }
    async fn dispatch_tool(
        &self,
        scope: &Scope,
        call: ToolCall,
        cancel: CancellationToken,
    ) -> ToolResult;
}
#[derive(Debug)]
pub struct LostPart(pub String);
impl std::fmt::Display for LostPart {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "lost: {}", self.0)
    }
}
impl std::error::Error for LostPart {}
pub trait Lease: Send + Sync {
    /// An optional signal for losses detected without a call to `check`.
    fn lost(&self) -> Option<CancellationToken> {
        None
    }
    fn check(&self) -> Result<()> {
        Ok(())
    }
}
pub trait HistoryStore: Send + Sync {
    fn supports_erasure(&self) -> bool {
        false
    }
    /// Opt in to storing opaque HTTP service snapshots. `save` must durably
    /// replace a whole snapshot, and `acquire` must exclude another server,
    /// even before the first `save`.
    fn supports_service_snapshots(&self) -> bool {
        false
    }
    fn acquire(&self, session: &str) -> Result<Box<dyn Lease>>;
    fn load(&self, session: &str) -> Result<SessionData>;
    fn save(&self, session: &SessionData) -> Result<()>;
    fn list(&self, project: Option<&Path>) -> Result<Vec<SessionData>>;
    fn erase(&self, entries: Vec<String>, held: &[String]) -> Result<Vec<SessionData>>;
    /// This store has a shared pending registry, not just an erase operation.
    fn coordinates_erasure(&self) -> bool {
        false
    }
    /// Publish the durable intent and return the exact known copies by session.
    /// All callers use the same registry for this backend.
    fn mark_erasure(
        &self,
        _source: &str,
        _targets: &[String],
    ) -> Result<std::collections::BTreeMap<String, Vec<String>>> {
        bail!("pending erasure is not supported")
    }
    /// Check a retained view against the authoritative registry.
    fn check_erasure(&self, _data: &SessionData) -> Result<()> {
        Ok(())
    }
    /// Reconcile under an already acquired writer lease. The return value contains
    /// the latest record and the IDs whose tombstones and bookkeeping are confirmed.
    /// Previously verified tombstones, without attempting another writer acquisition.
    fn confirmed_erasure(&self, _session: &str) -> Result<Vec<String>> {
        Ok(Vec::new())
    }
    fn reconcile_erasure(&self, _session: &str) -> Result<Option<(SessionData, Vec<String>)>> {
        Ok(None)
    }
}
pub trait Configuration: Send + Sync {
    fn settings(&self, project: &Path) -> Result<Value>;
}
pub trait CredentialStore: Send + Sync {
    /// A named secret that no Provider claimed, such as an answer a person
    /// gave. A store MUST refuse a Provider's credential here.
    fn get(&self, name: &str) -> Result<String>;
    /// A Provider's own credential, to the plugin that claimed its name.
    fn provider(&self, claim: &CredentialClaim, name: &str) -> Result<String> {
        ensure!(
            claim.covers(name),
            "{} did not register the credential {name}",
            claim.owner()
        );
        self.get(name)
    }
    fn put(&self, _name: &str, _value: &str) -> Result<()> {
        bail!("credential store is read-only")
    }
    fn writable(&self) -> bool {
        false
    }
    fn accepts(&self, _name: &str) -> bool {
        self.writable()
    }
    fn stage(&self, _receipt: StagingReceipt, _value: &str) -> Result<()> {
        bail!("credential staging is not supported")
    }
    fn lookup_staged(&self, _request: &SecretRequest) -> Result<Option<StagingReceipt>> {
        Ok(None)
    }
    fn activate(&self, _request: &SecretRequest) -> Result<Activation> {
        bail!("credential staging is not supported")
    }
    fn discard(&self, _request: &SecretRequest) -> Result<()> {
        Ok(())
    }
}
#[async_trait]
pub trait ModelAccess: Send + Sync {
    fn provider_tools(&self) -> Vec<ToolDefinition> {
        vec![]
    }
    fn safe_to_repeat(&self) -> bool {
        let info = self.info();
        !info.keeps_state && !info.runs_tools
    }
    async fn refresh(&self, _api: &Api, _scope: &Scope, _cancel: CancellationToken) -> Result<()> {
        Ok(())
    }
    async fn generate_attempt(
        &self,
        api: Api,
        scope: Scope,
        request: ModelRequest,
        cancel: CancellationToken,
        attempt: ModelAttempt,
    ) -> Result<ModelResponse> {
        let info = self.info();
        let request = if attempt.replay.is_some() {
            request
        } else {
            api.provider_request(&scope, &info, request).await?
        };
        attempt.authorize(api.as_ref(), &scope, &info, &request, &cancel)?;
        let response = telemetry::inference(
            &scope,
            &info,
            self.inference_kind(),
            self.streaming(),
            telemetry::model_failure,
            self.generate(api.clone(), scope.clone(), request, cancel),
        )
        .await?;
        api.provider_response(&scope, &info, &response).await?;
        Ok(response)
    }
    fn info(&self) -> ModelInfo;
    fn inference_kind(&self) -> telemetry::SpanKind {
        telemetry::SpanKind::Internal
    }
    fn streaming(&self) -> bool {
        false
    }
    async fn generate(
        &self,
        api: Api,
        scope: Scope,
        request: ModelRequest,
        cancel: CancellationToken,
    ) -> std::result::Result<ModelResponse, ModelFailure>;
    async fn discard(&self, _session: &str) -> Result<()> {
        Ok(())
    }
}
#[derive(Default)]
pub struct ProviderErasure {
    pub pending: Vec<String>,
    pub out_of_reach: Vec<String>,
}
#[async_trait]
pub trait Provider: Send + Sync {
    async fn erase_binding_copies(
        &self,
        api: Api,
        targets: &std::collections::BTreeMap<String, Vec<String>>,
    ) -> Result<ProviderErasure> {
        Ok(ProviderErasure {
            pending: vec![],
            out_of_reach: self
                .erase_copies(api, &targets.keys().cloned().collect::<Vec<_>>())
                .await?,
        })
    }
    /// Stop using a session's cached conversation immediately. No remote I/O.
    fn invalidate(&self, _session: &str) {}
    /// Delete controlled copies before acknowledging erasure. Report unreachable copies.
    async fn erase_copies(&self, _api: Api, _sessions: &[String]) -> Result<Vec<String>> {
        Ok(vec![])
    }
    fn catalog(&self) -> Vec<ModelInfo>;
    fn catalog_changes(&self) -> Option<tokio::sync::watch::Receiver<u64>> {
        None
    }
    fn bind(&self, model: &str) -> Result<Arc<dyn ModelAccess>>;
}
#[async_trait]
pub trait ModelSelection: Send + Sync {
    async fn select(&self, api: Api, scope: &Scope) -> Result<Arc<dyn ModelAccess>>;
}
pub struct TurnInput {
    pub resume: Vec<ToolCall>,
    pub scope: Scope,
    pub model: Arc<dyn ModelAccess>,
    pub system: String,
    pub tools: Vec<ToolDefinition>,
    pub settings: Value,
    pub cancel: CancellationToken,
}
#[async_trait]
pub trait Runtime: Send + Sync {
    fn declaration(&self) -> Value;
    async fn run(&self, api: Api, input: TurnInput) -> Result<TurnResult>;
    async fn interrupted(&self, api: Api, scope: Scope) -> Result<()>;
    async fn tool(&self, api: Api, scope: Scope, call: ToolCall) -> Result<ToolResult>;
    /// Run a call made by a running tool call. `scope.call` is the live parent.
    /// The nested call passes its own gates and is recorded with its parent,
    /// outside the model's view.
    async fn nested_tool(
        &self,
        _api: Api,
        _scope: Scope,
        _call: ToolCall,
        _cancel: CancellationToken,
    ) -> Result<ToolResult> {
        bail!("this Runtime does not run nested tool calls")
    }
}
pub async fn refresh_tool_sources(api: &Api, scope: &Scope) -> Result<()> {
    for key in api.capability_names("tools.") {
        capability::<dyn ToolSource>(api.as_ref(), &key)?
            .refresh_for_use(api, scope)
            .await;
    }
    Ok(())
}
/// The registered tools a running call may start as nested calls.
pub fn nested_tool_definitions(
    api: &dyn AgentApi,
    data: &SessionData,
) -> Result<Vec<ToolDefinition>> {
    let mut tools = vec![];
    for key in api.capability_names("tools.") {
        tools.extend(
            capability::<dyn ToolSource>(api, &key)?
                .tools(data)
                .into_iter()
                .filter(|tool| tool.allows("plugin")),
        );
    }
    Ok(tools)
}
/// The Runtime that runs this session's calls.
pub fn session_runtime(api: &dyn AgentApi, data: &SessionData) -> Result<Arc<dyn Runtime>> {
    capability(
        api,
        match data.settings["_runtime"].as_str() {
            Some("durable") => "runtime.durable",
            Some("transient") => "runtime.transient",
            _ => "runtime",
        },
    )
}
/// How deep nested calls may go: a call, its nested call, and so on.
pub const MAX_NESTING: usize = 4;
#[async_trait]
pub trait ToolSource: Send + Sync {
    async fn refresh_for_use(&self, _api: &Api, _scope: &Scope) {}
    fn tools(&self, session: &SessionData) -> Vec<ToolDefinition>;
    async fn run(
        &self,
        api: Api,
        scope: Scope,
        call: ToolCall,
        cancel: CancellationToken,
    ) -> ToolResult;
}
/// Missing files have the same typed error for local and adapted environments.
pub fn is_file_not_found(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
}
#[async_trait]
pub trait WorkingEnvironment: Send + Sync {
    /// Whether this environment can save points for this project. Most
    /// environments answer the same for every project, from their declaration.
    fn keeps_points(&self, _project: &Path) -> bool {
        self.declaration()["rewinding"] == true
    }
    async fn save_point(&self, _session: &str, _project: &Path) -> Result<String> {
        bail!("saved points are not supported")
    }
    async fn check_point(&self, _session: &str, _project: &Path, _point: &str) -> Result<bool> {
        bail!("checking saved points is not supported")
    }
    async fn restore_point(&self, _session: &str, _project: &Path, _point: &str) -> Result<()> {
        bail!("saved points are not supported")
    }
    async fn session_ended(&self, _session: &str) -> Result<()> {
        Ok(())
    }
    /// Bind file operations to the work that owns them, including cancellation.
    fn scoped(
        &self,
        _api: Api,
        _scope: Scope,
        _cancel: CancellationToken,
    ) -> Option<Arc<dyn WorkingEnvironment>> {
        None
    }
    fn declaration(&self) -> Value;
    /// Missing files return std::io::ErrorKind::NotFound, including remote not_found.
    async fn read(&self, project: &Path, path: &str) -> Result<String>;
    /// Like read, but without text decoding and with the same missing-file error.
    async fn read_bytes(&self, project: &Path, path: &str) -> Result<Vec<u8>> {
        Ok(self.read(project, path).await?.into_bytes())
    }
    async fn write_bytes(&self, project: &Path, path: &str, bytes: &[u8]) -> Result<()> {
        self.write(project, path, std::str::from_utf8(bytes)?).await
    }
    async fn exists(&self, project: &Path, path: &str) -> Result<bool> {
        match self.read_bytes(project, path).await {
            Ok(_) => Ok(true),
            Err(e) if is_file_not_found(&e) => Ok(false),
            Err(e) => Err(e),
        }
    }
    async fn write(&self, project: &Path, path: &str, text: &str) -> Result<()>;
    /// Names in a directory, in no fixed order. A directory's name ends in '/'.
    /// `Unsupported` lets the caller fall back to a command.
    async fn list_dir(&self, _project: &Path, _path: &str) -> Result<Vec<String>> {
        Err(std::io::Error::from(std::io::ErrorKind::Unsupported).into())
    }
    /// Files under `path` that the project's ignore rules keep, relative to
    /// `path`, with '/' separators. `Unsupported` lets the caller fall back.
    async fn walk_files(&self, _project: &Path, _path: &str) -> Result<Vec<String>> {
        Err(std::io::Error::from(std::io::ErrorKind::Unsupported).into())
    }
    async fn edit(&self, project: &Path, path: &str, old: &str, new: &str) -> Result<()>;
    async fn bash(
        &self,
        api: Api,
        scope: Scope,
        project: PathBuf,
        command: &str,
        cancel: CancellationToken,
    ) -> Result<ToolResult>;
    /// Run a command with a deadline. `None` and zero mean no limit. When the
    /// deadline ends the command, the result is `Failed` and its value has
    /// `timed_out: true`. An environment that can enforce the deadline where
    /// the command runs overrides this.
    async fn exec(
        &self,
        api: Api,
        scope: Scope,
        project: PathBuf,
        command: &str,
        timeout: Option<std::time::Duration>,
        cancel: CancellationToken,
    ) -> Result<ToolResult> {
        let Some(limit) = timeout.filter(|limit| !limit.is_zero()) else {
            return self.bash(api, scope, project, command, cancel).await;
        };
        let child = cancel.child_token();
        let run = self.bash(api, scope, project, command, child.clone());
        tokio::pin!(run);
        let mut result = tokio::select! {
            result = &mut run => return result,
            _ = tokio::time::sleep(limit) => {
                child.cancel();
                run.await?
            }
        };
        if !cancel.is_cancelled() {
            result.status = ToolStatus::Failed;
            let mut value = result
                .value
                .take()
                .filter(Value::is_object)
                .unwrap_or(json!({}));
            value["timed_out"] = json!(true);
            result.value = Some(value);
        }
        Ok(result)
    }
}
pub trait EventSink: Send + Sync {
    fn send(&self, event: Event);
}
pub fn merge(base: &mut Value, patch: Value) {
    if let (Some(b), Some(p)) = (base.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            if let Some(existing) = b.get_mut(k) {
                merge(existing, v.clone());
            } else {
                b.insert(k.clone(), v.clone());
            }
        }
    } else {
        *base = patch;
    }
}
