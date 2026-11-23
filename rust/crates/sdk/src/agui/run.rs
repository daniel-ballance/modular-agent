use super::*;
use crate::{Event, InterfaceReportDisposition};
use axum::http::HeaderMap;
use tokio::sync::broadcast;

// A selector follows this admission or this origin. A wake on a different
// turn (including a turn that was already queued) is never a match.
enum Target {
    Input(String),
    Turn(String),
    Continuation(String),
    Handled,
}
impl Target {
    fn turn(&self, d: &SessionData) -> Option<String> {
        match self {
            Self::Input(id) => crate::session::input_turn(d, id),
            Self::Turn(id) => Some(id.clone()),
            Self::Continuation(origin) => d
                .branch()
                .into_iter()
                .find(|e| {
                    e.kind == "turn.start"
                        && e.content
                            .as_ref()
                            .is_some_and(|v| v["continuesTurnId"] == *origin)
                })
                .and_then(|e| e.scope.turn),
            Self::Handled => None,
        }
    }
}
struct Exchange {
    server: Arc<Service>,
    a: Arc<AguiActor>,
    c: Arc<Client>,
    id: String,
    run: String,
    target: Target,
    events: broadcast::Receiver<Event>,
    executor: Option<InterfaceConnection>,
    steps: BTreeSet<String>,
    text: BTreeMap<String, String>,
    reasoning: BTreeSet<String>,
    closed_text: BTreeSet<String>,
    initial_input: bool,
    epoch: Option<String>,
    presence_at_start: Option<String>,
    state_revision: Option<String>,
    interruption: base::CancellationToken,
}
fn same_origin(origin: &mut Option<String>, other: &str) -> R<()> {
    if origin.as_ref().is_some_and(|s| s != other) {
        return Err(Fail::Conflict);
    }
    *origin = Some(other.into());
    Ok(())
}
impl Service {
    pub(super) async fn start(
        self: Arc<Self>,
        a: Arc<AguiActor>,
        req: input::Input,
        headers: HeaderMap,
    ) -> R<Response> {
        let id = &req.thread;
        let session = self.attach(&a, id).await?;
        let c = self.client(id, &a)?;
        let guard = c.run.clone().try_lock_owned().map_err(|_| Fail::Conflict)?;
        let d = self.watch(&a, id)?;
        let presence_at_start = c.presence.lock().unwrap().clone();
        let token = headers
            .get("ma-history-cursor")
            .map(|v| v.to_str().map_err(|_| Fail::Cursor))
            .transpose()?;
        let n = self.reconcile(&a, &d, &c, token, &req.messages).await?;
        if c.runs.lock().unwrap().contains(&req.run) {
            return Err(Fail::Conflict);
        }
        let mut user = None;
        let mut reports = vec![];
        let mut ids = BTreeSet::new();
        let mut origin = None;
        let suffix = &req.messages[n..];
        let user_count = suffix.iter().filter(|m| m["role"] == "user").count();
        if user_count > 0 && (suffix.len() != 1 || !req.resume.is_empty()) {
            return Err(Fail::Invalid);
        }
        let waits = self.waits(&a, &d)?;
        for m in suffix {
            let mid = input::string(m, "id")?;
            if mid.starts_with("ma:") || !ids.insert(mid) {
                return Err(Fail::Conflict);
            }
            match m["role"].as_str() {
                Some("user") => {
                    if !self.right(&a, id, "input")? {
                        return Err(Fail::Refused);
                    }
                    user = Some(input::content(&m["content"])?);
                }
                Some("tool") => {
                    let call = input::string(m, "toolCallId")?;
                    let (turn, _, _) = waits
                        .iter()
                        .find(|(_, c, _)| c == call)
                        .ok_or(Fail::Conflict)?;
                    same_origin(&mut origin, turn)?;
                    if reports.iter().any(|r: &Value| r["callId"] == call) {
                        return Err(Fail::Conflict);
                    }
                    let mut content = input::content(&m["content"])?;
                    let failed = m["error"].is_string();
                    if failed && base::wire::text(&content).trim().is_empty() {
                        content.as_array_mut().unwrap().push(json!({"type":"text","text":m["error"].as_str().filter(|s|!s.trim().is_empty()).unwrap_or("Frontend tool failed.")}));
                    }
                    reports.push(json!({"callId":call,"content":content,"status":if failed{"failed"}else{"completed"}}));
                }
                _ => return Err(Fail::Invalid),
            }
        }
        let questions = self.questions(&a, &d, &c, false).await?;
        let mut answers = BTreeMap::new();
        let mut live = None;
        for decision in &req.resume {
            let qid = input::string(decision, "interruptId")?;
            let Some((q, _)) = questions.iter().find(|(q, _)| q.id == qid) else {
                if d.entries.iter().any(|e| {
                    e.kind == "request.open" && e.content.as_ref().is_some_and(|v| v["id"] == qid)
                }) {
                    return Err(Fail::Conflict);
                }
                warn("resume.interruptId");
                continue;
            };
            let turn = q.scope.turn.as_ref().ok_or(Fail::Conflict)?;
            same_origin(&mut origin, turn)?;
            if !d
                .entries
                .iter()
                .any(|e| e.kind == "turn.end" && e.scope.turn == q.scope.turn)
            {
                live = Some(turn.clone());
            }
            let value = &decision["payload"];
            let reply = if decision["status"] == "cancelled" {
                None
            } else {
                match q.kind {
                    base::RequestKind::Approval => {
                        if value.as_object().is_none_or(|m| m.len() != 1) {
                            return Err(Fail::Invalid);
                        }
                        value["allow"]
                            .as_bool()
                            .ok_or(Fail::Invalid)?
                            .then(|| json!("allow"))
                    }
                    base::RequestKind::Choice
                        if value
                            .as_str()
                            .is_some_and(|s| q.options.iter().any(|o| s == o)) =>
                    {
                        Some(value.clone())
                    }
                    base::RequestKind::Text if value.is_string() => Some(value.clone()),
                    _ => return Err(Fail::Invalid),
                }
            };
            if answers.insert(qid.to_owned(), reply).is_some() {
                return Err(Fail::Conflict);
            }
        }
        if questions.iter().any(|(q, _)| !answers.contains_key(&q.id))
            || waits
                .iter()
                .any(|(_, id, _)| !reports.iter().any(|r| r["callId"] == *id))
        {
            return Err(Fail::Conflict);
        }
        if user.is_none() && answers.is_empty() && reports.is_empty() {
            return Err(if req.resume.is_empty() {
                Fail::Invalid
            } else {
                Fail::Conflict
            });
        }
        let mut offers = vec![];
        for offer in &req.tools {
            let d = self
                .agent
                .inner
                .interface_sources
                .iter()
                .filter(|s| s.route_id == a.client_id && s.actor_id == a.id())
                .flat_map(|s| &s.tools)
                .find(|d| d["name"] == offer["name"])
                .ok_or(Fail::Refused)?;
            if d["description"] != offer["description"]
                || !base::wire::json_eq(&d["parameters"], &offer["parameters"])
                || d.get("returns").is_some()
                || offers.contains(d)
            {
                return Err(Fail::Refused);
            }
            offers.push(d.clone());
        }
        let mut executor = if !offers.is_empty() || !reports.is_empty() {
            let conn = session
                .connect_interface_tools(&a.client_id, a.id(), a.principal.actor.rights.clone())
                .map_err(|_| Fail::Refused)?;
            conn.advertise(&offers).map_err(|_| Fail::Refused)?;
            Some(conn)
        } else {
            None
        };
        // Subscribe before making any decision runnable, including a report whose
        // commit wakes a driver on a different Tokio task.
        let events = self.agent.inner.hub.events.subscribe();
        let interruption = self.h().writer_interruption(id)?;
        let initial = self.snapshot_pair(&a, id, &c, &d).await?;
        if self.watch(&a, id)?.position != d.position {
            return Err(Fail::Conflict);
        }
        let target = if let Some(content) = user {
            let key = format!("agui:{}:{}{}", a.client_id.len(), a.client_id, req.run);
            let receipt = self
                .h()
                .submit_content_as(
                    &scope(id, a.id()),
                    None,
                    content,
                    base::Timing::Now,
                    Some(key),
                    None,
                )
                .await?;
            if receipt.duplicate || receipt.erased {
                return Err(Fail::Conflict);
            }
            if receipt.command.is_some() {
                Target::Handled
            } else {
                Target::Input(receipt.input)
            }
        } else {
            for (qid, value) in answers {
                let service = base::requests(self.h())?;
                let declined = value.is_none();
                if live.is_some() {
                    let route = c
                        .questions
                        .lock()
                        .unwrap()
                        .get(&qid)
                        .and_then(Clone::clone)
                        .ok_or(Fail::Conflict)?;
                    service
                        .answer_on_route(
                            self.agent.inner.harness.clone(),
                            &route,
                            base::Answer {
                                session: id.clone(),
                                request: qid,
                                actor: a.id().into(),
                                value: value.unwrap_or(Value::Null),
                                declined,
                                reason: None,
                            },
                        )
                        .await
                        .map_err(|_| Fail::Conflict)?;
                } else {
                    service
                        .answer(
                            self.agent.inner.harness.clone(),
                            id,
                            a.id(),
                            &qid,
                            value.unwrap_or(Value::Null),
                            declined,
                        )
                        .await
                        .map_err(|_| Fail::Conflict)?;
                }
            }
            for report in reports {
                if executor
                    .as_ref()
                    .ok_or(Fail::Refused)?
                    .report_tool_result(report)
                    .await
                    .map_err(|_| Fail::Lost)?
                    != InterfaceReportDisposition::Accepted
                {
                    return Err(Fail::Conflict);
                }
            }
            if let Some(turn) = live {
                if let Some((_, previous)) =
                    c.paused.lock().unwrap().take().filter(|(t, _)| *t == turn)
                {
                    executor = Some(previous);
                }
                Target::Turn(turn)
            } else {
                Target::Continuation(origin.ok_or(Fail::Conflict)?)
            }
        };
        {
            let mut used = c.runs.lock().unwrap();
            if used.len() == 1024 {
                used.pop_front();
            }
            used.push_back(req.run.clone());
        }
        let mut ex = Exchange {
            server: self,
            a,
            c: c.clone(),
            id: id.clone(),
            run: req.run,
            target,
            executor,
            events,
            steps: BTreeSet::new(),
            text: Default::default(),
            reasoning: Default::default(),
            closed_text: Default::default(),
            initial_input: true,
            epoch: view::epoch(&d),
            presence_at_start,
            state_revision: None,
            interruption,
        };
        let mut driver = Some(session.drive());
        let stream = async_stream::stream! {
            let _guard = guard;
            let mut next = ex.open(initial).await.map(|bytes|(bytes,false));
            loop {
                match next.and_then(|(bytes,end)| {ex.check_delivery()?; Ok((ex.server.buffer(&ex.id,bytes)?,end))}) {
                    Ok((bytes,finished)) => {
                        if !bytes.is_empty() {yield Ok::<_,std::convert::Infallible>(bytes);}
                        if finished {break;}
                    }
                    Err(err) => {
                        let error=json!({"type":"RUN_ERROR","code":err.code(),"message":"The run could not be delivered."});
                        // Even when the error is withheld the binding requires a content-free terminal.
                        let gated=ex.exact(error.clone()).await.unwrap_or_else(|_|json!({"type":"RUN_ERROR","code":"output_withheld","message":"Output withheld."}));
                        yield Ok(Bytes::from(format!("data: {gated}\n\n")));
                        break;
                    }
                }
                next=if matches!(ex.target,Target::Handled) {
                    ex.finish("success",vec![]).await.map(|v|(v,true))
                }else{tokio::select! {
                    biased;
                    _=ex.interruption.cancelled() => Err(Fail::Lost),
                    event=ex.events.recv() => match event {Ok(e)=>ex.event(e).await,Err(_)=>Err(Fail::Lost)},
                    _=async{driver.as_mut().unwrap().await}, if driver.is_some() => {
                        driver=None;
                        if matches!(ex.target,Target::Continuation(_)) && ex.turn().is_ok_and(|t|t.is_none()){
                            ex.wait_for_origin().map(|_|(b": waiting\n\n".to_vec(),false))
                        }else{Err(Fail::Lost)}
                    }
                    _=tokio::time::sleep(Duration::from_secs(10)) => ex.wait_for_origin().map(|_|(b": waiting\n\n".to_vec(),false)),
                }};
            }
        };
        Ok(reply(200, "text/event-stream", Body::from_stream(stream)))
    }
}
fn frames(events: Vec<Value>) -> R<Vec<u8>> {
    let mut group = Vec::new();
    for v in events {
        let b = encode(&v)?;
        group.extend_from_slice(b"data: ");
        group.extend(b);
        group.extend_from_slice(b"\n\n");
    }
    Ok(group)
}
impl Exchange {
    async fn gate(&self, v: Value) -> R<Value> {
        self.server.gate(&self.a, &self.id, v).await
    }
    async fn exact(&self, v: Value) -> R<Value> {
        let after = self.gate(v.clone()).await?;
        if v != after {
            return Err(Fail::Withheld);
        }
        Ok(after)
    }
    fn check_delivery(&self) -> R<()> {
        let current = self.server.watch(&self.a, &self.id)?;
        if self.interruption.is_cancelled() || view::epoch(&current) != self.epoch {
            return Err(Fail::Conflict);
        }
        Ok(())
    }
    fn turn(&self) -> R<Option<String>> {
        Ok(self.target.turn(&self.server.watch(&self.a, &self.id)?))
    }
    fn wait_for_origin(&self) -> R<()> {
        let d = self.server.watch(&self.a, &self.id)?;
        if let Target::Continuation(t) = &self.target
            && !d.branch().iter().any(|e| {
                e.kind == "turn.start" && e.scope.turn.as_ref() == Some(t) && e.content.is_some()
            })
        {
            return Err(Fail::Conflict);
        }
        Ok(())
    }
    async fn open(&mut self, (pair, cur): (Vec<Value>, Cursor)) -> R<Vec<u8>> {
        let mut v=vec![self.exact(json!({"type":"RUN_STARTED","protocolVersion":"1.0","threadId":self.id,"runId":self.run})).await?];
        self.initial_input = matches!(self.target, Target::Input(_));
        if !self.initial_input {
            v.extend(pair);
            *self.c.cursor.lock().unwrap() = Some(cur);
        }
        if let Some(s) = self.state_snapshot().await? {
            v.push(s);
        }
        frames(v)
    }
    async fn state_snapshot(&mut self) -> R<Option<Value>> {
        self.state_revision = None;
        let Some((rev, snap)) = self
            .server
            .state
            .as_ref()
            .and_then(|s| (s.snapshot)(&self.id))
        else {
            return Ok(None);
        };
        self.state_view(rev, snap).await
    }
    async fn state_view(&mut self, revision: String, snapshot: Value) -> R<Option<Value>> {
        let v = json!({"type":"STATE_SNAPSHOT","snapshot":snapshot});
        self.state_revision = None;
        match self.gate(v.clone()).await {
            Ok(view) => {
                if view == v {
                    self.state_revision = Some(revision);
                }
                Ok(Some(view))
            }
            Err(Fail::Withheld) => Ok(None),
            Err(e) => Err(e),
        }
    }
    async fn close_text(&mut self, step: &str, out: &mut Vec<Value>) -> R<()> {
        if self.text.contains_key(step) && self.closed_text.insert(step.into()) {
            out.push(
                self.exact(json!({"type":"TEXT_MESSAGE_END","messageId":view::assistant(step)}))
                    .await?,
            );
        }
        if self.reasoning.remove(step) {
            for ty in ["REASONING_MESSAGE_END", "REASONING_END"] {
                out.push(
                    self.exact(json!({"type":ty,"messageId":format!("ma:r:{step}")}))
                        .await?,
                );
            }
        }
        Ok(())
    }
    async fn text_delta(&mut self, step: &str, delta: &str, out: &mut Vec<Value>) -> R<()> {
        if delta.is_empty() {
            return Ok(());
        }
        let id = view::assistant(step);
        let content = self
            .gate(json!({"type":"TEXT_MESSAGE_CONTENT","messageId":id,"delta":delta}))
            .await?;
        if !self.text.contains_key(step) {
            out.push(
                self.exact(json!({"type":"TEXT_MESSAGE_START","messageId":id,"role":"assistant"}))
                    .await?,
            );
        }
        self.text.entry(step.into()).or_default().push_str(delta);
        out.push(content);
        Ok(())
    }
    async fn event(&mut self, event: Event) -> R<(Vec<u8>, bool)> {
        if event.session_id != self.id {
            return Ok((vec![], false));
        }
        if event.event_type == "sessionInterrupted" {
            return Err(Fail::Lost);
        }
        let Some(turn) = self.turn()? else {
            return Ok((vec![], false));
        };
        if event.turn_id.as_ref() != Some(&turn) {
            return Ok((vec![], false));
        }
        let step = event.step_id.as_deref().unwrap_or("");
        let d = &event.data;
        let mut out = vec![];
        if self.initial_input {
            // Offer the committed user ID before live assistant text. Upstream
            // snapshots reconcile by ID; they do not reorder existing messages.
            let mut data = self.server.watch(&self.a, &self.id)?;
            let taken = data
                .branch()
                .into_iter()
                .find(|e| e.kind == "input" && e.scope.turn.as_ref() == Some(&turn))
                .ok_or(Fail::Conflict)?;
            data.position = Some(taken.id);
            let (pair, cur) = self
                .server
                .snapshot_pair(&self.a, &self.id, &self.c, &data)
                .await?;
            out.extend(pair);
            *self.c.cursor.lock().unwrap() = Some(cur);
            self.initial_input = false;
        }
        let ty = event
            .emitter
            .as_ref()
            .and_then(|name| event.event_type.strip_prefix(&format!("plugin.{name}.")))
            .unwrap_or(&event.event_type);
        match ty {
            "stepStarted" => {
                if self.steps.insert(step.into()) {
                    out.push(
                        self.exact(json!({"type":"STEP_STARTED","stepName":step}))
                            .await?,
                    );
                }
            }
            "stepEnded" => {
                self.close_text(step, &mut out).await?;
                if self.steps.remove(step) {
                    out.push(
                        self.exact(json!({"type":"STEP_FINISHED","stepName":step}))
                            .await?,
                    );
                }
            }
            "text" => {
                let v = self.gate(json!({"type":"text","data":d})).await?;
                if let Some(s) = v["data"]["delta"].as_str() {
                    self.text_delta(step, s, &mut out).await?;
                }
            }
            "reasoning" => {
                let v = self.gate(json!({"type":"reasoning","data":d})).await?;
                if let Some(s) = v["data"]["delta"].as_str().filter(|s| !s.is_empty()) {
                    let id = format!("ma:r:{step}");
                    if self.reasoning.insert(step.into()) {
                        out.push(
                            self.exact(json!({"type":"REASONING_START","messageId":id}))
                                .await?,
                        );
                        out.push(self.exact(json!({"type":"REASONING_MESSAGE_START","messageId":id,"role":"reasoning"})).await?);
                    }
                    out.push(
                        self.gate(
                            json!({"type":"REASONING_MESSAGE_CONTENT","messageId":id,"delta":s}),
                        )
                        .await?,
                    );
                }
            }
            "questionOpened" => {
                if self.presence_at_start.is_none()
                    || *self.c.presence.lock().unwrap() != self.presence_at_start
                {
                    return Ok((vec![], false));
                }
                let data = self.server.watch(&self.a, &self.id)?;
                let questions = self.server.questions(&self.a, &data, &self.c, true).await?;
                let selected = questions
                    .into_iter()
                    .filter(|(q, _)| q.scope.turn.as_ref() == Some(&turn))
                    .map(|(_, v)| v)
                    .collect::<Vec<_>>();
                if !selected.is_empty() {
                    return self.finish("interrupt", selected).await.map(|v| (v, true));
                }
            }
            "turnEnded" => {
                let outcome = match d["outcome"]["kind"].as_str() {
                    Some("completed") => "success",
                    Some("cancelled" | "limit") => "cancelled",
                    _ => return Err(Fail::Lost),
                };
                if outcome == "success" {
                    let data = self.server.watch(&self.a, &self.id)?;
                    let questions = self
                        .server
                        .questions(&self.a, &data, &self.c, true)
                        .await?
                        .into_iter()
                        .filter(|(q, _)| q.scope.turn.as_ref() == Some(&turn))
                        .map(|(_, v)| v)
                        .collect::<Vec<_>>();
                    if !questions.is_empty() {
                        return self.finish("interrupt", questions).await.map(|v| (v, true));
                    }
                }
                return self.finish(outcome, vec![]).await.map(|v| (v, true));
            }
            "entry" => {
                let e = &d["entry"];
                if e["kind"] == "response" && !self.closed_text.contains(step) {
                    let gated = self.gate(json!({"entry":e})).await?;
                    let s = base::wire::text(&gated["entry"]["message"]["content"]);
                    let rest = s
                        .strip_prefix(self.text.get(step).map_or("", String::as_str))
                        .unwrap_or("");
                    self.text_delta(step, rest, &mut out).await?;
                } else if e["kind"] == "toolResult" {
                    out.extend(self.server_tool(e).await?);
                } else if e["kind"].as_str().is_some_and(|k| {
                    k.contains('.') && !k.starts_with("rust.") && !k.starts_with("modular-agent.")
                }) && e["modelVisible"] == true
                {
                    let v = self.gate(json!({"entry":e})).await?;
                    out.push(self.gate(json!({"type":"CUSTOM","name":"modular-agent.entry","value":v["entry"]})).await?);
                }
            }
            "toolCall" | "toolInput" | "toolStarted" => {
                out.extend(
                    self.custom(&event.event_type, json!({"toolCallId":event.tool_call_id}))
                        .await?,
                );
            }
            "toolResult" => {
                out.extend(
                    self.custom(
                        "toolResult",
                        json!({"toolCallId":d["toolCallId"],"status":d["status"]}),
                    )
                    .await?,
                );
            }
            "modular-agent.agui.stateSnapshot" | "modular-agent.agui.stateDelta" => {
                if self
                    .server
                    .state
                    .as_ref()
                    .is_some_and(|s| Some(&s.plugin) == event.emitter.as_ref())
                    && let Some(rev) = d["revisionId"].as_str()
                {
                    if event.event_type.ends_with("Snapshot") {
                        out.extend(self.state_view(rev.into(), d["snapshot"].clone()).await?);
                    } else {
                        let v = json!({"type":"STATE_DELTA","delta":d["delta"]});
                        if self
                            .state_revision
                            .as_deref()
                            .is_some_and(|base| d["baseRevisionId"] == base)
                            && valid_patch(&d["delta"])
                            && self.exact(v.clone()).await.is_ok()
                        {
                            out.push(v);
                            self.state_revision = Some(rev.into());
                        } else {
                            out.extend(self.state_snapshot().await?);
                        }
                    }
                }
            }
            ty if event.emitter.is_some()
                && ty.contains('.')
                && !ty.starts_with("modular-agent.")
                && !ty.starts_with("rust.") =>
            {
                let owner = event.emitter.as_ref().unwrap();
                if let Some(source) = self.server.raw.get(&(owner.clone(), ty.into())) {
                    if let Ok(v) = self
                        .gate(json!({"type":"RAW","source":source,"event":d}))
                        .await
                    {
                        out.push(v);
                    }
                } else {
                    out.extend(self.custom(ty, d.clone()).await?);
                }
            }
            "toolOutput" | "jobProgress" | "audio" => {
                out.extend(self.custom(&event.event_type, d.clone()).await?)
            }
            _ => (),
        }
        Ok((frames(out)?, false))
    }
    async fn custom(&self, ty: &str, data: Value) -> R<Option<Value>> {
        let v = json!({"type":ty,"data":data});
        let reply = async {
            let view = self.gate(v).await?;
            let event = self
                .gate(json!({"type":"CUSTOM","name":"modular-agent.event","value":view}))
                .await?;
            encode(&event)?;
            Ok(event)
        }
        .await;
        match reply {
            Ok(v) => Ok(Some(v)),
            Err(Fail::Size | Fail::Withheld) => Ok(None),
            Err(e) => Err(e),
        }
    }
    async fn server_tool(&self, e: &Value) -> R<Vec<Value>> {
        let id = &e["toolCallId"];
        let data = self.server.watch(&self.a, &self.id)?;
        let messages = self.server.messages(&self.a, &data).await?;
        let list = messages.as_array().unwrap();
        let Some((parent, call)) = list.iter().find_map(|m| {
            m["toolCalls"]
                .as_array()?
                .iter()
                .find(|c| c["id"] == *id)
                .map(|call| (&m["id"], call))
        }) else {
            return Ok(vec![]);
        };
        let Some(result) = list.iter().find(|m| m["toolCallId"] == *id) else {
            return Ok(vec![]);
        };
        let group = vec![
            json!({"type":"TOOL_CALL_START","toolCallId":id,"toolCallName":call["function"]["name"],"parentMessageId":parent}),
            json!({"type":"TOOL_CALL_ARGS","toolCallId":id,"delta":call["function"]["arguments"]}),
            json!({"type":"TOOL_CALL_END","toolCallId":id}),
            json!({"type":"TOOL_CALL_RESULT","toolCallId":id,"messageId":result["id"],"content":result["content"]}),
        ];
        for frame in &group {
            if self
                .exact(frame.clone())
                .await
                .and_then(|v| encode(&v))
                .is_err()
            {
                return Ok(vec![]);
            }
        }
        Ok(group)
    }
    async fn finish(&mut self, outcome: &str, questions: Vec<Value>) -> R<Vec<u8>> {
        let mut out = vec![];
        for step in self
            .text
            .keys()
            .chain(self.reasoning.iter())
            .cloned()
            .collect::<BTreeSet<_>>()
        {
            self.close_text(&step, &mut out).await?;
        }
        for step in std::mem::take(&mut self.steps) {
            out.push(
                self.exact(json!({"type":"STEP_FINISHED","stepName":step}))
                    .await?,
            );
        }
        let d = self.server.watch(&self.a, &self.id)?;
        let (pair, cursor) = self
            .server
            .snapshot_pair(&self.a, &self.id, &self.c, &d)
            .await?;
        let mut end = json!({"type":outcome});
        let mut pending = vec![];
        let turn = self.target.turn(&d);
        let in_turn = outcome == "interrupt"
            && !d
                .branch()
                .iter()
                .any(|e| e.kind == "turn.end" && e.scope.turn == turn);
        if outcome == "interrupt" {
            end["interrupts"] = json!(questions);
        }
        if (outcome == "success" || outcome == "interrupt" && !in_turn)
            && let Some(conn) = &mut self.executor
        {
            for call in conn.prepare_staged().await.map_err(|_| Fail::Withheld)? {
                let id = &call["id"];
                if !d.branch().iter().any(|e| {
                    base::interface_handoff(e)
                        && e.scope.call.as_deref() == id.as_str()
                        && e.scope.turn == self.target.turn(&d)
                }) {
                    return Err(Fail::Withheld);
                }
                let mut start =
                    json!({"type":"TOOL_CALL_START","toolCallId":id,"toolCallName":call["name"]});
                let parent = view::assistant(call["stepId"].as_str().unwrap_or_default());
                if pair[0]["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|m| m["id"] == parent)
                {
                    start["parentMessageId"] = json!(parent);
                }
                out.extend([start,json!({"type":"TOOL_CALL_ARGS","toolCallId":id,"delta":call["input"].to_string()}),json!({"type":"TOOL_CALL_END","toolCallId":id})]);
                pending.push(id.clone());
            }
            if !pending.is_empty() && outcome == "success" {
                end["pendingToolCallIds"] = json!(pending);
            }
        }
        out.extend(pair);
        let terminal =
            json!({"type":"RUN_FINISHED","threadId":self.id,"runId":self.run,"outcome":end});
        match self.exact(terminal).await {
            Ok(event) => out.push(event),
            Err(err) => {
                if in_turn && let Some(route) = &self.presence_at_start {
                    base::requests(self.server.h())?.detach_presence(&self.id, route);
                }
                return Err(err);
            }
        }
        // Gate all executable frames together. Do not write a prefix on failure.
        if !pending.is_empty() {
            for frame in out.iter().filter(|v| {
                v["type"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("TOOL_CALL_"))
            }) {
                self.exact(frame.clone()).await?;
            }
        }
        let bytes = frames(out)?;
        if let Some(conn) = &mut self.executor {
            for id in &pending {
                if conn
                    .release(id.as_str().ok_or(Fail::Withheld)?)
                    .await
                    .map_err(|_| Fail::Withheld)?
                    .is_none()
                {
                    return Err(Fail::Withheld);
                }
            }
        }
        let current = self.server.watch(&self.a, &self.id)?;
        if self.interruption.is_cancelled() || current.position != d.position {
            return Err(Fail::Conflict);
        }
        if !pending.is_empty()
            && (!self.server.right(&self.a, &self.id, "tools")?
                || !pending.iter().all(|id| {
                    self.server
                        .waits(&self.a, &current)
                        .is_ok_and(|w| w.iter().any(|(_, call, _)| id == call))
                }))
        {
            return Err(Fail::Withheld);
        }
        if outcome == "interrupt" {
            let presence = self.c.presence.lock().unwrap();
            if in_turn && (presence.is_none() || *presence != self.presence_at_start) {
                return Err(Fail::Refused);
            }
            let mut delivered = self.c.questions.lock().unwrap();
            delivered.clear();
            for q in questions {
                delivered.insert(
                    q["id"].as_str().ok_or(Fail::Lost)?.into(),
                    if in_turn { presence.clone() } else { None },
                );
            }
            if in_turn && let Some(conn) = self.executor.take() {
                *self.c.paused.lock().unwrap() =
                    Some((self.target.turn(&current).ok_or(Fail::Lost)?, conn));
            }
        }
        *self.c.cursor.lock().unwrap() = Some(cursor);
        for call in pending {
            if let Some(id) = call.as_str() {
                log::debug!(target:"modular_agent::agui::handoff","{} {}",self.id,id);
            }
        }
        Ok(bytes)
    }
}
fn valid_patch(p: &Value) -> bool {
    p.as_array().is_some_and(|v| {
        v.iter().all(|op| {
            op["path"]
                .as_str()
                .is_some_and(|s| s.is_empty() || s.starts_with('/'))
                && match op["op"].as_str() {
                    Some("add" | "replace" | "test") => op.get("value").is_some(),
                    Some("copy" | "move") => op["from"].is_string(),
                    Some("remove") => true,
                    _ => false,
                }
        })
    })
}
