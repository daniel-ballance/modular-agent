use super::{
    ActiveTurn, Harness, OpenSession,
    history_commit::{make_entry, push_setup},
    tenants,
};
use agent_api::telemetry::{KeyValue, Operation, SpanKind};
use agent_api::*;
use std::{
    collections::{BTreeMap, VecDeque},
    path::Path,
};

fn same_open_authority(a: &SessionData, b: &SessionData) -> bool {
    fn records(data: &SessionData) -> impl Iterator<Item = &Entry> {
        data.entries.iter().filter(|e| {
            matches!(
                e.kind.as_str(),
                "actor.grant" | "actor.left" | "limit" | "tenant"
            )
        })
    }
    a.project == b.project
        && a.settings == b.settings
        && records(a)
            .map(|e| (&e.kind, &e.content))
            .eq(records(b).map(|e| (&e.kind, &e.content)))
}

impl Harness {
    pub async fn create(&self, project: &Path, settings: Value) -> Result<String> {
        self.create_tenanted(project, settings, None, false).await
    }
    pub(super) async fn create_tenanted(
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

    pub(super) async fn install_recovery(&self, id: &str) -> Result<Vec<Input>> {
        if SESSION_OPEN_POLICY
            .try_with(|policy| policy.session == id)
            .unwrap_or(false)
        {
            let snapshot = self
                .sessions
                .lock()
                .unwrap()
                .get(id)
                .map(|open| open.data.clone())
                .ok_or_else(|| anyhow!(SessionNotOpen));
            if let Ok(data) = snapshot {
                let rights =
                    SESSION_OPEN_POLICY.with(|policy| self.check_session_open(&data, policy))?;
                let mut sessions = self.sessions.lock().unwrap();
                let open = sessions.get_mut(id).ok_or(SessionNotOpen)?;
                self.retry_locked_erasure(open)?;
                open.check_rewind()?;
                ensure!(
                    same_open_authority(&open.data, &data),
                    OperationError::Busy("session authority changed during attachment".into())
                );
                SESSION_OPEN_POLICY.with(|policy| self.admit_session_open(open, policy, rights))?;
                return Ok(vec![]);
            } else if let Err(error) = snapshot
                && !error.is::<SessionNotOpen>()
            {
                return Err(error);
            }
        }
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
            ensure!(
                !self.sessions.lock().unwrap().contains_key(id),
                OperationError::Busy("session already open here".into())
            );
            let store = self.store().ok_or_else(|| anyhow!("no history store"))?;
            let session_id = id.to_owned();
            let loaded = tokio::task::spawn_blocking(move || -> Result<_> {
                let lease = store.acquire(&session_id)?;
                let loaded = store.load(&session_id)?;
                Ok(select(&loaded)?.then_some((store, lease, loaded)))
            })
            .await??;
            let Some((store, lease, mut loaded)) = loaded else {
                return Ok(None);
            };
            if let Some(tenant) = tenants::name(&loaded) {
                self.check_tenant(tenant)?;
            }
            SESSION_OPEN_POLICY
                .try_with(|policy| {
                    if policy.session == id {
                        self.check_session_open(&loaded, policy).map(|_| ())
                    } else {
                        Ok(())
                    }
                })
                .unwrap_or(Ok(()))?;
            let pending = match store.check_erasure(&loaded) {
                Ok(()) => false,
                Err(error) if error.is::<PendingErasure>() => true,
                Err(error) => return Err(error),
            };
            if pending {
                self.settle_stored_erasure_jobs(&store, lease.as_ref(), &mut loaded)
                    .await?;
                self.discard_local_provider_state(id).await?;
                lease.check()?;
            }
            let (mut data, erased) = tokio::task::spawn_blocking(move || -> Result<_> {
                let reconciled = if pending {
                    store.reconcile_erasure(&loaded.id)?
                } else {
                    None
                };
                let (data, erased) = match reconciled {
                    Some((data, _)) => (data, true),
                    None => (loaded, false),
                };
                store.check_erasure(&data)?;
                Ok((data, erased))
            })
            .await??;
            let open_rights = SESSION_OPEN_POLICY
                .try_with(|policy| {
                    (policy.session == id).then(|| self.check_session_open(&data, policy))
                })
                .ok()
                .flatten()
                .transpose()?;
            if let Some(remove) = self.private_erasure.get() {
                remove(&data)?;
            }
            if erased {
                self.invalidate_providers(id)?;
            }
            if let Some(tenant) = tenants::name(&data) {
                self.check_tenant(tenant)?;
            }
            wire::validate_recorded_approval(&data.settings)?;
            match data.settings.get("approval") {
                None => data.settings["approval"] = json!("ask_always"),
                Some(value)
                    if matches!(
                        value.as_str(),
                        Some("off" | "ask_unless_read_only" | "ask_always" | "never_ask")
                    ) => {}
                Some(_) => data.settings["approval"] = json!("never_ask"),
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
                if let Some(rights) = open_rights
                    && let Err(error) = SESSION_OPEN_POLICY.with(|policy| {
                        self.admit_session_open(sessions.get_mut(id).unwrap(), policy, rights)
                    })
                {
                    sessions.remove(id);
                    self.blocked_projects.lock().unwrap().remove(&project);
                    return Err(error);
                }
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
                if sessions
                    .get(id)
                    .is_some_and(|open| self.can_release_pending_writer(open))
                {
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

    pub(super) fn session_snapshot(&self, session: &str) -> Result<SessionData> {
        let sessions = self.sessions.lock().unwrap();
        let open = sessions.get(session).ok_or(SessionNotOpen)?;
        self.check_open_erasure(open)?;
        Ok(open.data.clone())
    }

    pub(super) fn list_sessions(&self, project: Option<&Path>) -> Result<Vec<SessionData>> {
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
}
