//! Hosts plugins and owns sessions. Inference, turns, I/O and presentation are delegated.
use agent_api::*;
mod output;
pub use output::encode as output_event;
mod rewind;
mod tenants;
use std::{
    any::Any,
    collections::{BTreeMap, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock, Weak},
};

struct OpenSession {
    data: SessionData,
    _lease: Option<Box<dyn Lease>>,
    queue: VecDeque<Input>,
    interrupted: Vec<(Arc<dyn Runtime>, Scope)>,
    active: bool,
    rewinding: bool,
    journal_uncertain: bool,
    environment_work: usize,
    steer_closed: bool,
    cancel: CancellationToken,
}
type HeldOutput = BTreeMap<(String, String, String), Vec<(Event, Value)>>;

pub struct Harness {
    me: Weak<Harness>,
    project: Option<PathBuf>,
    tenants: RwLock<tenants::Tenants>,
    registry: RwLock<Registry>,
    points: BTreeMap<String, HookPoint>,
    plugins: Mutex<Vec<Arc<dyn Plugin>>>,
    sessions: Mutex<BTreeMap<String, OpenSession>>,
    blocked_projects: Mutex<BTreeMap<PathBuf, String>>,
    pending_events: Mutex<Vec<Event>>,
    held_output: Mutex<HeldOutput>,
    admissions: Mutex<BTreeMap<String, Arc<tokio::sync::Mutex<()>>>>,
    erasure: tokio::sync::RwLock<()>,
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
            project,
            tenants: RwLock::default(),
            registry: RwLock::new(registry),
            points,
            plugins: Mutex::default(),
            sessions: Mutex::default(),
            blocked_projects: Mutex::default(),
            pending_events: Mutex::default(),
            held_output: Mutex::default(),
            admissions: Mutex::default(),
            erasure: tokio::sync::RwLock::default(),
        })
    }
    pub fn configure_tenants(&self, config: Option<&str>) -> Result<()> {
        ensure!(
            self.sessions.lock().unwrap().is_empty(),
            "tenants are fixed while sessions are open"
        );
        *self.tenants.write().unwrap() =
            config.map(tenants::parse).transpose()?.unwrap_or_default();
        Ok(())
    }
    fn check_tenant(&self, name: &str) -> Result<tenants::Tenant> {
        self.tenants
            .read()
            .unwrap()
            .get(name)
            .cloned()
            .ok_or_else(|| anyhow!("unknown tenant {name}"))
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
        self.create_tenanted(project, settings, None).await
    }
    async fn create_tenanted(
        &self,
        project: &Path,
        settings: Value,
        tenant: Option<&str>,
    ) -> Result<String> {
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
        let id = id();
        let lease = self.store().map(|s| s.acquire(&id)).transpose()?;
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
        {
            let mut sessions = self.sessions.lock().unwrap();
            self.check_project_open(&sessions, &data)?;
            sessions.insert(
                id.clone(),
                OpenSession {
                    data,
                    _lease: lease,
                    queue: VecDeque::new(),
                    interrupted: Vec::new(),
                    active: false,
                    rewinding: false,
                    journal_uncertain: false,
                    environment_work: 0,
                    steer_closed: false,
                    cancel: CancellationToken::new(),
                },
            );
        }
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
        let (lease, mut data) = tokio::task::spawn_blocking(move || -> Result<_> {
            let lease = store.acquire(&session_id)?;
            let data = store.load(&session_id)?;
            Ok((lease, data))
        })
        .await??;
        if let Some(tenant) = tenants::name(&data) {
            self.check_tenant(tenant)?;
        }
        if !matches!(
            data.settings["approval"].as_str(),
            Some("off" | "ask_unless_read_only" | "ask_always" | "never_ask")
        ) {
            data.settings["approval"] = json!("ask_always");
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
                    _lease: Some(lease),
                    queue: VecDeque::new(),
                    interrupted: Vec::new(),
                    active: false,
                    rewinding: recovery,
                    journal_uncertain: false,
                    environment_work: 0,
                    steer_closed: false,
                    cancel: CancellationToken::new(),
                },
            );
        }
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
        let mut interrupted = Vec::new();
        for start in branch.iter().filter(|e| e.kind == "turn.start") {
            if !branch
                .iter()
                .any(|e| e.kind == "turn.end" && e.scope.turn == start.scope.turn)
            {
                interrupted.push((session_runtime(self, &snapshot)?, start.scope.clone()));
            }
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
        open.active = !interrupted.is_empty();
        open.steer_closed = open.active;
        open.interrupted = interrupted;
        Ok(handed_back)
    }

    async fn run_recovery(&self, id: &str) -> Result<()> {
        let interrupted = {
            let mut sessions = self.sessions.lock().unwrap();
            let open = sessions
                .get_mut(id)
                .ok_or_else(|| OperationError::NotFound("unknown session".into()))?;
            std::mem::take(&mut open.interrupted)
        };
        if interrupted.is_empty() {
            return Ok(());
        }
        let result = async {
            for (runtime, scope) in interrupted {
                runtime.interrupted(self.api(), scope).await?;
            }
            Ok(())
        }
        .await;
        self.sessions.lock().unwrap().get_mut(id).unwrap().active = false;
        result
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
    pub async fn close(&self, id: &str) -> Result<()> {
        {
            let mut sessions = self.sessions.lock().unwrap();
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
        self.invoke(&self.points["session.end"], &Scope::session(id), json!({}))
            .await?;
        self.emit(Event::new(&Scope::session(id), "session.end", json!({})))
            .await?;
        self.invalidate_providers(id)?;
        self.sessions
            .lock()
            .unwrap()
            .remove(id)
            .ok_or_else(|| OperationError::NotFound("unknown session".into()))?;
        Ok(())
    }
    fn invalidate_providers(&self, session: &str) -> Result<()> {
        for name in self.capability_names("provider.") {
            capability::<dyn Provider>(self, &name)?.invalidate(session);
        }
        Ok(())
    }
    async fn local_output(&self, scope: &Scope, output: Output) -> Result<Option<Value>> {
        let result = self
            .invoke(&self.points["output"], scope, json!(output))
            .await?;
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
        mut events: Vec<Value>,
    ) -> Result<Vec<Value>> {
        if events.is_empty() {
            return Ok(events);
        }
        let recipient = if recipient == "interface.acp" {
            self.registry.read().unwrap().declaration()["acp"]["actor"]["id"]
                .as_str()
                .unwrap_or(ACP_HOST_ACTOR)
                .to_owned()
        } else {
            recipient.to_owned()
        };
        let result = self.invoke(&self.points["output.stream"], scope,
             json!({"sessionId":scope.session,"recipient":recipient,"events":events,"final":true})).await?;
        let Some(after) = result.value["events"].as_array() else {
            return Ok(vec![]);
        };
        if after.len() != events.len() {
            return Ok(vec![]);
        }
        for (before, after) in events.iter_mut().zip(after) {
            if before["type"] != after["type"] || !output::apply_redactions(before, after) {
                return Ok(vec![]);
            }
        }
        Ok(events)
    }
    fn holds_remote_output(&self) -> bool {
        self.registry.read().unwrap().declaration()["remote_output"] == true
    }
    fn save(&self, data: &SessionData) -> Result<()> {
        // An ACP connection joins even a new session, but that join alone
        // must not leave an unused session in the store.
        if data.entries.iter().all(|e| {
            matches!(e.kind.as_str(), "command" | "plugins.changed" | "tenant")
                || (e.kind == "actor.grant" && e.writer == "interface.acp")
        }) {
            return Ok(());
        }
        if let Some(store) = self.store() {
            store.save(data)?;
        }
        Ok(())
    }
    pub async fn submit(
        &self,
        session: &str,
        actor: &str,
        text: &str,
        timing: Timing,
        key: Option<String>,
    ) -> Result<Receipt> {
        let scope = Scope {
            actor: actor.into(),
            ..Scope::session(session)
        };
        self.admit(&scope, text, timing, key, None, None).await
    }
    /// Admit a prompt with a schema attached to this admission, not to the session.
    pub async fn submit_shaped(
        &self,
        session: &str,
        actor: &str,
        text: &str,
        key: Option<String>,
        shape: Value,
    ) -> Result<Receipt> {
        schema::compile(&shape)?;
        let scope = Scope {
            actor: actor.into(),
            ..Scope::session(session)
        };
        self.admit(&scope, text, Timing::Now, key, None, Some(shape))
            .await
    }
    async fn admit(
        &self,
        scope: &Scope,
        text: &str,
        timing: Timing,
        key: Option<String>,
        sponsor: Option<&str>,
        result_shape: Option<Value>,
    ) -> Result<Receipt> {
        let session = scope.session.as_str();
        let actor = scope.actor.as_str();
        let own = self.authority(session, actor)?;
        let authority = match sponsor {
            Some(s) => own.intersect(&self.authority(session, s)?),
            None => own.clone(),
        };
        ensure!(
            authority.has(if timing == Timing::Propose {
                "propose"
            } else {
                "input"
            }),
            OperationError::Forbidden("actor lacks input authority".into())
        );
        let admission = self
            .admissions
            .lock()
            .unwrap()
            .entry(session.into())
            .or_default()
            .clone();
        let _admission = admission.lock().await;
        let _workspace = self.begin_environment_work(session)?;
        let submitter = sponsor.unwrap_or(actor);
        if let Some(ref key) = key {
            let data = self.snapshot(session)?;
            if data
                .entries
                .iter()
                .filter(|e| e.kind == "erasure")
                .filter_map(|e| e.content.as_ref()?.get("inputKeys")?.as_array())
                .flatten()
                .any(|r| {
                    r["key"] == *key
                        && r["actorId"] == actor
                        && r["submittedBy"].as_str().unwrap_or(actor) == submitter
                })
            {
                return Ok(Receipt {
                    input: String::new(),
                    duplicate: true,
                    erased: true,
                    command: None,
                });
            }
            if let Some(e) = data.entries.iter().find(|e| {
                matches!(e.kind.as_str(), "input.accepted" | "command")
                    && e.scope.actor == actor
                    && e.content.as_ref().is_some_and(|c| {
                        c["key"] == *key && c["submittedBy"].as_str().unwrap_or(actor) == submitter
                    })
            }) {
                let command = if e.kind == "command" {
                    self.output(
                        scope,
                        Output {
                            recipient: "interface".into(),
                            value: e.content.as_ref().unwrap()["result"].clone(),
                            stream: None,
                            end: true,
                        },
                    )
                    .await?
                } else {
                    None
                };
                return Ok(Receipt {
                    input: e
                        .content
                        .as_ref()
                        .and_then(|c| c["inputId"].as_str())
                        .unwrap_or(&e.id)
                        .into(),
                    duplicate: true,
                    erased: false,
                    command,
                });
            }
        }
        // A proposal is data, not a command. Do not run input hooks with
        // broader authority than the connection and actor share.
        let input_payload = json!({"text":text,"actor":actor,"timing":timing});
        let reply = if timing == Timing::Propose || authority != own {
            HookResult {
                value: input_payload,
                ..HookResult::default()
            }
        } else {
            self.invoke(&self.points["input"], scope, input_payload)
                .await?
        };
        if reply.stopped {
            let entry = self.append(
                scope,
                "commands",
                Draft::new(
                    "command",
                    false,
                    json!({"text":text,"result":reply.value,"key":key,"submittedBy":submitter}),
                )
                .copying(
                    self.snapshot(session)?
                        .entries
                        .iter()
                        .map(|e| e.id.clone())
                        .collect(),
                ),
            )?;
            self.emit(Event::new(scope, "command.result", reply.value.clone()))
                .await?;
            return Ok(Receipt {
                input: entry.id,
                duplicate: false,
                erased: false,
                command: self
                    .output(
                        scope,
                        Output {
                            recipient: "interface".into(),
                            value: reply.value,
                            stream: None,
                            end: true,
                        },
                    )
                    .await?,
            });
        }
        let text = reply.value["text"].as_str().unwrap_or(text).to_string();
        // The per-session admission lock already serialized the key lookup.
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(session)
            .ok_or_else(|| OperationError::NotFound("unknown session".into()))?;
        let mut next = open.data.clone();
        if !next.settings.as_object().is_none_or(|o| o.is_empty())
            && !next.entries.iter().any(|e| e.kind == "settings")
        {
            let baseline = make_entry(
                &next,
                &Scope::session(session),
                "harness",
                Draft::new("settings", false, next.settings.clone()),
            );
            next.position = Some(baseline.id.clone());
            next.entries.push(baseline);
        }
        let timing = if open.steer_closed && open.active && timing == Timing::Steer {
            Timing::After
        } else {
            timing
        };
        let mut entry = make_entry(
            &next,
            scope,
            "harness",
            Draft::new(
                "input.accepted",
                false,
                json!({"text":text,"content":[{"type":"text","text":text}],"key":key,"timing":timing,
                       "authority":authority,"sponsor":sponsor,"submittedBy":submitter,"taken":input_taken(open.active, timing)}),
            ),
        );
        let content = entry.content.as_mut().unwrap();
        content["inputId"] = json!(entry.id);
        if let Some(shape) = result_shape {
            content["resultShape"] = shape;
        }
        next.position = Some(entry.id.clone());
        next.entries.push(entry.clone());
        self.save(&next)?;
        open.data = next;
        open.queue.push_back(Input {
            id: entry.id.clone(),
            actor: actor.into(),
            text,
            timing,
            key,
        });
        self.pending_events.lock().unwrap().push(Event::new(
            scope,
            "input.accepted",
            json!({"input":entry.id,"timing":timing}),
        ));
        Ok(Receipt {
            input: entry.id,
            duplicate: false,
            erased: false,
            command: None,
        })
    }
    pub async fn cancel(&self, session: &str) -> Result<Vec<Input>> {
        {
            let sessions = self.sessions.lock().unwrap();
            if sessions.get(session).is_some_and(|open| {
                !open.rewinding
                    && (open.journal_uncertain || open.data.unresolved_rewind().is_some())
            }) {
                // Rewind started with no live work. Closing an unresolved session
                // should release the writer without writing cancellation records.
                return Ok(vec![]);
            }
        }
        let _workspace = self.begin_environment_work(session)?;
        let returned = {
            let mut sessions = self.sessions.lock().unwrap();
            let open = sessions
                .get_mut(session)
                .ok_or_else(|| OperationError::NotFound("unknown session".into()))?;
            open.cancel.cancel();
            open.queue.drain(..).collect::<Vec<_>>()
        };
        if !self.is_running(session) {
            let data = self.snapshot(session)?;
            if let Ok(service) = requests(self) {
                for q in questions(&data)?.iter().filter(|q| q.answerable) {
                    service.close_turn(self, &q.scope)?;
                }
            }
            for e in data.branch().iter().filter(|e| e.kind == "tool.call") {
                if data
                    .entries
                    .iter()
                    .any(|r| r.kind == "tool.result" && r.scope.call == e.scope.call)
                {
                    continue;
                }
                if let Some(value) = &e.content {
                    let call: ToolCall = serde_json::from_value(value.clone())?;
                    self.append(
                        &e.scope,
                        "harness",
                        Draft::new(
                            "tool.result",
                            true,
                            json!(ToolResult::new(
                                &call,
                                ToolStatus::Cancelled,
                                "open call cancelled"
                            )),
                        )
                        .copying(vec![e.id.clone()]),
                    )?;
                }
            }
        }
        for input in &returned {
            let scope = Scope::session(session);
            self.append(
                &scope,
                "harness",
                Draft::new("input.returned", false, json!({"input":input.id})),
            )?;
            self.emit(Event::new(&scope, "input.returned", json!(input)))
                .await?;
        }
        let view = self
            .output(
                &Scope::session(session),
                Output {
                    recipient: "interface".into(),
                    value: json!(returned),
                    stream: None,
                    end: true,
                },
            )
            .await?;
        Ok(serde_json::from_value(view.unwrap_or_else(|| json!([])))?)
    }
    pub async fn withdraw(&self, session: &str, input: &str) -> Result<Input> {
        let _workspace = self.begin_environment_work(session)?;
        let value = {
            let mut sessions = self.sessions.lock().unwrap();
            let open = sessions
                .get_mut(session)
                .ok_or_else(|| OperationError::NotFound("unknown session".into()))?;
            let i = open
                .queue
                .iter()
                .position(|x| x.id == input)
                .ok_or_else(|| anyhow!("input already taken"))?;
            open.queue.remove(i).unwrap()
        };
        let scope = Scope::session(session);
        self.append(
            &scope,
            "harness",
            Draft::new("input.withdrawn", false, json!({"input":input})),
        )?;
        self.emit(Event::new(&scope, "input.withdrawn", json!(value)))
            .await?;
        let view = self
            .output(
                &scope,
                Output {
                    recipient: "interface".into(),
                    value: json!(value),
                    stream: None,
                    end: true,
                },
            )
            .await?
            .ok_or_else(|| anyhow!("withdrawn input blocked by output gate"))?;
        Ok(serde_json::from_value(view)?)
    }
    pub async fn run_next(&self, session: &str) -> Result<Option<TurnResult>> {
        let _erasure = self
            .erasure
            .try_read()
            .map_err(|_| anyhow!("erasure in progress"))?;
        let _workspace = self.begin_environment_work(session)?;
        let data = self.snapshot(session)?;
        let branch = data.branch();
        let qs = questions(&data)?;
        let mut resume = vec![];
        for e in branch.iter().filter(|e| e.kind == "tool.call") {
            if branch
                .iter()
                .any(|r| r.kind == "tool.result" && r.scope.call == e.scope.call)
            {
                continue;
            }
            let ended = e.scope.turn.is_none()
                || branch.iter().any(|r| {
                    r.kind == "turn.end"
                        && r.scope.turn == e.scope.turn
                        && r.content.as_ref().is_some_and(|v| {
                            v["open_calls"].as_array().is_some_and(|a| {
                                a.iter().any(|c| {
                                    Some(c["id"].as_str().unwrap_or("")) == e.scope.call.as_deref()
                                })
                            })
                        })
                });
            let related: Vec<_> = qs.iter().filter(|q| q.scope.call == e.scope.call).collect();
            if ended
                && !related.is_empty()
                && related.iter().all(|q| !q.answerable)
                && related.iter().any(|q| q.answer.is_some())
            {
                resume.push(serde_json::from_value::<ToolCall>(
                    e.content
                        .clone()
                        .ok_or_else(|| anyhow!("erased open call"))?,
                )?);
            }
        }
        let ready: std::collections::BTreeSet<_> = resume.iter().map(|c| c.id.clone()).collect();
        resume.retain(|call| {
            let source = branch
                .iter()
                .find(|e| e.kind == "tool.call" && e.scope.call.as_ref() == Some(&call.id))
                .unwrap();
            source.scope.turn.is_none()
                || branch
                    .iter()
                    .filter(|e| e.kind == "tool.call" && e.scope.turn == source.scope.turn)
                    .all(|e| {
                        branch
                            .iter()
                            .any(|r| r.kind == "tool.result" && r.scope.call == e.scope.call)
                            || e.scope.call.as_ref().is_some_and(|id| ready.contains(id))
                    })
        });
        if let Some(first) = resume.first() {
            let first = first.id.clone();
            let origin = branch
                .iter()
                .find(|e| e.kind == "tool.call" && e.scope.call.as_ref() == Some(&first))
                .unwrap()
                .scope
                .turn
                .clone();
            resume.retain(|c| {
                if origin.is_none() {
                    c.id == first
                } else {
                    branch.iter().any(|e| {
                        e.kind == "tool.call"
                            && e.scope.call.as_ref() == Some(&c.id)
                            && e.scope.turn == origin
                    })
                }
            });
        }
        let (input, cancel) = {
            let mut sessions = self.sessions.lock().unwrap();
            let open = sessions
                .get_mut(session)
                .ok_or_else(|| OperationError::NotFound("unknown session".into()))?;
            open.check_rewind()?;
            ensure!(
                !open.active,
                OperationError::Busy("a turn is already running".into())
            );
            let input = if !resume.is_empty() {
                let source = branch
                    .iter()
                    .find(|e| e.scope.call.as_ref() == Some(&resume[0].id))
                    .unwrap();
                Input {
                    id: source.id.clone(),
                    actor: source.scope.actor.clone(),
                    text: "Continue after the answered input requests.".into(),
                    timing: Timing::Now,
                    key: None,
                }
            } else if let Some(i) = open.queue.iter().position(|i| i.timing != Timing::Propose) {
                open.queue.remove(i).unwrap()
            } else {
                return Ok(None);
            };

            open.active = true;
            open.steer_closed = false;
            open.cancel = CancellationToken::new();
            (input, open.cancel.clone())
        };
        let scope = Scope {
            actor: input.actor.clone(),
            job: self
                .snapshot(session)?
                .entries
                .iter()
                .find(|e| {
                    e.kind == "input.accepted"
                        && (e.id == input.id
                            || e.content.as_ref().is_some_and(|d| d["inputId"] == input.id))
                })
                .and_then(|e| e.scope.job.clone()),
            turn: Some(id()),
            ..Scope::session(session)
        };
        let admitted_input = input.id.clone();
        let result = self
            .prepare_and_run(&scope, input, cancel.clone(), resume)
            .await;
        self.sessions
            .lock()
            .unwrap()
            .get_mut(session)
            .unwrap()
            .active = false;
        let result = match result {
            Ok(r) => r,
            Err(e) => {
                let r = TurnResult {
                    outcome: if cancel.is_cancelled() {
                        Outcome::Cancelled
                    } else {
                        Outcome::Failed
                    },
                    error: (!cancel.is_cancelled()).then(|| e.to_string()),
                    ..TurnResult::default()
                };
                let data = self.snapshot(session)?;
                if !data
                    .entries
                    .iter()
                    .any(|e| e.kind == "turn.end" && e.scope.turn == scope.turn)
                {
                    let mut end = json!(r);
                    end["inputId"] = json!(admitted_input);
                    self.append(&scope, "harness", Draft::new("turn.end", false, end))?;
                }
                r
            }
        };
        let mut event = json!(result);
        event["inputId"] = json!(admitted_input);
        self.emit(Event::new(&scope, "turn.result", event)).await?;
        let view = self
            .output(
                &scope,
                Output {
                    recipient: "interface".into(),
                    value: json!(result),
                    stream: None,
                    end: true,
                },
            )
            .await?;
        Ok(Some(serde_json::from_value(view.unwrap_or_else(|| {
            json!(TurnResult {
                outcome: result.outcome,
                ..TurnResult::default()
            })
        }))?))
    }
    async fn prepare_and_run(
        &self,
        scope: &Scope,
        input: Input,
        cancel: CancellationToken,
        resume: Vec<ToolCall>,
    ) -> Result<TurnResult> {
        let data = self.snapshot(&scope.session)?;
        let source = data.entries.iter().rev().find(|e| {
            e.content
                .as_ref()
                .is_some_and(|v| e.kind == "input.accepted" && v["inputId"] == input.id)
                || e.id == input.id
        });
        let mut cap = self.authority(&scope.session, &input.actor)?;
        if let Some(source) = source {
            if let Some(v) = &source.content {
                cap = admitted_authority(self, &scope.session, cap, v)?;
            }
            if source.kind == "tool.call" {
                cap = cap.intersect(&work_authority(self, &source.scope)?);
            }
        }
        let budget_reached = self.tenant_budget_reached(&scope.session)?;
        let selector: Arc<dyn ModelSelection> = capability(self, "model.selection")?;
        let selected = selector.select(self.api(), scope).await;
        let info = selected
            .as_ref()
            .map(|model| model.info())
            .unwrap_or_else(|_| ModelInfo {
                name: data.settings["model"]
                    .as_str()
                    .unwrap_or("unknown")
                    .to_owned(),
                ..ModelInfo::default()
            });
        let contributions = self
            .invoke(
                &self.points["before.turn"],
                scope,
                json!({"input":input.text}),
            )
            .await?
            .value;
        let mut system = contributions
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().or_else(|| v["system"].as_str()))
            .collect::<Vec<_>>()
            .join("\n\n");
        let context: Vec<_> = contributions
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v["context"].as_array())
            .flatten()
            .cloned()
            .collect();
        let data = self.snapshot(&scope.session)?;
        let mut tools = vec![];
        for name in self.capability_names("tools.") {
            let source: Arc<dyn ToolSource> = capability(self, &name)?;
            for tool in source.tools(&data) {
                if !tool.allows("model") {
                    continue;
                }
                // `model_tools` names the only tools the model is offered.
                // The rest stay registered, for other tools and the UI to call.
                if data.settings["model_tools"]
                    .as_array()
                    .is_some_and(|names| !names.iter().any(|name| name == &tool.name))
                {
                    continue;
                }
                ensure!(
                    !tools.iter().any(|t: &ToolDefinition| t.name == tool.name),
                    "duplicate tool {}",
                    tool.name
                );
                tools.push(tool);
            }
        }
        let runtime: Arc<dyn Runtime> = capability(
            self,
            match data.settings["_runtime"].as_str() {
                Some("durable") => "runtime.durable",
                Some("transient") => "runtime.transient",
                _ => "runtime",
            },
        )?;
        let started_by = if !resume.is_empty() {
            let request = data
                .entries
                .iter()
                .rev()
                .find(|e| {
                    e.kind == "request.answer"
                        && resume.iter().any(|c| Some(&c.id) == e.scope.call.as_ref())
                })
                .and_then(|e| e.content.as_ref().and_then(|v| v["request"].as_str()))
                .unwrap_or(&input.id);
            json!({"kind":"answer","id":request})
        } else if let Some(job) = &scope.job {
            json!({"kind":"job","id":job})
        } else {
            json!({"kind":"actor","id":scope.actor})
        };
        let env: Arc<dyn WorkingEnvironment> = capability(self, "environment")?;
        let mut settings = data.settings.clone();
        settings["thinking"] = json!(wire::lower_reasoning(
            settings["thinking"].as_str().unwrap_or("low"),
            &info.thinking
        ));
        if let Some(shape) = source
            .and_then(|e| e.content.as_ref())
            .and_then(|v| v.get("resultShape"))
        {
            settings["result_shape"] = shape.clone();
            system.push_str(&format!("\n\nFor the final answer, return only one JSON value matching this schema:\n{shape}"));
        }
        let mut start = json!({"startedBy":started_by,"model":info,"system":system,"tools":tools,"settings":settings,"resume":resume,"context":context});
        if let Some(origin) = resume
            .first()
            .and_then(|c| {
                data.entries
                    .iter()
                    .find(|e| e.kind == "tool.call" && e.scope.call.as_ref() == Some(&c.id))
            })
            .and_then(|e| e.scope.turn.as_ref())
        {
            start["continuesTurnId"] = json!(origin);
        }
        if env.declaration()["rewinding"] == true {
            match env.save_point(&scope.session, &data.project).await {
                Ok(point) => start["point"] = json!(point),
                Err(error) => eprintln!("turn has no saved point: {error}"),
            }
        }
        let mut entries = vec![];
        let input_id =
            if resume.is_empty() {
                input.id.clone()
            } else {
                let input_id = id();
                entries.push(Draft::new("input.accepted", false,
                json!({"inputId":input_id,"text":input.text,"timing":"now","authority":cap}))
                .copying(vec![input.id.clone()]));
                input_id
            };
        // Only system and context additions can carry history into turnStart.
        // A contribution can declare its sources, including an empty list for
        // static content. Without lineage, conservatively keep real records.
        let history = data.branch();
        let mut sources = Vec::new();
        for addition in contributions.as_array().into_iter().flatten().filter(|v| {
            v.as_str()
                .or_else(|| v["system"].as_str())
                .is_some_and(|s| !s.is_empty())
                || v["context"]
                    .as_array()
                    .is_some_and(|parts| !parts.is_empty())
        }) {
            if let Some(ids) = addition["sources"].as_array() {
                for id in ids {
                    ensure!(
                        id.as_str().is_some_and(|s| history
                            .iter()
                            .any(|e| e.id == s && e.content.is_some())),
                        "unknown before-turn source"
                    );
                    sources.push(id.as_str().unwrap().to_owned());
                }
            } else {
                sources.extend(
                    history
                        .iter()
                        .filter(|e| e.writer != "rust.derived" && e.content.is_some())
                        .map(|e| e.id.clone()),
                );
            }
        }
        entries.push(Draft::new("turn.start", false, start).copying(sources));
        let mut taken = json!({"text":input.text,"inputId":input_id,"key":input.key,"authority":cap,"context":context});
        if let Some(value) = source.and_then(|s| s.content.as_ref()) {
            if let Some(content) = value["content"].as_array() {
                let parts: Vec<_> = context.iter().chain(content).collect();
                taken["message"] = json!({"role":"user","content":parts});
            }
            for key in ["sponsor", "releasedBy"] {
                if let Some(actor) = wire::optional(value, key) {
                    taken[key] = actor.clone();
                }
            }
        }
        entries.push(Draft::new("input", true, taken).copying(vec![input.id]));
        self.publish(scope, "harness", entries, None, None)?;
        if budget_reached {
            let result = TurnResult {
                outcome: Outcome::Limit,
                limit: Some("tenantTokens".into()),
                ..Default::default()
            };
            self.append(
                scope,
                "harness",
                Draft::new("turn.end", false, json!(result)),
            )?;
            return Ok(result);
        }
        let model = selected?;
        runtime
            .run(
                self.api(),
                TurnInput {
                    resume,
                    scope: scope.clone(),
                    model,
                    system,
                    tools,
                    settings,
                    cancel,
                },
            )
            .await
    }
    pub fn declaration(&self) -> Result<Value> {
        let runtime: Arc<dyn Runtime> = capability(self, "runtime")?;
        let env: Arc<dyn WorkingEnvironment> = capability(self, "environment")?;
        let mut declaration = json!({"runtime":runtime.declaration(),"environment":env.declaration(),"forking":true,"erasure":self.store().is_some_and(|store|store.supports_erasure()),"several_actors":true,"rewinding":env.declaration()["rewinding"] == true,"input_keys":true,"holds_output":false,"plugins_during_session":false,"live_sessions":false,"provider_state":false,"provider_tools":false,"starts_unasked_turns":false,"output_bypass":false,"questions_outlast_turn":false,"queued_input_after_restart":"handedBack","queued_job_reports_after_restart":"run","settings_during_turn":"refused","retention":"indefinite"});
        merge(
            &mut declaration,
            self.registry.read().unwrap().declaration(),
        );
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
fn admitted_authority(
    api: &dyn AgentApi,
    session: &str,
    mut cap: Authority,
    v: &Value,
) -> Result<Authority> {
    if let Some(saved) = v.get("authority").filter(|v| !v.is_null()) {
        cap = cap.intersect(&serde_json::from_value(saved.clone())?);
    }
    for key in ["sponsor", "releasedBy"] {
        if let Some(actor) = v[key].as_str() {
            cap = cap.intersect(&api.authority(session, actor)?);
        }
    }
    Ok(cap)
}

fn make_entry(data: &SessionData, scope: &Scope, writer: &str, draft: Draft) -> Entry {
    // Imported calls are a view over a real response or start, not entries
    // that can be named in a persisted sources list.
    let mut seen = std::collections::HashSet::new();
    let copies = draft
        .copies
        .into_iter()
        .map(|id| {
            data.entries
                .iter()
                .find(|entry| entry.writer == "rust.derived" && entry.id == id)
                .and_then(|entry| entry.parent.clone())
                .unwrap_or(id)
        })
        .filter(|id| seen.insert(id.clone()))
        .collect();
    Entry {
        id: id(),
        parent: data.position.clone(),
        scope: scope.clone(),
        writer: writer.into(),
        at: now(),
        kind: draft.kind,
        visible: draft.visible,
        copies,
        content: Some(draft.content),
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
        Ok(serde_json::from_value(result.value["request"].clone())?)
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
        for plugin in plugins.iter().rev() {
            plugin.shutdown().await?;
        }
        Ok(())
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
        self.create_tenanted(project, settings, tenant).await
    }
    fn tenant(&self, session: &str) -> Result<Value> {
        let data = self.snapshot(session)?;
        let Some(name) = tenants::name(&data) else {
            return Ok(json!({"tenant":null,"rights":null,"tokens":null}));
        };
        let tenant = self.check_tenant(name)?;
        let tokens = if let Some(budget) = tenant.tokens {
            let mut sessions = self.list(None)?;
            if !sessions.iter().any(|s| s.id == session) {
                sessions.push(data.clone());
            }
            let mut used = 0u64;
            for s in sessions.iter().filter(|s| tenants::name(s) == Some(name)) {
                used = used.saturating_add(tenants::used(s)?);
            }
            json!({"budget":budget,"used":used})
        } else {
            Value::Null
        };
        Ok(json!({"tenant":name,"rights":tenant.rights,"tokens":tokens}))
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
        self.admit(scope, text, timing, key, Some(sponsor), None)
            .await
    }
    async fn release(
        &self,
        scope: &Scope,
        input: &str,
        timing: Timing,
        declined: bool,
    ) -> Result<()> {
        require(self, scope, "input")?;
        ensure!(
            timing != Timing::Propose,
            "cannot release to proposed state"
        );
        let data = self.snapshot(&scope.session)?;
        let source = data
            .entries
            .iter()
            .find(|e| {
                e.kind == "input.accepted"
                    && (e.id == input || e.content.as_ref().is_some_and(|v| v["inputId"] == input))
            })
            .ok_or_else(|| anyhow!("unknown proposed input"))?;
        let releaser = self.authority(&scope.session, &scope.actor)?;
        let admitted = source
            .content
            .as_ref()
            .ok_or_else(|| anyhow!("erased proposal"))?;
        let cap = admitted_authority(
            self,
            &scope.session,
            self.authority(&scope.session, &source.scope.actor)?,
            admitted,
        )?
        .intersect(&releaser);
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(&scope.session)
            .ok_or_else(|| anyhow!("session closed"))?;
        let i = open
            .queue
            .iter()
            .position(|i| i.id == input && i.timing == Timing::Propose)
            .ok_or_else(|| anyhow!("input is not awaiting release"))?;
        open.check_rewind()?;
        let proposal = &open.queue[i];
        let (record_scope, draft) = if declined {
            (
                scope.clone(),
                Draft::new("input.returned", false, json!({"input":input})),
            )
        } else {
            (
                source.scope.clone(),
                Draft::new(
                    "input.accepted",
                    false,
                    json!({"inputId":input,"text":proposal.text,"content":portable::input_content(admitted),
                   "key":proposal.key,"timing":timing,"authority":cap,"sponsor":admitted["sponsor"],"submittedBy":admitted["submittedBy"],"releasedBy":scope.actor}),
                ),
            )
        };
        let mut next = open.data.clone();
        let entry = make_entry(&next, &record_scope, "harness", draft);
        next.position = Some(entry.id.clone());
        next.entries.push(entry);
        self.save(&next)?;
        open.data = next;
        if declined {
            open.queue.remove(i);
        } else {
            open.queue[i].timing = timing;
        }
        Ok(())
    }
    async fn withdraw_proposal(&self, scope: &Scope, sponsor: &str, input: &str) -> Result<()> {
        let shared = self
            .authority(&scope.session, &scope.actor)?
            .intersect(&self.authority(&scope.session, sponsor)?);
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(&scope.session)
            .ok_or_else(|| anyhow!("session closed"))?;
        let i = open
            .queue
            .iter()
            .position(|i| i.id == input && i.timing == Timing::Propose)
            .ok_or_else(|| anyhow!("input is not awaiting release"))?;
        ensure!(
            open.queue[i].actor == scope.actor || shared.has("input"),
            "cannot withdraw another actor's proposal"
        );
        ensure!(
            scope.actor == sponsor || shared.has("propose") || shared.has("input"),
            "connection cannot act for proposer"
        );
        let mut next = open.data.clone();
        let entry = make_entry(
            &next,
            scope,
            "harness",
            Draft::new("input.withdrawn", false, json!({"input":input})),
        );
        next.position = Some(entry.id.clone());
        next.entries.push(entry);
        self.save(&next)?;
        open.data = next;
        open.queue.remove(i);
        Ok(())
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
    fn check_writer(&self, session: &str) -> Result<()> {
        let sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get(session)
            .ok_or_else(|| anyhow!("session not open"))?;
        if let Some(lease) = &open._lease {
            lease.check()?;
        }
        Ok(())
    }
    fn cancellation(&self, session: &str) -> Result<CancellationToken> {
        Ok(self
            .sessions
            .lock()
            .unwrap()
            .get(session)
            .ok_or_else(|| anyhow!("session not open"))?
            .cancel
            .clone())
    }
    fn capability(&self, name: &str) -> Result<Arc<dyn Any + Send + Sync>> {
        self.registry.read().unwrap().capability(name)
    }
    fn capability_names(&self, prefix: &str) -> Vec<String> {
        self.registry.read().unwrap().capability_names(prefix)
    }
    fn tool_registration(&self, key: &str) -> Value {
        self.registry.read().unwrap().tool_registration(key)
    }
    fn snapshot(&self, session: &str) -> Result<SessionData> {
        Ok(self
            .sessions
            .lock()
            .unwrap()
            .get(session)
            .ok_or_else(|| anyhow!("session not open"))?
            .data
            .clone())
    }
    fn authority(&self, session: &str, actor: &str) -> Result<Authority> {
        let data = self.snapshot(session).or_else(|_| {
            self.store()
                .ok_or_else(|| anyhow!("session unavailable"))?
                .load(session)
        })?;
        if let Some(id) = actor.strip_prefix("job:") {
            let job = jobs(&data)?
                .into_iter()
                .find(|j| j.id == id)
                .ok_or_else(|| anyhow!("unknown job actor"))?;
            let mut origin = job.scope.clone();
            origin.job = None;
            let mut cap = job.authority.intersect(&work_authority(self, &origin)?);
            if let Some(child) = job.detail["child"].as_str() {
                cap = cap.intersect(&self.authority(child, "user")?);
            }
            return Ok(cap);
        }
        let mut authority = if actor == "user" {
            Authority::full()
        } else {
            Authority::default()
        };
        // Grants are session security state, not a branch-local approval.
        for e in &data.entries {
            if let Some(v) = &e.content {
                if e.kind == "actor.grant" && v["actor"] == actor {
                    authority = serde_json::from_value(v["authority"].clone())?;
                } else if e.kind == "actor.left" && v["actorId"] == actor {
                    authority = Authority::default();
                }
            }
        }
        if let Some(cap) = data
            .entries
            .iter()
            .rev()
            .find(|e| e.kind == "limit")
            .and_then(|e| e.content.as_ref())
            .and_then(|v| wire::optional(v, "rights"))
        {
            authority = authority.intersect(&serde_json::from_value(cap.clone())?);
        }
        if let Some(tenant) = tenants::name(&data) {
            authority = authority.intersect(&self.check_tenant(tenant)?.rights);
        }
        if let Some(cap) = data.settings.get("_authority") {
            authority = authority.intersect(&serde_json::from_value(cap.clone())?);
        }
        if let Some(parent) = data.settings["_parent"]["session"].as_str() {
            let parent_actor = data.settings["_parent"]["actor"].as_str().unwrap_or("user");
            authority = authority.intersect(&self.authority(parent, parent_actor)?);
        }
        Ok(authority)
    }
    fn grant(&self, scope: &Scope, actor: &str, authority: Authority) -> Result<()> {
        require(self, scope, "grant")?;
        ensure!(!actor.starts_with("job:"), "reserved actor identity");
        ensure!(
            work_authority(self, scope)?
                .intersect(&Authority::full())
                .contains(&authority),
            "cannot grant more authority than actor has"
        );
        self.append(
            scope,
            "harness",
            Draft::new(
                "actor.grant",
                false,
                json!({"actor":actor,"authority":authority}),
            ),
        )?;
        Ok(())
    }
    fn publish(
        &self,
        scope: &Scope,
        writer: &str,
        drafts: Vec<Draft>,
        input: Option<(String, String)>,
        key: Option<String>,
    ) -> Result<Vec<Entry>> {
        let cap = input
            .as_ref()
            .map(|(_, actor)| self.authority(&scope.session, actor))
            .transpose()?;
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(&scope.session)
            .ok_or_else(|| anyhow!("session not open"))?;
        open.check_rewind()?;
        if let Some(key) = &key
            && open.data.entries.iter().any(|e| {
                matches!(e.kind.as_str(), "input" | "input.accepted")
                    && e.content.as_ref().is_some_and(|v| v["key"] == *key)
            })
        {
            return Ok(vec![]);
        }
        let mut next = open.data.clone();
        let mut entries = vec![];
        for draft in drafts {
            let entry = make_entry(&next, scope, writer, draft);
            next.position = Some(entry.id.clone());
            next.entries.push(entry.clone());
            entries.push(entry);
        }
        let report_content = entries
            .iter()
            .rev()
            .find(|e| e.kind == "job.end")
            .and_then(|e| e.content.as_ref()?.get("wireResult"))
            .cloned();
        let queued = input.map(|(text, actor)| {
            let input_scope = Scope {
                actor: actor.clone(),
                ..scope.clone()
            };
            let mut value = json!({"text":text,"key":key,"timing":Timing::After,"authority":cap});
            if report_content.is_some() {
                value["parked"] = json!(
                    !self.registry.read().unwrap().declaration()["job_reports_start_turns"]
                        .as_bool()
                        .unwrap_or(false)
                );
            }
            if let Some(content) = report_content {
                value["content"] = content;
            }
            let entry = make_entry(
                &next,
                &input_scope,
                writer,
                Draft::new("input.accepted", false, value),
            );
            let input = Input {
                id: entry.id.clone(),
                actor,
                text,
                timing: Timing::After,
                key,
            };
            next.position = Some(entry.id.clone());
            next.entries.push(entry.clone());
            entries.push(entry);
            input
        });
        self.save(&next)?;
        open.data = next;
        if let Some(input) = queued {
            open.queue.push_back(input);
        }
        for entry in &entries {
            self.pending_events.lock().unwrap().push(Event::new(
                scope,
                "history.entry",
                json!(entry),
            ));
        }
        Ok(entries)
    }
    fn append(&self, scope: &Scope, writer: &str, draft: Draft) -> Result<Entry> {
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(&scope.session)
            .ok_or_else(|| anyhow!("session not open"))?;
        open.check_rewind()?;
        if draft.kind == "tool.result" {
            ensure!(
                !open
                    .data
                    .entries
                    .iter()
                    .any(|e| e.kind == "tool.result" && e.scope.call == scope.call),
                "tool call already has a result"
            );
        }
        let entry = make_entry(&open.data, scope, writer, draft);
        let mut next = open.data.clone();
        next.position = Some(entry.id.clone());
        next.entries.push(entry.clone());
        self.save(&next)?;
        open.data = next;
        self.pending_events
            .lock()
            .unwrap()
            .push(Event::new(scope, "history.entry", json!(entry)));
        Ok(entry)
    }
    fn has_steering(&self, session: &str) -> Result<bool> {
        Ok(self
            .sessions
            .lock()
            .unwrap()
            .get(session)
            .ok_or_else(|| OperationError::NotFound("unknown session".into()))?
            .queue
            .iter()
            .any(|i| i.timing == Timing::Steer))
    }
    fn take_steering(&self, scope: &Scope) -> Result<Vec<Input>> {
        self.take_steering_inner(scope, false)
    }
    fn take_final_steering(&self, scope: &Scope) -> Result<Vec<Input>> {
        self.take_steering_inner(scope, true)
    }
    fn is_running(&self, session: &str) -> bool {
        self.sessions
            .lock()
            .unwrap()
            .get(session)
            .is_some_and(|s| s.active)
    }
    fn settings(&self, scope: &Scope, patch: Value) -> Result<Value> {
        require(self, scope, "settings")?;
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
        self.save(&next)?;
        open.data = next.clone();
        self.pending_events.lock().unwrap().push(Event::new(
            scope,
            "setting.changed",
            json!(entry),
        ));
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
            "cancel jobs before moving position"
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
            "unknown position"
        );
        let mut next = open.data.clone();
        let original = next.branch();
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
        self.save(&next)?;
        open.data = next;
        open.queue.clear();
        self.invalidate_providers(&scope.session)?;
        Ok(())
    }
    fn fork(&self, scope: &Scope, position: Option<String>) -> Result<String> {
        require(self, scope, "input")?;
        let _workspace = self.begin_environment_work(&scope.session)?;
        ensure!(
            !self.is_running(&scope.session),
            OperationError::Busy("cannot fork during a turn".into())
        );
        let mut source = self.snapshot(&scope.session)?;
        if let Some(p) = position {
            ensure!(
                source.entries.iter().any(|e| e.id == p),
                "unknown fork point"
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
            "settle pending work before forking"
        );
        ensure!(
            self.sessions
                .lock()
                .unwrap()
                .get(&scope.session)
                .unwrap()
                .queue
                .is_empty(),
            "take or withdraw queued input before forking"
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
            .filter(|e| e.writer != "rust.derived")
            .collect();
        for original in &branch {
            let mut entry = (*original).clone();
            entry.id = id();
            entry.parent = next.position.clone();
            entry.scope.session = new_id.clone();
            if let Some(v) = entry.content.as_mut() {
                if entry.kind == "request.open" {
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
            entry.copies.push(original.id.clone());
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
            let mut local: Vec<_> = e
                .copies
                .iter()
                .filter_map(|x| map.get(x).filter(|local| *local != &e.id).cloned())
                .collect();
            e.copies.append(&mut local);
        }
        if !next.entries.is_empty() {
            self.save(&next)?;
        }
        self.sessions.lock().unwrap().insert(
            new_id.clone(),
            OpenSession {
                data: next,
                _lease: lease,
                queue: VecDeque::new(),
                interrupted: Vec::new(),
                active: false,
                rewinding: false,
                journal_uncertain: false,
                environment_work: 0,
                steer_closed: false,
                cancel: CancellationToken::new(),
            },
        );
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
            if open.data.entries.iter().any(|e| e.kind != "command")
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
        let _erasure = self
            .erasure
            .try_write()
            .map_err(|_| anyhow!("erasure requires idle turns and no other erasure"))?;
        let (erased, affected) = {
            let mut sessions = self.sessions.lock().unwrap();
            ensure!(
                sessions
                    .values()
                    .all(|s| !s.active && s.check_rewind().is_ok())
                    && self.blocked_projects.lock().unwrap().is_empty(),
                "erasure requires all local turns to be idle"
            );
            let held: Vec<_> = sessions.keys().cloned().collect();
            let store = self
                .store()
                .ok_or_else(|| anyhow!("ephemeral erasure not provided"))?;
            ensure!(
                !store
                    .list(None)?
                    .iter()
                    .flat_map(|s| &s.entries)
                    .any(|e| authority_record(e) && entries.contains(&e.id)),
                "authority records cannot be erased to restore wider rights"
            );
            let changed = store.erase(entries, &held)?;
            let mut erased = vec![];
            let mut affected = BTreeMap::from([(scope.session.clone(), vec![])]);
            for data in changed {
                let ids = data
                    .entries
                    .last()
                    .and_then(|e| e.content.as_ref())
                    .and_then(|v| v["entryIds"].as_array())
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>();
                erased.extend(ids.iter().cloned());
                affected.insert(data.id.clone(), ids);
                if let Some(open) = sessions.get_mut(&data.id) {
                    open.queue.retain(|q| {
                        data.entries
                            .iter()
                            .any(|e| e.id == q.id && e.content.is_some())
                    });
                    open.data = data;
                }
            }
            self.pending_events.lock().unwrap().clear();
            for session in affected.keys() {
                self.invalidate_providers(session)?;
            }
            (erased, affected)
        };
        let mut out_of_reach = vec!["output already delivered to recipients".into()];
        let mut pending = std::collections::BTreeSet::new();
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
    async fn output(&self, scope: &Scope, output: Output) -> Result<Option<Value>> {
        let recipient = output.recipient.clone();
        let Some(value) = self.local_output(scope, output).await? else {
            return Ok(None);
        };
        if !self.holds_remote_output() {
            return Ok(Some(value));
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
        Ok(self
            .remote_output(scope, &recipient, vec![json!({"type":kind,"data":value})])
            .await?
            .into_iter()
            .next()
            .map(|event| event["data"].clone()))
    }
    async fn emit(&self, event: Event) -> Result<()> {
        let mut events = if event.stream.is_some() && !event.end {
            vec![]
        } else {
            std::mem::take(&mut *self.pending_events.lock().unwrap())
        };
        events.push(event);
        for event in events {
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
                    if let Some(view) = view {
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
                    let mut held = self.held_output.lock().unwrap();
                    if let Some(item) = item {
                        held.entry(key.clone()).or_default().push(item);
                    }
                    if !event.end {
                        continue;
                    }
                    held.remove(&key).unwrap_or_default()
                } else {
                    item.into_iter().collect()
                };
                let gated = self
                    .remote_output(
                        &event.scope,
                        &name,
                        batch.iter().map(|(_, item)| item.clone()).collect(),
                    )
                    .await?;
                let decoded = batch
                    .into_iter()
                    .zip(gated)
                    .map(|((original, before), after)| output::decode(original, &before, &after))
                    .collect::<Result<Vec<_>>>();
                if let Ok(decoded) = decoded {
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
        let h = self.registry.read().unwrap().command(name)?;
        Ok(h.handle(self.api(), scope.clone(), json!({"args":args}))
            .await?
            .value)
    }
    fn commands(&self) -> Vec<String> {
        self.registry.read().unwrap().commands()
    }
    async fn dispatch_tool(
        &self,
        scope: &Scope,
        call: ToolCall,
        cancel: CancellationToken,
    ) -> ToolResult {
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
                return source.run(self.api(), scope.clone(), call, cancel).await;
            }
        }
        ToolResult::new(
            &call,
            ToolStatus::Failed,
            format!("unknown tool {}", call.name),
        )
    }
}
impl Harness {
    fn take_steering_inner(&self, scope: &Scope, final_check: bool) -> Result<Vec<Input>> {
        let inputs = {
            let mut sessions = self.sessions.lock().unwrap();
            let open = sessions
                .get_mut(&scope.session)
                .ok_or_else(|| OperationError::NotFound("unknown session".into()))?;
            let mut inputs = vec![];
            let mut rest = VecDeque::new();
            for i in open.queue.drain(..) {
                if i.timing == Timing::Steer {
                    inputs.push(i)
                } else {
                    rest.push_back(i)
                }
            }
            open.queue = rest;
            if final_check && inputs.is_empty() {
                open.steer_closed = true;
            }
            inputs
        };
        for input in &inputs {
            let data = self.snapshot(&scope.session)?;
            let mut cap = self.authority(&scope.session, &input.actor)?;
            let accepted = data
                .entries
                .iter()
                .rev()
                .find(|e| {
                    e.kind == "input.accepted"
                        && e.content
                            .as_ref()
                            .is_some_and(|v| v["inputId"] == input.id || e.id == input.id)
                })
                .and_then(|e| e.content.as_ref());
            if let Some(v) = accepted {
                cap = admitted_authority(self, &scope.session, cap, v)?;
            }
            let mut taken =
                json!({"text":input.text,"inputId":input.id,"key":input.key,"authority":cap});
            for key in ["sponsor", "releasedBy"] {
                if let Some(value) = accepted.and_then(|v| wire::optional(v, key)) {
                    taken[key] = value.clone();
                }
            }
            let input_scope = Scope {
                actor: input.actor.clone(),
                ..scope.clone()
            };
            self.append(
                &input_scope,
                "harness",
                Draft::new("input", true, taken).copying(vec![input.id.clone()]),
            )?;
        }
        Ok(inputs)
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        for plugin in self.plugins.get_mut().unwrap().iter().rev() {
            let _ = plugin.stop();
        }
    }
}
