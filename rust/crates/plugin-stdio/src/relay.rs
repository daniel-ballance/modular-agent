//! Preserve the work API while directing environment output only to its caller.
use crate::rpc::Peer;
use agent_api::*;
use std::{any::Any, path::Path, sync::Arc};
pub enum Route {
    Environment,
    RuntimeModel,
}
pub struct Relay {
    pub inner: Api,
    pub peer: Arc<Peer>,
    pub id: Value,
    pub route: Route,
}
#[async_trait]
impl AgentApi for Relay {
    async fn provider_request(
        &self,
        s: &Scope,
        m: &ModelInfo,
        r: ModelRequest,
    ) -> Result<ModelRequest> {
        self.inner.provider_request(s, m, r).await
    }
    async fn provider_response(&self, s: &Scope, m: &ModelInfo, r: &ModelResponse) -> Result<()> {
        self.inner.provider_response(s, m, r).await
    }
    async fn create(&self, p: &Path, s: Value) -> Result<String> {
        self.inner.create(p, s).await
    }
    async fn open(&self, s: &str) -> Result<()> {
        self.inner.open(s).await
    }
    async fn install_recovery(&self, s: &str) -> Result<Vec<Input>> {
        self.inner.install_recovery(s).await
    }
    async fn run_recovery(&self, s: &str) -> Result<()> {
        self.inner.run_recovery(s).await
    }
    async fn close(&self, s: &str) -> Result<()> {
        self.inner.close(s).await
    }
    async fn submit(
        &self,
        s: &str,
        a: &str,
        t: &str,
        w: Timing,
        k: Option<String>,
    ) -> Result<Receipt> {
        self.inner.submit(s, a, t, w, k).await
    }
    async fn next_turn(&self, s: &str) -> Result<Option<TurnResult>> {
        self.inner.next_turn(s).await
    }
    async fn cancel(&self, s: &str) -> Result<Vec<Input>> {
        self.inner.cancel(s).await
    }
    async fn withdraw(&self, s: &str, i: &str) -> Result<Input> {
        self.inner.withdraw(s, i).await
    }
    async fn history_view(&self, s: &str) -> Result<Value> {
        self.inner.history_view(s).await
    }
    fn declaration(&self) -> Result<Value> {
        self.inner.declaration()
    }
    fn check_writer(&self, s: &str) -> Result<()> {
        self.inner.check_writer(s)
    }
    fn cancellation(&self, s: &str) -> Result<CancellationToken> {
        self.inner.cancellation(s)
    }
    fn capability(&self, n: &str) -> Result<Arc<dyn Any + Send + Sync>> {
        self.inner.capability(n)
    }
    fn capability_names(&self, n: &str) -> Vec<String> {
        self.inner.capability_names(n)
    }
    fn snapshot(&self, s: &str) -> Result<SessionData> {
        self.inner.snapshot(s)
    }
    fn authority(&self, s: &str, a: &str) -> Result<Authority> {
        self.inner.authority(s, a)
    }
    fn grant(&self, s: &Scope, a: &str, r: Authority) -> Result<()> {
        self.inner.grant(s, a, r)
    }
    fn publish(
        &self,
        s: &Scope,
        w: &str,
        d: Vec<Draft>,
        i: Option<(String, String)>,
        k: Option<String>,
    ) -> Result<Vec<Entry>> {
        self.inner.publish(s, w, d, i, k)
    }
    fn append(&self, s: &Scope, w: &str, d: Draft) -> Result<Entry> {
        self.inner.append(s, w, d)
    }
    fn take_steering(&self, s: &Scope) -> Result<Vec<Input>> {
        self.inner.take_steering(s)
    }
    fn is_running(&self, s: &str) -> bool {
        self.inner.is_running(s)
    }
    fn settings(&self, s: &Scope, p: Value) -> Result<Value> {
        self.inner.settings(s, p)
    }
    fn begin_environment_work(&self, s: &str) -> Result<Box<dyn Send>> {
        self.inner.begin_environment_work(s)
    }
    fn move_position(&self, s: &Scope, p: Option<String>) -> Result<()> {
        self.inner.move_position(s, p)
    }
    fn fork(&self, s: &Scope, p: Option<String>) -> Result<String> {
        self.inner.fork(s, p)
    }
    fn tenant(&self, session: &str) -> Result<Value> {
        self.inner.tenant(session)
    }
    fn list(&self, p: Option<&Path>) -> Result<Vec<SessionData>> {
        self.inner.list(p)
    }
    async fn erase(&self, s: &Scope, e: Vec<String>) -> Result<ErasureReport> {
        self.inner.erase(s, e).await
    }
    async fn invoke(&self, p: &HookPoint, s: &Scope, v: Value) -> Result<HookResult> {
        self.inner.invoke(p, s, v).await
    }
    async fn output(&self, s: &Scope, o: Output) -> Result<Option<Value>> {
        self.inner.output(s, o).await
    }
    async fn command(&self, s: &Scope, n: &str, a: &str) -> Result<Value> {
        self.inner.command(s, n, a).await
    }
    fn commands(&self) -> Vec<String> {
        self.inner.commands()
    }
    fn covering_approval(&self, scope: &Scope, call: &ToolCall) -> Option<ApprovalCover> {
        self.inner.covering_approval(scope, call)
    }
    async fn dispatch_tool(
        &self,
        s: &Scope,
        c: ToolCall,
        t: CancellationToken,
        cover: Option<ApprovalCover>,
    ) -> ToolResult {
        self.inner.dispatch_tool(s, c, t, cover).await
    }
    async fn emit(&self, e: Event) -> Result<()> {
        match self.route {
            Route::Environment => {
                if e.kind == "tool.progress" {
                    self.peer.notify(
                        "host/env/output",
                        json!({"parentRequestId":self.id,"chunk":e.content.as_str().unwrap_or("")}),
                    );
                }
                return self.inner.emit(e).await;
            }
            Route::RuntimeModel => {
                let kind = match e.kind.as_str() {
                    "model.delta" => "text",
                    "model.thought" => "reasoning",
                    "model.tool_input" => "toolInput",
                    "model.end" => return self.inner.emit(e).await,
                    _ => return self.inner.emit(e).await,
                };
                self.peer.notify(
                    "host/runtime/modelEvent",
                    json!({"parentRequestId":self.id,"event":{"type":kind,"delta":e.content}}),
                );
                return self.inner.emit(e).await;
            }
        }
    }
}
