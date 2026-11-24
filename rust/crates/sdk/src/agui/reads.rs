//! Host reads do not call `attach`: they must not grant membership or run recovery.
use super::*;
use std::collections::VecDeque;

pub(super) fn parameter(query: Option<&str>, name: &str) -> R<String> {
    let mut pairs = form_urlencoded::parse(query.unwrap_or_default().as_bytes());
    match (pairs.next(), pairs.next()) {
        (Some((k, v)), None) if k == name => Ok(v.into_owned()),
        _ => Err(Fail::Invalid),
    }
}

#[derive(Clone)]
pub(super) struct Boundary {
    next: usize,
    epoch: Option<String>,
}
impl Boundary {
    pub(super) fn snapshot(d: &SessionData) -> Self {
        Self {
            next: d.entries.len(),
            epoch: branch_epoch(d),
        }
    }
    fn valid(&self, d: &SessionData) -> bool {
        self.next <= d.entries.len() && self.epoch == branch_epoch(d)
    }
}
fn branch_epoch(d: &SessionData) -> Option<String> {
    d.entries
        .iter()
        .rev()
        .find(|e| e.kind == "position")
        .map(|e| e.id.clone())
}
#[derive(Default)]
pub(super) struct WaitCursors(VecDeque<(String, Boundary, u64)>);
impl WaitCursors {
    pub(super) fn record(&mut self, token: String, cut: Boundary) {
        if self.0.len() == 256 {
            self.0.pop_front();
        }
        self.0
            .push_back((token, cut, base::now().saturating_add(300_000)));
    }
    fn resolve(&self, token: &str, d: &SessionData) -> R<Boundary> {
        self.0
            .iter()
            .find(|(s, c, until)| s == token && c.valid(d) && base::now() < *until)
            .map(|(_, c, _)| c.clone())
            .ok_or(Fail::Cursor)
    }
}
impl Service {
    pub(super) fn read_view(&self, a: &AguiActor, id: &str) -> R<SessionData> {
        if !a.principal.actor.rights.has("watch")
            || id.is_empty()
            || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err(Fail::Missing);
        }
        let d = if self.h().open_session_ids().iter().any(|s| s == id) {
            self.h().check_writer(id)?;
            self.h().snapshot(id)?
        } else {
            let history = &self.agent.inner.history.0;
            let d = history.inspect(id).map_err(|e| {
                if Error::from(e).code() == Code::NotFound {
                    Fail::Missing
                } else {
                    Fail::Lost
                }
            })?;
            history.check_erasure(&d)?;
            d
        };
        if !self.scope_ok(a, &d)
            || !base::actors(&d).contains_key(a.id())
            || !self
                .h()
                .discovery_rights(&d, a.id(), &a.principal.actor.rights, false)?
                .has("watch")
        {
            return Err(Fail::Missing);
        }
        Ok(d)
    }
    pub(super) async fn read_gate(&self, a: &AguiActor, id: &str, value: Value) -> R<Value> {
        self.read_view(a, id)?;
        let after = self
            .h()
            .output(
                &scope(id, a.id()),
                base::Output {
                    recipient: a.client_id.clone(),
                    value: value.clone(),
                    stream: None,
                    end: true,
                },
            )
            .await?
            .ok_or(Fail::Withheld)?;
        let mut before = value;
        if before != after && !agent_harness::apply_redactions(&mut before, &after) {
            return Err(Fail::Withheld);
        }
        self.read_view(a, id)?;
        Ok(after)
    }
    pub(super) async fn read_entry(
        &self,
        a: &AguiActor,
        d: &SessionData,
        e: &base::Entry,
    ) -> R<Value> {
        if e.content.is_none() {
            return Err(Fail::Withheld);
        }
        let mut row = base::portable::public_entry(e, d)?;
        if e.kind == "request.open" {
            let q: base::Question =
                serde_json::from_value(e.content.clone().unwrap()).map_err(|_| Fail::Lost)?;
            if q.kind == base::RequestKind::Secret
                || q.credential.is_some()
                || q.extra["answerers"]
                    .as_array()
                    .is_some_and(|ids| !ids.iter().any(|id| id == a.id()))
            {
                return Err(Fail::Withheld);
            }
            let question = interface_acp::shared_question(q);
            row["data"]["request"] = self
                .read_gate(a, &d.id, json!({"question":question}))
                .await?["question"]
                .clone();
        }
        Ok(self.read_gate(a, &d.id, json!({"entry":row})).await?["entry"].clone())
    }
    async fn closure(
        &self,
        a: &AguiActor,
        d: &SessionData,
        e: &base::Entry,
        cursor: &str,
    ) -> R<Option<Value>> {
        let Some(content) = e.content.as_ref() else {
            return Ok(None);
        };
        let branch = d.branch();
        if !branch.iter().any(|r| r.id == e.id) {
            return Ok(None);
        }
        let item = match e.kind.as_str() {
            "request.answer" | "request.closed" | "request.invalidated" => {
                let Some(id) = content["request"].as_str() else {
                    return Ok(None);
                };
                if !branch
                    .iter()
                    .find(|r| {
                        matches!(
                            r.kind.as_str(),
                            "request.answer" | "request.closed" | "request.invalidated"
                        ) && r.content.as_ref().is_some_and(|v| v["request"] == id)
                    })
                    .is_some_and(|r| r.id == e.id)
                {
                    return Ok(None);
                }
                let Some(open) = branch.iter().find(|r| {
                    r.kind == "request.open" && r.content.as_ref().is_some_and(|v| v["id"] == id)
                }) else {
                    return Ok(None);
                };
                let request = self.read_entry(a, d, open).await?;
                if request["data"]["request"]["id"] != id {
                    return Ok(None);
                }
                let row = self.read_entry(a, d, e).await?;
                let v = &row["data"];
                if v["requestId"] != id {
                    return Ok(None);
                }
                let reason = if v["actorId"].is_string() {
                    if v["declined"] == true {
                        "declined"
                    } else if v.get("value").is_some() {
                        "answered"
                    } else {
                        return Ok(None);
                    }
                } else {
                    if v["reason"] != content["reason"] || v.get("cause") != content.get("cause") {
                        return Ok(None);
                    }
                    match v["reason"].as_str() {
                        Some("timeLimit") => "expired",
                        Some("refused" | "noLongerAnswerable") if v["cause"] == "revoked" => {
                            "revoked"
                        }
                        Some(
                            r @ ("refused" | "noLongerAnswerable" | "cancelled" | "superseded"),
                        ) => r,
                        _ => return Ok(None),
                    }
                };
                json!({"cursor":cursor,"requestId":id,"reason":reason})
            }
            "tool.result" => {
                let Some(call) = e.scope.call.as_deref() else {
                    return Ok(None);
                };
                let Some(handoff) = branch
                    .iter()
                    .find(|r| base::interface_handoff(r) && r.scope.call == e.scope.call)
                else {
                    return Ok(None);
                };
                let v = handoff.content.as_ref().ok_or(Fail::Withheld)?;
                if v["routeId"] != a.client_id || v["executorActorId"] != a.id() {
                    return Ok(None);
                }
                let Some(end) = branch
                    .iter()
                    .find(|r| r.kind == "turn.end" && r.scope.turn == handoff.scope.turn)
                else {
                    return Ok(None);
                };
                let opening = self.read_entry(a, d, end).await?;
                if !opening["data"]["result"]["openToolCalls"]
                    .as_array()
                    .is_some_and(|set| set.iter().any(|c| c == call))
                {
                    return Ok(None);
                }
                let start = branch
                    .iter()
                    .find(|r| v["toolStartedId"] == r.id)
                    .ok_or(Fail::Withheld)?;
                self.read_entry(a, d, start).await?;
                let result = self.read_entry(a, d, e).await?;
                let status = &result["data"]["status"];
                if result["toolCallId"] != call || !status.is_string() {
                    return Ok(None);
                }
                json!({"cursor":cursor,"toolCallId":call,"reason":"settled","status":status})
            }
            _ => return Ok(None),
        };
        let notice = json!({"type":"modular-agent.waitClosed","data":item});
        Ok((self.read_gate(a, &d.id, notice.clone()).await? == notice).then_some(item))
    }
    pub(super) fn wait_closures(
        self: Arc<Self>,
        a: Arc<AguiActor>,
        id: &str,
        query: Option<&str>,
    ) -> R<Response> {
        let d = self.read_view(&a, id)?;
        let after = parameter(query, "after")?;
        let client = self.client(id, &a)?;
        let mut cut = client.wait_cursors.lock().unwrap().resolve(&after, &d)?;
        let mut commits = self.h().follow_commits(id).map_err(|_| Fail::Cursor)?;
        log::debug!(target:"modular_agent::agui::wait_following", "{id}");
        let id = id.to_owned();
        let stream = async_stream::stream! {
            // Subscribe first, then scan strictly from the cursor. Notifications carry
            // no facts. Appends during catch-up are read from the next ledger cut.
            let mut heartbeat=tokio::time::interval(Duration::from_secs(10));
            heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            'follow: loop {
                use tokio::sync::broadcast::error::TryRecvError;
                loop {match commits.try_recv(){Ok(())=>(),Err(TryRecvError::Empty)=>break,Err(_)=>break 'follow}}
                let Ok(d)=self.read_view(&a,&id) else {break};
                if !cut.valid(&d){break}
                // Buffer offsets only. Re-read source views when the body is polled for
                // delivery, rather than queuing a gated notice behind other notices.
                let limit=d.entries.len();
                let candidates=(cut.next..limit).filter(|i|matches!(d.entries[*i].kind.as_str(),"request.answer"|"request.closed"|"request.invalidated"|"tool.result")).collect::<Vec<_>>();
                drop(d);
                for i in candidates {
                    let Ok(d)=self.read_view(&a,&id) else {break 'follow};
                    if !cut.valid(&d) || commits.len()>128 {break 'follow}
                    let token=base::id();
                    let item=match self.closure(&a,&d,&d.entries[i],&token).await {Ok(Some(v))=>v,Ok(None)|Err(Fail::Withheld|Fail::Size)=>continue,Err(_)=>break 'follow};
                    let epoch=view::epoch(&d);
                    drop(d);
                    if !self.read_view(&a,&id).is_ok_and(|now| view::epoch(&now)==epoch) || commits.len()>128 {break 'follow}
                    cut.next=i+1;
                    let Ok(bytes)=encode(&item).and_then(|body|self.buffer(&id,[b"data: ",&body[..],b"\n\n"].concat())) else {break 'follow};
                    client.wait_cursors.lock().unwrap().record(token,cut.clone());
                    yield Ok::<_,std::convert::Infallible>(bytes);
                }
                cut.next=limit;
                tokio::select!{wake=commits.recv()=>if wake.is_err(){break},_=heartbeat.tick()=>{if self.read_view(&a,&id).is_err(){break} yield Ok(Bytes::from_static(b": waiting\n\n"));}}
            }
        };
        Ok(reply(200, "text/event-stream", Body::from_stream(stream)))
    }
}
