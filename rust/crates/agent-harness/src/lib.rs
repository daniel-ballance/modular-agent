//! Hosts plugins and owns sessions. Inference, turns, I/O and presentation are delegated.
use agent_api::{
    telemetry::{Context, KeyValue, Operation, SpanKind, TraceContextExt},
    *,
};
mod authority;
mod bytes;
mod continuation;
mod history_branch;
mod history_commit;
mod input_admission;
mod output_gate;
mod session_erasure;
mod session_lifecycle;
mod turn_execution;
mod writer;
pub use bytes::{ByteCapacity, ByteLimits};
mod capacity;
mod covered_approvals;
mod waiting_approvals;
pub use capacity::{Capacity, Pool as ReservationPool, ResourceLimits};
mod interface_tools;
mod output;
pub use interface_tools::{InterfaceConnection, InterfaceReportDisposition, InterfaceToolSource};
pub use output::{apply_redactions, encode as output_event};
pub mod receipt;
mod rewind;
mod tenants;
use output_gate::HeldOutput;
use std::{
    any::Any,
    collections::{BTreeMap, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock, Weak},
};

struct OpenSession {
    data: SessionData,
    lease: Option<Box<dyn Lease>>,
    provisional: bool,
    generation: CancellationToken,
    commits: Option<tokio::sync::broadcast::Sender<()>>,
    interruption: CancellationToken,
    queue: VecDeque<Input>,
    input_contexts: BTreeMap<String, Context>,
    question_contexts: BTreeMap<String, String>,
    approval_views: waiting_approvals::Views,
    interrupted: Vec<(Arc<dyn Runtime>, Scope)>,
    active: Option<ActiveTurn>,
    rewinding: bool,
    journal_uncertain: bool,
    environment_work: usize,
    steer_closed: bool,
    continuation_waiters: BTreeMap<String, Weak<CancellationToken>>,
    cancel: CancellationToken,
}
impl Drop for OpenSession {
    fn drop(&mut self) {
        self.generation.cancel();
    }
}

enum ActiveTurn {
    Recovery,
    Running(String),
}

type PrivateErasure = dyn Fn(&SessionData) -> Result<()> + Send + Sync;
pub struct Harness {
    me: Weak<Harness>,
    agent_name: std::sync::OnceLock<String>,
    project: Option<PathBuf>,
    approval_maximum: std::sync::OnceLock<u64>,
    live_covers: covered_approvals::Dispatches,
    approval_audiences: RwLock<waiting_approvals::Audiences>,
    tenants: RwLock<tenants::Tenants>,
    registry: RwLock<Registry>,
    points: BTreeMap<String, HookPoint>,
    plugins: Mutex<Vec<Arc<dyn Plugin>>>,
    sessions: Mutex<BTreeMap<String, OpenSession>>,
    blocked_projects: Mutex<BTreeMap<PathBuf, String>>,
    pending_events: Mutex<Vec<Event>>,
    held_output: Mutex<HeldOutput>,
    interface_tools: interface_tools::InterfaceTools,
    admissions: Mutex<BTreeMap<String, Arc<tokio::sync::Mutex<()>>>>,
    erasure: tokio::sync::RwLock<()>,
    reservations: RwLock<Arc<ReservationPool>>,
    private_erasure: std::sync::OnceLock<Box<PrivateErasure>>,
}
impl Harness {
    pub fn new() -> Arc<Self> {
        Self::with_project(None)
    }
    pub fn for_project(project: PathBuf) -> Arc<Self> {
        Self::with_project(Some(project))
    }
    fn with_project(project: Option<PathBuf>) -> Arc<Self> {
        let (registry, points) = Registry::with_harness_hooks();
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            agent_name: Default::default(),
            private_erasure: Default::default(),
            project,
            approval_maximum: Default::default(),
            live_covers: Default::default(),
            approval_audiences: Default::default(),
            tenants: RwLock::default(),
            registry: RwLock::new(registry),
            points,
            plugins: Mutex::default(),
            sessions: Mutex::default(),
            blocked_projects: Mutex::default(),
            pending_events: Mutex::default(),
            held_output: Mutex::default(),
            interface_tools: Default::default(),
            admissions: Mutex::default(),
            erasure: tokio::sync::RwLock::default(),
            reservations: RwLock::new(Arc::new(ReservationPool::new(ResourceLimits::default()))),
        })
    }
    pub fn configure_reservations(&self, pool: Arc<ReservationPool>) -> Result<()> {
        ensure!(
            self.sessions.lock().unwrap().is_empty(),
            "capacity is fixed while sessions are open"
        );
        *self.reservations.write().unwrap() = pool;
        Ok(())
    }
    pub fn reservations(&self) -> Arc<ReservationPool> {
        self.reservations.read().unwrap().clone()
    }
    pub fn rebuild_reservations(&self) -> Result<()> {
        if let Some(store) = self.store() {
            let pool = self.reservations();
            for data in store.list(None)? {
                pool.rebuild(&data);
            }
        }
        Ok(())
    }
    pub fn provider_points(&self) -> BTreeMap<String, HookPoint> {
        ["provider.request", "provider.response"]
            .into_iter()
            .map(|name| (name.into(), self.points[name].clone()))
            .collect()
    }
    pub fn runtime_points(&self) -> BTreeMap<String, HookPoint> {
        self.registry.read().unwrap().runtime_points()
    }
    fn api(&self) -> Api {
        self.me.upgrade().expect("Harness is alive")
    }
    fn store(&self) -> Option<Arc<dyn HistoryStore>> {
        capability(self, "history").ok()
    }
    pub async fn load(&self, plugin: Arc<dyn Plugin>) -> Result<()> {
        self.load_replacing(plugin, &[]).await
    }
    pub async fn load_replacing(&self, plugin: Arc<dyn Plugin>, items: &[String]) -> Result<()> {
        ensure!(
            self.sessions.lock().unwrap().is_empty(),
            "plugins are fixed while sessions are open"
        );
        // An environment can replace the project directory during rewind.
        // The process's launch directory may then no longer have a path.
        let project = match &self.project {
            Some(project) => project.clone(),
            None => std::env::current_dir()?,
        };
        let result = self
            .invoke(
                &self.points["plugin.load"],
                &Scope::default(),
                json!({"plugin":plugin.name(),"project":project}),
            )
            .await?;
        ensure!(
            result.refused.is_none(),
            "plugin refused: {:?}",
            result.refused
        );
        let mut candidate = self.registry.read().unwrap().clone();
        let empty = SessionData {
            id: String::new(),
            project,
            settings: json!({}),
            plugins: vec![],
            position: None,
            entries: vec![],
            origin: None,
        };
        candidate.omit_local(items, &empty)?;
        candidate.load(plugin.as_ref())?;
        candidate.validate_tools(&empty)?;
        let mut plugins = self.plugins.lock().unwrap();
        ensure!(
            !plugins
                .iter()
                .any(|p| p.registered_name() == plugin.registered_name()
                    && Some(p.name()) != plugin.replaces()),
            "plugin name {} is already loaded",
            plugin.registered_name()
        );
        if let Some(old) = plugin.replaces()
            && let Some(i) = plugins.iter().position(|p| p.name() == old)
        {
            plugins[i].stop()?;
            plugins.remove(i);
        }
        *self.registry.write().unwrap() = candidate;
        plugins.push(plugin);
        Ok(())
    }

    fn invalidate_providers(&self, session: &str) -> Result<()> {
        for name in self.capability_names("provider.") {
            capability::<dyn Provider>(self, &name)?.invalidate(session);
        }
        Ok(())
    }
    pub fn declaration(&self) -> Result<Value> {
        let runtime: Arc<dyn Runtime> = capability(self, "runtime")?;
        let env: Arc<dyn WorkingEnvironment> = capability(self, "environment")?;
        let mut declaration = json!({"runtime":runtime.declaration(),"environment":env.declaration(),"forking":true,"erasure":self.store().is_some_and(|store|store.coordinates_erasure()),"several_actors":true,"rewinding":self.project.as_ref().map_or(env.declaration()["rewinding"] == true, |project| env.keeps_points(project)),"input_keys":true,"holds_output":false,"plugins_during_session":false,"live_sessions":false,"provider_state":false,"provider_tools":false,"starts_unasked_turns":false,"output_bypass":false,"questions_outlast_turn":false,"queued_input_after_restart":"handedBack","queued_job_reports_after_restart":"run","settings_during_turn":"refused","retention":"indefinite"});
        merge(
            &mut declaration,
            self.registry.read().unwrap().declaration(),
        );
        declaration["telemetry"] = json!(1);
        if self.max_approval_wait_ms().is_some() {
            declaration["approvals_outlast_turns"] = json!(true);
        }
        if self.has_interface_tools() {
            declaration["interface_tools"] = json!(true);
        }
        declaration["resource_reservations"] = json!(self.reservations().limits());
        Ok(declaration)
    }
}
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
        let sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get(&scope.session)
            .ok_or_else(|| anyhow!("session not open"))?;
        self.reservations().stage_response(
            &open.data,
            (scope.turn.clone(), scope.step.clone()),
            response,
        )
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
        require(self, scope, "settings")?;
        self.validate_approval_wait(&patch)?;
        ensure!(
            patch
                .as_object()
                .is_none_or(|o| o.keys().all(|k| !k.starts_with('_'))),
            "internal session limits cannot change through settings"
        );
        ensure!(
            !self.is_running(&scope.session),
            OperationError::Busy("settings cannot change during a turn".into())
        );
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(&scope.session)
            .ok_or_else(|| OperationError::NotFound("unknown session".into()))?;
        open.check_rewind()?;
        let mut next = open.data.clone();
        let model_changed = patch
            .get("model")
            .is_some_and(|m| m != &next.settings["model"]);
        merge(&mut next.settings, patch);
        if model_changed {
            self.invalidate_providers(&scope.session)?;
        }
        let entry = history_commit::make_entry(
            &next,
            scope,
            "harness",
            Draft::new("settings", false, next.settings.clone()).copying(
                next.entries
                    .iter()
                    .filter(|e| e.kind == "settings")
                    .map(|e| e.id.clone())
                    .collect(),
            ),
        );
        next.position = Some(entry.id.clone());
        next.entries.push(entry.clone());
        self.commit(open, &next)?;
        open.data = next.clone();
        self.pending_events.lock().unwrap().push(Event::new(
            scope,
            "setting.changed",
            json!(entry),
        ));
        self.reconcile_open_approvals(open, false)?;
        Ok(next.settings)
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
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(session)
            .ok_or_else(|| anyhow!("session not open"))?;
        open.check_rewind()?;
        self.check_open_writer(open)?;
        open.environment_work += 1;
        Ok(Box::new(rewind::EnvironmentWork {
            harness: self.me.clone(),
            session: session.into(),
        }))
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
        if let Some(status) = self
            .approval_dispatch(scope, &call, cover.as_ref(), true)
            .await
            .unwrap_or(Some(ToolStatus::Refused))
        {
            telemetry::disposition(scope, &call, &status);
            return ToolResult::new(&call, status, "approval no longer permits dispatch");
        }
        let data = match self.snapshot(&scope.session) {
            Ok(s) => s,
            Err(e) => return ToolResult::new(&call, ToolStatus::Failed, e.to_string()),
        };
        for name in self.capability_names("tools.") {
            if let Ok(source) = capability::<dyn ToolSource>(self, &name)
                && source.tools(&data).iter().any(|t| t.name == call.name)
            {
                if let Err(error) = self.check_writer(&scope.session) {
                    return ToolResult::new(&call, ToolStatus::NotStarted, error.to_string());
                }
                let mut attrs = telemetry::tool_attributes(&call);
                if let Some(agent) = self.agent_name.get() {
                    attrs.push(KeyValue::new("gen_ai.agent.name", agent.clone()));
                }
                let name = telemetry::name(&call.name)
                    .map_or_else(|| "execute_tool".into(), |n| format!("execute_tool {n}"));
                let op = Operation::new(name, SpanKind::Internal, Some(scope), attrs);
                let _dispatch = match cover {
                    Some(cover) => match self.live_covers.begin(scope, &call, cover) {
                        Ok(guard) => Some(guard),
                        Err(error) => {
                            return ToolResult::new(&call, ToolStatus::Refused, error.to_string());
                        }
                    },
                    None => None,
                };
                let result = op
                    .run(source.run(self.api(), scope.clone(), call, cancel))
                    .await;
                op.attr("modular_agent.tool.status", wire::status(&result.status));
                if result.status == ToolStatus::Failed {
                    op.error("tool_failed");
                }
                return result;
            }
        }
        ToolResult::new(
            &call,
            ToolStatus::Failed,
            format!("unknown tool {}", call.name),
        )
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        for plugin in self.plugins.get_mut().unwrap().iter().rev() {
            let _ = plugin.stop();
        }
    }
}
