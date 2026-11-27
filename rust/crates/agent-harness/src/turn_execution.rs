use super::{
    ActiveTurn, Harness, authority::admitted_authority, continuation, interface_tools,
    waiting_approvals,
};
use agent_api::telemetry::{self, Context, KeyValue, Operation, SpanKind};
use agent_api::*;
use std::sync::Arc;

struct TurnActivity<'a> {
    harness: &'a Harness,
    session: &'a str,
}
impl Drop for TurnActivity<'_> {
    fn drop(&mut self) {
        if let Some(open) = self.harness.sessions.lock().unwrap().get_mut(self.session) {
            open.active = None;
        }
    }
}

#[derive(Debug)]
struct ContinuationRefused;
impl std::fmt::Display for ContinuationRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("continuation start refused")
    }
}

impl Harness {
    pub fn configure_agent_name(&self, name: String) {
        if telemetry::name(&name).is_some() {
            let _ = self.agent_name.set(name);
        }
    }

    fn invocation(
        &self,
        scope: &Scope,
        parent: &Context,
        links: Vec<telemetry::Link>,
        resumed: bool,
    ) -> Operation {
        let mut attrs = vec![KeyValue::new("gen_ai.operation.name", "invoke_agent")];
        let name = if let Some(agent) = self.agent_name.get() {
            attrs.push(KeyValue::new("gen_ai.agent.name", agent.clone()));
            format!("invoke_agent {agent}")
        } else {
            "invoke_agent".into()
        };
        if resumed {
            attrs.push(KeyValue::new("modular_agent.turn.resumed", true));
        }
        Operation::start(name, SpanKind::Internal, Some(scope), attrs, parent, links)
            .interrupted("modular_agent.turn.outcome")
    }

    pub(super) async fn run_recovery(&self, id: &str) -> Result<()> {
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
                if runtime.declaration()["continues_after_restart"] == true {
                    let data = self.snapshot(id)?;
                    let saved = saved_turn_trace(&data, scope.turn.as_deref());
                    let links = saved
                        .as_ref()
                        .and_then(telemetry::link)
                        .into_iter()
                        .collect();
                    let mut op = self.invocation(&scope, &saved.unwrap_or_default(), links, true);
                    op.run(async {
                        if let Some(carrier) = op.own_carrier() {
                            self.append(
                                &scope,
                                "harness",
                                Draft::new(
                                    telemetry::TURN_TRACE,
                                    false,
                                    json!({"traceContext":carrier}),
                                ),
                            )?;
                        }
                        runtime.interrupted(self.api(), scope.clone()).await
                    })
                    .await?;
                    if let Some(kind) = recorded_outcome(&self.snapshot(id)?, &scope) {
                        op.outcome("modular_agent.turn.outcome", kind);
                        if kind == "failed" {
                            op.error("turn_failed");
                        }
                    }
                } else {
                    runtime.interrupted(self.api(), scope).await?;
                }
            }
            Ok(())
        }
        .await;
        self.sessions.lock().unwrap().get_mut(id).unwrap().active = None;
        result
    }

    /// Whether the named turn still holds the session even if its end is journaled.
    pub fn is_turn_running(&self, session: &str, turn: &str) -> bool {
        matches!(
            self.sessions.lock().unwrap().get(session).and_then(|s| s.active.as_ref()),
            Some(ActiveTurn::Running(id)) if id == turn
        )
    }

    pub async fn cancel(&self, session: &str) -> Result<Vec<Input>> {
        self.cancel_inner(session, false).await
    }
    pub async fn cancel_for_close(&self, session: &str) -> Result<Vec<Input>> {
        self.cancel_inner(session, true).await
    }
    async fn cancel_inner(&self, session: &str, preserve_waits: bool) -> Result<Vec<Input>> {
        {
            let sessions = self.sessions.lock().unwrap();
            if sessions.get(session).is_some_and(|open| {
                open.interruption.is_cancelled()
                    || (!open.rewinding
                        && (open.journal_uncertain || open.data.unresolved_rewind().is_some()))
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
            self.abandon_open_interface_calls(open, "Interface call cancelled")?;
            open.queue.drain(..).collect::<Vec<_>>()
        };
        if !self.is_running(session) {
            let data = self.snapshot(session)?;
            if let Ok(service) = requests(self) {
                for q in questions(&data)?
                    .iter()
                    .filter(|q| q.answerable && !(preserve_waits && q.waits_for_approval()))
                {
                    service.close_turn(self, &q.scope)?;
                }
            }
            for e in data.branch().iter().filter(|e| e.kind == "tool.call") {
                if preserve_waits
                    && data
                        .entries
                        .iter()
                        .any(|r| waiting_approvals::marked(r) && r.scope.call == e.scope.call)
                {
                    continue;
                }
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

    pub async fn run_next(&self, session: &str) -> Result<Option<TurnResult>> {
        let (input, cancel, parent, resume, turn_id, erasure, interface) = {
            let mut sessions = self.sessions.lock().unwrap();
            let open = sessions
                .get_mut(session)
                .ok_or_else(|| OperationError::NotFound("unknown session".into()))?;
            open.check_rewind()?;
            ensure!(
                open.active.is_none(),
                OperationError::Busy("a turn is already running".into())
            );
            self.check_open_writer(open)?;
            self.refresh_open_erasure(open)?;
            self.reconcile_open_approvals(open, false)?;
            let interface = if self.has_interface_tools()
                || open.data.entries.iter().any(waiting_approvals::marked)
            {
                interface_tools::next_interface_continuation(&open.data)?
            } else {
                None
            };
            let continuation = if interface.is_none() {
                continuation::next_continuation(&open.data)?
            } else {
                None
            };
            let queued = open.queue.iter().position(|i| i.timing != Timing::Propose);
            if interface.is_none() && continuation.is_none() && queued.is_none() {
                return Ok(None);
            }
            // An idle driver wake-up must not take a reservation against
            // erasure or rewind. Decide and claim real work under one lock.
            let erasure = self
                .erasure
                .try_read()
                .map_err(|_| anyhow!("erasure in progress"))?;
            let (input, resume) = match (&interface, continuation) {
                (Some(interface), _) => (interface.input.clone(), interface.calls.clone()),
                (_, Some(continuation)) => continuation,
                _ => (open.queue.remove(queued.unwrap()).unwrap(), vec![]),
            };
            let turn_id = id();
            open.active = Some(ActiveTurn::Running(turn_id.clone()));
            open.steer_closed = false;
            open.cancel = CancellationToken::new();
            let parent = open.input_contexts.remove(&input.id).unwrap_or_default();
            (
                input,
                open.cancel.clone(),
                parent,
                resume,
                turn_id,
                erasure,
                interface,
            )
        };
        let activity = TurnActivity {
            harness: self,
            session,
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
            turn: Some(turn_id),
            ..Scope::session(session)
        };
        let admitted_input = input.id.clone();
        let mut invocation = None;
        let result = telemetry::within(
            parent,
            self.prepare_and_run(
                &scope,
                input,
                cancel.clone(),
                resume,
                interface.as_ref(),
                &mut invocation,
            ),
        )
        .await;
        self.check_writer(session)?;
        let result = match result {
            Ok(r) => r,
            Err(e) if e.is::<ContinuationRefused>() => return Err(e),
            Err(e) => {
                let mut r = TurnResult {
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
                    self.finish_interface_turn(&scope, &mut r)?;
                    let mut end = json!(r);
                    end["inputId"] = json!(admitted_input);
                    let _span = invocation.as_ref().map(Operation::enter);
                    let end = Draft::new("turn.end", false, end);
                    if data
                        .pending_inputs()
                        .iter()
                        .any(|(id, _)| *id == admitted_input)
                    {
                        let returned = Draft::new(
                            "input.returned",
                            false,
                            json!({"input":admitted_input,"reason":"turnEnded"}),
                        );
                        self.publish(&scope, "harness", vec![returned, end], None, None)?;
                    } else {
                        self.append(&scope, "harness", end)?;
                    }
                }
                r
            }
        };
        if let Some(mut op) = invocation {
            let kind = outcome_name(&result.outcome);
            op.outcome("modular_agent.turn.outcome", kind);
            if kind == "failed" {
                op.error("turn_failed");
            }
        }
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
        // The journal can already contain turn.end. Do not make completion
        // visible until all of the turn's idle-operation guards are gone.
        drop(erasure);
        drop(activity);
        let mut event = json!(result);
        event["inputId"] = json!(admitted_input);
        self.emit(Event::new(&scope, "turn.result", event)).await?;
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
        interface: Option<&interface_tools::Continuation>,
        invocation: &mut Option<Operation>,
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
        let env: Arc<dyn WorkingEnvironment> = capability(self, "environment")?;
        let point = if env.keeps_points(&data.project) {
            Some(
                env.save_point(&scope.session, &data.project)
                    .await
                    .map_err(|error| anyhow!("cannot save turn point: {error:#}"))?,
            )
        } else {
            None
        };
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
                json!({"input":input.text,"content":source.and_then(|entry|entry.content.as_ref())
                    .and_then(|value|value.get("content")).cloned()
                    .unwrap_or_else(|| wire::text_content(&input.text))}),
            )
            .await?
            .value;
        let mut system = contributions
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().or_else(|| v["system"].as_str()))
            .filter(|s| !s.is_empty())
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
                if !tool.allows("model") || !self.interface_offer(&data, &tool.name) {
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
        let started_by = if let Some(interface) = interface {
            interface.started_by.clone()
        } else if !resume.is_empty() {
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
        let mut settings = data.settings.clone();
        // Keep the requested level until the Runtime prepares a step against
        // the refreshed Provider catalog. An absent setting stays absent.
        if let Some(shape) = source
            .and_then(|e| e.content.as_ref())
            .and_then(|v| v.get("resultShape"))
        {
            settings["result_shape"] = shape.clone();
            system.push_str(&format!("\n\nFor the final answer, return only one JSON value matching this schema:\n{shape}"));
        }
        let authorizers = admission_authorizers(
            scope,
            source
                .and_then(|e| e.content.as_ref())
                .unwrap_or(&Value::Null),
        );
        let mut start = json!({"rights":cap,"authorizers":authorizers,"startedBy":started_by,"model":info,"system":system,"tools":tools,"settings":settings,"resume":resume,"context":context});
        if let Some(interface) = interface {
            start["continuesTurnId"] = json!(interface.origin);
        } else if let Some(origin) = resume
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
        if let Some(point) = point {
            start["point"] = json!(point);
        }
        let mut entries = vec![];
        let input_id = if resume.is_empty() || interface.is_some() {
            input.id.clone()
        } else {
            let input_id = id();
            entries.push(Draft::new("input.accepted", false,
                json!({"inputId":input_id,"text":input.text,"timing":"now","taken":"now","authority":cap,"authorizers":authorizers}))
                .copying(vec![input.id.clone()]));
            input_id
        };
        // Only system and context additions can carry history into turnStart.
        // A contribution can declare its sources, including an empty list for
        // static content. Without lineage, conservatively keep real records.
        let history: Vec<_> = data
            .branch()
            .into_iter()
            .filter(|e| e.writer != "rust.derived" && e.content.is_some())
            .map(|e| e.id)
            .collect();
        let live: std::collections::HashSet<_> = history.iter().map(String::as_str).collect();
        let mut uses_branch = false;
        let mut sources = Vec::new();
        for addition in contributions.as_array().into_iter().flatten().filter(|v| {
            v.as_str()
                .or_else(|| v["system"].as_str())
                .is_some_and(|s| !s.is_empty())
                || v["context"]
                    .as_array()
                    .is_some_and(|parts| !parts.is_empty())
        }) {
            if addition["sources"].is_null() {
                uses_branch = true;
            } else {
                let ids = addition["sources"]
                    .as_array()
                    .ok_or_else(|| anyhow!("before-turn sources must be an array"))?;
                for id in ids {
                    let id = id.as_str().filter(|id| live.contains(id));
                    sources.push(
                        id.ok_or_else(|| anyhow!("unknown before-turn source"))?
                            .to_owned(),
                    );
                }
            }
        }
        if uses_branch {
            sources = history;
        }
        let links = start["continuesTurnId"]
            .as_str()
            .and_then(|id| saved_turn_trace(&data, Some(id)))
            .as_ref()
            .and_then(telemetry::link)
            .into_iter()
            .collect();
        let op = invocation.insert(self.invocation(scope, &telemetry::current(), links, false));
        if let Some(context) = op.own_carrier() {
            start["traceContext"] = context;
        }
        if let Some(interface) = interface {
            sources.extend(interface.sources.iter().cloned());
        }
        let continuation_origin = start["continuesTurnId"].as_str().map(str::to_owned);
        entries.push(Draft::new("turn.start", false, start).copying(sources));
        let mut taken =
            json!({"text":input.text,"inputId":input_id,"key":input.key,"authority":cap});
        if let Some(value) = source.and_then(|s| s.content.as_ref()) {
            if let Some(content) = value["content"].as_array() {
                taken["message"] = json!({"role":"user","content":content});
            }
            for key in ["sponsor", "releasedBy"] {
                if let Some(actor) = wire::optional(value, key) {
                    taken[key] = actor.clone();
                }
            }
        }
        if interface.is_none() {
            let parent = if input_id == input.id {
                source.map(|e| e.id.clone()).unwrap_or(input.id)
            } else {
                input_id
            };
            entries.push(Draft::new("input", true, taken).copying(vec![parent]));
        }
        op.run(async {
            if let Err(err) = self.publish(scope, "harness", entries, None, None) {
                if let Some(origin) = continuation_origin
                    && matches!(
                        err.downcast_ref::<OperationError>(),
                        Some(OperationError::Busy(_))
                    )
                {
                    if let Some(signal) = self
                        .sessions
                        .lock()
                        .unwrap()
                        .get_mut(&scope.session)
                        .and_then(|s| s.continuation_waiters.remove(&origin))
                        .and_then(|s| s.upgrade())
                    {
                        signal.cancel();
                    }
                    return Err(err.context(ContinuationRefused));
                }
                return Err(err);
            }
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
        })
        .await
    }

    pub(super) fn turn_cancellation(&self, session: &str) -> Result<CancellationToken> {
        Ok(self
            .sessions
            .lock()
            .unwrap()
            .get(session)
            .ok_or_else(|| anyhow!("session not open"))?
            .cancel
            .clone())
    }

    pub(super) fn turn_active(&self, session: &str) -> bool {
        self.sessions
            .lock()
            .unwrap()
            .get(session)
            .is_some_and(|s| s.active.is_some())
    }
}

fn saved_turn_trace(data: &SessionData, turn: Option<&str>) -> Option<Context> {
    let turn = turn?;
    let copied: std::collections::BTreeSet<_> = if data.origin.is_some() {
        data.entries
            .iter()
            .take_while(|e| !e.copies.is_empty() || e.content.is_none())
            .map(|e| &e.id)
            .collect()
    } else {
        Default::default()
    };
    data.branch()
        .iter()
        .rev()
        .filter(|e| {
            e.scope.session == data.id
                && e.scope.turn.as_deref() == Some(turn)
                && !copied.contains(&e.id)
                && !e.visible
                && matches!(e.kind.as_str(), "turn.start" | telemetry::TURN_TRACE)
        })
        .filter_map(|e| e.content.as_ref()?.get("traceContext"))
        .find_map(telemetry::extract)
}

fn recorded_outcome(data: &SessionData, scope: &Scope) -> Option<&'static str> {
    let entry = data
        .branch()
        .into_iter()
        .rev()
        .find(|e| e.kind == "turn.end" && e.scope.turn == scope.turn)?;
    let outcome = serde_json::from_value::<Outcome>(entry.content?["outcome"].clone()).ok()?;
    Some(outcome_name(&outcome))
}

fn outcome_name(outcome: &Outcome) -> &'static str {
    match outcome {
        Outcome::Completed => "completed",
        Outcome::Cancelled => "cancelled",
        Outcome::Limit => "limit",
        Outcome::Failed => "failed",
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[tokio::test]
    async fn an_idle_turn_probe_does_not_compete_with_erasure() -> Result<()> {
        let harness = Harness::new();
        let session = harness.create(Path::new("."), json!({})).await?;
        let erasure = harness.erasure.try_write()?;
        assert!(harness.run_next(&session).await?.is_none());
        drop(erasure);
        harness.close(&session).await
    }
}
