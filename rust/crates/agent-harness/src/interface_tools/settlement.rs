//! Settle Interface handoff checkpoints and choose the continuation they release.
use super::super::*;
use super::registration::eligible;
use super::{InterfaceConnection, InterfaceReportDisposition, Source, Wake};

impl Harness {
    pub(super) fn restored_interface<'a>(
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
            || v["toolStartedId"] != json!(interface_start(data, checkpoint)?.id)
            || v["routeId"] != source.config.route_id
            || v["executorActorId"] != source.config.actor_id
            || !v["rights"].is_array()
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

    pub(super) fn queue_interface_entries(&self, entries: &[Entry]) {
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

    pub(crate) fn settle_interface_unknown(
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

    pub(super) fn expire_interface_call(
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
        self.check_open_erasure(open)?;
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

    pub(crate) fn recover_interface_tools(&self, session: &str, data: &SessionData) -> Result<()> {
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
                        && self
                            .executor_rights(data, &source.config.actor_id, ceiling)
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

    pub(super) fn watch_interface_deadline(&self, handoff: &Entry, deadline: u64) -> Result<()> {
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
            tokio::select! { biased; _ = generation.cancelled() => return, _ = wait_until(deadline) => {} }
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

    pub(crate) async fn interface_work_ready(&self, session: &str) -> Result<()> {
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

    pub(super) async fn report_interface_result(
        &self,
        connection: &InterfaceConnection,
        report: Value,
    ) -> Result<InterfaceReportDisposition> {
        use InterfaceReportDisposition::{Accepted, AlreadySettled, Refused};
        const REFUSED: InterfaceReportDisposition = Refused { reason: None };
        let Some(call_id) = report["callId"].as_str().filter(|id| !id.is_empty()) else {
            return Ok(REFUSED);
        };
        let Some(content) = report["content"].as_array() else {
            return Ok(REFUSED);
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
            return Ok(REFUSED);
        }
        let mut proposed = wire::parse_result(report.clone(), call_id)?;
        if proposed.status == ToolStatus::Failed && proposed.text.trim().is_empty() {
            return Ok(REFUSED);
        }
        let _serial = self.interface_tools.reports.lock().await;
        let inspect = |data: &SessionData| -> std::result::Result<_, InterfaceReportDisposition> {
            let branch = data.branch();
            let handoff = branch
                .iter()
                .find(|e| interface_handoff(e) && e.scope.call.as_deref() == Some(call_id))
                .ok_or(REFUSED)?;
            let (source, call, ceiling, deadline) =
                self.restored_interface(data, handoff).ok_or(REFUSED)?;
            if connection.generation.is_cancelled() || connection.route != source.config.route_id {
                return Err(REFUSED);
            }
            let connections = self.interface_tools.connections.lock().unwrap();
            let live = connections.get(&connection.id).ok_or(REFUSED)?;
            if !self
                .executor_rights(
                    data,
                    &source.config.actor_id,
                    &live.authority.intersect(&ceiling),
                )
                .is_ok_and(|a| eligible(&a))
            {
                return Err(REFUSED);
            }
            if let Some(result) = interface_result(data, handoff) {
                return Err(
                    if result.content.as_ref().is_some_and(|v| {
                        matches!(v["status"].as_str(), Some("completed" | "failed"))
                    }) && result.scope.actor == source.config.actor_id
                        && branch.iter().any(|e| e.id == result.id)
                    {
                        AlreadySettled
                    } else {
                        REFUSED
                    },
                );
            }
            if deadline <= now() {
                return Err(REFUSED);
            }
            match branch
                .iter()
                .find(|e| e.kind == "turn.end" && e.scope.turn == handoff.scope.turn)
            {
                None => {
                    return Err(Refused {
                        reason: Some("notReady"),
                    });
                }
                Some(end) if !listed(end, handoff) => return Err(REFUSED),
                _ => {}
            }
            Ok((handoff.clone(), call, source.config.actor_id.clone()))
        };
        if connection.generation.is_cancelled() {
            return Ok(REFUSED);
        }
        let Ok(data) = self.snapshot(&connection.session) else {
            return Ok(REFUSED);
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
                return Ok(REFUSED);
            };
            if self.check_open_erasure(open).is_err() {
                return Ok(REFUSED);
            }
            if let Err(status) = inspect(&open.data) {
                return Ok(status);
            }
            let start = interface_start(&open.data, &handoff).unwrap();
            let result = self.commit_interface_result(
                open,
                &handoff,
                &scope,
                Draft::new("tool.result", true, json!(proposed))
                    .copying(vec![start.id.clone(), handoff.id.clone()]),
            )?;
            // The result, not whichever driver happens to wake up, starts the continuation.
            let cx = telemetry::current();
            if telemetry::traceparent(&cx).is_some() {
                open.input_contexts.insert(result.id, cx);
            }
        }
        op.outcome("modular_agent.tool.status", wire::status(&proposed.status));
        self.interface_work_ready(&connection.session).await?;
        self.emit(Event::new(&scope, "tool.ended", json!(proposed)))
            .await?;
        processed?;
        Ok(Accepted)
    }

    pub(crate) fn finish_interface_turn(
        &self,
        scope: &Scope,
        result: &mut TurnResult,
    ) -> Result<()> {
        if !self.has_interface_tools() && self.max_approval_wait_ms().is_none() {
            return Ok(());
        }
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(&scope.session)
            .ok_or_else(|| anyhow!("session is closed"))?;
        self.finish_open_interface_turn(open, scope, result)
    }

    pub(crate) fn finish_open_interface_turn(
        &self,
        open: &mut OpenSession,
        scope: &Scope,
        result: &mut TurnResult,
    ) -> Result<()> {
        self.finish_approval_turn(open, scope, result)?;
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
    pub(crate) fn abandon_interface_calls(&self, session: &str, reason: &str) -> Result<()> {
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(session)
            .ok_or_else(|| anyhow!("session is closed"))?;
        self.abandon_open_interface_calls(open, reason)
    }

    pub(crate) fn abandon_open_interface_calls(
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

pub struct Continuation {
    pub input: Input,
    pub origin: String,
    pub started_by: Value,
    pub sources: Vec<String>,
    pub calls: Vec<ToolCall>,
}

pub fn next_interface_continuation(data: &SessionData) -> Result<Option<Continuation>> {
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
                found_interface |= questions
                    .iter()
                    .any(|q| q.scope.call.as_deref() == Some(id) && q.waits_for_approval());
                let settled = data
                    .entries
                    .iter()
                    .any(|e| e.kind == "tool.result" && e.scope.call.as_deref() == Some(id));
                let Some(source) = branch.iter().find(|e| {
                    e.kind == "tool.call"
                        && e.scope.call.as_deref() == Some(id)
                        && e.content.is_some()
                }) else {
                    complete = false;
                    break;
                };
                sources.push(source.id.clone());
                if !settled {
                    if !super::super::continuation::pending_questions(&branch, source) {
                        complete = false;
                        break;
                    }
                    calls.push(serde_json::from_value(source.content.clone().unwrap())?);
                }
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

pub fn same_authority_record(a: &SessionData, b: &SessionData, scope: &Scope) -> bool {
    let records = |data: &SessionData| {
        data.entries
            .iter()
            .filter(|e| authority_record(e) || (e.kind == "input" && e.scope.turn == scope.turn))
            .map(|e| (e.id.clone(), e.content.is_some()))
            .collect::<Vec<_>>()
    };
    records(a) == records(b) && a.settings == b.settings
}

pub(super) fn push(data: &mut SessionData, scope: &Scope, draft: Draft) -> Entry {
    let entry = super::super::history_commit::make_entry(data, scope, "harness", draft);
    data.position = Some(entry.id.clone());
    data.entries.push(entry.clone());
    entry
}
