use super::Harness;
use agent_api::*;
use std::{any::Any, path::Path, sync::Arc};

#[async_trait]
impl AgentApi for Harness {
    async fn provider_request(
        &self,
        scope: &Scope,
        model: &ModelInfo,
        request: ModelRequest,
    ) -> Result<ModelRequest> {
        let provider = model.name.split('/').next().unwrap_or(&model.name);
        let result=self.invoke(&self.points["provider.request"],scope,json!({"sessionId":scope.session,"provider":provider,"model":model,"request":request})).await?;
        let mut changed: ModelRequest = serde_json::from_value(result.value["request"].clone())?;
        changed.provider_tools = request.provider_tools;
        Ok(changed)
    }
    async fn provider_response(
        &self,
        scope: &Scope,
        model: &ModelInfo,
        response: &ModelResponse,
    ) -> Result<()> {
        let provider = model.name.split('/').next().unwrap_or(&model.name);
        self.invoke(
            &self.points["provider.response"],
            scope,
            json!({"sessionId":scope.session,"provider":provider,"model":model,"message":response}),
        )
        .await?;
        Ok(())
    }
    async fn shutdown(&self) -> Result<()> {
        let plugins = self.plugins.lock().unwrap().clone();
        let mut result = Ok(());
        for plugin in plugins.iter().rev() {
            if let Err(e) = plugin.shutdown().await
                && result.is_ok()
            {
                result = Err(e);
            }
        }
        result
    }
    async fn create(&self, project: &Path, settings: Value) -> Result<String> {
        Harness::create(self, project, settings).await
    }
    async fn create_in_tenant(
        &self,
        project: &Path,
        settings: Value,
        tenant: Option<&str>,
    ) -> Result<String> {
        self.create_tenanted(project, settings, tenant, false).await
    }
    async fn create_provisional(
        &self,
        project: &Path,
        settings: Value,
        tenant: Option<&str>,
    ) -> Result<String> {
        self.create_tenanted(project, settings, tenant, true).await
    }
    fn tenant(&self, session: &str) -> Result<Value> {
        self.tenant_info(session)
    }
    async fn open(&self, session: &str) -> Result<()> {
        Harness::open(self, session).await
    }
    async fn install_recovery(&self, session: &str) -> Result<Vec<Input>> {
        Harness::install_recovery(self, session).await
    }
    async fn run_recovery(&self, session: &str) -> Result<()> {
        Harness::run_recovery(self, session).await
    }
    async fn close(&self, session: &str) -> Result<()> {
        Harness::close(self, session).await
    }
    async fn submit(
        &self,
        session: &str,
        actor: &str,
        text: &str,
        timing: Timing,
        key: Option<String>,
    ) -> Result<Receipt> {
        Harness::submit(self, session, actor, text, timing, key).await
    }
    async fn submit_as(
        &self,
        scope: &Scope,
        sponsor: &str,
        text: &str,
        timing: Timing,
        key: Option<String>,
    ) -> Result<Receipt> {
        self.submit_content_as(
            scope,
            Some(sponsor),
            wire::text_content(text),
            timing,
            key,
            None,
        )
        .await
    }
    async fn release(
        &self,
        scope: &Scope,
        input: &str,
        timing: Timing,
        declined: bool,
    ) -> Result<&'static str> {
        self.release_proposal(scope, input, timing, declined).await
    }
    async fn withdraw_proposal(&self, scope: &Scope, sponsor: &str, input: &str) -> Result<()> {
        self.remove_proposal(scope, sponsor, input).await
    }
    async fn next_turn(&self, session: &str) -> Result<Option<TurnResult>> {
        Harness::run_next(self, session).await
    }
    async fn cancel(&self, session: &str) -> Result<Vec<Input>> {
        Harness::cancel(self, session).await
    }
    async fn withdraw(&self, session: &str, input: &str) -> Result<Input> {
        Harness::withdraw(self, session, input).await
    }
    async fn history_view(&self, session: &str) -> Result<Value> {
        Harness::history_view(self, session).await
    }
    fn declaration(&self) -> Result<Value> {
        Harness::declaration(self)
    }
    fn writer_interruption(&self, session: &str) -> Result<CancellationToken> {
        self.writer_interruption_token(session)
    }
    fn check_writer(&self, session: &str) -> Result<()> {
        self.check_session_writer(session)
    }
    fn delivery_generation(&self, session: &str) -> Result<CancellationToken> {
        self.sessions
            .lock()
            .unwrap()
            .get(session)
            .map(|open| open.generation.clone())
            .ok_or_else(|| anyhow!("session not open"))
    }
    fn delivery_epoch(&self, session: &str) -> Result<Option<String>> {
        self.writer_delivery_epoch(session)
    }
    fn cancellation(&self, session: &str) -> Result<CancellationToken> {
        self.turn_cancellation(session)
    }
    fn capability(&self, name: &str) -> Result<Arc<dyn Any + Send + Sync>> {
        self.registry.read().unwrap().capability(name)
    }
    fn provider_credential(&self, name: &str) -> bool {
        let r = self.registry.read().unwrap();
        r.has_credential_claim(name)
            || r.capability_names("provider.")
                .iter()
                .any(|key| key.strip_prefix("provider.") == Some(name))
    }

    fn capability_names(&self, prefix: &str) -> Vec<String> {
        self.registry.read().unwrap().capability_names(prefix)
    }
    fn tool_registration(&self, key: &str) -> Value {
        self.registry.read().unwrap().tool_registration(key)
    }
    fn park_approval(&self, question: &Question) -> Result<Option<bool>> {
        self.park(question)
    }
    async fn approval_dispatch(
        &self,
        scope: &Scope,
        call: &ToolCall,
        cover: Option<&ApprovalCover>,
        after_start: bool,
    ) -> Result<Option<ToolStatus>> {
        let status = self.check_approval(scope, call, after_start).await?;
        if status.is_none()
            && let Some(cover) = cover
            && !self.cover_is_current(scope, call, cover)?
        {
            return Ok(Some(ToolStatus::Refused));
        }
        Ok(status)
    }
    async fn deliver_approval(
        &self,
        session: &str,
        id: &str,
        route: &ApprovalRoute,
    ) -> Result<bool> {
        self.approval_view(session, id, route, None).await
    }
    async fn decide_approval(
        &self,
        session: &str,
        id: &str,
        route: &ApprovalRoute,
        allow: bool,
        reason: Option<String>,
    ) -> Result<bool> {
        self.approval_view(session, id, route, Some((allow, reason)))
            .await
    }
    fn question_trace(&self, session: &str, question: &str) -> Option<String> {
        self.sessions
            .lock()
            .unwrap()
            .get(session)?
            .question_contexts
            .get(question)
            .cloned()
    }
    fn snapshot(&self, session: &str) -> Result<SessionData> {
        self.session_snapshot(session)
    }
    fn job_records(&self, session: &str) -> Result<Vec<Job>> {
        let sessions = self.sessions.lock().unwrap();
        let open = sessions.get(session).ok_or(SessionNotOpen)?;
        jobs(&open.data)
    }
    fn authority(&self, session: &str, actor: &str) -> Result<Authority> {
        self.actor_authority(session, actor)
    }
    fn grant(&self, scope: &Scope, actor: &str, authority: Authority) -> Result<()> {
        self.grant_actor(scope, actor, authority)
    }
    fn publish(
        &self,
        scope: &Scope,
        writer: &str,
        drafts: Vec<Draft>,
        input: Option<(String, String)>,
        key: Option<String>,
    ) -> Result<Vec<Entry>> {
        self.publish_history(scope, writer, drafts, input, key)
    }
    fn append(&self, scope: &Scope, writer: &str, draft: Draft) -> Result<Entry> {
        self.append_history(scope, writer, draft)
    }
    fn has_steering(&self, session: &str) -> Result<bool> {
        self.steering_pending(session)
    }
    fn reserve_response_calls(&self, scope: &Scope, response: &ModelResponse) -> Result<()> {
        self.stage_response_calls(scope, response)
    }
    fn take_steering(&self, scope: &Scope) -> Result<Vec<Input>> {
        self.take_steering_inner(scope, false)
    }
    fn take_final_steering(&self, scope: &Scope) -> Result<Vec<Input>> {
        self.take_steering_inner(scope, true)
    }
    fn is_running(&self, session: &str) -> bool {
        self.turn_active(session)
    }
    fn settings(&self, scope: &Scope, patch: Value) -> Result<Value> {
        self.change_settings(scope, patch)
    }
    async fn rewind(&self, scope: &Scope, position: String) -> Result<Vec<String>> {
        let _erasure = self
            .erasure
            .try_read()
            .map_err(|_| anyhow!("erasure in progress"))?;
        self.rewind_project(scope, position).await
    }
    fn rewind_pending(&self, session: &str) -> Result<bool> {
        let sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get(session)
            .ok_or_else(|| anyhow!("session not open"))?;
        Ok(open.journal_uncertain || open.data.unresolved_rewind().is_some())
    }
    fn begin_environment_work(&self, session: &str) -> Result<Box<dyn Send>> {
        self.start_environment_work(session, false)
    }
    fn move_position(&self, scope: &Scope, position: Option<String>) -> Result<()> {
        self.move_history_position(scope, position)
    }
    fn fork(&self, scope: &Scope, position: Option<String>) -> Result<String> {
        self.fork_session(scope, position)
    }
    fn list(&self, project: Option<&Path>) -> Result<Vec<SessionData>> {
        self.list_sessions(project)
    }
    async fn erase(&self, scope: &Scope, entries: Vec<String>) -> Result<ErasureReport> {
        self.erase_history(scope, entries).await
    }
    async fn invoke(&self, point: &HookPoint, scope: &Scope, value: Value) -> Result<HookResult> {
        let registry = self.registry.read().unwrap().clone();
        registry.invoke(self.api(), point, scope, value).await
    }
    fn reserve_output(&self, session: &str, bytes: u64) -> Result<Box<dyn Send>> {
        self.reserve_output_buffer(session, bytes)
    }
    async fn output(&self, scope: &Scope, output: Output) -> Result<Option<Value>> {
        self.gate_output(scope, output).await
    }
    async fn emit(&self, event: Event) -> Result<()> {
        self.deliver_event(event).await
    }
    async fn command(&self, scope: &Scope, name: &str, args: &str) -> Result<Value> {
        let _workspace = self.begin_environment_work(&scope.session)?;
        require(self, scope, "input")?;
        let _reservation = self
            .reservations()
            .command(&self.snapshot(&scope.session)?)?;
        let h = self.registry.read().unwrap().command(name)?;
        Ok(h.handle(self.api(), scope.clone(), json!({"args":args}))
            .await?
            .value)
    }
    fn commands(&self) -> Vec<String> {
        self.registry.read().unwrap().commands()
    }
    fn interface_available(&self, data: &SessionData, name: &str) -> bool {
        self.interface_offer(data, name)
    }
    async fn handoff_interface_tool(
        &self,
        scope: &Scope,
        call: &ToolCall,
        start: Draft,
    ) -> Result<Option<ToolResult>> {
        self.stage_interface_call(scope, call, start).await
    }
    fn finish_interface_calls(&self, scope: &Scope, result: &mut TurnResult) -> Result<()> {
        self.finish_interface_turn(scope, result)
    }
    fn covering_approval(&self, scope: &Scope, call: &ToolCall) -> Option<ApprovalCover> {
        self.live_covers.parent(scope, call)
    }
    async fn dispatch_tool(
        &self,
        scope: &Scope,
        call: ToolCall,
        cancel: CancellationToken,
        cover: Option<ApprovalCover>,
    ) -> ToolResult {
        self.run_registered_tool(scope, call, cancel, cover).await
    }
}
