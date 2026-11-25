//! Hosts plugins and owns sessions. Inference, turns, I/O and presentation are delegated.
use agent_api::{
    telemetry::{Context, KeyValue, Operation, SpanKind, TraceContextExt},
    *,
};
mod authority;
mod bytes;
mod continuation;
mod history_commit;
mod input_admission;
mod turn_execution;
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
use history_commit::{make_entry, push_setup};
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

const GATE_SEGMENT: u64 = 4 << 20;
const MAX_HELD: u64 = 64 << 20;
#[derive(Default)]
struct HeldPieces {
    bytes: u64,
    pieces: Vec<(Event, Value, capacity::Buffer)>,
}
// None marks a blocked stream. Ignore later pieces until its end.
type HeldOutput = BTreeMap<(String, String, String), Option<HeldPieces>>;

#[derive(Debug)]
struct OutputOverflow;
impl std::fmt::Display for OutputOverflow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("output exceeds the gate or buffer limit")
    }
}
impl std::error::Error for OutputOverflow {}

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
    pub fn on_reconciled_erasure(
        &self,
        remove: impl Fn(&SessionData) -> Result<()> + Send + Sync + 'static,
    ) {
        assert!(self.private_erasure.set(Box::new(remove)).is_ok());
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
    pub async fn create(&self, project: &Path, settings: Value) -> Result<String> {
        self.create_tenanted(project, settings, None, false).await
    }
    async fn create_tenanted(
        &self,
        project: &Path,
        settings: Value,
        tenant: Option<&str>,
        provisional: bool,
    ) -> Result<String> {
        let op = Operation::new(
            "modular_agent.session.open",
            SpanKind::Internal,
            None,
            vec![KeyValue::new("modular_agent.session.operation", "new")],
        );
        op.run(async {
            let parent = settings["_parent"]["session"]
                .as_str()
                .map(|session| self.snapshot(session))
                .transpose()?;
            let inherited = parent.as_ref().and_then(tenants::name);
            ensure!(
                tenant.is_none() || inherited.is_none() || tenant == inherited,
                "child cannot choose another tenant"
            );
            let tenant = tenant.or(inherited);
            if let Some(name) = tenant {
                self.check_tenant(name)?;
            }
            let project = project.canonicalize()?;
            ensure!(project.is_dir(), "project must be a directory");
            let mut defaults = match capability::<dyn Configuration>(self, "configuration") {
                Ok(c) => c.settings(&project)?,
                Err(_) => json!({}),
            };
            merge(&mut defaults, settings);
            self.validate_approval_wait(&defaults)?;
            if self.max_approval_wait_ms().is_some() && defaults.get("approvalWait").is_none() {
                defaults["approvalWait"] = json!("live");
            }
            let id = id();
            op.attr("gen_ai.conversation.id", id.clone());
            let lease = if provisional {
                None
            } else {
                self.store().map(|s| s.acquire(&id)).transpose()?
            };
            let mut data = SessionData {
                id: id.clone(),
                project,
                settings: defaults,
                plugins: self.registry.read().unwrap().names(),
                position: None,
                entries: vec![],
                origin: None,
            };
            if let Some(tenant) = tenant {
                let entry = make_entry(
                    &data,
                    &Scope::session(&id),
                    "harness",
                    Draft::new("tenant", false, json!({"tenant":tenant})),
                );
                data.position = Some(entry.id.clone());
                data.entries.push(entry);
            }
            if provisional && !data.settings.as_object().is_none_or(|o| o.is_empty()) {
                push_setup(&mut data, "settings", |data| data.settings.clone());
            }
            {
                let mut sessions = self.sessions.lock().unwrap();
                self.check_project_open(&sessions, &data)?;
                sessions.insert(
                    id.clone(),
                    OpenSession {
                        data,
                        lease,
                        provisional,
                        commits: None,
                        generation: CancellationToken::new(),
                        interruption: CancellationToken::new(),
                        queue: VecDeque::new(),
                        input_contexts: BTreeMap::new(),
                        question_contexts: BTreeMap::new(),
                        approval_views: Default::default(),
                        interrupted: Vec::new(),
                        active: None,
                        rewinding: false,
                        journal_uncertain: false,
                        environment_work: 0,
                        steer_closed: false,
                        continuation_waiters: Default::default(),
                        cancel: CancellationToken::new(),
                    },
                );
            }
            self.watch_writer(&id);
            if let Err(error) = self.prepare_session(&id).await {
                let _ = self.close(&id).await;
                self.sessions.lock().unwrap().remove(&id);
                return Err(error);
            }
            self.append(
                &Scope::session(&id),
                "harness",
                Draft::new(
                    "plugins.changed",
                    false,
                    json!({"active":self.snapshot(&id)?.plugins}),
                ),
            )?;
            if let Err(error) = self
                .invoke(
                    &self.points["session.start"],
                    &Scope::session(&id),
                    json!({"resumed":false}),
                )
                .await
            {
                let _ = self.close(&id).await;
                self.sessions.lock().unwrap().remove(&id);
                return Err(error);
            }
            self.emit(Event::new(
                &Scope::session(&id),
                "session.start",
                json!({"reopened":false}),
            ))
            .await?;
            Ok(id)
        })
        .await
    }
    /// Test-only crash seam. The caller has already dropped or stopped every worker.
    /// Release writer leases without orderly shutdown, cancellation or settlement.
    #[doc(hidden)]
    pub fn abandon_sessions_for_test(&self) {
        self.sessions.lock().unwrap().clear();
    }

    pub async fn open(&self, id: &str) -> Result<()> {
        self.install_recovery(id).await?;
        if let Err(error) = self.run_recovery(id).await {
            let _ = self.close(id).await;
            self.sessions.lock().unwrap().remove(id);
            return Err(error);
        }
        Ok(())
    }

    async fn install_recovery(&self, id: &str) -> Result<Vec<Input>> {
        Ok(self
            .install_recovery_if(id, |_| Ok(true))
            .await?
            .expect("unconditional open"))
    }

    /// Recheck a discovery predicate under the writer lease, before preparing
    /// plugins or recovering work. A false result leaves the session unopened.
    pub async fn install_recovery_if(
        &self,
        id: &str,
        select: impl FnOnce(&SessionData) -> Result<bool> + Send + 'static,
    ) -> Result<Option<Vec<Input>>> {
        let op = Operation::internal("modular_agent.session.open", &Scope::session(id));
        op.attr("modular_agent.session.operation", "load");
        op.run(async {
            let _erasure = self
                .erasure
                .try_read()
                .map_err(|_| anyhow!("erasure in progress"))?;
            ensure!(
                !self.sessions.lock().unwrap().contains_key(id),
                OperationError::Busy("session already open here".into())
            );
            let store = self.store().ok_or_else(|| anyhow!("no history store"))?;
            let session_id = id.to_owned();
            let loaded = tokio::task::spawn_blocking(move || -> Result<_> {
                let lease = store.acquire(&session_id)?;
                let loaded = store.load(&session_id)?;
                if !select(&loaded)? {
                    return Ok(None);
                }
                let (data, erased) = match store.reconcile_erasure(&session_id)? {
                    Some((data, _)) => (data, true),
                    None => (loaded, false),
                };
                store.check_erasure(&data)?;
                Ok(Some((lease, data, erased)))
            })
            .await??;
            let Some((lease, mut data, erased)) = loaded else {
                return Ok(None);
            };
            if let Some(remove) = self.private_erasure.get() {
                remove(&data)?;
            }
            if erased {
                self.invalidate_providers(id)?;
            }
            if let Some(tenant) = tenants::name(&data) {
                self.check_tenant(tenant)?;
            }
            if !matches!(
                data.settings["approval"].as_str(),
                Some("off" | "ask_unless_read_only" | "ask_always" | "never_ask")
            ) {
                data.settings["approval"] = if data.settings["approval"].is_string()
                    && (self.max_approval_wait_ms().is_some()
                        || waiting_approvals::outstanding(&data))
                {
                    json!("never_ask")
                } else {
                    json!("ask_always")
                };
            }
            data.project = data.project.canonicalize()?;
            let previous_plugins = data.plugins.clone();
            data.plugins = self.registry.read().unwrap().names();
            let plugins_changed = data.plugins != previous_plugins;
            // Repair the journal before session preparation, recovery or new history.
            let recovery = data.unresolved_rewind().is_some();
            let project = data.project.clone();
            {
                let mut sessions = self.sessions.lock().unwrap();
                ensure!(
                    !sessions.contains_key(id),
                    OperationError::Busy("session already open here".into())
                );
                self.check_project_open(&sessions, &data)?;
                if recovery {
                    self.blocked_projects
                        .lock()
                        .unwrap()
                        .insert(project.clone(), id.into());
                } else {
                    self.blocked_projects.lock().unwrap().remove(&project);
                }
                sessions.insert(
                    id.into(),
                    OpenSession {
                        data,
                        lease: Some(lease),
                        provisional: false,
                        commits: None,
                        generation: CancellationToken::new(),
                        interruption: CancellationToken::new(),
                        queue: VecDeque::new(),
                        input_contexts: BTreeMap::new(),
                        question_contexts: BTreeMap::new(),
                        approval_views: Default::default(),
                        interrupted: Vec::new(),
                        active: None,
                        rewinding: recovery,
                        journal_uncertain: false,
                        environment_work: 0,
                        steer_closed: false,
                        continuation_waiters: Default::default(),
                        cancel: CancellationToken::new(),
                    },
                );
            }
            self.watch_writer(id);
            if recovery {
                let result = self.recover_rewind(&Scope::session(id)).await;
                let mut sessions = self.sessions.lock().unwrap();
                if let Err(error) = result {
                    sessions.remove(id);
                    return Err(error);
                }
                sessions.get_mut(id).unwrap().rewinding = false;
                self.blocked_projects.lock().unwrap().remove(&project);
            }
            if let Ok(questions) = requests(self)
                && let Err(error) = questions.recover(self, id)
            {
                self.sessions.lock().unwrap().remove(id);
                return Err(error);
            }
            if let Err(error) = self.prepare_session(id).await {
                let _ = self.close(id).await;
                self.sessions.lock().unwrap().remove(id);
                return Err(error);
            }
            if plugins_changed
                || !self
                    .snapshot(id)?
                    .entries
                    .iter()
                    .any(|e| e.kind == "plugins.changed")
            {
                self.append(
                    &Scope::session(id),
                    "harness",
                    Draft::new(
                        "plugins.changed",
                        false,
                        json!({"previous":previous_plugins,"active":self.snapshot(id)?.plugins}),
                    ),
                )?;
            }
            let snapshot = self.snapshot(id)?;
            let branch = snapshot.branch();
            self.reconcile_approvals(id, true)?;
            self.recover_interface_tools(id, &snapshot)?;
            let mut interrupted = Vec::new();
            for scope in unfinished_turns(&branch) {
                interrupted.push((session_runtime(self, &snapshot)?, scope.clone()));
            }
            let mut handed_back = Vec::new();
            for (input_id, entry) in snapshot.pending_inputs() {
                {
                    let content = entry.content.as_ref().unwrap();
                    let input = Input {
                        id: input_id.into(),
                        actor: entry.scope.actor.clone(),
                        text: content["text"].as_str().unwrap_or("").into(),
                        timing: if content["parked"] == true && content["releasedBy"].is_null() {
                            Timing::Propose
                        } else {
                            serde_json::from_value(content["timing"].clone())?
                        },
                        key: content["key"].as_str().map(str::to_string),
                    };
                    if input.key.as_deref().is_some_and(|key| {
                        key.starts_with("job-task:")
                            || key.starts_with("job-report:")
                            || key.starts_with("job:")
                    }) {
                        self.sessions
                            .lock()
                            .unwrap()
                            .get_mut(id)
                            .unwrap()
                            .queue
                            .push_back(input);
                        continue;
                    }
                    let scope = Scope::session(id);
                    self.append(
                        &scope,
                        "harness",
                        Draft::new("input.returned", false, json!({"input":input_id})),
                    )?;
                    self.emit(Event::new(&scope, "input.returned", json!(input)))
                        .await?;
                    handed_back.push(input);
                }
            }
            if let Err(error) = self
                .invoke(
                    &self.points["session.start"],
                    &Scope::session(id),
                    json!({"resumed":true}),
                )
                .await
            {
                let _ = self.close(id).await;
                self.sessions.lock().unwrap().remove(id);
                return Err(error);
            }
            let mut sessions = self.sessions.lock().unwrap();
            let open = sessions.get_mut(id).unwrap();
            // Reserve the session until recovery settles, even before its driver runs.
            open.active = (!interrupted.is_empty()).then_some(ActiveTurn::Recovery);
            open.steer_closed = open.active.is_some();
            open.interrupted = interrupted;
            Ok(Some(handed_back))
        })
        .await
    }

    async fn prepare_session(&self, id: &str) -> Result<()> {
        self.invoke(
            &self.points["session.prepare"],
            &Scope::session(id),
            json!({}),
        )
        .await?;
        self.registry
            .read()
            .unwrap()
            .validate_tools(&self.snapshot(id)?)?;
        Ok(())
    }
    pub fn open_session_ids(&self) -> Vec<String> {
        self.sessions.lock().unwrap().keys().cloned().collect()
    }

    pub async fn close(&self, id: &str) -> Result<()> {
        let op = Operation::internal("modular_agent.session.close", &Scope::session(id));
        op.attr("modular_agent.session.operation", "close");
        op.run(async {
            {
                let mut sessions = self.sessions.lock().unwrap();
                if let Some(open) = sessions.get(id)
                    && open.interruption.is_cancelled()
                    && open.active.is_none()
                {
                    if open.journal_uncertain || open.data.unresolved_rewind().is_some() {
                        self.blocked_projects
                            .lock()
                            .unwrap()
                            .insert(open.data.project.clone(), id.into());
                    }
                    sessions.remove(id);
                    return Ok(());
                }
                if let Some(open) = sessions.get(id)
                    && !open.rewinding
                    && (open.journal_uncertain || open.data.unresolved_rewind().is_some())
                {
                    // Release the writer so the next open can reconcile the journal.
                    self.blocked_projects
                        .lock()
                        .unwrap()
                        .insert(open.data.project.clone(), id.into());
                    sessions.remove(id);
                    return Ok(());
                }
            }
            let _workspace = self.begin_environment_work(id)?;
            ensure!(
                !self.is_running(id),
                "cancel and await the turn before closing"
            );
            self.abandon_interface_calls(id, "Session closed")?;
            self.invoke(&self.points["session.end"], &Scope::session(id), json!({}))
                .await?;
            if let Ok(environment) = capability::<dyn WorkingEnvironment>(self, "environment") {
                environment.session_ended(id).await?;
            }
            self.emit(Event::new(&Scope::session(id), "session.end", json!({})))
                .await?;
            self.invalidate_providers(id)?;
            self.sessions
                .lock()
                .unwrap()
                .remove(id)
                .ok_or_else(|| OperationError::NotFound("unknown session".into()))?;
            Ok(())
        })
        .await
    }
    fn refresh_open_erasure(&self, open: &mut OpenSession) -> Result<()> {
        if !open.provisional
            && let Some(store) = self.store()
            && let Err(error) = store.check_erasure(&open.data)
        {
            if open.active.is_some()
                || open.environment_work > 0
                || open.rewinding
                || open.lease.is_none()
            {
                return Err(error);
            }
            self.check_open_writer(open)?;
            let Some((data, _)) = store.reconcile_erasure(&open.data.id)? else {
                return Err(error);
            };
            store.check_erasure(&data)?;
            self.install_erased_data(open, data)?;
        }
        Ok(())
    }
    fn install_erased_data(&self, open: &mut OpenSession, data: SessionData) -> Result<()> {
        if let Some(remove) = self.private_erasure.get() {
            remove(&data)?;
        }
        let session = data.id.clone();
        open.queue.retain(|q| {
            data.entries
                .iter()
                .any(|e| e.id == q.id && e.content.is_some())
        });
        self.reservations().rebuild(&data);
        open.data = data;
        if let Some(commits) = &open.commits {
            let _ = commits.send(());
        }
        self.pending_events
            .lock()
            .unwrap()
            .retain(|e| e.scope.session != session);
        self.held_output
            .lock()
            .unwrap()
            .retain(|(id, _, _), _| id != &session);
        self.invalidate_providers(&session)
    }
    // Do not reconcile here: this check guards a view that was built from the
    // old state. Reconciliation must never make that view eligible again.
    fn output_epoch(&self, session: &str) -> Result<Option<String>> {
        let sessions = self.sessions.lock().unwrap();
        let Some(open) = sessions.get(session) else {
            return Ok(None);
        };
        if !open.provisional
            && let Some(store) = self.store()
        {
            store.check_erasure(&open.data)?;
        }
        Ok(open
            .data
            .entries
            .iter()
            .rev()
            .find(|e| e.kind == "erasure")
            .map(|e| e.id.clone()))
    }
    fn invalidate_providers(&self, session: &str) -> Result<()> {
        for name in self.capability_names("provider.") {
            capability::<dyn Provider>(self, &name)?.invalidate(session);
        }
        Ok(())
    }
    async fn local_output(&self, scope: &Scope, output: Output) -> Result<Option<Value>> {
        let result = match self
            .invoke(&self.points["output"], scope, json!(output))
            .await
        {
            Ok(result) => result,
            Err(e) => {
                eprintln!("output gate refused delivery: {e}");
                return Ok(None);
            }
        };
        if result.stopped && result.value.is_null() {
            return Ok(None);
        }
        let output: Output = serde_json::from_value(result.value)?;
        Ok(Some(output.value))
    }
    async fn remote_output(
        &self,
        scope: &Scope,
        recipient: &str,
        events: Vec<Value>,
    ) -> Result<Vec<Value>> {
        let registry = self.registry.read().unwrap().clone();
        let recipient = if recipient == "interface.acp" {
            registry.declaration()["acp"]["actor"]["id"]
                .as_str()
                .unwrap_or(ACP_HOST_ACTOR)
                .to_owned()
        } else {
            recipient.to_owned()
        };
        let mut accepted = Vec::new();
        let mut charges = Vec::new();
        let mut total = bytes::size(&events);
        if total > MAX_HELD {
            return Err(OutputOverflow.into());
        }
        let mut remaining = events.into_iter().peekable();
        while remaining.peek().is_some() {
            let mut segment = Vec::new();
            let mut charged = 2;
            while let Some(item) = remaining.peek() {
                let n = bytes::size(item);
                if n + 2 > GATE_SEGMENT {
                    return Err(OutputOverflow.into());
                }
                let next = charged + n + u64::from(!segment.is_empty());
                if next > GATE_SEGMENT {
                    break;
                }
                charged = next;
                segment.push(remaining.next().unwrap());
            }
            let result = registry.invoke_checked(self.api(), &self.points["output.stream"], scope,
                json!({"sessionId":scope.session,"recipient":recipient,"events":segment,"final":true}),
                |before,after| {
                    let size = bytes::size(&after["events"]);
                    if size > GATE_SEGMENT {return Err(OutputOverflow.into());}
                    ensure!(after["events"].is_array() && output::apply_redactions(&mut before["events"].clone(), &after["events"]), "invalid output redaction");
                    if size>charged {total+=size-charged; if total>MAX_HELD{return Err(OutputOverflow.into())}}
                        if size > charged && !scope.session.is_empty() {
                        charges.push(self.reserve_output(&scope.session,size-charged).map_err(|_|OutputOverflow)?);
                        charged=size;
                    }
                    Ok(())
                }).await?;
            let Some(after) = result.value["events"].as_array() else {
                return Ok(vec![]);
            };
            for (mut before, after) in segment.into_iter().zip(after) {
                if !output::apply_redactions(&mut before, after) {
                    return Ok(vec![]);
                }
                accepted.push(before);
            }
        }
        Ok(accepted)
    }
    pub fn gates_output(&self) -> bool {
        self.registry.read().unwrap().gates_output()
    }
    fn holds_remote_output(&self) -> bool {
        self.registry.read().unwrap().declaration()["remote_output"] == true
    }
    fn watch_writer(&self, id: &str) {
        if let Some(open) = self.sessions.lock().unwrap().get(id) {
            self.watch_open_writer(open);
        }
    }
    fn watch_open_writer(&self, open: &OpenSession) {
        let Some(lost) = open.lease.as_ref().and_then(|lease| lease.lost()) else {
            return;
        };
        let generation = open.generation.clone();
        let weak = self.me.clone();
        let id = open.data.id.clone();
        tokio::spawn(async move {
            tokio::select! {
                biased;
                _ = generation.cancelled() => {},
                _ = lost.cancelled() => {
                    if let Some(h) = weak.upgrade()
                        && let Some(open) = h.sessions.lock().unwrap().get_mut(&id)
                        && !generation.is_cancelled()
                    {
                        h.interrupt(open, "writerLost");
                    }
                }
            }
        });
    }
    fn interrupt(&self, open: &mut OpenSession, reason: &str) {
        if open.interruption.is_cancelled() {
            return;
        }
        open.cancel.cancel();
        open.interruption.cancel();
        let h = self.api();
        let event = Event::new(
            &Scope::session(&open.data.id),
            "session.interrupted",
            json!({"reason":reason}),
        );
        // The transition runs under the sessions lock; gates and delivery must not.
        tokio::spawn(async move {
            if let Err(error) = h.emit(event).await {
                eprintln!("session interruption delivery failed: {error}");
            }
        });
    }
    fn check_open_writer(&self, open: &mut OpenSession) -> Result<()> {
        ensure!(
            !open.interruption.is_cancelled(),
            LostPart("session writer interrupted; reopen to recover".into())
        );
        if let Some(lease) = &open.lease
            && let Err(error) = lease.check()
        {
            self.interrupt(open, "writerLost");
            return Err(LostPart(format!("session writer lost: {error}")).into());
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
    pub async fn history_view(&self, session: &str) -> Result<Value> {
        Ok(self
            .output(
                &Scope::session(session),
                Output {
                    recipient: "interface".into(),
                    value: json!(self.snapshot(session)?),
                    stream: None,
                    end: true,
                },
            )
            .await?
            .unwrap_or(Value::Null))
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
        self.sessions
            .lock()
            .unwrap()
            .get(session)
            .map(|open| open.interruption.clone())
            .ok_or_else(|| OperationError::NotFound("session not open".into()).into())
    }
    fn check_writer(&self, session: &str) -> Result<()> {
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(session)
            .ok_or_else(|| anyhow!("session not open"))?;
        self.check_open_writer(open)?;
        if !open.provisional
            && let Some(store) = self.store()
        {
            store.check_erasure(&open.data)?;
        }
        Ok(())
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
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(session)
            .ok_or_else(|| anyhow!("session not open"))?;
        self.refresh_open_erasure(open)?;
        Ok(open.data.clone())
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
        let entry = make_entry(
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
        require(self, scope, "settings")?;
        ensure!(
            !jobs(&self.snapshot(&scope.session)?)?
                .iter()
                .any(|j| j.state == JobState::Running),
            OperationError::Busy("cancel jobs before moving position".into())
        );
        ensure!(
            !self.is_running(&scope.session),
            OperationError::Busy("cannot move during a turn".into())
        );
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(&scope.session)
            .ok_or_else(|| OperationError::NotFound("unknown session".into()))?;
        open.check_rewind()?;
        ensure!(
            position
                .as_ref()
                .is_none_or(|p| open.data.entries.iter().any(|e| e.id == *p)),
            OperationError::NotFound("unknown position".into())
        );
        let mut next = open.data.clone();
        ensure!(
            !waiting_approvals::outstanding(&next),
            OperationError::Busy("settle waiting approvals before moving".into())
        );
        let original = next.branch();
        ensure!(
            !original
                .iter()
                .any(|e| interface_handoff(e) && interface_result(&next, e).is_none()),
            OperationError::Busy("settle Interface calls before moving position".into())
        );
        let mut additions: Vec<(Scope, Draft)> = vec![];
        for q in questions(&next)?.into_iter().filter(|q| q.answerable) {
            additions.push((
                q.scope,
                Draft::new(
                    "request.closed",
                    false,
                    json!({"request":q.id,"reason":"noLongerAnswerable"}),
                ),
            ));
        }
        for e in original.iter().filter(|e| e.kind == "tool.call") {
            if next
                .entries
                .iter()
                .any(|r| r.kind == "tool.result" && r.scope.call == e.scope.call)
            {
                continue;
            }
            let call: ToolCall = serde_json::from_value(
                e.content
                    .clone()
                    .ok_or_else(|| anyhow!("erased open call"))?,
            )?;
            let result = if let Some(done) = next
                .entries
                .iter()
                .find(|r| r.kind == "tool.completed" && r.scope.call == e.scope.call)
            {
                done.content
                    .clone()
                    .ok_or_else(|| anyhow!("erased tool completion"))?
            } else {
                json!(ToolResult::new(
                    &call,
                    ToolStatus::Cancelled,
                    "branch abandoned"
                ))
            };
            additions.push((
                e.scope.clone(),
                Draft::new("tool.result", true, result).copying(vec![e.id.clone()]),
            ));
        }
        for input in &open.queue {
            additions.push((
                scope.clone(),
                Draft::new("input.returned", false, json!({"input":input.id})),
            ));
        }
        for (scope, draft) in additions {
            let entry = make_entry(&next, &scope, "harness", draft);
            next.position = Some(entry.id.clone());
            next.entries.push(entry);
        }
        let old = next.position.clone();
        let entry = make_entry(
            &next,
            scope,
            "harness",
            Draft::new("position", false, json!({"from":old,"to":position})),
        );
        next.position = position;
        next.entries.push(entry);
        self.commit(open, &next)?;
        open.data = next;
        open.queue.clear();
        self.invalidate_providers(&scope.session)?;
        Ok(())
    }
    fn fork(&self, scope: &Scope, position: Option<String>) -> Result<String> {
        require(self, scope, "watch")?;
        require(self, scope, "settings")?;
        let _workspace = self.begin_environment_work(&scope.session)?;
        ensure!(
            !self.is_running(&scope.session),
            OperationError::Busy("cannot fork during a turn".into())
        );
        let mut source = self.snapshot(&scope.session)?;
        ensure!(
            !waiting_approvals::outstanding(&source),
            OperationError::Busy("settle waiting approvals before forking".into())
        );
        if let Some(p) = position {
            ensure!(
                source.entries.iter().any(|e| e.id == p),
                OperationError::NotFound("unknown fork point".into())
            );
            source.position = Some(p);
        }
        let branch = source.branch();
        ensure!(
            !questions(&source)?.iter().any(|q| q.answerable)
                && !jobs(&source)?.iter().any(|j| j.state == JobState::Running)
                && !branch.iter().any(|e| e.kind == "tool.call"
                    && !branch
                        .iter()
                        .any(|r| r.kind == "tool.result" && r.scope.call == e.scope.call)),
            OperationError::Busy("settle pending work before forking".into())
        );
        ensure!(
            self.sessions
                .lock()
                .unwrap()
                .get(&scope.session)
                .unwrap()
                .queue
                .is_empty(),
            OperationError::Busy("take or withdraw queued input before forking".into())
        );
        let new_id = id();
        let lease = self.store().map(|s| s.acquire(&new_id)).transpose()?;
        let mut next = SessionData {
            id: new_id.clone(),
            origin: Some((source.id.clone(), source.position.clone())),
            entries: vec![],
            position: None,
            ..source.clone()
        };
        let branch = source.branch();
        let branch: Vec<_> = branch
            .iter()
            .filter(|e| {
                e.writer != "rust.derived"
                    && e.content.is_some()
                    && e.kind != telemetry::TURN_TRACE
                    && !interface_handoff(e)
            })
            .collect();
        for original in &branch {
            let mut entry = (*original).clone();
            entry.id = id();
            entry.parent = next.position.clone();
            entry.scope.session = new_id.clone();
            if let Some(v) = entry.content.as_mut() {
                if entry.kind == "turn.start" {
                    if let Some(value) = v.as_object_mut() {
                        value.remove("traceContext");
                    }
                } else if entry.kind == "request.open" {
                    let mut q: Question = serde_json::from_value(v.clone())?;
                    q.scope.session = new_id.clone();
                    for s in &mut q.route {
                        if *s == source.id {
                            *s = new_id.clone();
                        }
                    }
                    *v = json!(q);
                } else if entry.kind == "request.answer" {
                    let mut answer: Answer = serde_json::from_value(v.clone())?;
                    if answer.session == source.id {
                        answer.session = new_id.clone();
                    }
                    *v = json!(answer);
                }
            }
            entry.copies.insert(0, original.id.clone());
            next.position = Some(entry.id.clone());
            next.entries.push(entry);
        }
        // Remap summary coverage to the fork's IDs as well as keeping erasure provenance.
        let map: BTreeMap<_, _> = branch
            .iter()
            .zip(next.entries.iter())
            .map(|(a, b)| (a.id.clone(), b.id.clone()))
            .collect();
        for e in &mut next.entries {
            if let Some(content) = &mut e.content
                && matches!(e.kind.as_str(), "input" | "input.accepted")
                && let Some(input) = content["inputId"].as_str().and_then(|id| map.get(id))
            {
                content["inputId"] = json!(input);
            }
            let mut local: Vec<_> = e
                .copies
                .iter()
                .filter_map(|x| map.get(x).filter(|local| *local != &e.id).cloned())
                .collect();
            e.copies.append(&mut local);
        }
        // The copied branch is display/context, not the fork's setup. Capture
        // the current session settings and membership even at an older fork point.
        if let Some(tenant) = tenants::name(&source) {
            push_setup(&mut next, "tenant", |_| json!({"tenant":tenant}));
        }
        let mut membership = BTreeMap::new();
        let mut limit = None;
        for entry in &source.entries {
            let Some(value) = &entry.content else {
                continue;
            };
            match entry.kind.as_str() {
                "actor.grant" => {
                    if let Some(actor) = value["actor"].as_str() {
                        membership.insert(actor, entry);
                    }
                }
                "actor.identity" => {
                    if let Some(actor) = value["id"].as_str() {
                        membership.insert(actor, entry);
                    }
                }
                "actor.left" => {
                    if let Some(actor) = value["actorId"].as_str() {
                        membership.insert(actor, entry);
                    }
                }
                "limit" => limit = Some(value),
                _ => {}
            }
        }
        for entry in membership.values() {
            push_setup(&mut next, &entry.kind, |_| entry.content.clone().unwrap());
        }
        push_setup(&mut next, "settings", |data| data.settings.clone());
        if let Some(limit) = limit {
            push_setup(&mut next, "limit", |_| limit.clone());
        }
        push_setup(
            &mut next,
            "plugins.changed",
            |data| json!({"active":data.plugins}),
        );
        let empty = SessionData {
            entries: vec![],
            position: None,
            ..next.clone()
        };
        self.reservations()
            .commit(&empty, &next, None, || self.save(&next))?;
        self.sessions.lock().unwrap().insert(
            new_id.clone(),
            OpenSession {
                data: next,
                lease,
                provisional: false,
                commits: None,
                generation: CancellationToken::new(),
                interruption: CancellationToken::new(),
                queue: VecDeque::new(),
                input_contexts: BTreeMap::new(),
                question_contexts: BTreeMap::new(),
                approval_views: Default::default(),
                interrupted: Vec::new(),
                active: None,
                rewinding: false,
                journal_uncertain: false,
                environment_work: 0,
                steer_closed: false,
                continuation_waiters: Default::default(),
                cancel: CancellationToken::new(),
            },
        );
        self.watch_writer(&new_id);
        Ok(new_id)
    }
    fn list(&self, project: Option<&Path>) -> Result<Vec<SessionData>> {
        let canonical = project.map(|p| p.canonicalize()).transpose()?;
        let mut result = self
            .store()
            .map(|s| s.list(canonical.as_deref()))
            .transpose()?
            .unwrap_or_default();
        for open in self.sessions.lock().unwrap().values() {
            if !open.provisional
                && open.data.entries.iter().any(|e| e.kind != "command")
                && canonical.as_ref().is_none_or(|p| p == &open.data.project)
            {
                result.retain(|s| s.id != open.data.id);
                result.push(open.data.clone());
            }
        }
        result.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(result)
    }
    async fn erase(&self, scope: &Scope, entries: Vec<String>) -> Result<ErasureReport> {
        require(self, scope, "erase")?;
        let _erasure = self.erasure.try_write().map_err(|_| {
            OperationError::Busy("erasure requires idle turns and no other erasure".into())
        })?;
        let (erased, unresolved, affected) = {
            let mut sessions = self.sessions.lock().unwrap();
            ensure!(
                sessions
                    .values()
                    .all(|s| s.active.is_none() && s.check_rewind().is_ok())
                    && self.blocked_projects.lock().unwrap().is_empty(),
                OperationError::Busy("erasure requires all local turns to be idle".into())
            );
            let store = self
                .store()
                .filter(|s| s.coordinates_erasure())
                .ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::Unsupported,
                        "no coordinated erasure store",
                    )
                })?;
            let mut affected = store.mark_erasure(&scope.session, &entries)?;
            // An internal request with no record targets still asks the Provider
            // to discard its copies of the source session.
            affected.entry(scope.session.clone()).or_default();
            let mut erased = vec![];
            let mut unresolved = std::collections::BTreeSet::new();
            for (session, targets) in &affected {
                let result = if let Some(open) = sessions.get_mut(session) {
                    if self.check_open_writer(open).is_ok()
                        && open.lease.is_some()
                        && open.environment_work == 0
                    {
                        store
                            .reconcile_erasure(session)
                            .and_then(|result| match result {
                                Some((data, ids)) => {
                                    self.install_erased_data(open, data)?;
                                    Ok(Some(ids))
                                }
                                None => Ok(None),
                            })
                    } else {
                        Ok(None)
                    }
                } else {
                    store.acquire(session).and_then(|_lease| {
                        store.reconcile_erasure(session).and_then(|result| {
                            result
                                .map(|(data, ids)| {
                                    if let Some(remove) = self.private_erasure.get() {
                                        remove(&data)?;
                                    }
                                    Ok(ids)
                                })
                                .transpose()
                        })
                    })
                };
                let done = result
                    .ok()
                    .flatten()
                    .unwrap_or_else(|| store.confirmed_erasure(session).unwrap_or_default());
                for id in targets {
                    if done.contains(id) {
                        erased.push(id.clone());
                    } else {
                        unresolved.insert(id.clone());
                    }
                }
            }
            (erased, unresolved, affected)
        };
        let mut out_of_reach = vec!["output already delivered to recipients".into()];
        let mut pending = unresolved;
        for name in self.capability_names("provider.") {
            let report = capability::<dyn Provider>(self, &name)?
                .erase_binding_copies(self.api(), &affected)
                .await?;
            pending.extend(report.pending);
            out_of_reach.extend(report.out_of_reach);
        }
        let qualified = affected
            .iter()
            .flat_map(|(session, ids)| ids.iter().map(|id| (session.clone(), id.clone())))
            .collect();
        Ok(ErasureReport {
            qualified,
            pending: pending.into_iter().collect(),
            erased,
            out_of_reach,
        })
    }
    async fn invoke(&self, point: &HookPoint, scope: &Scope, value: Value) -> Result<HookResult> {
        let registry = self.registry.read().unwrap().clone();
        registry.invoke(self.api(), point, scope, value).await
    }
    fn reserve_output(&self, session: &str, bytes: u64) -> Result<Box<dyn Send>> {
        let sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get(session)
            .ok_or_else(|| anyhow!("session not open"))?;
        Ok(Box::new(self.reservations().buffer(&open.data, bytes)?))
    }
    async fn output(&self, scope: &Scope, output: Output) -> Result<Option<Value>> {
        let epoch = self.output_epoch(&scope.session)?;
        let recipient = output.recipient.clone();
        let Some(value) = self.local_output(scope, output).await? else {
            return Ok(None);
        };
        if !self.holds_remote_output() {
            return Ok((self.output_epoch(&scope.session)? == epoch).then_some(value));
        }
        let kind = if value["method"].is_string() && value.get("params").is_some() {
            "request"
        } else if value["method"].is_string() && value.get("result").is_some() {
            "reply"
        } else if value["entry"]["id"].is_string() {
            "entry"
        } else {
            "rust.result"
        };
        let recipient = if recipient == "interface.acp" {
            scope.actor.as_str()
        } else {
            &recipient
        };
        let shared = matches!(
            value["type"].as_str(),
            Some("modular-agent.waitClosed" | "turnEnded" | "toolResult")
        ) && value["data"].is_object();
        let event = if shared {
            value
        } else {
            json!({"type":kind,"data":value})
        };
        let gated = self
            .remote_output(scope, recipient, vec![event])
            .await
            .unwrap_or_default();
        if self.output_epoch(&scope.session)? != epoch {
            return Ok(None);
        }
        Ok(gated
            .into_iter()
            .next()
            .map(|event| if shared { event } else { event["data"].clone() }))
    }
    async fn emit(&self, event: Event) -> Result<()> {
        let mut events =
            if event.kind == "session.interrupted" || (event.stream.is_some() && !event.end) {
                vec![]
            } else {
                std::mem::take(&mut *self.pending_events.lock().unwrap())
            };
        events.push(event);
        for event in events {
            let Ok(epoch) = self.output_epoch(&event.scope.session) else {
                continue;
            };
            let observe = match event.kind.as_str() {
                "actor.joined" => Some("session.join"),
                "actor.left" => Some("session.leave"),
                "model.delta" | "model.thought" | "model.tool_input" | "model.audio" => {
                    Some("provider.piece")
                }
                _ => None,
            };
            if let Some(point) = observe {
                self.invoke(&self.points[point], &event.scope, json!(event))
                    .await?;
            }
            for name in self.capability_names("interface.") {
                let sink: Arc<dyn EventSink> = capability(self, &name)?;
                let view = self
                    .local_output(
                        &event.scope,
                        Output {
                            recipient: name.clone(),
                            value: json!(event),
                            stream: event.stream.clone(),
                            end: event.end,
                        },
                    )
                    .await?;
                if !self.holds_remote_output() {
                    if let Some(view) = view
                        && self
                            .output_epoch(&event.scope.session)
                            .is_ok_and(|current| current == epoch)
                    {
                        sink.send(serde_json::from_value(view)?);
                    }
                    continue;
                }
                let view = view.map(serde_json::from_value::<Event>).transpose()?;
                let item = view
                    .filter(|e| !(e.end && e.content.is_null()))
                    .and_then(|e| output::encode(&e, self).ok().map(|item| (e, item)));
                let batch = if let Some(stream) = &event.stream {
                    let key = (event.scope.session.clone(), name.clone(), stream.clone());
                    let item = item.map(|(event, item)| -> Result<_> {
                        let n = bytes::size(&item) + 2;
                        ensure!(n <= GATE_SEGMENT, OutputOverflow);
                        let data = self.snapshot(&event.scope.session)?;
                        let permit = self.reservations().buffer(&data, n)?;
                        Ok((n, (event, item, permit)))
                    });
                    let mut held = self.held_output.lock().unwrap();
                    let stream = held
                        .entry(key.clone())
                        .or_insert_with(|| Some(HeldPieces::default()));
                    match item {
                        Some(Err(_)) => *stream = None,
                        Some(Ok((n, item))) => {
                            if let Some(held) = stream {
                                if held.bytes + n > MAX_HELD {
                                    *stream = None;
                                } else {
                                    held.bytes += n;
                                    held.pieces.push(item);
                                }
                            }
                        }
                        None => {}
                    }
                    if !event.end {
                        continue;
                    }
                    let batch = held.remove(&key).flatten();
                    drop(held);
                    let Some(batch) = batch else {
                        sink.send(Event::new(&event.scope, "output.overflow", Value::Null));
                        continue;
                    };
                    batch.pieces
                } else {
                    item.and_then(|(event, item)| {
                        let data = self.snapshot(&event.scope.session).ok()?;
                        let permit = self.reservations().buffer(&data, bytes::size(&item)).ok()?;
                        Some((event, item, permit))
                    })
                    .into_iter()
                    .collect()
                };
                let gated = match self
                    .remote_output(
                        &event.scope,
                        &name,
                        batch.iter().map(|(_, item, _)| item.clone()).collect(),
                    )
                    .await
                {
                    Ok(gated) => gated,
                    Err(error) => {
                        if error.is::<OutputOverflow>() && event.stream.is_some() {
                            sink.send(Event::new(&event.scope, "output.overflow", Value::Null));
                        }
                        continue;
                    }
                };
                let decoded = batch
                    .into_iter()
                    .zip(gated)
                    .map(|((original, before, _permit), after)| {
                        output::decode(original, &before, &after)
                    })
                    .collect::<Result<Vec<_>>>();
                if let Ok(decoded) = decoded
                    && self
                        .output_epoch(&event.scope.session)
                        .is_ok_and(|current| current == epoch)
                {
                    for event in decoded {
                        sink.send(event);
                    }
                }
            }
        }
        Ok(())
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
