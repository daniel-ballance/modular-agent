//! Developer Providers and their call-scoped context.
use crate::{Code, Error, Result};
use agent_api as base;
pub use agent_api::ProviderAvailability;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelRef {
    pub provider: String,
    pub id: String,
}

impl std::fmt::Display for ModelRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.provider, self.id)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    #[serde(flatten)]
    pub model: ModelRef,
    pub context_window: u64,
    pub max_output: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub thinking: Vec<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

/// Usage reported by a model attempt or aggregated by a step or turn.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cost: f64,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl From<base::Usage> for Usage {
    fn from(usage: base::Usage) -> Self {
        Self {
            input: usage.input_tokens,
            output: usage.output_tokens,
            cache_read: usage.cached_tokens,
            cache_write: usage.cache_write_tokens,
            cost: usage.cost,
            extra: Default::default(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ProviderSupport {
    pub keeps_state: bool,
    pub safe_to_repeat: bool,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ModelErrorKind {
    Temporary,
    ContextTooLarge,
    Credentials,
    Refused,
    Other,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModelError {
    pub kind: ModelErrorKind,
    pub message: String,
}
impl ModelError {
    pub fn new(kind: ModelErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
    pub fn failed(self) -> AssistantMessage {
        AssistantMessage(json!({"role":"assistant","content":[],"stop":"failed","error":self}))
    }
}

/// Shared JSON for a request, including any fields not understood by this SDK version.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ModelRequest(pub Value);
/// Shared JSON for a response. Use [`ModelError::failed`] for an admitted failure.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AssistantMessage(pub Value);

macro_rules! shared_json {
    ($name:ident) => {
        impl std::ops::Deref for $name {
            type Target = Value;
            fn deref(&self) -> &Value {
                &self.0
            }
        }
        impl std::ops::DerefMut for $name {
            fn deref_mut(&mut self) -> &mut Value {
                &mut self.0
            }
        }
    };
}
shared_json!(ModelRequest);
shared_json!(AssistantMessage);

impl AssistantMessage {
    pub fn text(text: impl Into<String>) -> Self {
        Self(
            json!({"role":"assistant","content":[{"type":"text","text":text.into()}],"stop":"finished"}),
        )
    }
}

#[derive(Clone, Copy, Debug)]
pub enum Piece {
    Text,
    Reasoning,
    ToolInput,
}

/// A Provider lists its models and answers one request at a time. Implementations may
/// be called concurrently. Use `#[modular_agent::async_trait]` on an implementation.
#[async_trait::async_trait]
pub trait Provider: Send + Sync + 'static {
    fn id(&self) -> &str;
    fn models(&self) -> Vec<ModelInfo>;
    fn supports(&self) -> ProviderSupport {
        ProviderSupport::default()
    }
    /// Check whether requests can be taken now without making a model request.
    async fn availability(&self) -> ProviderAvailability {
        ProviderAvailability::Available
    }
    /// Install an optional notifier during plugin setup. Call `changed()`
    /// after changing the catalog, not from `models()`.
    fn catalog_notifier(&self, _notifier: CatalogNotifier) {}
    async fn request(
        &self,
        model: ModelRef,
        request: ModelRequest,
        cx: ProviderContext,
    ) -> Result<AssistantMessage>;
    async fn discard_state(&self, _session_id: &str) -> Result<()> {
        if self.supports().keeps_state {
            return Err(crate::Error::msg(
                "Stateful Provider does not implement discard_state",
            ));
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct ProviderContext {
    backend: ProviderBackend,
    session: String,
    name: String,
    cancelled: CancellationToken,
    done: CancellationToken,
    stream: String,
}
#[derive(Clone)]
enum ProviderBackend {
    Local {
        api: base::Api,
        scope: Box<base::Scope>,
        claim: base::CredentialClaim,
    },
    Remote {
        peer: Arc<plugin_stdio::rpc::Peer>,
        parent: Value,
    },
}
impl ProviderContext {
    pub(crate) fn remote(
        peer: Arc<plugin_stdio::rpc::Peer>,
        parent: Value,
        session: String,
        name: String,
        cancelled: CancellationToken,
        done: CancellationToken,
    ) -> Self {
        Self {
            backend: ProviderBackend::Remote { peer, parent },
            session,
            name,
            cancelled,
            done,
            stream: String::new(),
        }
    }
    pub fn session_id(&self) -> &str {
        &self.session
    }
    pub fn actor_id(&self) -> Option<&str> {
        match &self.backend {
            ProviderBackend::Local { scope, .. } => Some(&scope.actor),
            _ => None,
        }
    }
    pub fn turn_id(&self) -> Option<&str> {
        match &self.backend {
            ProviderBackend::Local { scope, .. } => scope.turn.as_deref(),
            _ => None,
        }
    }
    pub fn step_id(&self) -> Option<&str> {
        match &self.backend {
            ProviderBackend::Local { scope, .. } => scope.step.as_deref(),
            _ => None,
        }
    }
    pub fn log(&self, message: impl std::fmt::Display) {
        eprintln!("Provider {}: {message}", self.name);
    }
    pub async fn emit(&self, kind: &str, data: Value) -> Result<()> {
        self.check()?;
        let backend = match &self.backend {
            ProviderBackend::Local { api, scope, .. } => crate::tool::Backend::Local {
                api: api.clone(),
                scope: scope.as_ref().clone(),
            },
            ProviderBackend::Remote { peer, parent } => crate::tool::Backend::Remote {
                peer: peer.clone(),
                parent: parent.clone(),
            },
        };
        crate::context::emit(&backend, &self.session, kind, data).await
    }
    pub async fn named_credential(&self, name: &str) -> Result<String> {
        self.check()?;
        let ProviderBackend::Local { api, .. } = &self.backend else {
            return Err(crate::plugin::cannot_serve("named credentials"));
        };
        crate::context::named_credential(api, name)
    }
    pub fn cancelled(&self) -> &CancellationToken {
        &self.cancelled
    }
    fn check(&self) -> Result<()> {
        if self.done.is_cancelled() {
            return Err(Error::new(Code::InvalidRequest, "the request has settled"));
        }
        if self.cancelled.is_cancelled() {
            return Err(Error::new(Code::Cancelled, "the request was cancelled"));
        }
        Ok(())
    }
    pub async fn credential(&self) -> Result<String> {
        self.check()?;
        match &self.backend {
            ProviderBackend::Local { api, claim, .. } => {
                let store =
                    base::capability::<dyn base::CredentialStore>(api.as_ref(), "credentials")?;
                Ok(store.provider(claim, &self.name)?)
            }
            ProviderBackend::Remote { peer, .. } => {
                let reply = peer
                    .call(
                        "host/credentials/read",
                        json!({"provider":self.name}),
                        None,
                        self.cancelled.clone(),
                    )
                    .await
                    .map_err(crate::serve::from_fault)?;
                reply["credential"]["key"]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| Error::new(Code::NotFound, "Provider credential unavailable"))
            }
        }
    }
    pub async fn piece(
        &self,
        kind: Piece,
        delta: impl Into<String>,
        tool_call_id: Option<&str>,
    ) -> Result<()> {
        self.check()?;
        let delta = delta.into();
        let ProviderBackend::Local { api, scope, .. } = &self.backend else {
            let ProviderBackend::Remote { peer, parent } = &self.backend else {
                unreachable!()
            };
            let mut event = json!({"type":match kind { Piece::Text => "text", Piece::Reasoning => "reasoning", Piece::ToolInput => "toolInput" }, "delta":delta});
            if let (Piece::ToolInput, Some(id)) = (kind, tool_call_id) {
                event["toolCallId"] = json!(id);
            }
            peer.notify(
                "provider/event",
                json!({"parentRequestId":parent,"event":event}),
            );
            return Ok(());
        };
        let mut event = base::Event::new(
            scope,
            match kind {
                Piece::Text => "model.delta",
                Piece::Reasoning => "model.thought",
                Piece::ToolInput => "model.tool_input",
            },
            json!(delta),
        );
        if let Some(id) = tool_call_id {
            event.scope.call = Some(id.into());
        }
        event.stream = Some(self.stream.clone());
        Ok(api.emit(event).await?)
    }
}

/// Subscriptions are coalesced: each notification means re-read the full catalog.
#[derive(Clone, Default)]
pub struct CatalogNotifier(tokio::sync::watch::Sender<u64>);
impl CatalogNotifier {
    pub fn changed(&self) {
        self.0
            .send_modify(|revision| *revision = revision.wrapping_add(1));
    }
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<u64> {
        self.0.subscribe()
    }
}

pub(crate) struct ProviderPlugin {
    pub name: String,
    pub provider: Arc<dyn Provider>,
}
impl base::Plugin for ProviderPlugin {
    fn name(&self) -> &str {
        &self.name
    }
    fn install(&self, r: &mut base::Registrar<'_>) -> base::Result<()> {
        let id = self.provider.id();
        base::ensure!(!id.is_empty() && !id.contains('/'), "invalid Provider id");
        let models = self.provider.models();
        let mut ids = std::collections::BTreeSet::new();
        for model in models {
            base::ensure!(
                model.model.provider == id
                    && !model.model.id.is_empty()
                    && ids.insert(model.model.id),
                "invalid or duplicate ModelRef for {id}"
            );
        }
        let claim = r.claim_credentials(&[id])?;
        let notifier = CatalogNotifier::default();
        self.provider.catalog_notifier(notifier.clone());
        r.provide::<dyn base::Provider>(
            &self.name,
            Arc::new(Adapter {
                provider: self.provider.clone(),
                claim,
                notifier,
            }),
        )
    }
}

#[derive(Clone)]
struct Adapter {
    provider: Arc<dyn Provider>,
    claim: base::CredentialClaim,
    notifier: CatalogNotifier,
}
impl Adapter {
    fn info(&self, model: &ModelInfo) -> base::ModelInfo {
        base::ModelInfo {
            name: format!("{}/{}", model.model.provider, model.model.id),
            context_window: model.context_window,
            output_limit: model.max_output,
            thinking: model.thinking.clone(),
            keeps_state: self.provider.supports().keeps_state,
            runs_tools: false,
            extra: Value::Object(model.extra.clone()),
        }
    }
}
#[async_trait::async_trait]
impl base::Provider for Adapter {
    fn needs_erasure_discard(&self) -> bool {
        self.provider.supports().keeps_state
    }

    async fn discard_for_erasure(&self, session: &str) -> base::Result<()> {
        Ok(self.provider.discard_state(session).await?)
    }
    fn catalog_changes(&self) -> Option<tokio::sync::watch::Receiver<u64>> {
        Some(self.notifier.subscribe())
    }

    fn catalog(&self) -> Vec<base::ModelInfo> {
        self.provider
            .models()
            .iter()
            .map(|m| self.info(m))
            .collect()
    }
    fn bind(&self, name: &str) -> base::Result<Arc<dyn base::ModelAccess>> {
        let model = self
            .provider
            .models()
            .into_iter()
            .find(|m| self.info(m).name == name)
            .ok_or_else(|| base::anyhow!("unknown model {name}"))?;
        Ok(Arc::new(Bound {
            adapter: self.clone(),
            model,
        }))
    }
}
struct Bound {
    adapter: Adapter,
    model: ModelInfo,
}
#[async_trait::async_trait]
impl base::ModelAccess for Bound {
    fn info(&self) -> base::ModelInfo {
        self.adapter.info(&self.model)
    }
    fn safe_to_repeat(&self) -> bool {
        self.adapter.provider.supports().safe_to_repeat
    }
    async fn discard(&self, session: &str) -> base::Result<()> {
        Ok(self.adapter.provider.discard_state(session).await?)
    }
    async fn refresh(
        &self,
        _api: &base::Api,
        _scope: &base::Scope,
        _cancel: CancellationToken,
    ) -> base::Result<()> {
        if let ProviderAvailability::Unavailable { reason } =
            self.adapter.provider.availability().await
        {
            base::bail!(
                "{}",
                reason
                    .as_deref()
                    .filter(|reason| !reason.trim().is_empty())
                    .unwrap_or("Provider is unavailable")
            );
        }
        base::ensure!(
            self.adapter
                .provider
                .models()
                .iter()
                .any(|model| model.model == self.model.model),
            "selected model is unavailable"
        );
        Ok(())
    }
    async fn generate(
        &self,
        api: base::Api,
        scope: base::Scope,
        request: base::ModelRequest,
        cancelled: CancellationToken,
    ) -> std::result::Result<base::ModelResponse, base::ModelFailure> {
        let fail = |e: Error| base::ModelFailure {
            kind: base::FailureKind::Other,
            message: e.message().into(),
        };
        if let ProviderAvailability::Unavailable { reason } =
            self.adapter.provider.availability().await
        {
            return Err(base::ModelFailure {
                kind: base::FailureKind::Temporary,
                message: reason
                    .filter(|reason| !reason.trim().is_empty())
                    .unwrap_or_else(|| "Provider is unavailable".into()),
            });
        }
        let stream = base::id();
        let done = CancellationToken::new();
        let _on_drop = done.clone().drop_guard();
        let cx = ProviderContext {
            backend: ProviderBackend::Local {
                api: api.clone(),
                scope: Box::new(scope.clone()),
                claim: self.adapter.claim.clone(),
            },
            session: scope.session.clone(),
            name: self.adapter.provider.id().into(),
            cancelled,
            done: done.clone(),
            stream: stream.clone(),
        };
        let reply = self
            .adapter
            .provider
            .request(
                self.model.model.clone(),
                ModelRequest(base::wire::request_for_provider(
                    &request,
                    None,
                    self.adapter.provider.id(),
                )),
                cx,
            )
            .await;
        done.cancel();
        let mut end = base::Event::new(&scope, "model.end", Value::Null);
        end.stream = Some(stream);
        end.end = true;
        api.emit(end).await.map_err(|e| fail(e.into()))?;
        let reply = reply.map_err(fail)?.0;
        if reply["stop"] == "failed" {
            return Err(base::wire::parse_failure(&reply["error"]));
        }
        base::wire::parse_response(reply).map_err(|e| fail(e.into()))
    }
}
