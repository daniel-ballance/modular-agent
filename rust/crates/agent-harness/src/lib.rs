//! Hosts plugins and owns sessions. Inference, turns, I/O and presentation are delegated.
use agent_api::{
    telemetry::{Context, KeyValue, Operation, SpanKind, TraceContextExt},
    *,
};
mod authority;
mod bytes;
mod capacity;
mod continuation;
mod covered_approvals;
mod history_branch;
mod history_commit;
mod input_admission;
mod interface_tools;
mod output;
mod output_gate;
mod plugin_api;
pub mod receipt;
mod rewind;
mod session_erasure;
mod session_lifecycle;
mod settings;
mod tenants;
mod tool_dispatch;
mod turn_execution;
mod waiting_approvals;
mod writer;

pub use bytes::{ByteCapacity, ByteLimits};
pub use capacity::{Capacity, Pool as ReservationPool, ResourceLimits};
pub use interface_tools::{InterfaceConnection, InterfaceReportDisposition, InterfaceToolSource};
pub use output::{apply_redactions, encode as output_event};

use output_gate::HeldOutput;
use std::{
    collections::{BTreeMap, VecDeque},
    path::PathBuf,
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
    fn store(&self) -> Option<session_erasure::AccountedHistory> {
        Some(session_erasure::AccountedHistory {
            store: capability(self, "history").ok()?,
            pool: self.reservations(),
        })
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
        candidate.validate_singleton_replacements(items, plugin.name())?;
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
impl Drop for Harness {
    fn drop(&mut self) {
        for plugin in self.plugins.get_mut().unwrap().iter().rev() {
            let _ = plugin.stop();
        }
    }
}
