//! Adapt a remote Runtime to the Harness. Turn policy stays in the Runtime.
use crate::{
    relay::{Relay, Route},
    rpc::*,
    wire,
};
use agent_api::*;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

pub(crate) enum Execution {
    Remote(Arc<Peer>),
    Local(Arc<dyn crate::RuntimeHandler>),
}

pub(crate) struct RemoteRuntime {
    pub execution: Execution,
    pub points: BTreeMap<String, HookPoint>,
    pub registration: Value,
    pub ui_runtime: Option<Arc<dyn Runtime>>,
}

pub(crate) struct Callback<'a> {
    pub peer: Option<Arc<Peer>>,
    pub id: Value,
    pub method: &'a str,
    pub params: &'a Value,
}

pub(crate) struct TurnWork {
    input: TurnInput,
    resumed: bool,
    points: BTreeMap<String, HookPoint>,
    ended: AtomicBool,
    commits: tokio::sync::Mutex<()>,
    allowed: Mutex<BTreeMap<String, Allowance>>,
    allocated: Mutex<BTreeSet<String>>,
    prepared: Mutex<BTreeMap<String, PreparedStep>>,
    expected: Mutex<BTreeMap<String, Value>>,
    after: Mutex<BTreeSet<String>>,
    step_refusal: Mutex<Option<String>>,
    limit: Mutex<Option<(String, bool)>>,
    running_tools: Mutex<BTreeSet<String>>,
    active_step: Mutex<Option<String>>,
    retry: AtomicBool,
    replacement: Mutex<Option<Value>>,
}

fn committed_pending(data: &SessionData, turn: Option<&str>, call: Option<&str>) -> bool {
    data.entries.iter().any(|e| {
        e.kind == "tool.pending"
            && e.content.is_some()
            && e.scope.turn.as_deref() == turn
            && e.scope.call.as_deref() == call
    })
}

struct PreparedStep {
    wire: Value,
    provider_tools: Vec<ToolDefinition>,
}

struct Allowance {
    input: Value,
    source: Value,
    definition: ToolDefinition,
}
fn matches_registration(decision: &Allowance, current: Option<&(Value, ToolDefinition)>) -> bool {
    current.is_some_and(|(source, def)| {
        same_json(&decision.source, source)
            && same_json(
                &wire::definition(&decision.definition),
                &wire::definition(def),
            )
    })
}

#[async_trait]
impl Runtime for RemoteRuntime {
    fn declaration(&self) -> Value {
        let s = &self.registration["supports"];
        json!({"id":self.registration["id"],"transient":s["continuesAfterRestart"]!=true,"input_during_turn":s["inputDuringTurn"]==true,"continues_after_restart":s["continuesAfterRestart"]==true,"waits_through_restart":s["waitingThroughRestart"]==true,"rewinding":false,"cancel_cancels_jobs":false})
    }
    async fn run(&self, api: Api, input: TurnInput) -> Result<TurnResult> {
        let method = if input.resume.is_empty() {
            "runtime/runTurn"
        } else {
            "runtime/continueOpenCalls"
        };
        self.run_remote(api, input, method).await
    }
    async fn interrupted(&self, api: Api, scope: Scope) -> Result<()> {
        let data = api.snapshot(&scope.session)?;
        let start = data
            .branch()
            .into_iter()
            .find(|e| e.kind == "turn.start" && e.scope.turn == scope.turn)
            .ok_or_else(|| anyhow!("missing turn start"))?;
        let state = start.content.unwrap_or(Value::Null);
        let model = if let Some(name) = state["model"]["name"].as_str() {
            let mut providers = api
                .capability_names("provider.")
                .iter()
                .map(|key| capability::<dyn Provider>(api.as_ref(), key))
                .collect::<Result<Vec<_>>>()?;
            providers.retain(|p| p.catalog().iter().any(|m| m.name == name));
            ensure!(providers.len() == 1, "saved model is unavailable: {name}");
            providers[0].bind(name)?
        } else {
            capability::<dyn ModelSelection>(api.as_ref(), "model.selection")?
                .select(api.clone(), &scope)
                .await?
        };
        let input = TurnInput {
            model,
            system: state["system"].as_str().unwrap_or_default().into(),
            tools: serde_json::from_value(state["tools"].clone()).unwrap_or_default(),
            settings: state.get("settings").cloned().unwrap_or(data.settings),
            cancel: api.cancellation(&scope.session)?,
            resume: serde_json::from_value(state["resume"].clone()).unwrap_or_default(),
            scope: scope.clone(),
        };
        api.emit(Event::new(&scope, "turn.resumed", json!({})))
            .await?;
        let result = self
            .run_remote(api.clone(), input, "runtime/resumeTurn")
            .await?;
        api.emit(Event::new(&scope, "turn.result", json!(result)))
            .await
    }
    async fn tool(&self, api: Api, scope: Scope, call: ToolCall) -> Result<ToolResult> {
        let ui = self
            .ui_runtime
            .clone()
            .or_else(|| capability::<dyn Runtime>(api.as_ref(), "runtime.transient").ok())
            .ok_or_else(|| anyhow!("UI tool calls are not offered by the Runtime binding"))?;
        ui.tool(api, scope, call).await
    }
}

impl RemoteRuntime {
    async fn run_remote(&self, api: Api, input: TurnInput, method: &str) -> Result<TurnResult> {
        let scope = input.scope.clone();
        let cancel = input.cancel.clone();
        let data = api.snapshot(&scope.session)?;
        let resumed = method == "runtime/resumeTurn";
        let start = data
            .branch()
            .into_iter()
            .find(|e| e.kind == "turn.start" && e.scope.turn == scope.turn);
        let started_by = start
            .as_ref()
            .and_then(|e| e.content.as_ref())
            .and_then(|v| v.get("startedBy"))
            .cloned()
            .unwrap_or_else(|| {
                if !input.resume.is_empty() {
                    json!({"kind":"answer","id":input.resume[0].id})
                } else if let Some(job) = &scope.job {
                    json!({"kind":"job","id":job})
                } else {
                    json!({"kind":"actor","id":scope.actor})
                }
            });
        let model = input.model.info();
        let mut settings = json!({"maxSteps":input.settings["step_limit"].as_u64().unwrap_or(12),"maxOutput":input.settings["output_limit"].as_u64().unwrap_or(model.output_limit)});
        if let Some(level) = input.settings["thinking"].as_str() {
            settings["reasoning"] = json!(level);
        }
        let mut params = json!({"turn":{"sessionId":scope.session,"turnId":scope.turn,"startedBy":started_by,"model":wire::model_value(&model),"modelSupports":{"keepsState":model.keeps_state,"runsTools":model.runs_tools},"settings":settings}});
        if let Some(shape) = input.settings.get("result_shape") {
            params["turn"]["resultShape"] = shape.clone();
        }
        let work = Arc::new(TurnWork {
            input,
            resumed,
            points: self.points.clone(),
            ended: AtomicBool::new(false),
            commits: tokio::sync::Mutex::new(()),
            allowed: Mutex::default(),
            allocated: Mutex::default(),
            prepared: Mutex::default(),
            expected: Mutex::default(),
            after: Mutex::default(),
            step_refusal: Mutex::default(),
            limit: Mutex::default(),
            running_tools: Mutex::default(),
            active_step: Mutex::default(),
            retry: AtomicBool::new(false),
            replacement: Mutex::default(),
        });
        let mut rpc = Work::new(&api, &scope, method, cancel.child_token());
        Arc::get_mut(&mut rpc).unwrap().runtime = Some(work.clone());
        let callback_cancel = rpc.cancel.clone();
        if resumed {
            work.close_unmatched(&api, &scope, true)?;
            // A response may have committed just before its derived call entries.
            work.materialize_calls(&api, &scope).await?;
            let data = api.snapshot(&scope.session)?;
            let branch = data.branch();
            let calls = work.unsettled(&data)?;
            let env: Arc<dyn WorkingEnvironment> = capability(api.as_ref(), "environment")?;
            let calls: Vec<Value> = calls
                .into_iter()
                .map(|(entry, call)| {
                    let started = branch
                        .iter()
                        .rev()
                        .find(|e| e.kind == "tool.started" && e.scope.call == entry.scope.call);
                    let registration = work.registration(&api, &entry.scope, &call.name)?;
                    let safe = started.and_then(|e| e.content.as_ref()).is_some_and(|v| {
                        v["safeToRepeat"] == true
                            && registration.as_ref().is_some_and(|(source, d)| {
                                d.safe_to_repeat
                                    && same_json(&v["source"], source)
                                    && same_json(&v["definition"], &wire::registered_definition(d))
                            })
                    }) && env.declaration()["stops_commands_after_sigkill"] == true;
                    let mut c = wire::call(&call, &entry.scope);
                    c["started"] = json!(started.is_some());
                    c["safeToRepeat"] = json!(safe);
                    Ok(c)
                })
                .collect::<Result<_>>()?;
            let durable = self.registration["supports"]["continuesAfterRestart"] == true;
            let mut recoverable = Vec::new();
            for call in calls {
                let (call_scope, entry, original) =
                    work.call_scope(&api, scope.clone(), wire::string(&call, "id")?)?;
                if committed_pending(&data, scope.turn.as_deref(), entry.scope.call.as_deref()) {
                    continue;
                }
                let offered = work.input.resume.iter().any(|c| c.id == original.id)
                    || branch.iter().any(|e| {
                        e.kind == "model.request"
                            && e.scope.turn == entry.scope.turn
                            && e.scope.step == entry.scope.step
                            && e.content
                                .as_ref()
                                .and_then(|v| v["tools"].as_array())
                                .is_some_and(|tools| {
                                    tools.iter().any(|name| name == &original.name)
                                })
                    });
                let eligible = offered
                    && work_authority(api.as_ref(), &call_scope)?.has("tools")
                    && work
                        .registration(&api, &call_scope, &original.name)?
                        .is_some()
                    && !cancel.is_cancelled();
                let expired = expired_leave_open(&branch, &call_scope);
                if expired {
                    requests(api.as_ref())?.close_turn_with_reason(
                        api.as_ref(),
                        &call_scope,
                        "noLongerAnswerable",
                    )?;
                }
                if !durable
                    || expired
                    || !eligible
                    || (call["started"] == true && call["safeToRepeat"] != true)
                {
                    let (status, message) = if call["started"] == true {
                        (
                            ToolStatus::Unknown,
                            "The interrupted call may have run. Check outside state before relying on it.",
                        )
                    } else {
                        (
                            ToolStatus::NotStarted,
                            "The interrupted call did not start.",
                        )
                    };
                    work.settle_tool(
                        &api,
                        &call_scope,
                        &entry,
                        ToolResult::new(&original, status, message),
                    )
                    .await?;
                } else {
                    recoverable.push(call);
                }
            }
            params["interrupted"] = json!({"turnId":scope.turn,"calls":recoverable});
            let restored = work.last_step(&api, &scope);
            match restored {
                Ok(Some(step)) => {
                    let id = wire::string(&step, "stepId")?.to_owned();
                    *work.active_step.lock().unwrap() = Some(id.clone());
                    if let Some(decision) = step.get("decision") {
                        work.after.lock().unwrap().insert(id);
                        *work.step_refusal.lock().unwrap() =
                            decision["refuse"].as_str().map(str::to_owned);
                    }
                    params["interrupted"]["lastStep"] = step;
                }
                Ok(None) => {}
                Err(error) => {
                    let mut result = failed(error);
                    work.finish(&api, &scope, &mut result).await?;
                    return Ok(result);
                }
            }
        } else if method == "runtime/continueOpenCalls" {
            let branch = data.branch();
            params["calls"] = json!(
                work.input
                    .resume
                    .iter()
                    .map(|c| {
                        let cs = branch
                            .iter()
                            .find(|e| {
                                e.kind == "tool.call" && e.scope.call.as_deref() == Some(&c.id)
                            })
                            .map(|e| &e.scope)
                            .unwrap_or(&scope);
                        let mut call = wire::call(c, cs);
                        call["started"] = json!(
                            branch
                                .iter()
                                .any(|e| e.kind == "tool.started" && e.scope.call == cs.call)
                        );
                        call["safeToRepeat"] = json!(false);
                        call
                    })
                    .collect::<Vec<_>>()
            );
        }
        let reply = match &self.execution {
            Execution::Remote(peer) => peer.call(method, params, Some(rpc), cancel.clone()).await,
            Execution::Local(handler) => {
                let cx = crate::RuntimeContext::local(work.clone(), rpc);
                let _settled = cx.settled.clone().drop_guard();
                handler.run(method, params, cx).await
            }
        };
        callback_cancel.cancel();
        work.ended.store(true, Ordering::Release);
        let _commits = work.commits.lock().await;
        let mut result = match reply {
            Ok(v) => work
                .outcome(&api, &v, cancel.is_cancelled())
                .unwrap_or_else(failed),
            Err(e) if cancel.is_cancelled() || e.code == "cancelled" => TurnResult {
                outcome: Outcome::Cancelled,
                ..TurnResult::default()
            },
            Err(e) => {
                let mut result = failed(e);
                work.effective_outcome(&mut result, cancel.is_cancelled());
                result
            }
        };
        if let Some(end) = api
            .snapshot(&scope.session)?
            .branch()
            .iter()
            .rev()
            .find(|e| e.scope.turn == scope.turn && e.kind == "turn.end")
        {
            result = serde_json::from_value(end.content.clone().unwrap_or(Value::Null))?;
        } else {
            work.close_unmatched(&api, &scope, false)?;
            settle_cancelled_failure(&mut result, cancel.is_cancelled());
            work.finish(&api, &scope, &mut result).await?;
        }
        if (result.outcome == Outcome::Cancelled
            || (resumed && self.registration["supports"]["continuesAfterRestart"] != true))
            && let Ok(requests) = requests(api.as_ref())
        {
            requests.close_turn_with_reason(
                api.as_ref(),
                &scope,
                if result.outcome == Outcome::Cancelled {
                    "cancelled"
                } else {
                    "noLongerAnswerable"
                },
            )?;
        }
        Ok(result)
    }
}
fn settle_cancelled_failure(result: &mut TurnResult, cancelled: bool) {
    // A Runtime can see a cancelled callback as an error before it handles
    // the turn's own cancel notification. The host already knows why it stopped.
    if cancelled {
        result.outcome = Outcome::Cancelled;
        result.error = None;
        result.limit = None;
        result.open_calls.clear();
    }
}

fn failed(e: impl ToString) -> TurnResult {
    TurnResult {
        outcome: Outcome::Failed,
        error: Some(e.to_string()),
        ..TurnResult::default()
    }
}

impl TurnWork {
    pub(crate) fn active(&self) -> Result<()> {
        ensure!(!self.ended.load(Ordering::Acquire), "turn has ended");
        Ok(())
    }
    fn scope(&self, work: &Work, p: &Value) -> Scope {
        Scope {
            step: p["stepId"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| self.active_step.lock().unwrap().clone()),
            ..work.scope.clone()
        }
    }
    fn call_scope(
        &self,
        api: &Api,
        mut scope: Scope,
        id: &str,
    ) -> Result<(Scope, Entry, ToolCall)> {
        let data = api.snapshot(&scope.session)?;
        let entry = data
            .branch()
            .into_iter()
            .find(|e| {
                e.kind == "tool.call"
                    && e.scope.call.as_deref() == Some(id)
                    && (e.scope.turn == scope.turn || self.input.resume.iter().any(|c| c.id == id))
            })
            .ok_or_else(|| anyhow!("call does not belong to this turn"))?;
        scope.call = Some(id.into());
        scope.step = entry.scope.step.clone().or(scope.step);
        let call = serde_json::from_value(entry.content.clone().unwrap_or(Value::Null))?;
        Ok((scope, entry, call))
    }
    fn definition(&self, api: &Api, scope: &Scope, name: &str) -> Result<Option<ToolDefinition>> {
        Ok(self
            .registration(api, scope, name)?
            .map(|(_, definition)| definition))
    }
    fn registration(
        &self,
        api: &Api,
        scope: &Scope,
        name: &str,
    ) -> Result<Option<(Value, ToolDefinition)>> {
        let data = api.snapshot(&scope.session)?;
        for cap in api.capability_names("tools.") {
            if let Some(def) = capability::<dyn ToolSource>(api.as_ref(), &cap)?
                .tools(&data)
                .into_iter()
                .find(|d| d.name == name && d.allows("model"))
            {
                return Ok(Some((api.tool_registration(&cap), def)));
            }
        }
        Ok(None)
    }
    fn unsettled(&self, data: &SessionData) -> Result<Vec<(Entry, ToolCall)>> {
        let branch = data.branch();
        branch
            .iter()
            .filter(|e| {
                e.kind == "tool.call"
                    && (e.scope.turn == self.input.scope.turn
                        || self
                            .input
                            .resume
                            .iter()
                            .any(|c| e.scope.call.as_ref() == Some(&c.id)))
                    && !data
                        .entries
                        .iter()
                        .any(|r| r.kind == "tool.result" && r.scope.call == e.scope.call)
            })
            .map(|e| {
                Ok((
                    e.clone(),
                    serde_json::from_value(e.content.clone().unwrap_or(Value::Null))?,
                ))
            })
            .collect()
    }
    async fn materialize_calls(&self, api: &Api, scope: &Scope) -> Result<()> {
        let data = api.snapshot(&scope.session)?;
        for e in data
            .branch()
            .iter()
            .filter(|e| e.kind == "model.response" && e.scope.turn == scope.turn)
        {
            let response: ModelResponse =
                serde_json::from_value(e.content.clone().unwrap_or(Value::Null))?;
            if !matches!(response.stop.as_str(), "tools" | "finished") {
                continue;
            }
            for call in response.tool_calls() {
                if let Some(prior) = api.snapshot(&scope.session)?.entries.iter().find(|prior| {
                    prior.kind == "tool.call" && prior.scope.call.as_ref() == Some(&call.id)
                }) {
                    ensure!(
                        prior.copies.contains(&e.id)
                            || (prior.scope.turn == e.scope.turn
                                && prior.scope.step == e.scope.step),
                        "duplicate tool call id"
                    );
                    continue;
                }
                let sc = Scope {
                    call: Some(call.id.clone()),
                    ..e.scope.clone()
                };
                api.append(
                    &sc,
                    "external.runtime",
                    Draft::new("tool.call", false, json!(call)).copying(vec![e.id.clone()]),
                )?;
                api.emit(Event::new(&sc, "tool.requested", json!(call)))
                    .await?;
            }
        }
        Ok(())
    }
    fn sources(&self, api: &Api, scope: &Scope, all_turn: bool) -> Result<Vec<String>> {
        Ok(api
            .snapshot(&scope.session)?
            .branch()
            .iter()
            .filter(|e| e.visible || (all_turn && e.scope.turn == scope.turn))
            .map(|e| e.id.clone())
            .collect())
    }
    async fn prepare(
        &self,
        api: &Api,
        scope: &Scope,
        usage: &Value,
        token: CancellationToken,
    ) -> Result<Value> {
        self.check_budget(api, scope)?;
        let step = scope
            .step
            .as_ref()
            .ok_or_else(|| anyhow!("missing stepId"))?;
        ensure!(
            self.allocated.lock().unwrap().contains(step)
                && !self.prepared.lock().unwrap().contains_key(step),
            "step id was not allocated or was already prepared"
        );
        self.check_step_boundary()?;
        self.close_unmatched(api, scope, false)?;
        let data = api.snapshot(&scope.session)?;
        let (_, counted) = self.account(&data)?;
        ensure!(
            same_json(&json!(counted), &json!(wire::parse_usage(usage))),
            "usage differs from committed responses"
        );
        refresh_tool_sources(api, scope).await?;
        self.input.model.refresh(api, scope, token.clone()).await?;
        let info = self.input.model.info();
        let request = ModelRequest {
            session: scope.session.clone(),
            system: self.input.system.clone(),
            messages: model_messages(&data.branch(), scope.turn.as_deref())?,
            tools: current_model_tools(api, scope, &self.input.tools)?,
            provider_tools: if work_authority(api.as_ref(), scope)?.has("tools") {
                self.input.model.provider_tools()
            } else {
                vec![]
            },
            thinking: wire::lower_reasoning(
                self.input.settings["thinking"].as_str().unwrap_or(""),
                &info.thinking,
            )
            .into(),
            extra: Value::Null,
            output_limit: self.input.settings["output_limit"]
                .as_u64()
                .unwrap_or(info.output_limit)
                .min(info.output_limit),
        };
        let value = api
            .invoke(
                &self.points["runtime.before.step"],
                scope,
                json!({"request":request,"limits":info,"usage":wire::parse_usage(usage)}),
            )
            .await?
            .value;
        let request: ModelRequest = serde_json::from_value(value["request"].clone())?;
        let projected = wire::request(&request, Some(&api.snapshot(&scope.session)?));
        ensure!(!token.is_cancelled(), "cancelled");
        self.prepared.lock().unwrap().insert(
            step.clone(),
            PreparedStep {
                wire: projected.clone(),
                provider_tools: request.provider_tools,
            },
        );
        *self.active_step.lock().unwrap() = scope.step.clone();
        api.emit(Event::new(scope, "step.start", json!({}))).await?;
        Ok(projected)
    }
    async fn model(
        &self,
        api: &Api,
        scope: &Scope,
        request_wire: &Value,
        token: CancellationToken,
        peer: Option<Arc<Peer>>,
        callback: Value,
    ) -> Result<Value> {
        let model = &self.input.model;
        self.check_budget(api, scope)?;
        let step = scope
            .step
            .as_ref()
            .ok_or_else(|| anyhow!("missing stepId"))?;
        ensure!(
            self.allocated.lock().unwrap().remove(step),
            "step id was not allocated or was already used"
        );
        let prepared = self.prepared.lock().unwrap().remove(step);
        let replacement = self.replacement.lock().unwrap().take();
        let matched = prepared
            .as_ref()
            .filter(|step| same_json(&step.wire, request_wire));
        let replay = if matched.is_some()
            || replacement
                .as_ref()
                .is_some_and(|v| same_json(v, request_wire))
        {
            if prepared.is_none() {
                self.check_step_boundary()?;
            }
            None
        } else {
            self.check_step_boundary()?;
            let pending = self.unmatched(api, scope)?;
            Some(
                pending
                    .last()
                    .filter(|e| {
                        self.replayable(e)
                            && e.content
                                .as_ref()
                                .is_some_and(|v| same_json(&v["request"], request_wire))
                    })
                    .cloned()
                    .ok_or_else(|| {
                        anyhow!("model request does not match preparation or authorized replay")
                    })?,
            )
        };
        let mut request = wire::parse_request(request_wire, &scope.session)?;
        if self.retry.swap(false, Ordering::AcqRel) {
            model.discard(&scope.session).await?;
        }
        if replay.is_none() {
            let prepared = api
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
            request = serde_json::from_value(prepared)?;
            if let Some(step) = matched {
                request.provider_tools.clone_from(&step.provider_tools);
            }
        }
        let branch = api.snapshot(&scope.session)?.branch();
        let sources = if let Some(old) = &replay {
            old.copies.clone()
        } else {
            branch
                .iter()
                .filter(|e| e.visible && e.kind != "resultFeedback")
                .chain(pending_result_feedback(&branch, scope.turn.as_deref()))
                .map(|e| e.id.clone())
                .collect()
        };
        let step_started = self.active_step.lock().unwrap().as_deref() == Some(step);
        *self.active_step.lock().unwrap() = scope.step.clone();
        if !step_started {
            api.emit(Event::new(scope, "step.start", json!({}))).await?;
        }
        let relay: Api = if let Some(peer) = peer {
            Arc::new(Relay {
                inner: api.clone(),
                peer,
                id: callback,
                route: Route::RuntimeModel,
            })
        } else {
            api.clone()
        };
        let result = model
            .generate_attempt(
                relay,
                scope.clone(),
                request,
                token.clone(),
                ModelAttempt {
                    writer: "external.runtime",
                    tools: current_model_tools(api, scope, &self.input.tools)?,
                    sources,
                    auxiliary: false,
                    safe_to_repeat: model.safe_to_repeat(),
                    close_attempt: replay.clone(),
                    replay: replay.map(|_| request_wire.clone()),
                    authorized_wire: None,
                },
            )
            .await;
        let answer = match result {
            Ok(mut response) => {
                let data = api.snapshot(&scope.session)?;
                let mut names: BTreeSet<String> = data
                    .entries
                    .iter()
                    .filter_map(|e| e.scope.call.clone())
                    .collect();
                for part in &mut response.parts {
                    if let Part::ToolCall { call } = part
                        && !names.insert(call.id.clone())
                    {
                        call.id = agent_api::id();
                        names.insert(call.id.clone());
                    }
                }
                if bound_model_response(api.as_ref(), scope, &mut response)? {
                    *self.limit.lock().unwrap() = Some(("capacity".into(), false));
                }
                wire::response(&response)
            }
            Err(e) => {
                if let Some(limit) = e.downcast_ref::<ModelAttemptLimit>() {
                    return Err(self.signal_limit(limit.0).into());
                }
                if let Some(fault) = e.downcast_ref::<Fault>() {
                    if fault.code == "turn_limit" {
                        return Err(self
                            .signal_limit(fault.limit.as_deref().unwrap_or("tenantTokens"))
                            .into());
                    }
                    return Err(e);
                }
                if token.is_cancelled() {
                    bail!("cancelled");
                }
                let fail = e
                    .downcast_ref::<ModelFailure>()
                    .cloned()
                    .unwrap_or(ModelFailure {
                        kind: FailureKind::Other,
                        message: e.to_string(),
                    });
                ensure!(
                    self.unmatched(api, scope)?
                        .iter()
                        .any(|e| e.scope.step == scope.step),
                    "{}",
                    fail.message
                );
                wire::response(&wire::parse_response(
                    json!({"role":"assistant","stop":"failed",
                    "content":[],"error":wire::failure(&fail)}),
                )?)
            }
        };
        self.expected
            .lock()
            .unwrap()
            .insert(step.clone(), answer.clone());
        Ok(answer)
    }
    fn account(&self, data: &SessionData) -> Result<(usize, Usage)> {
        let branch = data.branch();
        let mut usage = Usage::default();
        let mut count = 0;
        for e in branch.iter().filter(|e| {
            e.scope.turn == self.input.scope.turn
                && e.kind == "model.request"
                && !e.content.as_ref().is_some_and(|v| v["auxiliary"] == true)
        }) {
            count += 1;
            if let Some(r) = branch.iter().find(|r| {
                r.kind == "model.response"
                    && r.scope.turn == e.scope.turn
                    && r.scope.step == e.scope.step
            }) && let Some(v) = &r.content
            {
                usage.add(&serde_json::from_value::<ModelResponse>(v.clone())?.usage);
            }
        }
        Ok((count, usage))
    }
    fn signal_limit(&self, name: &str) -> Fault {
        *self.limit.lock().unwrap() = Some((name.into(), true));
        Fault {
            limit: Some(name.into()),
            ..Fault::new("turn_limit", format!("turn limit: {name}"))
        }
    }
    fn check_budget(&self, api: &Api, scope: &Scope) -> Result<()> {
        ensure!(!self.input.cancel.is_cancelled(), "cancelled");
        let latched = self
            .limit
            .lock()
            .unwrap()
            .as_ref()
            .map(|(name, _)| name.clone());
        if let Some(name) = latched {
            return Err(self.signal_limit(&name).into());
        }
        ensure!(
            self.step_refusal.lock().unwrap().is_none(),
            "step.after refused the turn"
        );
        if api.tenant_budget_reached(&scope.session)? {
            return Err(self.signal_limit("tenantTokens").into());
        }
        let (count, _) = self.account(&api.snapshot(&scope.session)?)?;
        if count as u64 >= self.input.settings["step_limit"].as_u64().unwrap_or(12) {
            return Err(self.signal_limit("steps").into());
        }
        Ok(())
    }
    fn effective_outcome(&self, r: &mut TurnResult, cancelled: bool) {
        if cancelled {
            settle_cancelled_failure(r, true);
        } else if let Some((name, false)) = self.limit.lock().unwrap().as_ref() {
            // The binding makes the host responsible for a latched limit it
            // has not yet signalled to the Runtime.
            r.outcome = Outcome::Limit;
            r.limit = Some(name.clone());
            r.error = None;
        }
    }
    fn unmatched(&self, api: &Api, scope: &Scope) -> Result<Vec<Entry>> {
        let branch = api.snapshot(&scope.session)?.branch();
        Ok(branch
            .iter()
            .filter(|e| {
                e.kind == "model.request"
                    && e.scope.turn == scope.turn
                    && !branch.iter().any(|r| {
                        r.kind == "model.response"
                            && r.scope.turn == e.scope.turn
                            && r.scope.step == e.scope.step
                    })
            })
            .cloned()
            .collect())
    }
    fn replayable(&self, entry: &Entry) -> bool {
        self.resumed
            && self.input.model.safe_to_repeat()
            && entry.content.as_ref().is_some_and(|v| {
                v["auxiliary"] != true
                    && v["safeToRepeat"] == true
                    && v["request"].is_object()
                    && v["model"] == wire::model_request_record(&self.input.model.info())["model"]
            })
    }
    fn close_unmatched(&self, api: &Api, scope: &Scope, before_resume: bool) -> Result<()> {
        let unmatched = self.unmatched(api, scope)?;
        for entry in &unmatched {
            if !before_resume
                || !self.replayable(entry)
                || unmatched.last().map(|e| &e.id) != Some(&entry.id)
            {
                abort_attempt(api.as_ref(), "external.runtime", entry)?;
            }
        }
        Ok(())
    }
    fn last_step(&self, api: &Api, scope: &Scope) -> Result<Option<Value>> {
        let data = api.snapshot(&scope.session)?;
        let branch = data.branch();
        let mut checkpoint = branch
            .iter()
            .filter(|e| {
                e.scope.turn == scope.turn
                    && matches!(e.kind.as_str(), "model.request" | "model.response")
            })
            .map(|e| wire::entry(e, &data))
            .collect::<Result<Vec<_>>>()?;
        for decision in data
            .entries
            .iter()
            .filter(|e| e.scope.turn == scope.turn && e.kind == recovery::STEP_AFTER)
        {
            checkpoint.push(wire::entry(decision, &data)?);
        }
        recovery::last_answered_step(&checkpoint).map(|step| step.map(|(_, step)| step))
    }

    fn check_step_boundary(&self) -> Result<()> {
        let active = self.active_step.lock().unwrap();
        ensure!(
            active
                .as_ref()
                .is_none_or(|step| self.after.lock().unwrap().contains(step)),
            "previous step has not reached step.after"
        );
        Ok(())
    }
    fn refusal_status(&self, data: &SessionData, scope: &Scope) -> ToolStatus {
        if self.resumed
            && data
                .entries
                .iter()
                .any(|entry| entry.kind == "tool.started" && entry.scope.call == scope.call)
        {
            ToolStatus::Unknown
        } else {
            ToolStatus::Refused
        }
    }

    async fn settle_tool(
        &self,
        api: &Api,
        scope: &Scope,
        source: &Entry,
        result: ToolResult,
    ) -> Result<ToolResult> {
        let status = result.status.clone();
        let id = result.call.clone();
        let checked = self
            .points
            .get("after.tool")
            .map(|point| api.invoke(point, scope, json!(result)));
        let result = if let Some(check) = checked {
            match check
                .await
                .and_then(|r| serde_json::from_value::<ToolResult>(r.value).map_err(Into::into))
            {
                Ok(r) if r.status == status && r.call == id => r,
                _ => result,
            }
        } else {
            result
        };
        let mut result = result;
        let mut invalid = None;
        if result.status == ToolStatus::Completed {
            let data = api.snapshot(&scope.session)?;
            if let Some(start) = data
                .entries
                .iter()
                .rev()
                .find(|entry| entry.kind == "tool.started" && entry.scope.call == scope.call)
                .and_then(|e| e.content.as_ref())
                .and_then(|e| e.get("definition"))
            {
                let definition = wire::parse_definition(start)?;
                if let Err(error) = schema::tool_result(&definition, &result) {
                    result.text =
                        "The call completed, but its result did not match its schema.".into();
                    result.value = None;
                    invalid = Some(error);
                }
            }
        }
        api.append(
            scope,
            "external.runtime",
            Draft::new("tool.result", true, json!(result)).copying(vec![source.id.clone()]),
        )?;
        api.emit(Event::new(scope, "tool.ended", json!(result)))
            .await?;
        if let Some(error) = invalid {
            return Err(error);
        }
        Ok(result)
    }
    fn record_feedback(&self, api: &Api, scope: &Scope, reason: &str) -> Result<()> {
        api.append(
            scope,
            "external.runtime",
            Draft::new("resultFeedback", true, json!({"reason":reason})),
        )?;
        Ok(())
    }

    async fn hook(
        &self,
        api: &Api,
        scope: &Scope,
        name: &str,
        p: &Value,
        cancelled: bool,
    ) -> Result<Value> {
        let value = &p["payload"];
        let mut gate_registration = None;
        let mut scope = scope.clone();
        let native = match name {
            "turn.start" => json!({}),
            "step.after" => {
                let data = api.snapshot(&scope.session)?;
                let response = data
                    .branch()
                    .into_iter()
                    .find(|e| {
                        e.kind == "model.response"
                            && e.scope.turn == scope.turn
                            && e.scope.step == scope.step
                    })
                    .ok_or_else(|| anyhow!("step.after requires a committed response"))?;
                let response_id = response.id;
                let response: ModelResponse =
                    serde_json::from_value(response.content.unwrap_or_default())?;
                ensure!(
                    same_json(&wire::response(&response), &value["response"]),
                    "step.after response differs"
                );
                let step = scope
                    .step
                    .as_ref()
                    .ok_or_else(|| anyhow!("missing step id"))?;
                if let Some(decision) = data.entries.iter().find(|e| {
                    e.kind == recovery::STEP_AFTER
                        && e.scope.turn == scope.turn
                        && e.scope.step == scope.step
                }) {
                    let decision = decision
                        .content
                        .as_ref()
                        .and_then(|c| c.get("decision"))
                        .ok_or_else(|| anyhow!("committed step.after decision is unavailable"))?;
                    let mut reply = json!({"value":value});
                    if let Some(reason) = decision["refuse"].as_str() {
                        reply["refused"] = json!(reason);
                    }
                    return Ok(reply);
                }
                ensure!(
                    self.active_step.lock().unwrap().as_ref() == Some(step),
                    "step.after is not for the active step"
                );
                ensure!(
                    self.unsettled(&data)?
                        .iter()
                        .filter(|(e, _)| e.scope.step == scope.step)
                        .all(|(e, _)| committed_pending(
                            &data,
                            scope.turn.as_deref(),
                            e.scope.call.as_deref()
                        )),
                    "tool round is not settled"
                );
                // The callback commit lock serializes the decision with retries.
                let name = if api.tenant_budget_reached(&scope.session)? {
                    Some("tenantTokens")
                } else if response.stop == "limit" {
                    Some("output")
                } else {
                    None
                };
                if let Some(name) = name {
                    self.limit
                        .lock()
                        .unwrap()
                        .get_or_insert((name.into(), false));
                }
                api.emit(Event::new(
                    &scope,
                    "step.end",
                    json!({"usage":response.usage}),
                ))
                .await?;
                let gate = api
                    .invoke(
                        &self.points["runtime.after.step"],
                        &scope,
                        json!({"response":response}),
                    )
                    .await?;
                let decision = gate
                    .refused
                    .as_ref()
                    .map(|reason| json!({"refuse":reason}))
                    .unwrap_or(Value::Null);
                api.append(
                    &scope,
                    "external.runtime",
                    Draft::new(recovery::STEP_AFTER, false, json!({"decision":decision}))
                        .copying(vec![response_id]),
                )?;
                self.after.lock().unwrap().insert(step.clone());
                let mut reply = json!({"value":value});
                if let Some(reason) = gate.refused {
                    reply["refused"] = json!(reason);
                    *self.step_refusal.lock().unwrap() = Some(reason);
                }
                return Ok(reply);
            }
            "tool.before" => {
                let call = wire::parse_call(&value["call"])?;
                let (sc, entry, original) = self.call_scope(api, scope, &call.id)?;
                scope = sc;
                ensure!(
                    call.name == original.name && call.input == original.input,
                    "call differs from recorded call"
                );
                let data = api.snapshot(&scope.session)?;
                let current = self.registration(api, &scope, &call.name)?;
                {
                    let mut allowed = self.allowed.lock().unwrap();
                    if allowed
                        .get(&call.id)
                        .is_some_and(|decision| !matches_registration(decision, current.as_ref()))
                    {
                        allowed.remove(&call.id);
                    }
                }
                ensure!(
                    !self.allowed.lock().unwrap().contains_key(&call.id)
                        && !committed_pending(&data, scope.turn.as_deref(), Some(&call.id))
                        && !self.running_tools.lock().unwrap().contains(&call.id)
                        && !data
                            .entries
                            .iter()
                            .any(|e| e.kind == "tool.result" && e.scope.call == scope.call),
                    "call is not unstarted"
                );
                let offered = self.input.resume.iter().any(|c| c.id == call.id)
                    || data
                        .entries
                        .iter()
                        .find(|e| {
                            e.kind == "model.request"
                                && e.scope.turn == scope.turn
                                && e.scope.step == scope.step
                        })
                        .and_then(|e| e.content.as_ref()?.get("tools"))
                        .and_then(Value::as_array)
                        .is_some_and(|tools| tools.iter().any(|tool| tool == &call.name));
                if !offered
                    || current.is_none()
                    || !work_authority(api.as_ref(), &scope)?.has("tools")
                {
                    let reason = if !work_authority(api.as_ref(), &scope)?.has("tools") {
                        "actor lacks tools authority"
                    } else if !offered {
                        "not offered"
                    } else {
                        "tool registration is unavailable"
                    };
                    let result = self
                        .settle_tool(
                            api,
                            &scope,
                            &entry,
                            ToolResult::new(&call, self.refusal_status(&data, &scope), reason),
                        )
                        .await?;
                    return Ok(
                        json!({"value":value,"refused":reason,"result":wire::result(&result)}),
                    );
                }
                let (source, definition) = current.unwrap();
                let payload = json!({"call":original,"definition":definition});
                gate_registration = Some((source, definition));
                payload
            }
            "tool.after" => {
                let id = value["call"]["id"]
                    .as_str()
                    .or_else(|| value["result"]["callId"].as_str())
                    .ok_or_else(|| anyhow!("missing call id"))?;
                scope = self.call_scope(api, scope, id)?.0;
                let data = api.snapshot(&scope.session)?;
                let entry = data
                    .entries
                    .iter()
                    .find(|e| e.kind == "tool.result" && e.scope.call == scope.call)
                    .ok_or_else(|| anyhow!("no committed result"))?;
                let r: ToolResult =
                    serde_json::from_value(entry.content.clone().unwrap_or_default())?;
                let result = wire::result(&r);
                ensure!(
                    same_json(&result, &value["result"])
                        || (result["status"] == "refused"
                            && result["callId"] == value["result"]["callId"]
                            && value["result"]["status"] == "refused"),
                    "tool.after result differs from committed result"
                );
                return Ok(json!({"call":value["call"],"result":result}));
            }
            "model.failed" => {
                json!({"failure":wire::parse_failure(&value["error"]),"attempt":0,"request":wire::parse_request(&value["request"],&scope.session)?})
            }
            "turn.result" => {
                self.check_step_boundary()?;
                let mut payload = json!({"text":value["result"]["text"]});
                if let Some(shape) = self.input.settings.get("result_shape") {
                    payload["shape"] = shape.clone();
                    if let Err(error) = schema::check(shape, value["result"].get("value")) {
                        let reason =
                            format!("The result shape does not accept this value: {error}");
                        self.record_feedback(api, &scope, &reason)?;
                        return Ok(json!({"value":value,"refused":reason}));
                    }
                }
                if let Some(value) = value["result"].get("value") {
                    payload["value"] = value.clone();
                }
                payload
            }
            "turn.end" => {
                json!(self.outcome(api, value, cancelled)?)
            }
            _ => bail!("hook is not owned by the Runtime"),
        };
        let key = crate::host::hook_name(name).unwrap();
        let r = api.invoke(&self.points[key], &scope, native).await?;
        if name == "turn.end" {
            self.ended.store(true, Ordering::Release);
        }
        match name {
            "turn.start" | "turn.end" => Ok(Value::Null),
            "tool.after" => Ok(
                json!({"call":value["call"],"result":wire::result(&serde_json::from_value(r.value)?)}),
            ),
            "model.failed" => {
                let mut v = r.value;
                if v["retry"] == true {
                    self.retry.store(true, Ordering::Release);
                }
                if v["retry"] == true && v["request"].is_object() {
                    v["request"] = wire::request(
                        &serde_json::from_value(v["request"].clone())?,
                        Some(&api.snapshot(&scope.session)?),
                    );
                    *self.replacement.lock().unwrap() = Some(v["request"].clone());
                }
                Ok(v)
            }
            _ => {
                let mut result = json!({"value":value});
                if let Some(reason) = r
                    .refused
                    .or_else(|| r.value["retry_reason"].as_str().map(str::to_owned))
                {
                    if name == "tool.before" {
                        let (_, entry, original) = self.call_scope(
                            api,
                            scope.clone(),
                            value["call"]["id"].as_str().unwrap_or_default(),
                        )?;
                        let data = api.snapshot(&scope.session)?;
                        let settled = self
                            .settle_tool(
                                api,
                                &scope,
                                &entry,
                                ToolResult::new(
                                    &original,
                                    self.refusal_status(&data, &scope),
                                    &reason,
                                ),
                            )
                            .await?;
                        result["result"] = wire::result(&settled);
                    }
                    if name == "turn.result" {
                        self.record_feedback(api, &scope, &reason)?;
                    }
                    result["refused"] = json!(reason);
                } else if r.suspended {
                    ensure!(
                        name == "tool.before",
                        "only tool.before can leave a call open"
                    );
                    self.record_pending(api, &scope, None)?;
                    result["pending"] = json!("waiting for answer");
                } else if name == "tool.before" {
                    let call: ToolCall = serde_json::from_value(r.value["call"].clone())?;
                    ensure!(
                        scope.call.as_ref() == Some(&call.id) && value["call"]["name"] == call.name,
                        "tool hook changed call identity"
                    );
                    let (source, definition) = gate_registration.unwrap();
                    if !cancelled {
                        self.allowed.lock().unwrap().insert(
                            call.id.clone(),
                            Allowance {
                                input: call.input.clone(),
                                source,
                                definition,
                            },
                        );
                    }
                    result["value"]["call"] = wire::call(&call, &scope);
                }
                Ok(result)
            }
        }
    }
    async fn tool(
        &self,
        api: &Api,
        scope: Scope,
        p: &Value,
        token: CancellationToken,
    ) -> Result<Value> {
        let commit = self.commits.lock().await;
        self.active()?;
        let mut call = wire::parse_call(&p["call"])?;
        let (scope, entry, original) = self.call_scope(api, scope, &call.id)?;
        call.started_by = original.started_by.clone();
        let data = api.snapshot(&scope.session)?;
        ensure!(
            !data
                .entries
                .iter()
                .any(|e| e.scope.call == scope.call && e.kind == "tool.result"),
            "call already settled"
        );
        ensure!(!token.is_cancelled(), "cancelled");
        let decision = self
            .allowed
            .lock()
            .unwrap()
            .remove(&call.id)
            .ok_or_else(|| anyhow!("call was not allowed by tool.before"))?;
        if original.name != call.name || !same_json(&decision.input, &call.input) {
            let result = self
                .settle_tool(
                    api,
                    &scope,
                    &entry,
                    ToolResult::new(
                        &original,
                        ToolStatus::Refused,
                        "call differs from its allowance",
                    ),
                )
                .await?;
            return Ok(wire::result(&result));
        }
        let current = self.registration(api, &scope, &call.name)?;
        if !matches_registration(&decision, current.as_ref()) {
            return Err(Fault::new(
                "invalid_request",
                "registration changed; obtain a fresh tool.before allowance",
            )
            .into());
        }
        if !work_authority(api.as_ref(), &scope)?.has("tools") {
            let result = self
                .settle_tool(
                    api,
                    &scope,
                    &entry,
                    ToolResult::new(
                        &original,
                        ToolStatus::Refused,
                        "actor lacks tools authority",
                    ),
                )
                .await?;
            return Ok(wire::result(&result));
        }
        let (registration, definition) = current.unwrap();
        if let Some(previous) = data.entries.iter().rev().find(|e| {
            e.kind == "tool.started" && e.scope.call == scope.call && e.scope.turn == scope.turn
        }) {
            let safe = previous.content.as_ref().is_some_and(|entry| {
                entry["safeToRepeat"] == true
                    && same_json(&entry["call"]["input"], &call.input)
                    && same_json(&entry["source"], &registration)
                    && same_json(
                        &entry["definition"],
                        &wire::registered_definition(&definition),
                    )
            }) && definition.safe_to_repeat
                && capability::<dyn WorkingEnvironment>(api.as_ref(), "environment")?.declaration()
                    ["stops_commands_after_sigkill"]
                    == true;
            if !self.resumed || !safe {
                let result = self.settle_tool(api, &scope, &entry, ToolResult::new(&original, ToolStatus::Unknown,
                    "The interrupted call could not be repeated with the recorded input and registration.")).await?;
                return Ok(wire::result(&result));
            }
        }
        let allowed = Allowance {
            source: registration.clone(),
            definition: definition.clone(),
            input: call.input.clone(),
        };
        api.check_writer(&scope.session)?;
        ensure!(
            self.running_tools.lock().unwrap().insert(call.id.clone()),
            "call already ran for this request"
        );
        let start = api.append(
            &scope,
            "external.runtime",
            Draft::new("tool.started", false, json!({"call":call,"source":registration,
                "definition":wire::registered_definition(&definition),"openWorld":definition.open_world(),
                "safeToRepeat":definition.safe_to_repeat && capability::<dyn WorkingEnvironment>(api.as_ref(),"environment")?.declaration()["stops_commands_after_sigkill"]==true})).copying(vec![entry.id.clone()]),
        )?;
        drop(commit);
        api.emit(Event::new(&scope, "tool.started", json!(call)))
            .await?;
        let r = if token.is_cancelled() {
            ToolResult::new(&call, ToolStatus::Cancelled, "turn cancelled")
        } else if !matches_registration(
            &allowed,
            self.registration(api, &scope, &call.name)?.as_ref(),
        ) || !work_authority(api.as_ref(), &scope)?.has("tools")
        {
            ToolResult::new(
                &call,
                ToolStatus::Refused,
                "registration or authority changed before dispatch",
            )
        } else {
            api.check_writer(&scope.session)?;
            api.dispatch_tool(&scope, call, token).await
        };
        let _commit = self.commits.lock().await;
        if r.status == ToolStatus::Waiting {
            self.active()?;
            self.record_pending(api, &scope, Some(&start.id))?;
            self.running_tools.lock().unwrap().remove(&r.call);
            Ok(json!({"callId":r.call,"pending":r.text}))
        } else {
            let r = self.settle_tool(api, &scope, &entry, r).await?;
            Ok(wire::result(&r))
        }
    }
    fn record_pending(&self, api: &Api, scope: &Scope, start: Option<&str>) -> Result<()> {
        let data = api.snapshot(&scope.session)?;
        let branch = data.branch();
        let requests: Vec<_> = branch
            .iter()
            .filter(|e| {
                e.kind == "request.open" && e.scope.turn == scope.turn && e.scope.call == scope.call
            })
            .filter_map(|e| e.content.as_ref())
            .filter(|q| {
                q["kind"] != "approval"
                    && branch.iter().any(|e| {
                        e.kind == "request.suspended"
                            && e.scope.turn == scope.turn
                            && e.scope.call == scope.call
                            && e.content.as_ref().is_some_and(|v| v["request"] == q["id"])
                    })
            })
            .filter_map(|q| q["id"].as_str())
            .collect();
        ensure!(
            !requests.is_empty(),
            "pending call has no committed leaveOpen expiry"
        );
        let mut pending = json!({"requestIds":requests});
        if let Some(start) = start {
            pending["toolStartedId"] = json!(start);
        }
        api.append(
            scope,
            "external.runtime",
            Draft::new("tool.pending", false, pending),
        )?;
        Ok(())
    }
    async fn record(&self, api: &Api, work: &Work, mut scope: Scope, v: &Value) -> Result<Value> {
        let _commit = self.commits.lock().await;
        self.active()?;
        ensure!(v.is_object(), "entry must be an object");
        let kind = wire::string(v, "kind")?;
        let mut visible = false;
        let mut sources = vec![];
        let (native, content) = match kind {
            "response" => {
                let step = scope
                    .step
                    .as_ref()
                    .ok_or_else(|| anyhow!("response requires stepId"))?;
                ensure!(
                    self.expected
                        .lock()
                        .unwrap()
                        .get(step)
                        .is_some_and(|m| same_json(m, &v["message"])),
                    "response differs from the model answer"
                );
                let response = wire::parse_response(v["message"].clone())?;
                let data = api.snapshot(&scope.session)?;
                let branch = data.branch();
                if let Some(old) = branch.iter().find(|e| {
                    e.kind == "model.response"
                        && e.scope.turn == scope.turn
                        && e.scope.step == scope.step
                }) {
                    return wire::entry(old, &data);
                }
                let intent = branch
                    .iter()
                    .find(|e| {
                        e.kind == "model.request"
                            && e.scope.turn == scope.turn
                            && e.scope.step == scope.step
                    })
                    .ok_or_else(|| anyhow!("response has no committed intent"))?;
                visible = !matches!(response.stop.as_str(), "failed" | "aborted")
                    || !response.parts.is_empty();
                let mut ids: BTreeSet<_> = data
                    .entries
                    .iter()
                    .filter(|e| e.kind == "tool.call")
                    .filter_map(|e| e.scope.call.as_deref())
                    .collect();
                let calls = response.tool_calls();
                ensure!(
                    calls.iter().all(|c| ids.insert(&c.id)),
                    "duplicate tool call id"
                );
                sources.push(intent.id.clone());
                ("model.response", json!(response))
            }
            "toolResult" => {
                let id = wire::string(v, "toolCallId")?;
                scope = self.call_scope(api, scope, id)?.0;
                ensure!(
                    v["data"]["status"] != "notStarted",
                    "notStarted is host-owned"
                );
                let data = api.snapshot(&scope.session)?;
                let committed = data
                    .entries
                    .iter()
                    .find(|e| e.kind == "tool.result" && e.scope.call == scope.call)
                    .ok_or_else(|| anyhow!("no matching committed result"))?;
                let wire_entry = wire::entry(committed, &data)?;
                ensure!(
                    same_json(&wire_entry["message"], &v["message"])
                        && same_json(&wire_entry["data"], &v["data"]),
                    "result differs from committed result"
                );
                return Ok(wire_entry);
            }
            // Don't interpret a plugin's private kinds as trusted Harness entries.
            _ => {
                ensure!(
                    kind.contains('.')
                        && !matches!(kind, telemetry::TURN_TRACE | "modular-agent.disclosure"),
                    "record kind is host-owned"
                );
                if let Some(id) = v["toolCallId"].as_str() {
                    let (sc, call, _) = self.call_scope(api, scope, id)?;
                    scope = sc;
                    sources.push(call.id);
                }
                ("runtime.private", v.clone())
            }
        };
        if native == "runtime.private" && sources.is_empty() {
            sources = self.sources(api, &scope, false)?;
        }
        let data = api.snapshot(&scope.session)?;
        for id in v["sources"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            ensure!(
                data.entries.iter().any(|e| e.id == id),
                "unknown source entry"
            );
            sources.push(id.to_owned());
        }
        sources.sort();
        sources.dedup();
        let record = api.append(
            &scope,
            "external.runtime",
            Draft::new(native, visible && native != "runtime.private", content).copying(sources),
        )?;
        if kind == "response" {
            self.materialize_calls(api, &work.scope).await?;
        }
        wire::entry(&record, &api.snapshot(&scope.session)?)
    }
    fn outcome(&self, api: &Api, v: &Value, cancelled: bool) -> Result<TurnResult> {
        let mut r = wire::parse_outcome(&v["outcome"], &v["result"], &v["usage"])?;
        let data = api.snapshot(&self.input.scope.session)?;
        let (steps, usage) = self.account(&data)?;
        r.steps = steps;
        ensure!(
            cancelled || v["usage"].is_null() || same_json(&json!(r.usage), &json!(usage)),
            "outcome usage differs from committed responses"
        );
        r.usage = usage;
        if !cancelled {
            let open: Vec<_> = self
                .unsettled(&data)?
                .into_iter()
                .filter_map(|(_, call)| {
                    committed_pending(&data, self.input.scope.turn.as_deref(), Some(&call.id))
                        .then_some(call)
                })
                .collect();
            let ids = v["result"]["openToolCalls"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default();
            if !ids.is_empty() || matches!(r.outcome, Outcome::Completed | Outcome::Limit) {
                ensure!(
                    ids.iter()
                        .map(Value::as_str)
                        .eq(open.iter().map(|call| Some(call.id.as_str()))),
                    "openToolCalls differs from committed pending calls"
                );
                r.open_calls = open;
            }
            ensure!(
                r.outcome != Outcome::Cancelled || r.open_calls.is_empty(),
                "a cancelled turn cannot leave calls open"
            );
            let limit = self.limit.lock().unwrap();
            let matches_limit = r.outcome == Outcome::Limit
                && limit
                    .as_ref()
                    .is_some_and(|(name, _)| r.limit.as_ref() == Some(name));
            if limit.as_ref().is_some_and(|(_, signalled)| *signalled) {
                ensure!(matches_limit, "outcome disagrees with the signalled limit");
            }
            if r.outcome == Outcome::Limit && !r.open_calls.is_empty() {
                ensure!(matches_limit, "leaving calls open is not a turn limit");
            }
            if limit.is_none() && self.step_refusal.lock().unwrap().is_some() {
                ensure!(
                    r.outcome == Outcome::Failed,
                    "outcome disagrees with step.after refusal"
                );
            }
            if r.outcome == Outcome::Completed
                || (r.outcome == Outcome::Limit && !r.open_calls.is_empty())
            {
                self.check_step_boundary()?;
            }
        }
        self.effective_outcome(&mut r, cancelled);
        Ok(r)
    }
    async fn finish(&self, api: &Api, scope: &Scope, r: &mut TurnResult) -> Result<Entry> {
        let data = api.snapshot(&scope.session)?;
        for (call_entry, call) in self.unsettled(&data)? {
            if r.open_calls.iter().any(|c| c.id == call.id) {
                continue;
            }
            let sc = Scope {
                call: call_entry.scope.call.clone(),
                step: call_entry.scope.step.clone(),
                ..scope.clone()
            };
            let branch = data.branch();
            let done = branch.iter().rev().find(|e| {
                e.kind == "runtime.private"
                    && e.scope.call == sc.call
                    && e.content
                        .as_ref()
                        .is_some_and(|v| v["kind"] == "runtime.toolCompleted")
            });
            let started = branch
                .iter()
                .any(|e| e.kind == "tool.started" && e.scope.call == sc.call);
            let cancelled = r.outcome == Outcome::Cancelled;
            let status = if started && (self.resumed || !cancelled) {
                ToolStatus::Unknown
            } else if cancelled {
                ToolStatus::Cancelled
            } else {
                ToolStatus::NotStarted
            };
            let result = if let Some(e) = done {
                wire::parse_result(e.content.as_ref().unwrap()["data"].clone(), &call.id)?
            } else {
                ToolResult::new(
                    &call,
                    status,
                    "Interrupted: this call did not finish. Check outside state before relying on it.",
                )
            };
            api.append(
                &sc,
                "external.runtime",
                Draft::new("tool.result", true, json!(result)).copying(vec![call_entry.id]),
            )?;
            api.emit(Event::new(&sc, "tool.ended", json!(result)))
                .await?;
        }
        let entry = api.append(
            scope,
            "external.runtime",
            Draft::new("turn.end", false, json!(r)).copying(self.sources(api, scope, true)?),
        )?;
        api.emit(Event::new(scope, "turn.end", json!(r))).await?;
        Ok(entry)
    }
    pub(crate) async fn report(&self, api: &Api, work: &Work, p: &Value) -> Result<()> {
        self.active()?;
        let kind = wire::string(p, "type")?;
        // Only extension events can come from a report. The host owns standard events.
        if ["model.", "step.", "turn.", "tool.", "history."]
            .iter()
            .any(|prefix| kind.starts_with(prefix))
            || ["text", "reasoning", "toolInput", "modelEvent"].contains(&kind)
        {
            return Ok(());
        }
        let mut scope = self.scope(work, p);
        if let Some(call) = p["toolCallId"].as_str() {
            scope = self.call_scope(api, scope, call)?.0;
        }
        api.emit(Event::new(&scope, kind, p["data"].clone())).await
    }
    pub(crate) async fn callback(
        &self,
        api: &Api,
        work: &Work,
        request: Callback<'_>,
        token: CancellationToken,
    ) -> Result<Value> {
        self.active()?;
        let Callback {
            peer,
            id,
            method,
            params: p,
        } = request;
        let mut scope = self.scope(work, p);
        match method {
            "host/runtime/newId" => {
                let id = agent_api::id();
                self.allocated.lock().unwrap().insert(id.clone());
                Ok(json!({"id":id}))
            }
            "host/runtime/prepareStep" | "host/runtime/model" => {
                let _commit = self.commits.lock().await;
                self.active()?;
                scope.step = Some(wire::string(p, "stepId")?.into());
                if method == "host/runtime/prepareStep" {
                    self.prepare(api, &scope, &p["usage"], token).await
                } else {
                    self.model(api, &scope, &p["request"], token, peer, id)
                        .await
                }
            }
            "host/runtime/hook" => {
                let hook = wire::string(p, "hook")?;
                let _commit = self.commits.lock().await;
                self.active()?;
                if token.is_cancelled() && hook != "turn.end" {
                    bail!("cancelled");
                }
                if let Some(step) = p["payload"]["stepId"].as_str() {
                    ensure!(
                        p["stepId"].is_null() || p["stepId"] == step,
                        "stepId mismatch"
                    );
                    scope.step = Some(step.into());
                }
                self.hook(api, &scope, hook, p, work.cancel.is_cancelled())
                    .await
            }
            "host/runtime/definition" => {
                refresh_tool_sources(api, &scope).await?;
                Ok(self
                    .definition(api, &scope, wire::string(p, "toolName")?)?
                    .as_ref()
                    .map(wire::definition)
                    .unwrap_or(Value::Null))
            }
            "host/runtime/runToolCall" => self.tool(api, scope, p, token).await,
            "host/runtime/record" => {
                if let Some(step) = p["entry"]["stepId"].as_str() {
                    scope.step = Some(step.into());
                }
                self.record(api, work, scope, &p["entry"]).await
            }
            "host/runtime/takeSteering" => {
                let _commit = self.commits.lock().await;
                self.check_step_boundary()?;
                let data = api.snapshot(&scope.session)?;
                if p["final"] == true {
                    api.take_final_steering(&scope)?;
                } else {
                    api.take_steering(&scope)?;
                }
                let new = api.snapshot(&scope.session)?;
                let entries = new
                    .branch()
                    .iter()
                    .filter(|e| e.kind == "input" && !data.entries.iter().any(|a| a.id == e.id))
                    .map(|e| wire::entry(e, &new))
                    .collect::<Result<Vec<_>>>()?;
                Ok(json!({"entries":entries}))
            }
            "host/runtime/hasSteering" => Ok(json!({"waiting":api.has_steering(&scope.session)?})),
            _ => bail!("unknown Runtime host request"),
        }
    }
}
