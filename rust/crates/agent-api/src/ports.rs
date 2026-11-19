use crate::*;

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
    ) -> Result<()> {
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
    fn check_writer(&self, _session: &str) -> Result<()> {
        Ok(())
    }
    fn cancellation(&self, session: &str) -> Result<CancellationToken>;
    fn capability(&self, name: &str) -> Result<Arc<dyn Any + Send + Sync>>;
    fn capability_names(&self, prefix: &str) -> Vec<String>;
    fn tool_registration(&self, capability: &str) -> Value {
        json!({"plugin":capability,"toolSource":capability.strip_prefix("tools.").unwrap_or(capability)})
    }
    fn snapshot(&self, session: &str) -> Result<SessionData>;
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
    fn take_steering(&self, scope: &Scope) -> Result<Vec<Input>>;
    fn take_final_steering(&self, scope: &Scope) -> Result<Vec<Input>> {
        self.take_steering(scope)
    }
    fn has_steering(&self, _session: &str) -> Result<bool> {
        Ok(false)
    }
    fn is_running(&self, session: &str) -> bool;
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
    async fn output(&self, scope: &Scope, output: Output) -> Result<Option<Value>>;
    async fn command(&self, scope: &Scope, name: &str, args: &str) -> Result<Value>;
    fn commands(&self) -> Vec<String>;
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
    fn check(&self) -> Result<()> {
        Ok(())
    }
}
pub trait HistoryStore: Send + Sync {
    fn acquire(&self, session: &str) -> Result<Box<dyn Lease>>;
    fn load(&self, session: &str) -> Result<SessionData>;
    fn save(&self, session: &SessionData) -> Result<()>;
    fn list(&self, project: Option<&Path>) -> Result<Vec<SessionData>>;
    fn erase(&self, entries: Vec<String>, held: &[String]) -> Result<Vec<SessionData>>;
}
pub trait Configuration: Send + Sync {
    fn settings(&self, project: &Path) -> Result<Value>;
}
pub trait CredentialStore: Send + Sync {
    fn get(&self, name: &str) -> Result<String>;
    fn put(&self, _name: &str, _value: &str) -> Result<()> {
        bail!("credential store is read-only")
    }
    fn writable(&self) -> bool {
        false
    }
    fn accepts(&self, _name: &str) -> bool {
        self.writable()
    }
}
#[async_trait]
pub trait ModelAccess: Send + Sync {
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
        let response = self
            .generate(api.clone(), scope.clone(), request, cancel)
            .await?;
        api.provider_response(&scope, &info, &response).await?;
        Ok(response)
    }
    fn info(&self) -> ModelInfo;
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
}
pub async fn refresh_tool_sources(api: &Api, scope: &Scope) -> Result<()> {
    for key in api.capability_names("tools.") {
        capability::<dyn ToolSource>(api.as_ref(), &key)?
            .refresh_for_use(api, scope)
            .await;
    }
    Ok(())
}
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
    async fn edit(&self, project: &Path, path: &str, old: &str, new: &str) -> Result<()>;
    async fn bash(
        &self,
        api: Api,
        scope: Scope,
        project: PathBuf,
        command: &str,
        cancel: CancellationToken,
    ) -> Result<ToolResult>;
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
