use super::*;
use crate::events::{Message, Sink};
use tokio::sync::{mpsc, oneshot};
pub(crate) struct Session {
    pub id: String,
    pub project: PathBuf,
    pub api: Api,
    owns_agent: bool,
    pub gate: tokio::sync::Mutex<()>,
    pub stop: CancellationToken,
    pub tx: mpsc::UnboundedSender<Message>,
    pub worker: Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub driver: Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub wake: tokio::sync::Notify,
    pub closing: std::sync::atomic::AtomicBool,
    pub cancellation: tokio::sync::Mutex<()>,
    pub completed: tokio::sync::Notify,
    pub approval_views: Mutex<std::collections::BTreeSet<(String, String)>>,
}
impl Session {
    pub async fn flush(&self) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Message::Flush(tx))
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
        requests(self.api.as_ref())?.presence(&self.id, connection_actor().as_str(), false);
        let open = self.api.snapshot(&self.id).is_ok();
        if open && self.api.is_running(&self.id) {
            self.cancel().await?;
        }
        self.stop.cancel();
        let driver = self.driver.lock().unwrap().take();
        if let Some(driver) = driver {
            let _ = driver.await;
        }
        let _guard = self.gate.lock().await;
        let result = if open {
            self.api.close(&self.id).await
        } else {
            Ok(())
        };
        let worker = self.worker.lock().unwrap().take();
        if let Some(worker) = worker {
            let _ = worker.await;
        }
        if self.owns_agent {
            result.and(self.api.shutdown().await)
        } else {
            result
        }
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
                tokio::select! { _ = completed => (), _ = self.stop.cancelled() => bail!("session closed before input ran") }
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
            tokio::select! { _ = self.stop.cancelled() => break, _ = self.wake.notified() => () }
            let _guard = tokio::select! { _ = self.stop.cancelled() => break, guard = self.gate.lock() => guard };
            if self.closing.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            if let Err(e) = self.drain_inner().await {
                eprintln!("ACP input driver failed: {e}");
            }
            let _ = self.flush().await;
        }
    }
    pub async fn drain(&self) -> Result<Value> {
        let _guard = self.gate.try_lock().map_err(|_| anyhow!("session busy"))?;
        let result = self.drain_inner().await?;
        self.flush().await?;
        Ok(result)
    }
    async fn drain_inner(&self) -> Result<Value> {
        let mut last = None;
        while !self.closing.load(std::sync::atomic::Ordering::SeqCst) {
            let Some(result) = self.api.next_turn(&self.id).await? else {
                break;
            };
            self.completed.notify_waiters();
            let stop = result.outcome != Outcome::Completed || !result.open_calls.is_empty();
            last = Some(result);
            if stop {
                break;
            }
        }
        let reason = match last.as_ref().map(|r| &r.outcome) {
            Some(Outcome::Cancelled) => "cancelled",
            Some(Outcome::Limit) => "max_turn_requests",
            _ => "end_turn",
        };
        Ok(json!({"stopReason":reason,"_meta":{"result":last}}))
    }
}
pub(crate) fn join_host(api: &dyn AgentApi, session: &str) -> Result<()> {
    let rights = Authority::full();
    let data = api.snapshot(session)?;
    let latest = data.entries.iter().rev().find_map(|e| {
        let v = e.content.as_ref()?;
        match e.kind.as_str() {
            "actor.grant" if v["actor"] == connection_actor().as_str() => Some(
                serde_json::from_value::<Authority>(v["authority"].clone())
                    .is_ok_and(|a| a.has("watch")),
            ),
            "actor.left" if v["actorId"] == connection_actor().as_str() => Some(false),
            _ => None,
        }
    });
    if latest == Some(false) {
        return Err(request_error("forbidden", "session inaccessible").into());
    }
    if latest.is_none() {
        api.append(
            &actor_scope(session),
            "interface.acp",
            Draft::new(
                "actor.grant",
                false,
                json!({"actor":connection_actor().as_str(),"kind":"host","authority":rights,"operatorAdmission":true}),
            ),
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
    Ok(json!([
        {"id":"model","name":"Model","category":"model","type":"select","currentValue":current_model,"options":models},
        {"id":"thinking","name":"Thinking","category":"thought_level","type":"select","currentValue":effective_thinking,"options":thinking.into_iter().map(|v|json!({"value":v,"name":v})).collect::<Vec<_>>()},
        {"id":"approval","name":"Approval","type":"select","currentValue":match settings["approval"].as_str().unwrap_or("off") {"ask_always"=>"all","ask_unless_read_only"=>"ask","never_ask"=>"never",_=>"off"},"options":[{"value":"off","name":"Off"},{"value":"ask","name":"Ask unless read-only"},{"value":"all","name":"Ask always"},{"value":"never","name":"Refuse without asking"}]}
    ]))
}
impl State {
    pub(crate) async fn setup_session(
        &self,
        method: &str,
        mut p: Value,
        cx: ConnectionTo<acp::Client>,
    ) -> Result<Value> {
        let _guard = self.setup.lock().await;
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
        let reopening = method != "session/new";
        let existing = if reopening {
            let id = string(&p, "sessionId")?;
            ensure!(
                !self.sessions.lock().unwrap().contains_key(id),
                "session already open"
            );
            let data = self
                .factory
                .list(None)?
                .into_iter()
                .find(|s| s.id == id)
                .ok_or_else(|| anyhow!("unknown session"))?;
            ensure!(
                data.project == project,
                "cwd differs from recorded session project"
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
            let mut blocked = self.rewind_blocks.lock().unwrap();
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
        let (tx, rx) = mpsc::unbounded_channel();
        let api = self
            .factory
            .build(&project, Arc::new(Sink(tx.clone())))
            .await?;
        let id = if let Some(data) = existing {
            data.id
        } else {
            let tenant = wire::optional(&p["_meta"]["modular-agent"], "tenant")
                .map(|v| v.as_str().ok_or_else(|| anyhow!("tenant must be a string")))
                .transpose()?;
            match api
                .create_in_tenant(&project, self.factory.initial_settings(), tenant)
                .await
            {
                Ok(id) => id,
                Err(error) => {
                    if self.factory.owns_session_agent() {
                        let _ = api.shutdown().await;
                    }
                    return Err(error);
                }
            }
        };
        let session = Arc::new(Session {
            id: id.clone(),
            project: project.clone(),
            api: api.clone(),
            owns_agent: self.factory.owns_session_agent(),
            gate: tokio::sync::Mutex::new(()),
            stop: CancellationToken::new(),
            tx,
            worker: Mutex::new(None),
            driver: Mutex::new(None),
            wake: tokio::sync::Notify::new(),
            closing: std::sync::atomic::AtomicBool::new(false),
            cancellation: tokio::sync::Mutex::new(()),
            completed: tokio::sync::Notify::new(),
            approval_views: Mutex::default(),
        });
        let gate = session.gate.lock().await;
        requests(api.as_ref())?.presence(&id, connection_actor().as_str(), true);
        let worker = tokio::spawn(events::pump(
            session.clone(),
            rx,
            cx.clone(),
            self.client.lock().unwrap().clone().unwrap_or_default(),
        ));
        *session.worker.lock().unwrap() = Some(worker);
        self.sessions
            .lock()
            .unwrap()
            .insert(id.clone(), session.clone());
        let setup:Result<Value> = async {
            // On reopen, host sources must exist before durable Runtime recovery.
            self.factory.attach(api.clone(),&id,&project,wire::optional(&p,"mcpServers").cloned().unwrap_or(json!([]))).await?;
            let handed_back = if reopening {
                let inputs = api.install_recovery(&id).await?;
                self.rewind_blocks.lock().unwrap().remove(&project);
                inputs
            } else {
                vec![]
            };
            require(api.as_ref(), &actor_scope(&id), "watch")?;
            let mut response = json!({"configOptions":config(api.as_ref(),&id)?,"_meta":{"modular-agent":{"declaration":self.factory.session_declaration(api.as_ref(), &id)?}}});
            if !reopening { response["sessionId"] = json!(id); }
            if !handed_back.is_empty() {
                response["_meta"]["modular-agent"]["handedBack"] = json!(handed_back.iter()
                    .map(|input| json!({"inputId":input.id,"content":[{"type":"text","text":input.text}]}))
                    .collect::<Vec<_>>());
            }
            let gated = api.output(&actor_scope(&id), Output {
                recipient: "interface.acp".into(),
                value: json!({"method":method,"result":response}),
                stream: None, end: true,
            }).await?.and_then(|v| v.get("result").cloned()).ok_or_else(withheld)?;
            if method == "session/load" { events::replay(api.clone(),&id,&cx).await?; }
            session.flush().await?;
            Ok(gated)
        }.await;
        if setup.is_ok() || api.is_running(&id) {
            // On failure after installation, run the cancelled recovery so it
            // releases the reservation before close releases the writer.
            *session.driver.lock().unwrap() = Some(tokio::spawn(session.clone().drive(reopening)));
        }
        drop(gate);
        if setup.is_err() {
            // Reopen can fail before Harness admission. Also close pre-attached sources.
            let _ = session.close().await;
            self.factory.detach(api.clone(), &id).await;
            self.sessions.lock().unwrap().remove(&id);
        }
        setup
    }
}
