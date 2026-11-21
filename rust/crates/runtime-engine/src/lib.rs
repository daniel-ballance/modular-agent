//! Shared turn semantics. The Runtime plugins choose only interruption policy.
pub mod binding;

use agent_api::*;
use futures_util::{StreamExt, stream::FuturesUnordered};
use std::collections::BTreeSet;
use std::{collections::BTreeMap, sync::Arc};

const INTERRUPTED_TOOL: &str = "Interrupted: this call did not finish. Its outside effects are unknown. Check outside state before relying on it; do not assume it succeeded or failed.";

pub fn install(r: &mut Registrar<'_>, durable: bool) -> Result<()> {
    let mut hooks = BTreeMap::new();
    for (name, rule) in [
        ("turn.start", Rule::Observe),
        ("before.step", Rule::Transform),
        ("after.step", Rule::Gate),
        ("before.tool", Rule::Gate),
        ("after.tool", Rule::Transform),
        ("model.failed", Rule::FirstAnswer),
        ("result.ready", Rule::Gate),
        ("turn.end", Rule::Observe),
    ] {
        hooks.insert(name, r.define(&format!("runtime.{name}"), rule)?);
    }
    r.provide::<dyn Runtime>(
        "runtime.transient",
        Arc::new(Engine {
            hooks: hooks.clone(),
            durable: false,
        }),
    )?;
    r.provide::<dyn Runtime>(
        "runtime.durable",
        Arc::new(Engine {
            hooks: hooks.clone(),
            durable: true,
        }),
    )?;
    r.provide::<dyn Runtime>("runtime", Arc::new(Engine { hooks, durable }))
}
struct Execution<'a> {
    tools: &'a [ToolDefinition],
    cancel: &'a CancellationToken,
}
fn current_registration(
    api: &Api,
    data: &SessionData,
    name: &str,
) -> Result<Option<(Value, ToolDefinition)>> {
    for key in api.capability_names("tools.") {
        if let Some(definition) = capability::<dyn ToolSource>(api.as_ref(), &key)?
            .tools(data)
            .into_iter()
            .find(|d| d.name == name)
        {
            return Ok(Some((api.tool_registration(&key), definition)));
        }
    }
    Ok(None)
}

struct Engine {
    hooks: BTreeMap<&'static str, HookPoint>,
    durable: bool,
}
impl Engine {
    fn writer(&self) -> &str {
        if self.durable {
            "runtime.durable"
        } else {
            "runtime.transient"
        }
    }
    async fn hook(&self, api: &Api, name: &str, scope: &Scope, value: Value) -> Result<HookResult> {
        api.invoke(&self.hooks[name], scope, value).await
    }
    async fn step_after(
        &self,
        api: &Api,
        scope: &Scope,
        response: &ModelResponse,
    ) -> Result<Option<String>> {
        let data = api.snapshot(&scope.session)?;
        let checkpoint = data
            .entries
            .iter()
            .filter(|e| e.scope.turn == scope.turn && e.scope.step == scope.step)
            .map(|e| wire::entry(e, &data))
            .collect::<Result<Vec<_>>>()?;
        if let Some(decision) = recovery::checkpoint_decision(
            &checkpoint,
            scope.step.as_deref().ok_or_else(|| anyhow!("no step id"))?,
        )? {
            return Ok(decision["refuse"].as_str().map(str::to_owned));
        }
        let source = checkpoint
            .iter()
            .find(|e| e["kind"] == "response" && e["erased"] != true)
            .ok_or_else(|| anyhow!("missing committed response"))?;
        let result = self
            .hook(api, "after.step", scope, json!({"response":response}))
            .await?;
        let decision = result
            .refused
            .as_ref()
            .map(|reason| json!({"refuse":reason}))
            .unwrap_or(Value::Null);
        self.record(
            api,
            scope,
            recovery::STEP_AFTER,
            false,
            json!({"decision":decision}),
            vec![wire::string(source, "id")?.to_owned()],
        )?;
        Ok(result.refused)
    }

    fn record(
        &self,
        api: &Api,
        scope: &Scope,
        kind: &str,
        visible: bool,
        value: Value,
        copies: Vec<String>,
    ) -> Result<Entry> {
        api.append(
            scope,
            self.writer(),
            Draft::new(kind, visible, value).copying(copies),
        )
    }
    fn turn_entries(&self, api: &Api, scope: &Scope) -> Result<Vec<Entry>> {
        Ok(api
            .snapshot(&scope.session)?
            .branch()
            .into_iter()
            .filter(|e| e.scope.turn == scope.turn)
            .collect())
    }
    fn usage(&self, entries: &[Entry]) -> Result<Usage> {
        let mut usage = Usage::default();
        for e in entries.iter().filter(|e| e.kind == "model.response") {
            if let Some(value) = e.content.as_ref().and_then(|v| v.get("usage")) {
                usage.add(&serde_json::from_value(value.clone())?);
            }
        }
        Ok(usage)
    }
    async fn request(
        &self,
        api: &Api,
        input: &TurnInput,
        scope: &Scope,
        usage: &Usage,
    ) -> Result<std::result::Result<(Scope, ModelResponse), ModelFailure>> {
        let prior = self.turn_entries(api, scope)?;
        // The declaration controls replay even if a Provider later gains state.
        if prior.iter().any(|e| {
            e.scope.step == scope.step
                && e.kind == "model.request"
                && e.content.as_ref().is_some_and(|v| {
                    v["safeToRepeat"] == false
                        || v["keeps_state"] == true
                        || v["runs_tools"] == true
                })
        }) {
            bail!(
                "Interrupted model request has unknown outside effects; check Provider state before retrying"
            );
        }
        let mut retry_request: Option<ModelRequest> = None;
        for attempt in 0..2 {
            if input.cancel.is_cancelled() {
                return Ok(Err(ModelFailure {
                    kind: FailureKind::Cancelled,
                    message: "turn cancelled".into(),
                }));
            }
            if self
                .turn_entries(api, scope)?
                .iter()
                .filter(|e| {
                    e.kind == "model.request"
                        && !e.content.as_ref().is_some_and(|v| v["auxiliary"] == true)
                })
                .count() as u64
                >= input.settings["step_limit"].as_u64().unwrap_or(12)
            {
                return Err(ModelAttemptLimit("steps").into());
            }
            refresh_tool_sources(api, scope).await?;
            let offer = current_model_tools(api, scope, &input.tools)?;
            let data = api.snapshot(&scope.session)?;
            input
                .model
                .refresh(api, scope, input.cancel.clone())
                .await?;
            let info = input.model.info();
            let request = ModelRequest {
                session: scope.session.clone(),
                system: input.system.clone(),
                messages: model_messages(&data.branch(), scope.turn.as_deref())?,
                tools: offer.clone(),
                provider_tools: if work_authority(api.as_ref(), scope)?.has("tools") {
                    input.model.provider_tools()
                } else {
                    vec![]
                },
                thinking: wire::lower_reasoning(
                    input.settings["thinking"].as_str().unwrap_or(""),
                    &info.thinking,
                )
                .into(),
                extra: Value::Null,
                output_limit: input.settings["output_limit"]
                    .as_u64()
                    .unwrap_or(info.output_limit)
                    .min(info.output_limit),
            };
            let request = retry_request.take().unwrap_or(request);
            let value = self
                .hook(
                    api,
                    "before.step",
                    scope,
                    json!({"request":request,"limits":input.model.info(),"usage":usage}),
                )
                .await?
                .value;
            let request: ModelRequest = serde_json::from_value(value["request"].clone())?;
            let request = api
                .output(
                    scope,
                    Output {
                        recipient: "model".into(),
                        value: json!(request),
                        stream: None,
                        end: true,
                    },
                )
                .await?
                .ok_or_else(|| anyhow!("model request blocked by output gate"))?;
            let branch = api.snapshot(&scope.session)?.branch();
            let sources = branch
                .iter()
                .filter(|e| e.visible && e.kind != "resultFeedback")
                .chain(pending_result_feedback(&branch, scope.turn.as_deref()))
                .map(|e| e.id.clone())
                .collect();
            let attempt_scope = if attempt == 0 {
                scope.clone()
            } else {
                Scope {
                    step: Some(id()),
                    ..scope.clone()
                }
            };
            let generated = input
                .model
                .generate_attempt(
                    api.clone(),
                    attempt_scope.clone(),
                    serde_json::from_value(request.clone())?,
                    input.cancel.clone(),
                    ModelAttempt {
                        writer: if self.durable {
                            "runtime.durable"
                        } else {
                            "runtime.transient"
                        },
                        tools: offer,
                        sources,
                        auxiliary: false,
                        safe_to_repeat: input.model.safe_to_repeat(),
                        close_attempt: None,
                        replay: None,
                        authorized_wire: None,
                    },
                )
                .await;
            let response = match generated {
                Ok(r) => r,
                Err(e) if e.downcast_ref::<ModelAttemptLimit>().is_some() => return Err(e),
                Err(e) => {
                    let error = e
                        .downcast_ref::<ModelFailure>()
                        .cloned()
                        .unwrap_or_else(|| ModelFailure {
                            kind: if input.cancel.is_cancelled() {
                                FailureKind::Cancelled
                            } else {
                                FailureKind::Other
                            },
                            message: e.to_string(),
                        });
                    wire::parse_response(
                        json!({"role":"assistant","stop":if error.kind == FailureKind::Cancelled {"aborted"} else {"failed"},
                        "content":[],"error":wire::failure(&error)}),
                    )?
                }
            };
            let intent = self
                .turn_entries(api, scope)?
                .into_iter()
                .find(|e| e.kind == "model.request" && e.scope.step == attempt_scope.step);
            if matches!(response.stop.as_str(), "failed" | "aborted") {
                let mut error = wire::parse_failure(&wire::response(&response)["error"]);
                if response.stop == "aborted" && input.cancel.is_cancelled() {
                    error.kind = FailureKind::Cancelled;
                }
                if let Some(intent) = intent {
                    self.record(
                        api,
                        &attempt_scope,
                        "model.response",
                        !response.parts.is_empty(),
                        json!(response),
                        vec![intent.id],
                    )?;
                }
                if error.kind != FailureKind::Cancelled
                    && let Some(reason) = self.step_after(api, &attempt_scope, &response).await?
                {
                    bail!("{reason}");
                }
                {
                    self.record(
                        api,
                        scope,
                        "model.failure",
                        false,
                        json!(error),
                        api.snapshot(&scope.session)?
                            .branch()
                            .iter()
                            .filter(|e| e.visible)
                            .map(|e| e.id.clone())
                            .collect(),
                    )?;
                    if error.kind == FailureKind::Cancelled || input.cancel.is_cancelled() {
                        return Ok(Err(error));
                    }
                    let reply = self
                        .hook(
                            api,
                            "model.failed",
                            scope,
                            json!({"failure":error,"attempt":attempt,"request":request}),
                        )
                        .await?;
                    if attempt == 0 && reply.value["retry"] == true {
                        input.model.discard(&scope.session).await?;
                        retry_request = reply
                            .value
                            .get("request")
                            .filter(|v| !v.is_null())
                            .cloned()
                            .map(serde_json::from_value)
                            .transpose()?;
                    } else {
                        return Ok(Err(error));
                    }
                }
            } else {
                return Ok(Ok((attempt_scope, response)));
            }
        }
        unreachable!()
    }
    async fn execute(
        &self,
        api: &Api,
        input: &Execution<'_>,
        scope: &Scope,
        call: &ToolCall,
        call_entry: &Entry,
    ) -> Result<ToolResult> {
        refresh_tool_sources(api, scope).await?;
        let session = api.snapshot(&scope.session)?;
        let entries = session.branch();
        if let Some(done) = entries.iter().find(|e| {
            e.scope.call == scope.call
                && matches!(e.kind.as_str(), "tool.result" | "tool.completed")
        }) {
            return Ok(serde_json::from_value(
                done.content
                    .clone()
                    .ok_or_else(|| anyhow!("erased tool result"))?,
            )?);
        }
        if scope.turn.is_some()
            && entries.iter().any(|e| {
                e.kind == "tool.pending"
                    && e.scope.turn == scope.turn
                    && e.scope.call == scope.call
                    && e.content.is_some()
            })
        {
            return Ok(ToolResult::new(
                call,
                ToolStatus::Waiting,
                "waiting for answer",
            ));
        }
        if scope.turn.is_some() && expired_leave_open(&entries, scope) {
            requests(api.as_ref())?.close_turn_with_reason(
                api.as_ref(),
                scope,
                "noLongerAnswerable",
            )?;
            return Ok(
                if entries.iter().any(|e| {
                    e.kind == "tool.started"
                        && e.scope.call == scope.call
                        && e.scope.turn == scope.turn
                }) {
                    ToolResult::new(call, ToolStatus::Unknown, INTERRUPTED_TOOL)
                } else {
                    ToolResult::new(
                        call,
                        ToolStatus::NotStarted,
                        "Interrupted before the call started",
                    )
                },
            );
        }
        let registration = current_registration(api, &session, &call.name)?;
        let definition = registration.as_ref().map(|(_, def)| def);
        let model_offer = scope.turn.is_none()
            || call.started_by != "model"
            || call_entry.scope.turn != scope.turn
            || entries
                .iter()
                .find(|e| {
                    e.kind == "model.request"
                        && e.scope.turn == scope.turn
                        && e.scope.step == scope.step
                })
                .and_then(|e| e.content.as_ref()?.get("tools"))
                .and_then(Value::as_array)
                .is_some_and(|tools| tools.iter().any(|n| n == &call.name));
        let offered = model_offer && input.tools.iter().any(|d| d.name == call.name);
        let started = entries
            .iter()
            .rev()
            .find(|e| e.kind == "tool.started" && e.scope.call == scope.call);
        let interrupted = started.is_some_and(|e| e.scope.turn == scope.turn);
        let unknown = || ToolResult::new(call, ToolStatus::Unknown, INTERRUPTED_TOOL);
        let environment: Arc<dyn WorkingEnvironment> = capability(api.as_ref(), "environment")?;
        let repeat = definition.is_some_and(|d| d.safe_to_repeat)
            && environment.declaration()["stops_commands_after_sigkill"] == true;
        let still_safe = repeat
            && started
                .and_then(|e| e.content.as_ref())
                .is_some_and(|start| {
                    registration.as_ref().is_some_and(|(source, def)| {
                        same_json(&start["source"], source)
                            && same_json(&start["definition"], &wire::registered_definition(def))
                    })
                });
        let waiting = questions(&api.snapshot(&scope.session)?)?
            .iter()
            .any(|q| q.scope.call == scope.call && q.answerable);
        let relinquished = started.is_some_and(|start| {
            entries.iter().any(|e| {
                e.kind == "tool.pending"
                    && e.scope.call == scope.call
                    && e.content
                        .as_ref()
                        .is_some_and(|v| v["toolStartedId"] == start.id)
            }) && start.content.as_ref().is_some_and(|v| {
                registration.as_ref().is_some_and(|(source, def)| {
                    same_json(&v["source"], source)
                        && same_json(&v["definition"], &wire::registered_definition(def))
                })
            })
        });
        // Only a committed pending reply confirms that the invocation relinquished execution.
        if !relinquished
            && started.is_some_and(|e| {
                !still_safe || e.content.as_ref().is_none_or(|v| v["safeToRepeat"] != true)
            })
            && (interrupted || !waiting)
        {
            return Ok(unknown());
        }
        let denied = if input.cancel.is_cancelled() {
            Some((ToolStatus::Cancelled, "turn cancelled"))
        } else if !work_authority(api.as_ref(), scope)?.has("tools") {
            Some((ToolStatus::Refused, "actor lacks tools authority"))
        } else {
            None
        };
        if interrupted && denied.is_some() {
            return Ok(unknown());
        }
        let mut result = if let Some((status, text)) = denied {
            ToolResult::new(call, status, text)
        } else if !offered || definition.is_none() {
            ToolResult::new(call, ToolStatus::Refused, "tool was not offered")
        } else {
            let reply = self
                .hook(
                    api,
                    "before.tool",
                    scope,
                    json!({"call":call,"definition":definition}),
                )
                .await?;
            if reply.suspended {
                return Ok(ToolResult::new(
                    call,
                    ToolStatus::Waiting,
                    "waiting for answer",
                ));
            }
            if interrupted && (reply.refused.is_some() || input.cancel.is_cancelled()) {
                return Ok(unknown());
            }
            if let Some(reason) = reply.refused {
                ToolResult::new(
                    call,
                    if input.cancel.is_cancelled() {
                        ToolStatus::Cancelled
                    } else {
                        ToolStatus::Refused
                    },
                    reason,
                )
            } else {
                let changed: ToolCall = serde_json::from_value(reply.value["call"].clone())?;
                ensure!(
                    changed.id == call.id && changed.name == call.name,
                    "before-tool may change input only"
                );
                let (source, definition) = registration.as_ref().unwrap();
                let mut start = json!({"call":changed,"safeToRepeat":repeat,"openWorld":definition.open_world(),
                    "source":source,"definition":wire::registered_definition(definition)});
                if scope.turn.is_none()
                    && environment.keeps_points(&api.snapshot(&scope.session)?.project)
                {
                    match environment
                        .save_point(&scope.session, &api.snapshot(&scope.session)?.project)
                        .await
                    {
                        Ok(point) => start["point"] = json!(point),
                        Err(error) => eprintln!("tool call has no saved point: {error}"),
                    }
                }
                let current = || -> Result<bool> {
                    Ok(
                        current_registration(api, &api.snapshot(&scope.session)?, &call.name)?
                            .is_some_and(|(s, d)| {
                                same_json(source, &s)
                                    && same_json(
                                        &wire::definition(definition),
                                        &wire::definition(&d),
                                    )
                            })
                            && work_authority(api.as_ref(), scope)?.has("tools"),
                    )
                };
                if input.cancel.is_cancelled() {
                    ToolResult::new(call, ToolStatus::Cancelled, "turn cancelled")
                } else if !current()? {
                    ToolResult::new(
                        call,
                        ToolStatus::Refused,
                        "registration or authority changed after the gate",
                    )
                } else {
                    api.check_writer(&scope.session)?;
                    let started = self.record(
                        api,
                        scope,
                        "tool.started",
                        false,
                        start,
                        vec![call_entry.id.clone()],
                    )?;
                    api.emit(Event::new(scope, "tool.started", json!(changed)))
                        .await?;
                    if input.cancel.is_cancelled() {
                        ToolResult::new(call, ToolStatus::Cancelled, "turn cancelled")
                    } else if !current()? {
                        ToolResult::new(
                            call,
                            ToolStatus::Refused,
                            "registration or authority changed before dispatch",
                        )
                    } else {
                        let result = api
                            .dispatch_tool(scope, changed, input.cancel.child_token())
                            .await;
                        if result.status == ToolStatus::Waiting {
                            let data = api.snapshot(&scope.session)?;
                            let request_ids: Vec<_> = data
                                .entries
                                .iter()
                                .filter(|e| {
                                    e.kind == "request.suspended"
                                        && e.scope.turn == scope.turn
                                        && e.scope.call == scope.call
                                })
                                .filter_map(|e| e.content.as_ref()?.get("request")?.as_str())
                                .collect();
                            ensure!(
                                !request_ids.is_empty(),
                                "pending call has no committed leaveOpen expiry"
                            );
                            api.append(
                                scope,
                                &started.writer,
                                Draft::new(
                                    "tool.pending",
                                    false,
                                    json!({"toolStartedId":started.id,"requestIds":request_ids}),
                                ),
                            )?;
                        }
                        result
                    }
                }
            }
        };
        if result.status == ToolStatus::Waiting {
            return Ok(result);
        }
        if interrupted && matches!(result.status, ToolStatus::Refused | ToolStatus::NotStarted) {
            return Ok(unknown());
        }
        match self.hook(api, "after.tool", scope, json!(result)).await {
            Ok(reply) => {
                result = serde_json::from_value(reply.value)?;
                ensure!(result.call == call.id, "after-tool changed result identity");
            }
            Err(error) => {
                result = ToolResult::new(
                    call,
                    ToolStatus::Failed,
                    format!("after-tool handler failed: {error}"),
                )
            }
        }
        if let Some((_, definition)) = registration
            && let Err(error) = schema::tool_result(&definition, &result)
        {
            // Execution was confirmed. Settle once without exposing the invalid payload.
            let safe = ToolResult::new(
                call,
                result.status,
                "The call completed, but its result did not match its schema.",
            );
            self.publish_tool_result(api, scope, call_entry, safe)
                .await?;
            return Err(error);
        }
        Ok(result)
    }
    async fn tools(
        &self,
        api: &Api,
        input: &TurnInput,
        scope: &Scope,
        response_entry: &Entry,
        response: &ModelResponse,
    ) -> Result<Vec<ToolCall>> {
        let calls = if matches!(response.stop.as_str(), "tools" | "finished") {
            response.tool_calls()
        } else {
            vec![]
        };
        let mut ids = std::collections::BTreeSet::new();
        ensure!(
            calls.iter().all(|call| ids.insert(&call.id)),
            "duplicate tool call id"
        );
        let mut jobs = vec![];
        for call in &calls {
            let call_scope = Scope {
                call: Some(call.id.clone()),
                ..scope.clone()
            };
            let entries = self.turn_entries(api, scope)?;
            let call_entry = if let Some(entry) = entries
                .iter()
                .find(|e| e.kind == "tool.call" && e.scope.call == call_scope.call)
            {
                ensure!(entry.scope.step == scope.step, "duplicate tool call id");
                entry.clone()
            } else {
                // A complete response may have committed immediately before the crash.
                ensure!(
                    !api.snapshot(&scope.session)?
                        .entries
                        .iter()
                        .any(|e| e.kind == "tool.call" && e.scope.call == call_scope.call),
                    "duplicate tool call id"
                );
                let entry = self.record(
                    api,
                    &call_scope,
                    "tool.call",
                    false,
                    json!(call),
                    vec![response_entry.id.clone()],
                )?;
                api.emit(Event::new(&call_scope, "tool.requested", json!(call)))
                    .await?;
                entry
            };
            jobs.push((call_scope, call_entry));
        }
        let parallel = calls
            .iter()
            .all(|c| input.tools.iter().any(|d| d.name == c.name && d.parallel));
        let execution = Execution {
            tools: &input.tools,
            cancel: &input.cancel,
        };
        let mut open = vec![];
        if parallel {
            let mut results: FuturesUnordered<_> = calls
                .iter()
                .zip(&jobs)
                .map(|(call, (scope, entry))| {
                    let execution = &execution;
                    async move {
                        (
                            call,
                            scope,
                            entry,
                            self.execute(api, execution, scope, call, entry).await,
                        )
                    }
                })
                .collect();
            while let Some((call, scope, entry, result)) = results.next().await {
                if self.publish_tool_result(api, scope, entry, result?).await? {
                    open.push(call.clone());
                }
            }
        } else {
            for (call, (scope, entry)) in calls.iter().zip(&jobs) {
                let result = self.execute(api, &execution, scope, call, entry).await?;
                if self.publish_tool_result(api, scope, entry, result).await? {
                    open.push(call.clone());
                }
            }
        }
        // An open call list is in call order even when the tools answered out of order.
        open.sort_by_key(|call| calls.iter().position(|c| c.id == call.id));
        Ok(open)
    }
    async fn publish_tool_result(
        &self,
        api: &Api,
        scope: &Scope,
        entry: &Entry,
        result: ToolResult,
    ) -> Result<bool> {
        if result.status == ToolStatus::Waiting {
            return Ok(true);
        }
        if !self
            .turn_entries(api, scope)?
            .iter()
            .any(|e| e.kind == "tool.result" && e.scope.call == scope.call)
        {
            self.record(
                api,
                scope,
                "tool.result",
                true,
                json!(result),
                vec![entry.id.clone()],
            )?;
            api.emit(Event::new(scope, "tool.ended", json!(result)))
                .await?;
        }
        Ok(false)
    }
    async fn resume(&self, api: &Api, input: &TurnInput) -> Result<Option<TurnResult>> {
        let mut open = vec![];
        let execution = Execution {
            tools: &input.tools,
            cancel: &input.cancel,
        };
        for call in &input.resume {
            let scope = Scope {
                call: Some(call.id.clone()),
                ..input.scope.clone()
            };
            let data = api.snapshot(&scope.session)?;
            if data
                .entries
                .iter()
                .any(|e| e.kind == "tool.result" && e.scope.call == scope.call)
            {
                continue;
            }
            let entry = data
                .branch()
                .into_iter()
                .find(|e| e.kind == "tool.call" && e.scope.call == scope.call)
                .ok_or_else(|| anyhow!("open call left branch"))?;
            let result = self.execute(api, &execution, &scope, call, &entry).await?;
            if result.status == ToolStatus::Waiting {
                open.push(call.clone());
                continue;
            }
            self.record(
                api,
                &scope,
                "tool.result",
                true,
                json!(result),
                vec![entry.id],
            )?;
            api.emit(Event::new(&scope, "tool.ended", json!(result)))
                .await?;
        }
        Ok(if open.is_empty() {
            None
        } else {
            Some(TurnResult {
                open_calls: open,
                ..TurnResult::default()
            })
        })
    }
    async fn steps(&self, api: &Api, input: &TurnInput) -> Result<TurnResult> {
        let limit = input.settings["step_limit"].as_u64().unwrap_or(12) as usize;
        let mut result = TurnResult::default();
        // Revisit an incomplete step; completed decisions are not made twice.
        for index in 0..limit {
            let entries = self.turn_entries(api, &input.scope)?;
            let mut seen = BTreeSet::new();
            let start = entries
                .iter()
                .filter(|e| {
                    matches!(e.kind.as_str(), "step.start" | "model.response")
                        && seen.insert(e.scope.step.clone())
                })
                .nth(index);
            let mut scope = if let Some(start) = start {
                start.scope.clone()
            } else {
                Scope {
                    step: Some(id()),
                    ..input.scope.clone()
                }
            };
            if let Some(end) = entries
                .iter()
                .find(|e| e.kind == "step.end" && e.scope.step == scope.step)
            {
                let content = end
                    .content
                    .as_ref()
                    .ok_or_else(|| anyhow!("erased step checkpoint"))?;
                result = serde_json::from_value(content["result"].clone())?;
                if content["continue"] != true {
                    return Ok(result);
                }
                continue;
            }
            if input.cancel.is_cancelled() {
                result.outcome = Outcome::Cancelled;
                return Ok(result);
            }
            if start.is_none() {
                api.take_steering(&scope)?;
                self.record(
                    api,
                    &scope,
                    "step.start",
                    false,
                    json!({"index":index}),
                    vec![],
                )?;
                api.emit(Event::new(&scope, "step.start", json!({"index":index})))
                    .await?;
            }
            let (response_entry, response) = if let Some(entry) = entries
                .iter()
                .find(|e| e.kind == "model.response" && e.scope.step == scope.step)
            {
                (
                    entry.clone(),
                    serde_json::from_value(
                        entry
                            .content
                            .clone()
                            .ok_or_else(|| anyhow!("erased response"))?,
                    )?,
                )
            } else {
                result.usage = self.usage(&entries)?;
                let generated = self.request(api, input, &scope, &result.usage).await;
                if let Err(e) = &generated
                    && let Some(limit) = e.downcast_ref::<ModelAttemptLimit>()
                {
                    result.outcome = Outcome::Limit;
                    result.limit = Some(limit.0.into());
                    return Ok(result);
                }
                let response = match generated? {
                    Ok((step, response)) => {
                        scope = step;
                        response
                    }
                    Err(error) => {
                        result.outcome = if error.kind == FailureKind::Cancelled
                            || input.cancel.is_cancelled()
                        {
                            Outcome::Cancelled
                        } else {
                            Outcome::Failed
                        };
                        result.error = Some(error.to_string());
                        return Ok(result);
                    }
                };
                let copies = self
                    .turn_entries(api, &scope)?
                    .into_iter()
                    .filter(|e| e.kind == "model.request" && e.scope.step == scope.step)
                    .map(|e| e.id)
                    .collect();
                let entry =
                    self.record(api, &scope, "model.response", true, json!(response), copies)?;
                (entry, response)
            };
            result.steps = index + 1;
            result.usage = self.usage(&self.turn_entries(api, &scope)?)?;
            result.open_calls = self
                .tools(api, input, &scope, &response_entry, &response)
                .await?;
            api.emit(Event::new(
                &scope,
                "step.end",
                json!({"usage":response.usage}),
            ))
            .await?;
            let refusal = self.step_after(api, &scope, &response).await?;
            result.text = response.text_content();
            result.value = None;
            let mut carry_on = false;
            if input.cancel.is_cancelled() {
                result.outcome = Outcome::Cancelled;
            } else if api.tenant_budget_reached(&scope.session)? {
                result.outcome = Outcome::Limit;
                result.limit = Some("tenantTokens".into());
            } else if response.stop == "limit" {
                result.outcome = Outcome::Limit;
                result.limit = Some("output".into());
            } else if let Some(reason) = refusal.as_ref() {
                result.outcome = Outcome::Failed;
                result.error = Some(reason.clone());
            } else if !result.open_calls.is_empty() {
                if input.settings.get("result_shape").is_some() {
                    result.outcome = Outcome::Failed;
                    result.error =
                        Some("The turn left calls open without a structured result.".into());
                } else {
                    result.outcome = Outcome::Completed;
                }
            } else {
                if !response.tool_calls().is_empty() || !api.take_steering(&scope)?.is_empty() {
                    carry_on = true;
                } else {
                    let mut payload = json!(result);
                    let mut reason = None;
                    if let Some(shape) = input.settings.get("result_shape") {
                        let value = wire::decode_json(result.text.as_bytes());
                        reason = match value {
                            Ok(value) => match schema::check(shape, Some(&value)) {
                                Ok(()) => {
                                    payload["value"] = value.clone();
                                    result.value = Some(value);
                                    None
                                }
                                Err(error) => Some(format!(
                                    "The result shape does not accept this value: {error}"
                                )),
                            },
                            Err(_) => Some("The final answer must be a JSON value.".into()),
                        };
                        payload["shape"] = shape.clone();
                    }
                    if reason.is_none() {
                        let checked = self.hook(api, "result.ready", &scope, payload).await?;
                        reason = checked
                            .refused
                            .or_else(|| checked.value["retry_reason"].as_str().map(str::to_owned));
                    }
                    if let Some(reason) = reason {
                        result.value = None;
                        self.record(
                            api,
                            &scope,
                            "resultFeedback",
                            true,
                            json!({"reason":reason}),
                            vec![],
                        )?;
                        carry_on = true;
                    }
                }
            }
            let copies = self
                .turn_entries(api, &scope)?
                .iter()
                .map(|e| e.id.clone())
                .collect();
            self.record(
                api,
                &scope,
                "step.end",
                false,
                json!({"continue":carry_on,"result":result}),
                copies,
            )?;
            if !carry_on {
                return Ok(result);
            }
        }
        result.outcome = Outcome::Limit;
        result.error = Some("step limit".into());
        Ok(result)
    }
    fn settle(
        &self,
        api: &Api,
        scope: &Scope,
        cancelled: bool,
        recovering: bool,
        open: &[ToolCall],
    ) -> Result<()> {
        // Responses commit before their call records. Even a transient Runtime
        // must account for every requested call if that small window was cut off.
        for response in self
            .turn_entries(api, scope)?
            .iter()
            .filter(|e| e.kind == "model.response")
        {
            let model: ModelResponse = serde_json::from_value(
                response
                    .content
                    .clone()
                    .ok_or_else(|| anyhow!("erased response"))?,
            )?;
            for call in model.tool_calls() {
                if !self
                    .turn_entries(api, scope)?
                    .iter()
                    .any(|e| e.kind == "tool.call" && e.scope.call.as_deref() == Some(&call.id))
                {
                    let call_scope = Scope {
                        call: Some(call.id.clone()),
                        ..response.scope.clone()
                    };
                    self.record(
                        api,
                        &call_scope,
                        "tool.call",
                        false,
                        json!(call),
                        vec![response.id.clone()],
                    )?;
                }
            }
        }
        let entries = self.turn_entries(api, scope)?;
        let call_order: Vec<_> = entries
            .iter()
            .filter(|e| e.kind == "model.response")
            .filter_map(|e| e.content.as_ref())
            .map(|v| serde_json::from_value::<ModelResponse>(v.clone()))
            .collect::<std::result::Result<Vec<_>, _>>()?
            .into_iter()
            .flat_map(|r| r.tool_calls())
            .map(|c| c.id)
            .collect();
        let mut calls: Vec<_> = entries.iter().filter(|e| e.kind == "tool.call").collect();
        calls.sort_by_key(|e| {
            call_order
                .iter()
                .position(|id| Some(id) == e.scope.call.as_ref())
                .unwrap_or(usize::MAX)
        });
        for entry in calls {
            if open
                .iter()
                .any(|c| entry.scope.call.as_ref() == Some(&c.id))
            {
                continue;
            }
            if entries
                .iter()
                .any(|e| e.kind == "tool.result" && e.scope.call == entry.scope.call)
            {
                continue;
            }
            let call: ToolCall = serde_json::from_value(
                entry
                    .content
                    .clone()
                    .ok_or_else(|| anyhow!("erased call"))?,
            )?;
            let completed = entries
                .iter()
                .find(|e| e.kind == "tool.completed" && e.scope.call == entry.scope.call);
            let result = if let Some(done) = completed {
                serde_json::from_value(
                    done.content
                        .clone()
                        .ok_or_else(|| anyhow!("erased completion"))?,
                )?
            } else {
                let started = entries
                    .iter()
                    .any(|e| e.kind == "tool.started" && e.scope.call == entry.scope.call);
                if started && (recovering || !cancelled) {
                    ToolResult::new(&call, ToolStatus::Unknown, INTERRUPTED_TOOL)
                } else if cancelled {
                    ToolResult::new(&call, ToolStatus::Cancelled, "turn cancelled")
                } else {
                    ToolResult::new(
                        &call,
                        ToolStatus::NotStarted,
                        "Interrupted before the call started",
                    )
                }
            };
            self.record(
                api,
                &entry.scope,
                "tool.result",
                call.started_by != "tool",
                json!(result),
                vec![entry.id.clone()],
            )?;
        }
        Ok(())
    }
    async fn finish(
        &self,
        api: &Api,
        scope: &Scope,
        run: Result<TurnResult>,
        recovering: bool,
    ) -> Result<TurnResult> {
        let mut result = run.unwrap_or_else(|e| TurnResult {
            outcome: Outcome::Failed,
            error: Some(e.to_string()),
            ..TurnResult::default()
        });
        if api.cancellation(&scope.session)?.is_cancelled() {
            result.outcome = Outcome::Cancelled;
            result.error = None;
            result.limit = None;
            result.open_calls.clear();
        }
        self.settle(
            api,
            scope,
            result.outcome == Outcome::Cancelled,
            recovering,
            &result.open_calls,
        )?;
        if matches!(result.outcome, Outcome::Cancelled | Outcome::Failed)
            && let Ok(requests) = requests(api.as_ref())
        {
            let reason = if result.outcome == Outcome::Cancelled {
                "cancelled"
            } else {
                "noLongerAnswerable"
            };
            if result.open_calls.is_empty() {
                requests.close_turn_with_reason(api.as_ref(), scope, reason)?;
            } else {
                let data = api.snapshot(&scope.session)?;
                let calls: BTreeSet<_> = questions(&data)?
                    .into_iter()
                    .filter(|q| q.answerable && q.scope.turn == scope.turn)
                    .map(|q| q.scope.call)
                    .collect();
                for call in calls {
                    if call
                        .as_ref()
                        .is_none_or(|id| !result.open_calls.iter().any(|c| &c.id == id))
                    {
                        // A call-less request has no pending disposition.
                        if call.is_some() {
                            requests.close_turn_with_reason(
                                api.as_ref(),
                                &Scope {
                                    call,
                                    ..scope.clone()
                                },
                                reason,
                            )?;
                        }
                    }
                }
            }
        }
        let entries = self.turn_entries(api, scope)?;
        result.usage = self.usage(&entries)?;
        if let Err(error) = self.hook(api, "turn.end", scope, json!(result)).await {
            eprintln!("turn.end observer failed: {error:#}");
        }
        self.record(
            api,
            scope,
            "turn.end",
            false,
            json!(result),
            entries.iter().map(|e| e.id.clone()).collect(),
        )?;
        api.emit(Event::new(scope, "turn.end", json!(result)))
            .await?;
        Ok(result)
    }
}
#[async_trait]
impl Runtime for Engine {
    fn declaration(&self) -> Value {
        json!({"transient":!self.durable,"input_during_turn":true,"continues_after_restart":self.durable,"waits_through_restart":self.durable,"cancel_cancels_jobs":false,"parallel_tools":true,"nested_tools":true})
    }
    async fn run(&self, api: Api, input: TurnInput) -> Result<TurnResult> {
        let run = async {
            self.hook(&api, "turn.start", &input.scope, json!({}))
                .await?;
            if let Some(pending) = self.resume(&api, &input).await? {
                return Ok(pending);
            }
            self.steps(&api, &input).await
        }
        .await;
        self.finish(&api, &input.scope, run, false).await
    }
    async fn tool(&self, api: Api, mut scope: Scope, mut call: ToolCall) -> Result<ToolResult> {
        let _workspace = api.begin_environment_work(&scope.session)?;
        refresh_tool_sources(&api, &scope).await?;
        call.started_by = scope.actor.clone();
        scope.call = Some(call.id.clone());
        let data = api.snapshot(&scope.session)?;
        ensure!(
            !data
                .entries
                .iter()
                .any(|e| e.kind == "tool.call" && e.scope.call == scope.call),
            "duplicate tool call id"
        );
        let entry = self.record(&api, &scope, "tool.call", false, json!(call), vec![])?;
        let mut tools = vec![];
        for name in api.capability_names("tools.") {
            tools.extend(capability::<dyn ToolSource>(api.as_ref(), &name)?.tools(&data));
        }
        let cancel = api.cancellation(&scope.session)?;
        let result = self
            .execute(
                &api,
                &Execution {
                    tools: &tools,
                    cancel: &cancel,
                },
                &scope,
                &call,
                &entry,
            )
            .await?;
        if result.status != ToolStatus::Waiting {
            self.record(
                &api,
                &scope,
                "tool.result",
                true,
                json!(result),
                vec![entry.id],
            )?;
            api.emit(Event::new(&scope, "tool.ended", json!(result)))
                .await?;
        }
        Ok(result)
    }
    async fn nested_tool(
        &self,
        api: Api,
        mut scope: Scope,
        mut call: ToolCall,
        cancel: CancellationToken,
    ) -> Result<ToolResult> {
        let parent = scope
            .call
            .clone()
            .ok_or_else(|| anyhow!("a nested call needs a parent call"))?;
        let data = api.snapshot(&scope.session)?;
        ensure!(
            data.entries
                .iter()
                .any(|e| e.kind == "tool.started" && e.scope.call.as_deref() == Some(&parent))
                && !data
                    .entries
                    .iter()
                    .any(|e| e.kind == "tool.result" && e.scope.call.as_deref() == Some(&parent)),
            "the parent call is not running"
        );
        ensure!(
            !data
                .entries
                .iter()
                .any(|e| e.kind == "tool.call" && e.scope.call.as_deref() == Some(&call.id)),
            "duplicate tool call id"
        );
        // Count the chain of parents above this call.
        let mut depth = 1;
        let mut above = Some(parent.clone());
        while let Some(id) = above {
            above = data
                .entries
                .iter()
                .find(|e| e.kind == "tool.call" && e.scope.call.as_deref() == Some(&id))
                .and_then(|e| e.content.as_ref()?["extra"]["parentCallId"].as_str())
                .map(str::to_owned);
            if above.is_some() {
                depth += 1;
            }
        }
        ensure!(
            depth <= MAX_NESTING,
            "nested calls may go {MAX_NESTING} deep at most"
        );
        call.started_by = "tool".into();
        if !call.extra.is_object() {
            call.extra = json!({});
        }
        call.extra["parentCallId"] = json!(parent);
        scope.call = Some(call.id.clone());
        let entry = self.record(&api, &scope, "tool.call", false, json!(call), vec![])?;
        // Followers hear of a nested call as they do of the model's own.
        api.emit(Event::new(&scope, "tool.requested", json!(call)))
            .await?;
        let tools = nested_tool_definitions(api.as_ref(), &data)?;
        let mut result = self
            .execute(
                &api,
                &Execution {
                    tools: &tools,
                    cancel: &cancel,
                },
                &scope,
                &call,
                &entry,
            )
            .await?;
        if result.status == ToolStatus::Waiting {
            // A nested call has no continuation of its own to come back to.
            for question in questions(&api.snapshot(&scope.session)?)?
                .into_iter()
                .filter(|q| q.answerable && q.scope.call == scope.call)
            {
                self.record(
                    &api,
                    &question.scope,
                    "request.closed",
                    false,
                    json!({"request":question.id,"reason":"noLongerAnswerable"}),
                    vec![],
                )?;
            }
            result = ToolResult::new(
                &call,
                ToolStatus::Refused,
                "it needs an answer that cannot outlast the calling tool",
            );
        }
        self.record(
            &api,
            &scope,
            "tool.result",
            false,
            json!(result),
            vec![entry.id],
        )?;
        api.emit(Event::new(&scope, "tool.ended", json!(result)))
            .await?;
        Ok(result)
    }
    async fn interrupted(&self, api: Api, scope: Scope) -> Result<()> {
        if !self.durable {
            let branch = api.snapshot(&scope.session)?.branch();
            let open_calls = branch
                .iter()
                .filter(|e| e.kind == "tool.call")
                .filter(|call| {
                    branch.iter().any(|e| {
                        e.kind == "tool.pending"
                            && e.scope.turn == scope.turn
                            && e.scope.call == call.scope.call
                            && e.content.is_some()
                    }) && !branch
                        .iter()
                        .any(|e| e.kind == "tool.result" && e.scope.call == call.scope.call)
                })
                .map(|e| {
                    serde_json::from_value::<ToolCall>(e.content.clone().unwrap_or(Value::Null))
                })
                .collect::<std::result::Result<Vec<_>, _>>()?;
            self.finish(
                &api,
                &scope,
                Ok(TurnResult {
                    outcome: Outcome::Failed,
                    error: Some("transient turn interrupted by process exit".into()),
                    open_calls,
                    ..TurnResult::default()
                }),
                true,
            )
            .await?;
            return Ok(());
        }
        let run = async {
            let entries = self.turn_entries(&api, &scope)?;
            let data = api.snapshot(&scope.session)?;
            let mut checkpoint = entries
                .iter()
                .filter(|e| e.kind != recovery::STEP_AFTER)
                .map(|e| wire::entry(e, &data))
                .collect::<Result<Vec<_>>>()?;
            for decision in data
                .entries
                .iter()
                .filter(|e| e.scope.turn == scope.turn && e.kind == recovery::STEP_AFTER)
            {
                checkpoint.push(wire::entry(decision, &data)?);
            }
            recovery::last_answered_step(&checkpoint)?;
            let saved = entries
                .iter()
                .find(|e| e.kind == "turn.start")
                .and_then(|e| e.content.as_ref())
                .ok_or_else(|| anyhow!("missing turn checkpoint"))?;
            let name = saved["model"]["name"]
                .as_str()
                .ok_or_else(|| anyhow!("saved model is unavailable"))?;
            let model = api
                .capability_names("provider.")
                .into_iter()
                .filter_map(|key| capability::<dyn Provider>(api.as_ref(), &key).ok())
                .find(|p| p.catalog().iter().any(|m| m.name == name))
                .ok_or_else(|| anyhow!("saved model is unavailable: {name}"))?
                .bind(name)?;
            let mut settings = saved["settings"].clone();
            settings["thinking"] = json!(wire::lower_reasoning(
                settings["thinking"].as_str().unwrap_or(""),
                &model.info().thinking
            ));
            let input = TurnInput {
                resume: saved
                    .get("resume")
                    .map(|v| serde_json::from_value(v.clone()))
                    .transpose()?
                    .unwrap_or_default(),
                scope: scope.clone(),
                model,
                system: saved["system"]
                    .as_str()
                    .ok_or_else(|| anyhow!("missing saved system prompt"))?
                    .into(),
                tools: serde_json::from_value(saved["tools"].clone())?,
                settings,
                cancel: api.cancellation(&scope.session)?,
            };
            api.emit(Event::new(&scope, "turn.resumed", json!({})))
                .await?;
            if let Some(pending) = self.resume(&api, &input).await? {
                return Ok(pending);
            }
            self.steps(&api, &input).await
        }
        .await;
        let result = self.finish(&api, &scope, run, true).await?;
        api.emit(Event::new(&scope, "turn.result", json!(result)))
            .await?;
        Ok(())
    }
}
