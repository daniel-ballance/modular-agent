//! Registration and the live side of private Interface handoff checkpoints.
use super::*;
use std::collections::BTreeSet;
use tokio::sync::mpsc;

#[derive(Clone, Debug)]
pub struct InterfaceToolSource {
    pub source_id: String,
    pub actor_id: String,
    pub route_id: String,
    pub result_timeout_ms: u64,
    pub tools: Vec<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InterfaceReportDisposition {
    Accepted,
    AlreadySettled,
    Refused,
}

struct Source {
    config: InterfaceToolSource,
    tools: Vec<ToolDefinition>,
}
impl Plugin for Source {
    fn name(&self) -> &str {
        &self.config.source_id
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.provide::<dyn ToolSource>(
            &format!("tools.{}", self.name()),
            Arc::new(Self {
                config: self.config.clone(),
                tools: self.tools.clone(),
            }),
        )
    }
}
#[async_trait]
impl ToolSource for Source {
    fn tools(&self, _: &SessionData) -> Vec<ToolDefinition> {
        self.tools.clone()
    }
    async fn run(&self, _: Api, _: Scope, call: ToolCall, _: CancellationToken) -> ToolResult {
        ToolResult::new(
            &call,
            ToolStatus::Refused,
            "Interface tools require a model handoff",
        )
    }
}

type Wake = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Default)]
pub(super) struct InterfaceTools {
    configuration: std::sync::OnceLock<Configuration>,
    traces: Mutex<BTreeMap<String, Context>>,
    connections: Mutex<BTreeMap<String, Presence>>,
    reports: tokio::sync::Mutex<()>,
    wake: std::sync::OnceLock<Wake>,
}
#[derive(Default)]
struct Configuration {
    sources: BTreeMap<String, Arc<Source>>,
    routes: BTreeMap<String, String>,
}
struct Candidate {
    id: String,
    actor: String,
    authority: Authority,
}
struct Presence {
    session: String,
    route: String,
    authority: Authority,
    tools: BTreeSet<String>,
    sender: mpsc::Sender<String>,
}

/// An operator-authenticated executor slot, scoped to one session. Disconnect
/// is dropping this handle; reports never require an availability advertisement.
pub struct InterfaceConnection {
    harness: Weak<Harness>,
    session: String,
    route: String,
    id: String,
    generation: CancellationToken,
    receiver: mpsc::Receiver<String>,
}
impl Drop for InterfaceConnection {
    fn drop(&mut self) {
        if let Some(h) = self.harness.upgrade() {
            h.interface_tools
                .connections
                .lock()
                .unwrap()
                .remove(&self.id);
        }
    }
}
impl InterfaceConnection {
    /// Advertise an exact subset of the definitions registered on this route.
    pub fn advertise(&self, definitions: &[Value]) -> Result<()> {
        let h = self
            .harness
            .upgrade()
            .ok_or_else(|| anyhow!("agent is closed"))?;
        ensure!(!self.generation.is_cancelled(), "session is closed");
        let mut names = BTreeSet::new();
        for d in definitions {
            let name = wire::string(d, "name")?;
            ensure!(
                h.interface_source(name).is_some_and(|s| {
                    s.config.route_id == self.route
                        && s.config.tools.iter().any(|v| same_json(v, d))
                }),
                "definition is not registered on this route"
            );
            ensure!(names.insert(name.into()), "duplicate advertised tool");
        }
        h.interface_tools
            .connections
            .lock()
            .unwrap()
            .get_mut(&self.id)
            .ok_or_else(|| anyhow!("connection is closed"))?
            .tools = names;
        Ok(())
    }

    /// Receive a live executable call. There is no replay. The SDK rechecks
    /// staged calls here; a binding staging them further must recheck too.
    pub async fn next_call(&mut self) -> Result<Option<Value>> {
        loop {
            let id = tokio::select! {
                biased;
                _ = self.generation.cancelled() => return Ok(None),
                id = self.receiver.recv() => match id { Some(id) => id, None => return Ok(None) },
            };
            let Some(h) = self.harness.upgrade() else {
                return Ok(None);
            };
            if let Some(call) = h.release_interface_call(self, &id).await? {
                return Ok(Some(call));
            }
        }
    }

    pub async fn report_tool_result(&self, report: Value) -> Result<InterfaceReportDisposition> {
        let h = self
            .harness
            .upgrade()
            .ok_or_else(|| anyhow!("agent is closed"))?;
        h.report_interface_result(self, report).await
    }
}

impl Harness {
    pub async fn configure_interface_tools(
        self: &Arc<Self>,
        configs: Vec<InterfaceToolSource>,
    ) -> Result<()> {
        if configs.is_empty() {
            return Ok(());
        }
        ensure!(
            self.declaration()?["runtime"]["interface_tools"] == true,
            "the Runtime does not support Interface tool continuations"
        );
        let mut tools = Configuration::default();
        for config in configs {
            ensure!(
                !config.source_id.is_empty()
                    && !config.route_id.is_empty()
                    && !config.actor_id.is_empty(),
                "Interface tool source, actor and route IDs must not be empty"
            );
            ensure!(
                config.result_timeout_ms > 0
                    && config.result_timeout_ms <= MAX_SHARED_INTEGER - now(),
                "Interface result timeout must be positive and fit the shared deadline"
            );
            ensure!(!config.tools.is_empty(), "Interface tool source is empty");
            let mut definitions = Vec::new();
            for wire in &config.tools {
                let def = wire::parse_definition(wire)?;
                ensure!(
                    !def.name.is_empty()
                        && wire["callers"] == json!(["model"])
                        && !def.safe_to_repeat
                        && wire["hints"]["openWorld"] != false,
                    "Interface tools must be model-only, open-world and not safe to repeat"
                );
                schema::compile(&def.input)?;
                if let Some(returns) = wire.get("returns") {
                    schema::compile(returns)?;
                }
                definitions.push(def);
            }
            let actor = tools
                .routes
                .entry(config.route_id.clone())
                .or_insert_with(|| config.actor_id.clone());
            ensure!(
                actor == &config.actor_id,
                "Interface route is assigned to different actors"
            );
            let source = Arc::new(Source {
                config,
                tools: definitions,
            });
            for def in &source.tools {
                ensure!(
                    tools
                        .sources
                        .insert(def.name.clone(), source.clone())
                        .is_none(),
                    "duplicate Interface tool {}",
                    def.name
                );
            }
            self.load(source).await?;
        }
        let project = self.project.clone().unwrap_or_default();
        let probe = SessionData {
            id: String::new(),
            project,
            settings: json!({}),
            plugins: vec![],
            position: None,
            entries: vec![],
            origin: None,
        };
        self.registry.read().unwrap().validate_tools(&probe)?;
        ensure!(
            self.interface_tools.configuration.set(tools).is_ok(),
            "Interface tools already configured"
        );
        Ok(())
    }

    pub fn has_interface_tools(&self) -> bool {
        self.interface_tools.configuration.get().is_some()
    }

    fn interface_source(&self, name: &str) -> Option<&Arc<Source>> {
        self.interface_tools.configuration.get()?.sources.get(name)
    }

    /// Call only after authenticating the actual actor and checking its project
    /// and tenant scope. A represented actor is not an authenticated executor.
    pub fn connect_interface_tools(
        &self,
        session: &str,
        route: &str,
        actor: &str,
        ceiling: Authority,
    ) -> Result<InterfaceConnection> {
        ensure!(
            self.interface_tools
                .configuration
                .get()
                .and_then(|c| c.routes.get(route))
                .is_some_and(|a| a == actor),
            OperationError::Forbidden("actor is not the configured executor on this route".into())
        );
        let sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get(session)
            .ok_or_else(|| OperationError::NotFound("unknown session".into()))?;
        let authority = executor_rights(&open.data, actor, &ceiling)?;
        ensure!(
            eligible(&authority),
            OperationError::Forbidden("executor lacks watch or tools".into())
        );
        let (sender, receiver) = mpsc::channel(32);
        let id = id();
        self.interface_tools.connections.lock().unwrap().insert(
            id.clone(),
            Presence {
                session: session.into(),
                route: route.into(),
                authority,
                tools: BTreeSet::new(),
                sender,
            },
        );
        Ok(InterfaceConnection {
            harness: self.me.clone(),
            session: session.into(),
            route: route.into(),
            id,
            generation: open.generation.clone(),
            receiver,
        })
    }

    fn candidate(
        &self,
        data: &SessionData,
        source: &Source,
        name: &str,
        connection: Option<&str>,
    ) -> Option<Candidate> {
        self.interface_tools
            .connections
            .lock()
            .unwrap()
            .iter()
            .find_map(|(id, p)| {
                if p.route != source.config.route_id
                    || p.session != data.id
                    || p.sender.is_closed()
                    || !p.tools.contains(name)
                    || connection.is_some_and(|c| id != c)
                {
                    return None;
                }
                let authority =
                    executor_rights(data, &source.config.actor_id, &p.authority).ok()?;
                eligible(&authority).then(|| Candidate {
                    id: id.clone(),
                    actor: source.config.actor_id.clone(),
                    authority,
                })
            })
    }

    pub(super) fn interface_offer(&self, data: &SessionData, name: &str) -> bool {
        self.interface_source(name)
            .is_none_or(|source| self.candidate(data, source, name, None).is_some())
    }

    async fn unchanged_handoff(&self, scope: &Scope, actor: &str, call: &ToolCall) -> bool {
        let recipient = Scope {
            actor: actor.into(),
            ..scope.clone()
        };
        let request = wire::call(call, scope);
        self.output(
            &recipient,
            Output {
                recipient: actor.into(),
                value: request.clone(),
                stream: None,
                end: true,
            },
        )
        .await
        .is_ok_and(|view| view.is_some_and(|v| same_json(&v, &request)))
    }

    pub(super) async fn stage_interface_call(
        &self,
        scope: &Scope,
        call: &ToolCall,
        start: Draft,
    ) -> Result<Option<ToolResult>> {
        let Some(source) = self.interface_source(&call.name) else {
            return Ok(None);
        };
        let refused = |reason| Ok(Some(ToolResult::new(call, ToolStatus::Refused, reason)));
        if scope.turn.is_none() || scope.step.is_none() || call.started_by != "model" {
            return refused("Interface tools require a model call in a turn");
        }
        let data = self.snapshot(&scope.session)?;
        let Some(candidate) = self.candidate(&data, source, &call.name, None) else {
            return refused("Interface executor is not available");
        };
        if !self.unchanged_handoff(scope, &candidate.actor, call).await {
            return refused("Interface handoff was withheld or changed");
        }
        let data = self.snapshot(&scope.session)?;
        if !work_authority(self, scope)?.has("tools") {
            return refused("work no longer has tools authority");
        }
        let definition = source.tools.iter().find(|d| d.name == call.name).unwrap();
        if !same_json(
            &start.content["definition"],
            &wire::registered_definition(definition),
        ) || !same_json(
            &start.content["source"],
            &self.tool_registration(&format!("tools.{}", source.config.source_id)),
        ) || schema::check(&definition.input, Some(&call.input)).is_err()
        {
            return refused("Interface tool registration or input changed");
        }
        let (handoff, deadline, mut op) = {
            let mut sessions = self.sessions.lock().unwrap();
            let open = sessions
                .get_mut(&scope.session)
                .ok_or_else(|| anyhow!("session is closed"))?;
            self.check_open_writer(open)?;
            if !same_authority_record(&open.data, &data, scope) || open.cancel.is_cancelled() {
                return refused("Interface handoff authority changed");
            }
            let connections = self.interface_tools.connections.lock().unwrap();
            let Some(p) = connections
                .get(&candidate.id)
                .filter(|p| p.tools.contains(&call.name))
            else {
                return refused("Interface executor is not available");
            };
            let Ok(slot) = p.sender.try_reserve() else {
                return refused("Interface executor cannot receive a call");
            };
            let ceiling = executor_rights(&open.data, &candidate.actor, &p.authority)?;
            if !eligible(&ceiling) {
                return refused("Interface executor lacks watch or tools");
            }
            let deadline = now() + source.config.result_timeout_ms;
            ensure!(
                deadline <= MAX_SHARED_INTEGER,
                "Interface deadline does not fit shared time"
            );
            let mut attributes = telemetry::tool_attributes(call);
            attributes.push(KeyValue::new("gen_ai.operation.name", "execute_tool"));
            let op = Operation::start(
                format!("execute_tool {}", call.name),
                SpanKind::Internal,
                Some(scope),
                attributes,
                &telemetry::current(),
                vec![],
            );
            let _guard = op.enter();
            let mut next = open.data.clone();
            let mut start = start;
            start.content["safeToRepeat"] = json!(false);
            start.content["openWorld"] = json!(true);
            let start = push(&mut next, scope, start);
            let checkpoint = push(&mut next, scope, Draft::new(INTERFACE_HANDOFF, false, json!({
                "sourceId":source.config.source_id, "actorId":candidate.actor, "routeId":source.config.route_id,
                "rights":ceiling, "deadline":deadline,
            })).copying(vec![start.id.clone()]));
            self.commit(open, &next)?;
            open.data = next;
            self.queue_interface_entries(&[start, checkpoint.clone()]);
            self.interface_tools
                .traces
                .lock()
                .unwrap()
                .insert(checkpoint.id.clone(), op.context());
            slot.send(checkpoint.id.clone());
            (checkpoint, deadline, op)
        };
        op.outcome("modular_agent.tool.status", "pending");
        drop(op);
        self.watch_interface_deadline(&handoff, deadline)?;
        self.emit(Event::new(scope, "tool.started", json!(call)))
            .await?;
        Ok(Some(ToolResult::new(
            call,
            ToolStatus::Waiting,
            "waiting for Interface tool result",
        )))
    }

    async fn release_interface_call(
        &self,
        connection: &InterfaceConnection,
        id: &str,
    ) -> Result<Option<Value>> {
        let _erasure = self
            .erasure
            .try_read()
            .map_err(|_| anyhow!("erasure in progress"))?;
        let read = |data: &SessionData| -> Option<(Entry, ToolCall)> {
            let handoff = data
                .branch()
                .into_iter()
                .find(|e| e.id == id && interface_handoff(e))?;
            let (source, call, ceiling, deadline) = self.restored_interface(data, &handoff)?;
            if interface_result(data, &handoff).is_some()
                || deadline <= now()
                || !eligible(&ceiling)
                || connection.route != source.config.route_id
                || self
                    .candidate(data, source, &call.name, Some(&connection.id))
                    .is_none()
            {
                return None;
            }
            Some((handoff, call))
        };
        let data = self.snapshot(&connection.session)?;
        let Some((handoff, call)) = read(&data) else {
            return Ok(None);
        };
        let actor = self
            .interface_source(&call.name)
            .unwrap()
            .config
            .actor_id
            .as_str();
        let unchanged = self.unchanged_handoff(&handoff.scope, actor, &call).await;
        let data = self.snapshot(&connection.session)?;
        if !unchanged || !work_authority(self, &handoff.scope)?.has("tools") {
            self.expire_interface_call(
                &connection.session,
                id,
                "Interface handoff could not be released",
                true,
            )?;
            self.interface_work_ready(&connection.session).await?;
            return Ok(None);
        }
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(&connection.session)
            .ok_or_else(|| anyhow!("session is closed"))?;
        self.check_open_writer(open)?;
        self.refresh_open_erasure(open)?;
        Ok((same_authority_record(&open.data, &data, &handoff.scope)
            && !open.cancel.is_cancelled()
            && !connection.generation.is_cancelled()
            && read(&open.data).is_some())
        .then(|| wire::call(&call, &handoff.scope)))
    }

    fn restored_interface<'a>(
        &'a self,
        data: &SessionData,
        checkpoint: &Entry,
    ) -> Option<(&'a Source, ToolCall, Authority, u64)> {
        let v = checkpoint.content.as_ref()?;
        let start = interface_start(data, checkpoint)?.content.as_ref()?;
        let call: ToolCall = serde_json::from_value(start.get("call")?.clone()).ok()?;
        let source = self.interface_source(&call.name)?;
        let def = source.tools.iter().find(|def| def.name == call.name)?;
        let deadline = v["deadline"]
            .as_u64()
            .filter(|deadline| *deadline <= MAX_SHARED_INTEGER && *deadline > checkpoint.at)?;
        if checkpoint.scope.call.as_ref() != Some(&call.id)
            || call.started_by != "model"
            || checkpoint.scope.turn.is_none()
            || checkpoint.scope.step.is_none()
            || v["sourceId"] != source.config.source_id
            || v["routeId"] != source.config.route_id
            || v["actorId"] != source.config.actor_id
            || start["safeToRepeat"] != false
            || start["openWorld"] != true
            || !same_json(
                &start["source"],
                &self.tool_registration(&format!("tools.{}", source.config.source_id)),
            )
            || !same_json(&start["definition"], &wire::registered_definition(def))
            || data
                .entries
                .iter()
                .filter(|e| interface_handoff(e) && e.scope.call == checkpoint.scope.call)
                .count()
                != 1
        {
            return None;
        }
        Some((
            source,
            call,
            serde_json::from_value(v["rights"].clone()).ok()?,
            deadline,
        ))
    }

    fn queue_interface_entries(&self, entries: &[Entry]) {
        self.pending_events.lock().unwrap().extend(
            entries
                .iter()
                .filter(|e| !interface_handoff(e))
                .map(|e| Event::new(&e.scope, "history.entry", json!(e))),
        );
    }

    fn interface_settlement(&self, handoff: &Entry, parent: &Context) -> Operation {
        let link = self
            .interface_tools
            .traces
            .lock()
            .unwrap()
            .get(&handoff.id)
            .and_then(telemetry::link);
        Operation::start(
            "modular_agent.tool.settle",
            SpanKind::Internal,
            Some(&handoff.scope),
            vec![KeyValue::new(
                "modular_agent.tool.call.id",
                handoff.scope.call.clone().unwrap_or_default(),
            )],
            parent,
            link.into_iter().collect(),
        )
    }

    fn commit_interface_result(
        &self,
        open: &mut OpenSession,
        handoff: &Entry,
        scope: &Scope,
        draft: Draft,
    ) -> Result<Entry> {
        let mut next = open.data.clone();
        let result = push(&mut next, scope, draft);
        self.commit(open, &next)?;
        open.data = next;
        self.interface_tools
            .traces
            .lock()
            .unwrap()
            .remove(&handoff.id);
        self.queue_interface_entries(std::slice::from_ref(&result));
        Ok(result)
    }

    pub(super) fn settle_interface_unknown(
        &self,
        open: &mut OpenSession,
        handoff: &Entry,
        reason: &str,
    ) -> Result<bool> {
        let Some((scope, draft)) = interface_unknown(&open.data, handoff, reason) else {
            return Ok(false);
        };
        let mut op = self.interface_settlement(handoff, &Context::new());
        {
            let _guard = op.enter();
            self.commit_interface_result(open, handoff, &scope, draft)?;
        }
        op.outcome("modular_agent.tool.status", "outcomeUnknown");
        Ok(true)
    }

    fn expire_interface_call(
        &self,
        session: &str,
        id: &str,
        reason: &str,
        force: bool,
    ) -> Result<bool> {
        let mut sessions = self.sessions.lock().unwrap();
        let Some(open) = sessions.get_mut(session) else {
            return Ok(false);
        };
        self.refresh_open_erasure(open)?;
        let Some(handoff) = open
            .data
            .branch()
            .into_iter()
            .find(|e| e.id == id && interface_handoff(e))
        else {
            return Ok(false);
        };
        if !force
            && handoff
                .content
                .as_ref()
                .and_then(|v| v["deadline"].as_u64())
                .is_some_and(|deadline| deadline > now())
        {
            return Ok(false);
        }
        self.settle_interface_unknown(open, &handoff, reason)
    }

    pub(super) fn recover_interface_tools(&self, session: &str, data: &SessionData) -> Result<()> {
        for checkpoint in data
            .entries
            .iter()
            .filter(|e| interface_handoff(e) && interface_result(data, e).is_none())
        {
            let branch = data.branch();
            let recovery = self.restored_interface(data, checkpoint).filter(
                |(source, _, ceiling, deadline)| {
                    *deadline > now()
                        && eligible(ceiling)
                        && branch.iter().any(|e| e.id == checkpoint.id)
                        && executor_rights(data, &source.config.actor_id, ceiling)
                            .is_ok_and(|cap| eligible(&cap))
                        && (branch.iter().any(|e| {
                            e.kind == "turn.end"
                                && e.scope.turn == checkpoint.scope.turn
                                && listed(e, checkpoint)
                        }) || (branch.iter().all(|e| {
                            e.kind != "turn.end" || e.scope.turn != checkpoint.scope.turn
                        }) && session_runtime(self, data)
                            .is_ok_and(|r| r.declaration()["continues_after_restart"] == true)))
                },
            );
            if let Some((_, _, _, deadline)) = recovery {
                self.watch_interface_deadline(checkpoint, deadline)?;
            } else {
                let mut sessions = self.sessions.lock().unwrap();
                let open = sessions
                    .get_mut(session)
                    .ok_or_else(|| anyhow!("session is closed"))?;
                self.settle_interface_unknown(
                    open,
                    checkpoint,
                    "Interface handoff could not be restored",
                )?;
            }
        }
        Ok(())
    }

    fn watch_interface_deadline(&self, handoff: &Entry, deadline: u64) -> Result<()> {
        let generation = self
            .sessions
            .lock()
            .unwrap()
            .get(&handoff.scope.session)
            .ok_or_else(|| anyhow!("session is closed"))?
            .generation
            .clone();
        let harness = self.me.clone();
        let session = handoff.scope.session.clone();
        let id = handoff.id.clone();
        tokio::spawn(async move {
            loop {
                let delay = deadline.saturating_sub(now());
                if delay == 0 {
                    break;
                }
                tokio::select! { biased; _ = generation.cancelled() => return, _ = tokio::time::sleep(std::time::Duration::from_millis(delay)) => {} }
            }
            if let Some(h) = harness.upgrade()
                && !generation.is_cancelled()
            {
                let expired = h.expire_interface_call(
                    &session,
                    &id,
                    "Interface result deadline expired",
                    false,
                );
                if matches!(expired, Ok(true)) {
                    let _ = h.interface_work_ready(&session).await;
                }
            }
        });
        Ok(())
    }

    async fn interface_work_ready(&self, session: &str) -> Result<()> {
        if let Some(wake) = self.interface_tools.wake.get() {
            wake(session);
        }
        self.emit(Event::new(
            &Scope::session(session),
            "interface.work_ready",
            Value::Null,
        ))
        .await
    }

    pub fn on_interface_work(&self, wake: Wake) {
        let _ = self.interface_tools.wake.set(wake);
    }

    async fn report_interface_result(
        &self,
        connection: &InterfaceConnection,
        report: Value,
    ) -> Result<InterfaceReportDisposition> {
        use InterfaceReportDisposition::*;
        let Some(call_id) = report["callId"].as_str().filter(|id| !id.is_empty()) else {
            return Ok(Refused);
        };
        let Some(content) = report["content"].as_array() else {
            return Ok(Refused);
        };
        if !matches!(report["status"].as_str(), Some("completed" | "failed"))
            || !content
                .iter()
                .all(|p| p["type"].is_string() && (p["type"] != "text" || p["text"].is_string()))
            || report.as_object().is_none_or(|o| {
                o.keys()
                    .any(|k| !matches!(k.as_str(), "callId" | "status" | "content" | "value"))
            })
        {
            return Ok(Refused);
        }
        let mut proposed = wire::parse_result(report.clone(), call_id)?;
        if proposed.status == ToolStatus::Failed && proposed.text.trim().is_empty() {
            return Ok(Refused);
        }
        let _serial = self.interface_tools.reports.lock().await;
        let Ok(_erasure) = self.erasure.try_read() else {
            return Ok(Refused);
        };
        let inspect = |data: &SessionData| -> std::result::Result<_, InterfaceReportDisposition> {
            let branch = data.branch();
            let handoff = branch
                .iter()
                .find(|e| interface_handoff(e) && e.scope.call.as_deref() == Some(call_id))
                .ok_or(Refused)?;
            let (source, call, ceiling, deadline) =
                self.restored_interface(data, handoff).ok_or(Refused)?;
            if connection.generation.is_cancelled() || connection.route != source.config.route_id {
                return Err(Refused);
            }
            let connections = self.interface_tools.connections.lock().unwrap();
            let live = connections.get(&connection.id).ok_or(Refused)?;
            if !executor_rights(
                data,
                &source.config.actor_id,
                &live.authority.intersect(&ceiling),
            )
            .is_ok_and(|a| eligible(&a))
            {
                return Err(Refused);
            }
            if let Some(result) = interface_result(data, handoff) {
                return Err(
                    if result.content.is_some()
                        && result.scope.actor == source.config.actor_id
                        && branch.iter().any(|e| e.id == result.id)
                    {
                        AlreadySettled
                    } else {
                        Refused
                    },
                );
            }
            if deadline <= now()
                || !branch.iter().any(|e| {
                    e.kind == "turn.end" && e.scope.turn == handoff.scope.turn && listed(e, handoff)
                })
            {
                return Err(Refused);
            }
            Ok((handoff.clone(), call, source.config.actor_id.clone()))
        };
        if connection.generation.is_cancelled() {
            return Ok(Refused);
        }
        let Ok(data) = self.snapshot(&connection.session) else {
            return Ok(Refused);
        };
        let (handoff, call, actor) = match inspect(&data) {
            Ok(v) => v,
            Err(status) => return Ok(status),
        };
        let mut op = self.interface_settlement(&handoff, &telemetry::current());
        let status = proposed.status.clone();
        let processed = op
            .run(async {
                let points = self.runtime_points();
                if let Some(point) = points.get("runtime.after.tool") {
                    proposed = serde_json::from_value(
                        self.invoke(point, &handoff.scope, json!(proposed))
                            .await?
                            .value,
                    )?;
                }
                ensure!(
                    proposed.status == status && proposed.call == call.id,
                    "tool.after changed result identity or status"
                );
                let source = self.interface_source(&call.name).unwrap();
                schema::tool_result(
                    source.tools.iter().find(|d| d.name == call.name).unwrap(),
                    &proposed,
                )
            })
            .await;
        if processed.is_err() {
            op.error("result_processing_failed");
            proposed = ToolResult::new(
                &call,
                status,
                "The Interface ran the call, but its result could not be processed.",
            );
        }
        let mut scope = handoff.scope.clone();
        scope.actor = actor;
        {
            let _guard = op.enter();
            let mut sessions = self.sessions.lock().unwrap();
            let Some(open) = sessions.get_mut(&connection.session) else {
                return Ok(Refused);
            };
            if self.refresh_open_erasure(open).is_err() {
                return Ok(Refused);
            }
            if let Err(status) = inspect(&open.data) {
                return Ok(status);
            }
            let start = interface_start(&open.data, &handoff).unwrap();
            self.commit_interface_result(
                open,
                &handoff,
                &scope,
                Draft::new("tool.result", true, json!(proposed))
                    .copying(vec![start.id.clone(), handoff.id.clone()]),
            )?;
        }
        op.outcome("modular_agent.tool.status", wire::status(&proposed.status));
        self.interface_work_ready(&connection.session).await?;
        self.emit(Event::new(&scope, "tool.ended", json!(proposed)))
            .await?;
        processed?;
        Ok(Accepted)
    }

    pub(super) fn finish_interface_turn(
        &self,
        scope: &Scope,
        result: &mut TurnResult,
    ) -> Result<()> {
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(&scope.session)
            .ok_or_else(|| anyhow!("session is closed"))?;
        for handoff in open
            .data
            .branch()
            .into_iter()
            .filter(|e| interface_handoff(e) && e.scope.turn == scope.turn)
        {
            let expired = handoff
                .content
                .as_ref()
                .and_then(|v| v["deadline"].as_u64())
                .is_none_or(|d| d <= now());
            let call = handoff.scope.call.as_ref();
            if expired || result.outcome != Outcome::Completed {
                self.settle_interface_unknown(
                    open,
                    &handoff,
                    if expired {
                        "Interface result deadline expired"
                    } else {
                        "Originating turn did not complete"
                    },
                )?;
            }
            if interface_result(&open.data, &handoff).is_some() {
                result.open_calls.retain(|c| Some(&c.id) != call);
            }
        }
        Ok(())
    }
}

impl Harness {
    pub(super) fn abandon_interface_calls(&self, session: &str, reason: &str) -> Result<()> {
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(session)
            .ok_or_else(|| anyhow!("session is closed"))?;
        self.abandon_open_interface_calls(open, reason)
    }

    pub(super) fn abandon_open_interface_calls(
        &self,
        open: &mut OpenSession,
        reason: &str,
    ) -> Result<()> {
        for handoff in open.data.branch().into_iter().filter(interface_handoff) {
            self.settle_interface_unknown(open, &handoff, reason)?;
        }
        Ok(())
    }
}

pub(super) struct Continuation {
    pub input: Input,
    pub origin: String,
    pub started_by: Value,
    pub sources: Vec<String>,
    pub calls: Vec<ToolCall>,
}

pub(super) fn next_interface_continuation(data: &SessionData) -> Result<Option<Continuation>> {
    let branch = data.branch();
    let questions = questions(data)?;
    let mut ready = Vec::new();
    for end in branch.iter().filter(|e| e.kind == "turn.end") {
        let Some(origin) = &end.scope.turn else {
            continue;
        };
        if data.entries.iter().any(|e| {
            e.kind == "turn.start"
                && e.content
                    .as_ref()
                    .is_some_and(|v| v["continuesTurnId"] == *origin)
        }) {
            continue;
        }
        let Some(start) = branch.iter().find(|e| {
            e.kind == "turn.start" && e.scope.turn == end.scope.turn && e.content.is_some()
        }) else {
            continue;
        };
        let Some(open) = end
            .content
            .as_ref()
            .and_then(|v| v["open_calls"].as_array())
        else {
            continue;
        };
        let mut calls = vec![];
        let mut sources = vec![start.id.clone(), end.id.clone()];
        let mut trigger = end;
        let mut trigger_order = data
            .entries
            .iter()
            .position(|e| e.id == end.id)
            .unwrap_or(0);
        let mut found_interface = false;
        let mut complete = true;
        for v in open {
            let Some(id) = v["id"].as_str() else {
                complete = false;
                break;
            };
            if let Some(checkpoint) = branch
                .iter()
                .find(|e| interface_handoff(e) && e.scope.call.as_deref() == Some(id))
            {
                found_interface = true;
                if checkpoint.content.is_none()
                    || interface_start(data, checkpoint).is_none_or(|e| e.content.is_none())
                {
                    complete = false;
                    break;
                }
                let Some(terminal) = branch.iter().find(|e| {
                    e.kind == "tool.result"
                        && e.scope.call.as_deref() == Some(id)
                        && e.content.is_some()
                }) else {
                    complete = false;
                    break;
                };
                sources.extend([checkpoint.id.clone(), terminal.id.clone()]);
                let order = data
                    .entries
                    .iter()
                    .position(|e| e.id == terminal.id)
                    .unwrap_or(0);
                if order > trigger_order {
                    trigger = terminal;
                    trigger_order = order;
                }
            } else {
                let mut related = questions
                    .iter()
                    .filter(|q| q.scope.call.as_deref() == Some(id))
                    .peekable();
                if related.peek().is_none() || related.any(|q| q.answerable) {
                    complete = false;
                    break;
                }
                if data
                    .entries
                    .iter()
                    .any(|e| e.kind == "tool.result" && e.scope.call.as_deref() == Some(id))
                {
                    continue;
                }
                let Some(source) = branch.iter().find(|e| {
                    e.kind == "tool.call"
                        && e.scope.call.as_deref() == Some(id)
                        && e.content.is_some()
                }) else {
                    complete = false;
                    break;
                };
                sources.push(source.id.clone());
                calls.push(serde_json::from_value(source.content.clone().unwrap())?);
                for (order, answer) in data.entries.iter().enumerate().filter(|(_, e)| {
                    matches!(e.kind.as_str(), "request.answer" | "request.closed")
                        && e.scope.call.as_deref() == Some(id)
                        && e.content.is_some()
                        && branch.iter().any(|b| b.id == e.id)
                }) {
                    sources.push(answer.id.clone());
                    if order > trigger_order {
                        trigger = answer;
                        trigger_order = order;
                    }
                }
            }
        }
        if found_interface && complete && trigger.id != end.id {
            let started_by = if trigger.kind == "tool.result" {
                json!({"kind":"toolResult","id":trigger.id})
            } else {
                json!({"kind":"answer","id":trigger.content.as_ref().unwrap()["request"]})
            };
            ready.push((
                trigger_order,
                Continuation {
                    input: Input {
                        id: trigger.id.clone(),
                        actor: start.scope.actor.clone(),
                        text: String::new(),
                        timing: Timing::Now,
                        key: None,
                    },
                    origin: origin.clone(),
                    started_by,
                    sources,
                    calls,
                },
            ));
        }
    }
    Ok(ready
        .into_iter()
        .min_by_key(|(order, _)| *order)
        .map(|(_, c)| c))
}

fn listed(end: &Entry, checkpoint: &Entry) -> bool {
    end.content
        .as_ref()
        .and_then(|v| v["open_calls"].as_array())
        .is_some_and(|calls| {
            calls
                .iter()
                .any(|c| c["id"].as_str() == checkpoint.scope.call.as_deref())
        })
}

fn same_authority_record(a: &SessionData, b: &SessionData, scope: &Scope) -> bool {
    let records = |data: &SessionData| {
        data.entries
            .iter()
            .filter(|e| authority_record(e) || (e.kind == "input" && e.scope.turn == scope.turn))
            .map(|e| (e.id.clone(), e.content.is_some()))
            .collect::<Vec<_>>()
    };
    records(a) == records(b) && a.settings == b.settings
}

fn push(data: &mut SessionData, scope: &Scope, draft: Draft) -> Entry {
    let entry = make_entry(data, scope, "harness", draft);
    data.position = Some(entry.id.clone());
    data.entries.push(entry.clone());
    entry
}
fn eligible(cap: &Authority) -> bool {
    cap.has("watch") && cap.has("tools")
}
fn executor_rights(data: &SessionData, actor: &str, ceiling: &Authority) -> Result<Authority> {
    let mut current = if actor == "user" {
        Authority::full()
    } else {
        Authority::default()
    };
    for e in &data.entries {
        let Some(v) = e.content.as_ref() else {
            continue;
        };
        if e.kind == "actor.grant" && v["actor"] == actor {
            current = serde_json::from_value(v["authority"].clone())?;
        } else if e.kind == "actor.left" && v["actorId"] == actor {
            current = Authority::default();
        }
    }
    Ok(current.intersect(ceiling))
}
