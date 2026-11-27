use super::*;
use crate::events::Message;
use crate::routes::Fanout;
use tokio::sync::{mpsc, oneshot};
pub(crate) struct SharedSession {
    borrowed_writer: bool,
    pub id: String,
    pub project: PathBuf,
    pub api: Api,
    pub factory: Arc<dyn Factory>,
    fanout: Arc<Fanout>,
    pub gate: tokio::sync::Mutex<()>,
    pub(crate) drive_stop: CancellationToken,
    pub driver: Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub wake: tokio::sync::Notify,
    pub closing: std::sync::atomic::AtomicBool,
    pub cancellation: tokio::sync::Mutex<()>,
    pub completed: tokio::sync::Notify,
}

pub(crate) struct Session {
    pub shared: Arc<SharedSession>,
    pub route: String,
    pub stop: CancellationToken,
    pub tx: mpsc::Sender<Message>,
    pub worker: Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub approval_views: Mutex<std::collections::BTreeSet<(String, String)>>,
}
impl std::ops::Deref for Session {
    type Target = SharedSession;
    fn deref(&self) -> &Self::Target {
        &self.shared
    }
}
impl Session {
    fn new(shared: Arc<SharedSession>) -> (Arc<Session>, mpsc::Receiver<Message>) {
        let (tx, rx) = mpsc::channel(64);
        let route = id();
        shared.fanout.add(&route, tx.clone());
        let session = Arc::new(Session {
            shared,
            route,
            stop: CancellationToken::new(),
            tx,
            worker: Mutex::new(None),
            approval_views: Mutex::default(),
        });
        (session, rx)
    }
    fn start_route(
        self: &Arc<Self>,
        state: &State,
        rx: mpsc::Receiver<Message>,
        cx: ConnectionTo<acp::Client>,
    ) -> Result<()> {
        let requests = requests(self.api.as_ref())?;
        requests.presence_route(&self.id, &state.principal.id, &self.route, true);
        if let Ok(data) = self.api.snapshot(&self.id) {
            let members = actors(&data);
            for id in state
                .principal
                .represents
                .iter()
                .filter(|id| members.contains_key(*id))
            {
                requests.presence_route(&self.id, id, &self.route, true);
            }
        }
        let worker = tokio::spawn(with_principal(
            state.principal.clone(),
            state.ceiling.clone(),
            events::pump(
                self.clone(),
                rx,
                cx,
                state.client.lock().unwrap().clone().unwrap_or_default(),
            ),
        ));
        *self.worker.lock().unwrap() = Some(worker);
        Ok(())
    }
    pub fn waiting_route(&self) -> Result<ApprovalRoute> {
        self.check_view()?;
        let actor = connection_actor();
        Ok(ApprovalRoute {
            instance: self.route.clone(),
            binding: PRINCIPAL
                .try_with(|p| p.approval_route())
                .map_err(|_| anyhow!("no ACP principal"))?,
            actor: actor.clone(),
            principal: actor.clone(),
            ceiling: self.api.authority(&self.id, &actor)?,
            live: self.stop.clone(),
        })
    }
    pub async fn detach_route(&self) -> bool {
        let last = self.fanout.remove(&self.route);
        self.stop.cancel();
        if let Ok(requests) = requests(self.api.as_ref()) {
            requests.detach_presence(&self.id, &self.route);
        }
        let worker = self.worker.lock().unwrap().take();
        if let Some(worker) = worker {
            let _ = worker.await;
        }
        last
    }
    pub fn check_view(&self) -> Result<()> {
        ensure!(
            !self.stop.is_cancelled() && !self.drive_stop.is_cancelled(),
            request_error("not_open", "session is detached")
        );
        let data = self.api.snapshot(&self.id)?;
        let allowed = PRINCIPAL
            .try_with(|identity| {
                self.factory.serves_project(&data.project) && in_scope(identity, &data)
            })
            .unwrap_or(false);
        ensure!(
            allowed
                && self
                    .api
                    .authority(&self.id, &connection_actor())?
                    .has("watch"),
            request_error("forbidden", "session inaccessible")
        );
        Ok(())
    }

    pub async fn flush(&self) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Message::Flush(tx))
            .await
            .map_err(|_| anyhow!("ACP output disconnected"))?;
        rx.await.map_err(|_| anyhow!("ACP output disconnected"))
    }
    pub async fn cancel(&self) -> Result<()> {
        let _guard = self.cancellation.lock().await;
        let data = self.api.snapshot(&self.id)?;
        let turn = if self.api.is_running(&self.id) {
            data.branch()
                .iter()
                .rev()
                .find(|e| e.kind == "input")
                .and_then(|e| e.scope.turn.clone())
        } else {
            None
        };
        let returned = self.api.cancel(&self.id).await?;
        if let Some(turn) = turn {
            let inputs: Vec<_> = returned.iter().map(|i| i.id.clone()).collect();
            self.api.append(
                &Scope {
                    turn: Some(turn),
                    ..actor_scope(&self.id)
                },
                "interface.acp",
                Draft::new("acp.input.returned", false, json!({"inputs":inputs})).copying(inputs),
            )?;
        }
        Ok(())
    }
    pub fn begin_close(&self, requested: bool) -> Result<()> {
        use std::sync::atomic::Ordering::SeqCst;
        if self.closing.load(SeqCst) {
            return Err(request_error("busy", "session is already closing").into());
        }
        if requested {
            let data = self.api.snapshot(&self.id)?;
            ensure!(
                actors(&data).contains_key(connection_actor().as_str()),
                request_error("forbidden", "closing requires membership")
            );
            if self.api.is_running(&self.id)
                || jobs(&data)?.iter().any(|j| j.state == JobState::Running)
            {
                require(self.api.as_ref(), &actor_scope(&self.id), "cancel")?;
            }
        }
        self.closing
            .compare_exchange(false, true, SeqCst, SeqCst)
            .map_err(|_| request_error("busy", "session is already closing"))?;
        Ok(())
    }
    pub async fn close(&self) -> Result<()> {
        self.begin_close(false)?;
        self.finish_close().await
    }
    pub async fn finish_close(&self) -> Result<()> {
        self.drive_stop.cancel();
        let routes = self.fanout.clear();
        if let Ok(service) = requests(self.api.as_ref()) {
            for route in routes {
                service.detach_presence(&self.id, &route);
            }
        }
        self.detach_route().await;
        let open = self.api.snapshot(&self.id).is_ok();
        if open && !self.borrowed_writer && self.api.is_running(&self.id) {
            self.cancel().await?;
        }
        let driver = self.driver.lock().unwrap().take();
        if let Some(driver) = driver {
            let _ = driver.await;
        }
        let _guard = self.gate.lock().await;
        let result = if open && !self.borrowed_writer {
            self.api.close(&self.id).await
        } else {
            Ok(())
        };
        self.factory.detach(self.api.clone(), &self.id).await;
        result.and(self.factory.dispose(self.api.clone()).await)
    }
    pub async fn prompt(&self, text: &str, key: Option<String>) -> Result<Value> {
        let mut guard = Some(self.gate.lock().await);
        ensure!(
            !self.closing.load(std::sync::atomic::Ordering::SeqCst),
            "session closing"
        );
        let receipt = self
            .api
            .submit(
                &self.id,
                connection_actor().as_str(),
                text,
                Timing::Now,
                key,
            )
            .await?;
        if receipt.erased {
            return Ok(
                json!({"stopReason":"end_turn","_meta":{"modular-agent":{"duplicate":true,"erased":true}}}),
            );
        }
        if text.split_whitespace().next() == Some("/fork")
            && let Some(id) = receipt.command.as_ref().and_then(|v| v["session"].as_str())
        {
            self.api.close(id).await?;
        }
        if !receipt.duplicate && receipt.command.is_none() && !self.api.is_running(&self.id) {
            self.api.next_turn(&self.id).await?;
        }
        let interruption = self.api.writer_interruption(&self.id)?;
        // A duplicate of extension input may still be queued. It must describe
        // the original turn, never invent a completed outcome or start it twice.
        if receipt.command.is_none()
            && !binding::has_result(&self.api.snapshot(&self.id)?, &receipt.input)
        {
            drop(guard.take());
            loop {
                let completed = self.completed.notified();
                tokio::pin!(completed);
                completed.as_mut().enable();
                let data = self.api.snapshot(&self.id)?;
                if binding::has_result(&data, &receipt.input) {
                    break;
                }
                ensure!(
                    !data.entries.iter().any(|e| e.kind == "input.returned"
                        && e.content
                            .as_ref()
                            .is_some_and(|c| c["input"] == receipt.input)),
                    "input was handed back before a turn took it"
                );
                self.wake.notify_one();
                tokio::select! {
                    _ = interruption.cancelled() => bail!(LostPart("session writer interrupted; reopen to recover".into())),
                    _ = completed => (),
                    _ = self.stop.cancelled() => bail!("session closed before input ran"),
                }
            }
        }
        // cancel may still be recording the queued inputs it handed back.
        let _cancel = self.cancellation.lock().await;
        let response = binding::prompt_response(&self.api.snapshot(&self.id)?, &receipt)?;
        self.flush().await?;
        Ok(response)
    }
    pub async fn input(
        &self,
        actor: &str,
        text: String,
        timing: Timing,
        key: Option<String>,
    ) -> Result<Value> {
        ensure!(
            !self.closing.load(std::sync::atomic::Ordering::SeqCst),
            "session closing"
        );
        let running = self.api.is_running(&self.id);
        let receipt = self
            .api
            .submit_as(
                &Scope {
                    actor: actor.into(),
                    ..actor_scope(&self.id)
                },
                connection_actor().as_str(),
                &text,
                timing,
                key,
            )
            .await?;
        if receipt.erased {
            return Ok(json!({"duplicate":true,"erased":true}));
        }
        // Preserve admission-time timing for retries, including after a restart.
        let data = self.api.snapshot(&self.id)?;
        let taken = data
            .entries
            .iter()
            .find(|e| {
                (e.kind == "acp.input.receipt" || e.kind == "input.accepted")
                    && e.content
                        .as_ref()
                        .is_some_and(|c| c["inputId"] == receipt.input && c["taken"].is_string())
            })
            .and_then(|e| e.content.as_ref())
            .and_then(|c| c["taken"].as_str())
            .unwrap_or_else(|| {
                data.entries
                    .iter()
                    .find(|e| {
                        e.kind == "input.accepted"
                            && e.content
                                .as_ref()
                                .is_some_and(|v| v["inputId"] == receipt.input)
                    })
                    .and_then(|e| {
                        serde_json::from_value::<Timing>(e.content.as_ref()?["timing"].clone()).ok()
                    })
                    .map(|timing| input_taken(false, timing))
                    .unwrap_or_else(|| input_taken(running, timing))
            })
            .to_string();
        if !receipt.duplicate && timing != Timing::Propose {
            self.wake.notify_one();
        }
        Ok(json!({"inputId":receipt.input,"taken":taken,"duplicate":receipt.duplicate}))
    }
    pub async fn drive(self: Arc<Self>, reopening: bool) {
        if reopening {
            // Do not hold the admission gate here: a fresh prompt must be able
            // to queue, even if recovery is waiting for a live answer.
            if let Err(e) = self.api.run_recovery(&self.id).await {
                eprintln!("ACP recovery failed: {e}");
            }
            self.completed.notify_waiters();
            self.wake.notify_one();
        }
        loop {
            tokio::select! { _ = self.drive_stop.cancelled() => break, _ = self.wake.notified() => () }
            let _guard = tokio::select! { _ = self.drive_stop.cancelled() => break, guard = self.gate.lock() => guard };
            if self.closing.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            if let Err(e) = self.drain_inner().await {
                eprintln!("ACP input driver failed: {e}");
            }
        }
    }
    async fn drain_inner(&self) -> Result<()> {
        while !self.closing.load(std::sync::atomic::Ordering::SeqCst) {
            let Some(result) = self.api.next_turn(&self.id).await? else {
                break;
            };
            self.completed.notify_waiters();
            let stop = result.outcome != Outcome::Completed || !result.open_calls.is_empty();
            if stop {
                break;
            }
        }
        Ok(())
    }
}
fn recorded_rights(data: &SessionData, id: &str) -> Option<Option<Authority>> {
    data.entries.iter().rev().find_map(|e| {
        let v = e.content.as_ref()?;
        match e.kind.as_str() {
            "actor.grant" if v["actor"] == id => {
                Some(serde_json::from_value(v["authority"].clone()).ok())
            }
            "actor.left" if v["actorId"] == id => Some(None),
            _ => None,
        }
    })
}

pub(crate) fn in_scope(identity: &Identity, data: &SessionData) -> bool {
    let tenant = data
        .entries
        .iter()
        .find(|e| e.kind == "tenant")
        .and_then(|e| e.content.as_ref())
        .and_then(|v| v["tenant"].as_str());
    identity.allows_project(&data.project) && identity.allows_tenant(tenant)
}

pub(crate) fn discoverable(identity: &Identity, data: &SessionData) -> bool {
    in_scope(identity, data)
        && identity.rights.has("watch")
        && match recorded_rights(data, &identity.id) {
            Some(rights) => rights.is_some_and(|rights| {
                rights.has("watch")
                    && (identity.has_ceiling()
                        || identity
                            .rights
                            .contains(&rights.intersect(&Authority::full())))
            }),
            None => identity.join_on_open,
        }
}

pub(crate) fn join_host(api: &dyn AgentApi, session: &str) -> Result<()> {
    let identity = PRINCIPAL
        .try_with(|id| id.as_ref().clone())
        .unwrap_or_else(|_| {
            let mut identity = Identity::local();
            identity.id = connection_actor();
            identity
        });
    let data = api.snapshot(session)?;
    ensure!(
        in_scope(&identity, &data),
        request_error("forbidden", "session inaccessible")
    );
    let latest = recorded_rights(&data, &identity.id);
    if let Some(rights) = latest {
        ensure!(
            rights.is_some_and(|r| r.has("watch")
                && (if identity.has_ceiling() {
                    identity.rights.has("watch")
                } else {
                    identity.rights.contains(&r.intersect(&Authority::full()))
                })),
            request_error("forbidden", "session inaccessible")
        );
    } else {
        api.append(
            &actor_scope(session),
            "interface.acp",
            Draft::new("actor.grant", false, json!({
                "actor":identity.id,"kind":identity.kind,"authority":identity.rights,"operatorAdmission":true
            })),
        )?;
    }
    Ok(())
}

pub(crate) fn config(api: &dyn AgentApi, id: &str) -> Result<Value> {
    let settings = api.snapshot(id)?.settings;
    let mut models = Vec::new();
    let mut thinking = Vec::new();
    let mut current_model = String::new();
    for key in api.capability_names("provider.") {
        for model in capability::<dyn Provider>(api, &key)?.catalog() {
            if model.name == settings["model"] {
                thinking = model.thinking.clone();
                current_model = binding::model_id(&key, &model.name);
            }
            let name = binding::model_id(&key, &model.name);
            models.push(json!({"value":name,"name":name}));
        }
    }
    if current_model.is_empty() {
        let name = settings["model"].as_str().unwrap_or("unconfigured");
        current_model = if name.contains('/') {
            name.into()
        } else {
            format!("{}/{}", portable::native_provider(name), name)
        };
        models.insert(
            0,
            json!({"value":current_model,"name":format!("{current_model} (unavailable)")}),
        );
        thinking.push(settings["thinking"].as_str().unwrap_or("low").into());
    }
    let effective_thinking =
        wire::lower_reasoning(settings["thinking"].as_str().unwrap_or("low"), &thinking);
    let mut options = json!([
        {"id":"model","name":"Model","category":"model","type":"select","currentValue":current_model,"options":models},
        {"id":"thinking","name":"Thinking","category":"thought_level","type":"select","currentValue":effective_thinking,"options":thinking.into_iter().map(|v|json!({"value":v,"name":v})).collect::<Vec<_>>()}
    ]);
    let declaration = api.declaration()?;
    if declaration["approval_policies"].is_array() {
        options.as_array_mut().unwrap().push(json!({"id":"approval","name":"Approval","type":"select","currentValue":match settings["approval"].as_str() {Some("ask_always")=>"all",Some("ask_unless_read_only")=>"ask",Some("never_ask")=>"never",_=>"off"},"options":[{"value":"off","name":"Off"},{"value":"ask","name":"Ask unless read-only"},{"value":"all","name":"Ask always"},{"value":"never","name":"Refuse without asking"}]}));
    }
    if declaration["approvals_outlast_turns"] == true {
        options.as_array_mut().unwrap().push(json!({"id":"approvalWait","name":"Approval wait","type":"select","currentValue":settings["approvalWait"].as_str().unwrap_or("live"),"options":[{"value":"live","name":"Live only"},{"value":"untilDeadline","name":"Until deadline"}]}));
    }
    Ok(options)
}
struct Opening<'a>(&'a Mutex<std::collections::BTreeSet<String>>, String);
impl Drop for Opening<'_> {
    fn drop(&mut self) {
        self.0.lock().unwrap().remove(&self.1);
    }
}

impl State {
    async fn admit_open(
        &self,
        api: &dyn AgentApi,
        id: &str,
        project: &Path,
        tools: bool,
    ) -> Result<Vec<Input>> {
        let actor = &self.principal;
        SESSION_OPEN_POLICY
            .scope(
                SessionOpenPolicy {
                    session: id.into(),
                    actor: actor.id.clone(),
                    kind: actor.kind.clone(),
                    rights: actor.rights.clone(),
                    project: project.into(),
                    tenants: actor.tenants.clone().unwrap_or_else(|| vec![None]),
                    join_on_open: actor.join_on_open,
                    several_actors: !actor.network || self.factory.several_actors(api)?,
                    required: if tools { &["tools"] } else { &[] },
                    writer: "interface.acp",
                },
                api.install_recovery(id),
            )
            .await
    }

    async fn open_response(
        &self,
        session: &Session,
        method: &str,
        cx: &ConnectionTo<acp::Client>,
        handed_back: &[Input],
    ) -> Result<Value> {
        let api = &session.api;
        let id = &session.id;
        session.check_view()?;
        let mut response = json!({
            "configOptions": config(api.as_ref(), id)?,
            "_meta": {"modular-agent": {"declaration": self.factory.session_declaration(api.as_ref(), id)?}},
        });
        if method == "session/new" {
            response["sessionId"] = json!(id);
        }
        if !handed_back.is_empty() {
            response["_meta"]["modular-agent"]["handedBack"] = json!(handed_back.iter()
                .map(|input| json!({"inputId":input.id,"content":[{"type":"text","text":input.text}]}))
                .collect::<Vec<_>>());
        }
        let gated = api
            .output(
                &actor_scope(id),
                Output {
                    recipient: "interface.acp".into(),
                    value: json!({"method":method,"result":response}),
                    stream: None,
                    end: true,
                },
            )
            .await?
            .and_then(|v| v.get("result").cloned())
            .ok_or_else(withheld)?;
        if method == "session/load" {
            events::replay(api.clone(), id, cx).await?;
        }
        session.flush().await?;
        session.check_view()?;
        Ok(gated)
    }

    pub(crate) async fn setup_session(
        &self,
        method: &str,
        mut p: Value,
        cx: ConnectionTo<acp::Client>,
    ) -> Result<Value> {
        if p.is_object() && p["mcpServers"].is_null() {
            p["mcpServers"] = json!([]);
        }
        match method {
            "session/new" => {
                let _: NewSessionRequest = serde_json::from_value(p.clone())?;
            }
            "session/load" => {
                let _: LoadSessionRequest = serde_json::from_value(p.clone())?;
            }
            _ => {
                let _: ResumeSessionRequest = serde_json::from_value(p.clone())?;
            }
        }
        let cwd = Path::new(string(&p, "cwd")?);
        ensure!(cwd.is_absolute(), "cwd must be absolute");
        let project = cwd.canonicalize()?;
        ensure!(
            p["systemPrompt"].is_null(),
            "host system prompts are not supported; send recorded context as input"
        );
        ensure!(
            p["additionalDirectories"]
                .as_array()
                .is_none_or(|v| v.is_empty()),
            "additional roots are not supported"
        );
        let tenant = wire::optional(&p["_meta"]["modular-agent"], "tenant")
            .map(|v| v.as_str().ok_or_else(|| anyhow!("tenant must be a string")))
            .transpose()?;
        let reopening = method != "session/new";
        {
            let has_servers = p["mcpServers"]
                .as_array()
                .is_some_and(|servers| !servers.is_empty());
            ensure!(
                self.principal.allows_project(&project)
                    && self.factory.serves_project(&project)
                    && (!has_servers || self.principal.rights.has("tools"))
                    && (reopening
                        || (self.principal.allows_tenant(tenant)
                            && self.principal.rights.has("input")
                            && self.principal.rights.has("watch"))),
                request_error("forbidden", "session inaccessible")
            );
        }
        let _opening = if reopening {
            let id = string(&p, "sessionId")?.to_owned();
            ensure!(
                self.routes.opening.lock().unwrap().insert(id.clone()),
                request_error("busy", "session is already opening")
            );
            Some(Opening(&self.routes.opening, id))
        } else {
            None
        };
        let _guard = self.routes.setup.lock().await;
        let existing = if let Some(Opening(_, id)) = &_opening {
            let opened = self.sessions.lock().unwrap().get(id).cloned();
            if let Some(session) = opened {
                session.check_view()?;
                ensure!(
                    session.project == project,
                    request_error("wrong_project", "cwd differs from recorded session project")
                );
                ensure!(
                    !session.closing.load(std::sync::atomic::Ordering::SeqCst),
                    request_error("busy", "session is closing")
                );
                return self.open_response(&session, method, &cx, &[]).await;
            }
            let shared = self
                .routes
                .sessions
                .lock()
                .unwrap()
                .get(id)
                .and_then(std::sync::Weak::upgrade);
            if let Some(shared) = shared {
                let data = shared.api.snapshot(id)?;
                ensure!(
                    discoverable(&self.principal, &data)
                        && self.factory.serves_project(&data.project),
                    request_error("forbidden", "session inaccessible")
                );
                ensure!(
                    shared.project == project,
                    request_error("wrong_project", "cwd differs from recorded session project")
                );
                ensure!(
                    !shared.closing.load(std::sync::atomic::Ordering::SeqCst),
                    request_error("busy", "session is closing")
                );
                ensure!(
                    !p["mcpServers"]
                        .as_array()
                        .is_some_and(|servers| !servers.is_empty()),
                    request_error("busy", "cannot attach MCP to an open session")
                );
                self.admit_open(shared.api.as_ref(), id, &project, false)
                    .await?;
                let (session, rx) = Session::new(shared);
                session.start_route(self, rx, cx.clone())?;
                self.delivery_views
                    .lock()
                    .unwrap()
                    .insert(id.clone(), Arc::downgrade(&session));
                let result = self.open_response(&session, method, &cx, &[]).await;
                if result.is_ok() {
                    self.sessions.lock().unwrap().insert(id.clone(), session);
                } else {
                    self.delivery_views.lock().unwrap().remove(id);
                    session.detach_route().await;
                }
                return result;
            }
            let data = self
                .factory
                .list(None)?
                .into_iter()
                .find(|s| {
                    &s.id == id
                        && self.factory.serves_project(&s.project)
                        && discoverable(&self.principal, s)
                })
                .ok_or_else(|| request_error("forbidden", "session inaccessible"))?;
            ensure!(
                data.project == project,
                request_error("wrong_project", "cwd differs from recorded session project")
            );
            Some(data)
        } else {
            None
        };
        let reopening_id = existing.as_ref().map(|s| s.id.as_str());
        let unresolved = existing
            .as_ref()
            .is_some_and(|s| s.unresolved_rewind().is_some());
        {
            let mut blocked = self.routes.rewind_blocks.lock().unwrap();
            ensure!(
                blocked
                    .get(&project)
                    .is_none_or(|id| Some(id.as_str()) == reopening_id),
                request_error("busy", "project has an unresolved rewind")
            );
            if unresolved {
                let id = reopening_id.unwrap();
                ensure!(
                    !self.project_in_use(&project, id),
                    request_error("conflict", "cannot recover rewind in a shared project")
                );
                blocked.insert(project.clone(), id.into());
            }
        }
        let fanout = Arc::new(Fanout::default());
        let api = self
            .factory
            .build_for(&project, reopening_id, fanout.clone())
            .await?;
        fanout.bind(&api);
        let id = if let Some(data) = existing {
            data.id
        } else {
            let created = async {
                api.create_provisional(&project, self.factory.project_settings(&project)?, tenant)
                    .await
            }
            .await;
            match created {
                Ok(id) => id,
                Err(error) => {
                    let _ = self.factory.dispose(api).await;
                    return Err(error);
                }
            }
        };
        // The embedded SDK can already own this writer for an AG-UI thread.
        // Attach only a route. Do not recover, cancel or release its writer.
        let borrowed_writer =
            reopening && !self.factory.owns_session_agent() && api.snapshot(&id).is_ok();
        let (session, rx) = Session::new(Arc::new(SharedSession {
            borrowed_writer,
            id: id.clone(),
            project: project.clone(),
            api: api.clone(),
            factory: self.factory.clone(),
            fanout,
            gate: tokio::sync::Mutex::new(()),
            drive_stop: CancellationToken::new(),
            driver: Mutex::new(None),
            wake: tokio::sync::Notify::new(),
            closing: std::sync::atomic::AtomicBool::new(false),
            cancellation: tokio::sync::Mutex::new(()),
            completed: tokio::sync::Notify::new(),
        }));
        session.start_route(self, rx, cx.clone())?;
        let setup: Result<Value> = async {
            // On reopen, host sources must exist before durable Runtime recovery.
            self.factory
                .attach(
                    api.clone(),
                    &id,
                    &project,
                    wire::optional(&p, "mcpServers")
                        .cloned()
                        .unwrap_or(json!([])),
                )
                .await?;
            let handed_back = if reopening {
                let tools = p["mcpServers"]
                    .as_array()
                    .is_some_and(|servers| !servers.is_empty());
                let inputs = self.admit_open(api.as_ref(), &id, &project, tools).await?;
                self.routes.rewind_blocks.lock().unwrap().remove(&project);
                inputs
            } else {
                vec![]
            };
            self.delivery_views
                .lock()
                .unwrap()
                .insert(id.clone(), Arc::downgrade(&session));
            self.open_response(&session, method, &cx, &handed_back)
                .await
        }
        .await;
        if setup.is_ok() {
            *session.driver.lock().unwrap() = Some(tokio::spawn(with_principal(
                self.principal.clone(),
                self.ceiling.clone(),
                session.clone().drive(reopening && !borrowed_writer),
            )));
            self.routes
                .sessions
                .lock()
                .unwrap()
                .insert(id.clone(), Arc::downgrade(&session.shared));
            self.sessions.lock().unwrap().insert(id, session);
        } else {
            // Release the writer even if an error after installation stranded an
            // interrupted turn. No turn driver was started in this case.
            if !borrowed_writer && api.is_running(&id) {
                let _ = api.cancel(&id).await;
                let _ = api.run_recovery(&id).await;
            }
            self.delivery_views.lock().unwrap().remove(&id);
            let _ = session.close().await;
        }
        setup
    }
}
