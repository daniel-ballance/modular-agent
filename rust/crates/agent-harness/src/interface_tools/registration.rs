//! Register Interface tool sources and deliver their calls on live routes.
use super::super::*;
use super::settlement::{push, same_authority_record};
use super::{
    InterfaceConnection, InterfaceReportDisposition, InterfaceToolSource, Presence, Source,
};
use std::collections::BTreeSet;
use tokio::sync::mpsc;

#[derive(Default)]
pub(super) struct Configuration {
    sources: BTreeMap<String, Arc<Source>>,
    routes: BTreeMap<String, String>,
}
struct Candidate {
    id: String,
    actor: String,
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

    /// Receive a live executable call. There is no replay.
    pub async fn next_call(&mut self) -> Result<Option<Value>> {
        loop {
            let (_, ticket) = if let Some(pending) = self.staged.pop_front() {
                pending
            } else {
                tokio::select! {
                    biased;
                    _ = self.generation.cancelled() => return Ok(None),
                    id = self.receiver.recv() => match id { Some(id) => id, None => return Ok(None) },
                }
            };
            let Some(h) = self.harness.upgrade() else {
                return Ok(None);
            };
            if let Some(call) = h.release_interface_call(self, &ticket).await? {
                return Ok(Some(call));
            }
        }
    }

    fn collect_tickets(&mut self) {
        while let Ok(ticket) = self.receiver.try_recv() {
            self.staged.push_back(ticket);
        }
    }

    /// A trusted adapter may prepare gated frames, but cannot authorize
    /// execution until release succeeds for every ticket in its terminal group.
    pub async fn prepare_staged(&mut self) -> Result<Vec<Value>> {
        self.collect_tickets();
        let h = self
            .harness
            .upgrade()
            .ok_or_else(|| anyhow!("agent closed"))?;
        let mut group = Vec::new();
        for (_, ticket) in &self.staged {
            group.push(
                h.release_interface_call(self, ticket)
                    .await?
                    .ok_or_else(|| anyhow!("staged delivery refused"))?,
            );
        }
        Ok(group)
    }

    pub async fn release(&mut self, call_id: &str) -> Result<Option<Value>> {
        self.collect_tickets();
        let Some(index) = self.staged.iter().position(|(id, _)| id == call_id) else {
            return Ok(None);
        };
        let (_, ticket) = self.staged.remove(index).unwrap();
        let h = self
            .harness
            .upgrade()
            .ok_or_else(|| anyhow!("agent closed"))?;
        h.release_interface_call(self, &ticket).await
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

    pub(crate) fn is_interface_tool(&self, name: &str) -> bool {
        self.interface_source(name).is_some()
    }
    pub(super) fn interface_source(&self, name: &str) -> Option<&Arc<Source>> {
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
        let authority = self.executor_rights(&open.data, actor, &ceiling)?;
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
                generation: open.generation.clone(),
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
            staged: Default::default(),
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
                    || p.generation.is_cancelled()
                    || p.sender.is_closed()
                    || !p.tools.contains(name)
                    || connection.is_some_and(|c| id != c)
                {
                    return None;
                }
                let authority = self
                    .executor_rights(data, &source.config.actor_id, &p.authority)
                    .ok()?;
                eligible(&authority).then(|| Candidate {
                    id: id.clone(),
                    actor: source.config.actor_id.clone(),
                })
            })
    }

    pub(crate) fn interface_offer(&self, data: &SessionData, name: &str) -> bool {
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

    pub(crate) async fn stage_interface_call(
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
            let ceiling = self.executor_rights(&open.data, &candidate.actor, &p.authority)?;
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
                "toolStartedId":start.id, "executorActorId":candidate.actor, "routeId":source.config.route_id,
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
            slot.send((call.id.clone(), checkpoint.id.clone()));
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
}

pub(super) fn eligible(cap: &Authority) -> bool {
    cap.has("watch") && cap.has("tools")
}

impl Harness {
    pub(crate) fn executor_rights(
        &self,
        data: &SessionData,
        actor: &str,
        ceiling: &Authority,
    ) -> Result<Authority> {
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
        if let Some(rights) = data
            .entries
            .iter()
            .rev()
            .find(|e| e.kind == "limit")
            .and_then(|e| e.content.as_ref())
            .and_then(|v| wire::optional(v, "rights"))
        {
            current = current.intersect(&serde_json::from_value(rights.clone())?);
        }
        if let Some(tenant) = tenants::name(data) {
            current = current.intersect(&self.check_tenant(tenant)?.rights);
        }
        if let Some(rights) = data.settings.get("_authority") {
            current = current.intersect(&serde_json::from_value(rights.clone())?);
        }
        Ok(current.intersect(ceiling))
    }
}
