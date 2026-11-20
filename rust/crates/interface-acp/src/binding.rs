//! Shared wire vocabulary. The frozen in-process API and stored entries stay unchanged.
//! Source: docs/bindings/acp.md (modular-agent-acp/1).
use super::*;

pub(crate) const EXTENSIONS: &[&str] = &[
    "history",
    "input",
    "requests",
    "answer",
    "actors",
    "join",
    "leave",
    "release",
    "proposals",
    "limit",
    "tenant",
    "fork",
    "move",
    "erase",
    "jobs",
    "cancel-job",
    "declaration",
    "withdraw",
    "drain",
    "command",
    "commands",
    "tool",
    "trust-project",
];

pub fn declaration(api: &dyn AgentApi, session: Option<&str>) -> Result<Value> {
    let d = api.declaration()?;
    let mut keeps_state = d["provider_state"] == true;
    let mut runs_tools = d["provider_tools"] == true;
    let mut rewinding = d["rewinding"] == true;
    if let Some(session) = session {
        let data = api.snapshot(session)?;
        // Points can depend on the session's project, such as being in git.
        if let Ok(env) = capability::<dyn WorkingEnvironment>(api, "environment") {
            rewinding = env.keeps_points(&data.project);
        }
        let model = data.settings["model"].clone();
        for key in api.capability_names("provider.") {
            for info in capability::<dyn Provider>(api, &key)?.catalog() {
                if info.name == model {
                    keeps_state = info.keeps_state;
                    runs_tools = info.runs_tools;
                }
            }
        }
    }
    let queued = d["queued_input_after_restart"]
        .as_str()
        .unwrap_or("handedBack");
    let queued_reports = d["queued_job_reports_after_restart"]
        .as_str()
        .unwrap_or(queued);
    let mut declaration = json!({
        "inputDuringTurn":d["runtime"]["input_during_turn"] == true,
        "waitingThroughRestart":d["runtime"]["waits_through_restart"] == true,
        "continuesAfterRestart":d["runtime"]["continues_after_restart"] == true,
        "rewinding":rewinding, "forking":d["forking"] == true,
        "keepsStateAtProvider":keeps_state, "runsToolsAtProvider":runs_tools,
        "liveSessions":d["live_sessions"] == true, "severalActors":d["several_actors"] == true,
        "holdsOutput":d["holds_output"] == true, "outputBypassesAgent":d["output_bypass"] == true,
        "cancellingTurnCancelsJobs":d["runtime"]["cancel_cancels_jobs"] == true,
        "pluginsDuringSession":d["plugins_during_session"] == true, "erasure":d["erasure"] == true,
        "sessionLimits":true, "tenants":true, "portableSessions":true, "inputKeys":d["input_keys"] == true, "questionsOutlastTurns":d["questions_outlast_turn"] == true, "lateAnswersStartTurns":d["questions_outlast_turn"] == true,
        "startsTurnsUnasked":if d["job_reports_start_turns"] == true {"jobReports"} else {"never"},
        "queuedInputAfterRestart":queued, "movingWithUnfinishedWork":"refused",
        "mixedActorInput":"shared", "settingsDuringTurn":d["settings_during_turn"].as_str().unwrap_or("refused"), "erasureDuringTurn":"refused",
        "nestedToolCalls":d["runtime"]["nested_tools"] == true,
        "confinesFiles":d["environment"]["confines_files"] == true,
        "commandContainment":if d["environment"]["stops_commands_after_sigkill"] == true {"strong"} else if d["environment"]["containment"] == "processGroup" {"processGroup"} else {"none"}
    });
    if queued_reports != queued {
        declaration["queuedJobReportsAfterRestart"] = json!(queued_reports);
    }
    Ok(declaration)
}

pub(crate) fn model_id(provider: &str, name: &str) -> String {
    let provider = provider.strip_prefix("provider.").unwrap_or(provider);
    if name.starts_with(&format!("{provider}/")) {
        name.into()
    } else {
        format!("{provider}/{name}")
    }
}

pub(crate) fn outcome(result: &TurnResult) -> Value {
    // A suspended question is not a step/output limit. ACP explicitly permits
    // completed turns with open calls; the call's pending status carries the wait.
    if !result.open_calls.is_empty()
        && result.outcome == Outcome::Limit
        && result.limit.as_deref() != Some("tenantTokens")
    {
        return json!({"kind":"completed"});
    }
    match result.outcome {
        Outcome::Completed => json!({"kind":"completed"}),
        Outcome::Cancelled => json!({"kind":"cancelled"}),
        Outcome::Failed => {
            json!({"kind":"failed","error":result.error.as_deref().unwrap_or("turn failed")})
        }
        Outcome::Limit => {
            json!({"kind":"limit","limit":result.limit.as_deref().unwrap_or(if result.error.as_deref() == Some("model output limit") {"output"} else {"steps"})})
        }
    }
}
pub(crate) fn stop_reason(outcome: &Value) -> &'static str {
    match outcome["kind"].as_str() {
        Some("cancelled") => "cancelled",
        Some("failed") => "refusal",
        Some("limit")
            if matches!(
                outcome["limit"].as_str(),
                Some("output" | "sessionTokens" | "tenantTokens")
            ) =>
        {
            "max_tokens"
        }
        Some("limit") => "max_turn_requests",
        _ => "end_turn",
    }
}
fn blocks(parts: &[Part]) -> Vec<Value> {
    parts
        .iter()
        .map(|p| match p {
            Part::Text { text } => json!({"type":"text","text":text}),
            Part::ToolCall { call } => {
                // Shared content uses arguments; input remains a legacy alias.
                json!({"type":"toolCall","id":call.id,"name":call.name,"arguments":call.input,"input":call.input})
            }
            Part::Reasoning { .. } => wire::content(std::slice::from_ref(p)).remove(0),
            Part::Other { name, data } => json!({"type":name,"data":data}),
        })
        .collect()
}
fn entry(e: Entry) -> Result<Value> {
    let kind = match e.kind.as_str() {
        "model.response" => "response",
        "tool.result" => "toolResult",
        "turn.start" => "turnStart",
        "turn.end" => "turnEnd",
        other => other,
    };
    let mut v = json!({"id":e.id,"parentId":e.parent,"kind":kind,"time":e.at,
        "turnId":e.scope.turn,"toolCallId":e.scope.call,"actorId":e.scope.actor});
    let Some(c) = e.content else {
        v["erased"] = json!(true);
        return Ok(v);
    };
    v["data"] = c.clone();
    if e.kind == "input" {
        v["inputId"] = c["inputId"]
            .as_str()
            .map_or_else(|| json!(e.id), |id| json!(id));
    }
    match e.kind.as_str() {
        "input" => {
            v["message"] = json!({"role":"user","content":[{"type":"text","text":c["text"]}]})
        }
        "model.response" => {
            let response: ModelResponse = serde_json::from_value(c)?;
            v["message"] = json!({"role":"assistant","content":blocks(&response.parts)});
            wire::omit_provider_data(&mut v["message"]);
            v["data"] = Value::Null;
        }
        "tool.result" => {
            v["data"]["status"] = match c["status"].as_str() {
                Some("unknown") => json!("outcomeUnknown"),
                Some("not_started") => json!("notStarted"),
                _ => c["status"].clone(),
            };
            v["message"] =
                json!({"role":"toolResult","content":[{"type":"text","text":c["text"]}]});
        }
        "turn.end" => v["data"]["outcome"] = outcome(&serde_json::from_value(c)?),
        _ => (),
    }
    Ok(v)
}
pub(crate) async fn gate_entry(
    api: &dyn AgentApi,
    scope: &Scope,
    entry: Value,
) -> Result<Option<Value>> {
    Ok(api
        .output(
            scope,
            Output {
                recipient: "interface.acp".into(),
                value: json!({"entry":entry}),
                stream: None,
                end: true,
            },
        )
        .await?
        .and_then(|v| v.get("entry").filter(|e| e["id"].is_string()).cloned()))
}

pub(crate) async fn history(session: &Session, p: &Value) -> Result<Value> {
    let data = session.api.snapshot(&session.id)?;
    let entries = if p["all"] == true {
        data.entries.clone()
    } else {
        data.branch()
    };
    let start = if let Some(after) = p["after"].as_str() {
        entries
            .iter()
            .position(|e| e.id == after)
            .ok_or_else(|| anyhow!("unknown history point"))?
            + 1
    } else {
        0
    };
    let scope = actor_scope(&session.id);
    let mut visible = Vec::new();
    for e in entries
        .into_iter()
        .skip(start)
        .filter(|e| e.writer != "rust.derived")
    {
        let mut shared = portable::public_entry(&e, &data)?;
        if e.kind == "erasure"
            && let Some(payload) = shared["data"].as_object_mut()
        {
            payload.remove("inputKeys");
        }
        if e.kind == "request.open" {
            let q: Question = serde_json::from_value(e.content.clone().unwrap_or_default())?;
            shared["data"]["request"] = shared_question(q);
        }
        let Some(gated) = gate_entry(session.api.as_ref(), &scope, shared.clone()).await? else {
            return Err(withheld().into());
        };
        let entry = if gated != shared
            || matches!(
                e.kind.as_str(),
                "actor.grant"
                    | "actor.identity"
                    | "actor.left"
                    | "job.start"
                    | "job.end"
                    | "job.cleanup_unconfirmed"
                    | "plugins.changed"
                    | "turn.start"
                    | "turn.end"
                    | "erasure"
                    | "input.accepted"
                    | "input.withdrawn"
                    | "input.returned"
                    | "model.request"
                    | "model.response"
                    | recovery::STEP_AFTER
                    | "tool.pending"
                    | "result.feedback"
                    | "tool.started"
                    | "request.open"
                    | "request.answer"
                    | "request.closed"
                    | "tenant"
                    | "limit"
            )
            || e.content.is_none()
        {
            gated
        } else {
            entry(e)?
        };
        visible.push(entry);
    }
    Ok(json!({"entries":visible}))
}
pub(crate) fn text_content(content: &Value) -> Result<String> {
    if let Some(text) = content.as_str() {
        return Ok(text.into());
    }
    let blocks = content
        .as_array()
        .ok_or_else(|| anyhow!("content must be a string or text blocks"))?;
    blocks
        .iter()
        .map(|b| {
            ensure!(b["type"] == "text", "only text input is supported");
            Ok(string(b, "text")?.to_string())
        })
        .collect::<Result<Vec<_>>>()
        .map(|v| v.join("\n"))
}
pub(crate) fn has_result(data: &SessionData, input: &str) -> bool {
    data.entries.iter().any(|e| {
        e.kind == "input"
            && e.copies.iter().any(|id| id == input)
            && data
                .entries
                .iter()
                .any(|end| end.kind == "turn.end" && end.scope.turn == e.scope.turn)
    })
}
pub(crate) fn prompt_response(data: &SessionData, receipt: &Receipt) -> Result<Value> {
    let taken = data
        .entries
        .iter()
        .find(|e| e.kind == "input" && e.copies.contains(&receipt.input));
    let end = taken.and_then(|input| {
        data.entries
            .iter()
            .find(|e| e.kind == "turn.end" && e.scope.turn == input.scope.turn)
    });
    ensure!(
        end.is_some() || receipt.command.is_some(),
        "original input has no finished turn"
    );
    let result: TurnResult = end
        .and_then(|e| e.content.clone())
        .map(serde_json::from_value)
        .transpose()?
        .unwrap_or_default();
    let outcome = outcome(&result);
    let mut meta = json!({"inputId":receipt.input,"duplicate":receipt.duplicate,"outcome":outcome,
        "openToolCalls":result.open_calls.iter().map(|c| &c.id).collect::<Vec<_>>()});
    if result.outcome == Outcome::Cancelled {
        let turn = taken.and_then(|e| e.scope.turn.as_ref());
        let returned: Vec<_> = data.entries.iter()
            .filter(|e|e.kind == "acp.input.returned" && e.scope.turn.as_ref() == turn)
            .filter_map(|e|e.content.as_ref().and_then(|c|c["inputs"].as_array()))
            .flatten().filter_map(Value::as_str)
            .filter_map(|id|data.entries.iter().find(|e|e.id == id).map(|e|json!({"inputId":id,"content":e.content.as_ref().map(|c|c["text"].clone()).unwrap_or(Value::Null)})))
            .collect();
        meta["handedBack"] = json!(returned);
    }
    Ok(json!({"stopReason":stop_reason(&outcome),"_meta":{"modular-agent":meta}}))
}

pub fn shared_question(q: Question) -> Value {
    let mut value = json!({"id":q.id,"kind":q.kind,"question":q.text});
    if let Some(call_id) = q.scope.call {
        value["toolCallId"] = json!(call_id);
    }
    if q.kind == RequestKind::Choice {
        value["options"] = json!(q.options);
    }
    if q.extra["kind"] == "link" {
        value["kind"] = json!("link");
        value["details"] = q.extra["details"].clone();
    }
    if let Some(call) = q.extra.get("approvalCall") {
        value["call"] = json!({"name":call["name"],"input":call["input"]});
    }
    value
}

pub(crate) fn answerable(session: &Session, service: &dyn InputRequests, q: &Question) -> bool {
    q.answerable
        && q.kind != RequestKind::Secret
        && service.eligible(
            session.api.as_ref(),
            q,
            &session.id,
            connection_actor().as_str(),
        )
        && (q.kind != RequestKind::Approval
            || service
                .present(&session.id)
                .iter()
                .any(|a| a == connection_actor().as_str()))
}

pub(crate) fn poll_payload(session: &Session) -> Result<Value> {
    let list = requests(session.api.as_ref())?.visible(
        session.api.as_ref(),
        &session.id,
        connection_actor().as_str(),
    )?;
    Ok(
        json!({"requests":list.into_iter().filter(|q| q.answerable).map(shared_question).collect::<Vec<_>>()}),
    )
}

pub(crate) fn mark_poll_view(session: &Session, before: &Value, after: &mut [Value]) -> Result<()> {
    let api = session.api.as_ref();
    let service = requests(api)?;
    let current = service.visible(api, &session.id, connection_actor().as_str())?;
    for view in after {
        let id = view["id"].as_str().unwrap_or_default().to_owned();
        let eligible = current.iter().find(|q| q.id == id).is_some_and(|q| {
            answerable(session, service.as_ref(), q)
                && (q.kind != RequestKind::Approval
                    || before.as_array().is_some_and(|items| {
                        items
                            .iter()
                            .any(|v| v["id"] == id && wire::json_eq(v, view))
                    }))
        });
        if let Some(view) = view.as_object_mut() {
            view.insert("answerable".into(), json!(eligible));
        }
    }
    Ok(())
}

pub(crate) fn mark_history_views(
    session: &Session,
    before: &Value,
    after: &mut Value,
) -> Result<()> {
    let Some(entries) = after["entries"].as_array_mut() else {
        return Ok(());
    };
    let api = session.api.as_ref();
    let service = requests(api)?;
    let current = service.visible(api, &session.id, connection_actor().as_str())?;
    for entry in entries.iter_mut().filter(|e| e["kind"] == "inputRequest") {
        let id = entry["id"].clone();
        let view = &mut entry["data"]["request"];
        let eligible = current
            .iter()
            .find(|q| view["id"] == q.id)
            .is_some_and(|q| {
                answerable(session, service.as_ref(), q)
                    && (q.kind != RequestKind::Approval
                        || before["entries"].as_array().is_some_and(|items| {
                            items.iter().any(|e| {
                                e["id"] == id && wire::json_eq(&e["data"]["request"], view)
                            })
                        }))
            });
        if let Some(view) = view.as_object_mut() {
            view.insert("answerable".into(), json!(eligible));
        }
    }
    Ok(())
}
fn input_timing_for_release(
    api: &dyn AgentApi,
    session: &str,
    timing: Timing,
    declined: bool,
) -> &'static str {
    if declined {
        "handedBack"
    } else {
        input_taken(api.is_running(session), timing)
    }
}
pub(crate) async fn extension(
    factory: &dyn Factory,
    session: Arc<Session>,
    method: &str,
    p: &Value,
) -> Result<Value> {
    let scope = actor_scope(&session.id);
    let connection_actor = connection_actor();
    // Proposals, release and withdraw also serve parked job reports.
    let feature = match method {
        "actors" | "join" | "leave" => Some("severalActors"),
        "input" if p["when"] == "propose" => Some("severalActors"),
        "input" | "answer"
            if p["actorId"]
                .as_str()
                .is_some_and(|id| id != connection_actor.as_str()) =>
        {
            Some("severalActors")
        }
        "limit" => Some("sessionLimits"),
        "tenant" => Some("tenants"),
        _ => None,
    };
    if let Some(feature) = feature
        && factory.session_declaration(session.api.as_ref(), &session.id)?[feature] != true
    {
        return Err(request_error("not_supported", "feature is disabled in this session").into());
    }
    let actor = if matches!(method, "input" | "answer") {
        let actor = p
            .get("actorId")
            .map(|_| string(p, "actorId"))
            .transpose()?
            .unwrap_or(connection_actor.as_str());
        let represented = std::env::var("MODULAR_AGENT_ACP_REPRESENTS")
            .ok()
            .and_then(|v| serde_json::from_str::<Vec<String>>(&v).ok())
            .unwrap_or_default();
        if actor != connection_actor.as_str() && !represented.iter().any(|id| id == actor) {
            return Err(
                request_error("forbidden", "connection does not represent this actor").into(),
            );
        }
        actor
    } else {
        connection_actor.as_str()
    };
    let api = session.api.as_ref();
    let require_both = |right| -> Result<()> {
        require(api, &scope, right)?;
        require(
            api,
            &Scope {
                actor: actor.into(),
                ..scope.clone()
            },
            right,
        )
    };
    match method {
        "actors" => {
            require(api, &scope, "watch")?;
            let actors = actors(&api.snapshot(&session.id)?);
            Ok(
                json!({"present":requests(api)?.present(&session.id),"actors":actors.values().collect::<Vec<_>>()}),
            )
        }
        "join" => {
            require(api, &scope, "grant")?;
            let value = &p["actor"];
            let id = string(value, "id")?;
            let kind = string(value, "kind")?;
            ensure!(
                !id.is_empty() && !id.starts_with("job:"),
                "invalid actor identity"
            );
            ensure!(
                matches!(kind, "user" | "host" | "agent" | "plugin"),
                "invalid actor kind"
            );
            let rights: Authority = serde_json::from_value(value["rights"].clone())?;
            let cap = api
                .authority(&session.id, connection_actor.as_str())?
                .intersect(&Authority::full());
            ensure!(
                cap.contains(&rights),
                "cannot grant a right you do not have"
            );
            let present = match p.get("present") {
                None => true,
                Some(v) => v
                    .as_bool()
                    .ok_or_else(|| anyhow!("present must be boolean"))?,
            };
            api.append(
                &scope,
                "interface.acp",
                Draft::new(
                    "actor.grant",
                    false,
                    json!({"actor":id,"kind":kind,"authority":rights}),
                ),
            )?;
            let represented = std::env::var("MODULAR_AGENT_ACP_REPRESENTS")
                .ok()
                .and_then(|v| serde_json::from_str::<Vec<String>>(&v).ok())
                .unwrap_or_default();
            if !present
                || id == connection_actor.as_str()
                || represented.iter().any(|actor| actor == id)
            {
                requests(api)?.presence(&session.id, id, present);
            }
            Ok(json!({}))
        }
        "leave" => {
            let id = string(p, "actorId")?;
            if id != connection_actor.as_str() {
                require(api, &scope, "grant")?;
            }
            ensure!(
                actors(&api.snapshot(&session.id)?).contains_key(id),
                "unknown actor"
            );
            api.append(
                &scope,
                "interface.acp",
                Draft::new("actor.left", false, json!({"actorId":id})),
            )?;
            requests(api)?.presence(&session.id, id, false);
            Ok(json!({}))
        }
        "release" => {
            let input = string(p, "inputId")?;
            let timing = serde_json::from_value(p["when"].clone())?;
            let taken = input_timing_for_release(api, &session.id, timing, p["declined"] == true);
            api.release(&scope, input, timing, p["declined"] == true)
                .await?;
            session.wake.notify_one();
            Ok(json!({"inputId":input,"taken":taken}))
        }
        "proposals" => {
            require(api, &scope, "watch")?;
            let data = api.snapshot(&session.id)?;
            let pending = data.pending_inputs();
            let mut proposals = Vec::new();
            for (id, entry) in pending {
                let Some(value) = &entry.content else {
                    continue;
                };
                if value["timing"] != "propose"
                    && !(value["parked"] == true && value["releasedBy"].is_null())
                {
                    continue;
                }
                let shared = portable::public_entry(entry, &data)?;
                proposals.push(json!({"inputId":id,"actorId":shared["actorId"],
                    "content":shared["data"]["content"],"time":entry.at}));
            }
            Ok(json!({"proposals":proposals}))
        }
        "withdraw" => {
            ensure!(
                actors(&api.snapshot(&session.id)?).contains_key(actor),
                "unknown actor"
            );
            let proposer = Scope {
                actor: actor.into(),
                ..scope
            };
            api.withdraw_proposal(&proposer, connection_actor.as_str(), string(p, "inputId")?)
                .await?;
            Ok(json!({}))
        }
        "limit" => {
            require(api, &scope, "administer")?;
            let value = p.get("rights").ok_or_else(|| anyhow!("missing rights"))?;
            if !value.is_null() {
                let rights: Authority = serde_json::from_value(value.clone())?;
                ensure!(
                    work_authority(api, &scope)?
                        .intersect(&Authority::full())
                        .contains(&rights),
                    "cannot grant a right you do not have"
                );
            }
            api.append(
                &scope,
                "interface.acp",
                Draft::new("limit", false, json!({"rights":value})),
            )?;
            Ok(json!({}))
        }
        "tenant" => {
            require(api, &scope, "watch")?;
            api.tenant(&session.id)
        }
        "history" => {
            require(api, &scope, "watch")?;
            history(&session, p).await
        }
        "input" => {
            let timing = serde_json::from_value(p["when"].clone())?;
            ensure!(
                actors(&api.snapshot(&session.id)?).contains_key(actor),
                "unknown actor"
            );
            require_both(if timing == Timing::Propose {
                "propose"
            } else {
                "input"
            })?;
            session
                .input(
                    actor,
                    text_content(&p["content"])?,
                    timing,
                    p["key"].as_str().map(str::to_string),
                )
                .await
        }
        "requests" => poll_payload(&session),
        "answer" => {
            let id = string(p, "requestId")?;
            let service = requests(session.api.as_ref())?;
            let question = service
                .visible(session.api.as_ref(), &session.id, connection_actor.as_str())?
                .into_iter()
                .find(|q| q.id == id);
            let Some(q) = question.filter(|q| q.answerable) else {
                return Ok(json!({"accepted":false,"reason":"not_open"}));
            };
            {
                ensure!(
                    actors(&api.snapshot(&session.id)?).contains_key(actor),
                    "unknown actor"
                );
                require_both(if q.kind == RequestKind::Approval {
                    "approve"
                } else {
                    "answer"
                })?;
            }
            if q.kind == RequestKind::Approval
                && !session
                    .approval_views
                    .lock()
                    .unwrap()
                    .contains(&(actor.to_owned(), id.to_owned()))
            {
                return Ok(json!({"accepted":false,"reason":"not_open"}));
            }
            if q.kind == RequestKind::Secret {
                return Ok(json!({"accepted":false,"reason":"ACP does not accept secret answers"}));
            }
            match service
                .answer(
                    session.api.clone(),
                    &session.id,
                    actor,
                    id,
                    p["value"].clone(),
                    p["declined"] == true || p["value"].is_null(),
                )
                .await
            {
                Ok(()) => {
                    session.wake.notify_one();
                    Ok(json!({"accepted":true}))
                }
                Err(e)
                    if matches!(
                        e.to_string().as_str(),
                        "unknown request" | "request is closed"
                    ) =>
                {
                    Ok(json!({"accepted":false,"reason":"not_open"}))
                }
                Err(e) => Ok(json!({"accepted":false,"reason":e.to_string()})),
            }
        }
        "fork" | "move" => {
            let _guard = session
                .gate
                .try_lock()
                .map_err(|_| anyhow!("session busy"))?;
            let data = session.api.snapshot(&session.id)?;
            let branch = data.branch();
            ensure!(
                !questions(&data)?.iter().any(|q| q.answerable)
                    && !jobs(&data)?.iter().any(|j| j.state.is_unfinished())
                    && data.pending_inputs().is_empty()
                    && !branch.iter().any(|e| e.kind == "tool.call"
                        && !data
                            .entries
                            .iter()
                            .any(|r| r.kind == "tool.result" && r.scope.call == e.scope.call)),
                "settle pending work before moving or forking"
            );
            let target = string(p, "entryId")?;
            let entry = data
                .entries
                .iter()
                .find(|e| e.id == target)
                .ok_or_else(|| request_error("not_found", "unknown target"))?;
            if entry.kind == "position"
                || (method == "move"
                    && ((!branch.iter().any(|e| e.id == target))
                        || (entry.scope.turn.is_some() && entry.kind != "turn.end")))
            {
                return Err(request_error("conflict", "target is not a quiescent position").into());
            }
            let position = target.to_owned();
            if method == "move" {
                if p["rewind"] == true {
                    let out = session
                        .api
                        .rewind(&scope, position)
                        .await
                        .map_err(|error| match error.downcast_ref::<RewindError>() {
                            Some(issue) => request_error(
                                match issue {
                                    RewindError::Busy(_) => "busy",
                                    RewindError::Conflict(_) => "conflict",
                                    RewindError::NotSupported => "not_supported",
                                },
                                &error.to_string(),
                            )
                            .into(),
                            None => error,
                        })?;
                    if !out.is_empty() {
                        return Ok(json!({"outOfReach":out}));
                    }
                } else {
                    session.api.move_position(&scope, Some(position))?;
                }
                Ok(json!({}))
            } else {
                let id = session.api.fork(&scope, Some(position))?;
                session.api.close(&id).await?;
                Ok(json!({"sessionId":id}))
            }
        }
        "erase" => {
            let _guard = session
                .gate
                .try_lock()
                .map_err(|_| anyhow!("session busy"))?;
            require(api, &scope, "erase")?;
            let ids: std::collections::BTreeSet<String> =
                serde_json::from_value(p["entryIds"].clone())?;
            let data = api.snapshot(&session.id)?;
            for id in &ids {
                let target = data
                    .entries
                    .iter()
                    .find(|e| e.id == *id)
                    .ok_or_else(|| request_error("not_found", "unknown erasure target"))?;
                if authority_record(target) || target.kind == "erasure" {
                    return Err(request_error("forbidden", "protected erasure target").into());
                }
            }
            let mut report = api.erase(&scope, ids.into_iter().collect()).await?;
            let mut hidden = false;
            let mut erased = Vec::new();
            let mut pending = Vec::new();
            for (sid, id) in report
                .qualified
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>()
            {
                if sid != session.id {
                    hidden = true;
                    continue;
                }
                let pair = json!({"sessionId":sid,"id":id});
                if report.pending.contains(&id) {
                    pending.push(pair.clone());
                }
                erased.push(pair);
            }
            if hidden {
                report.out_of_reach.push("copies in other sessions".into());
            }
            report.out_of_reach.sort();
            report.out_of_reach.dedup();
            Ok(json!({"erased":erased,"pending":pending,"outOfReach":report.out_of_reach}))
        }
        "jobs" => {
            require(api, &scope, "watch")?;
            Ok(json!({"jobs":jobs(&api.snapshot(&session.id)?)?.iter()
                    .filter(|j| j.state.is_unfinished())
                    .map(|j| json!({"id":j.id,"kind":j.kind,"state":j.state}))
                    .collect::<Vec<_>>()}))
        }
        "cancel-job" => {
            require(api, &scope, "cancel")?;
            let id = string(p, "jobId")?;
            let jobs = jobs(&api.snapshot(&session.id)?)?;
            let job = jobs
                .iter()
                .find(|j| j.id == id)
                .ok_or_else(|| request_error("not_found", "unknown job"))?;
            if job.state == JobState::CleanupUnconfirmed {
                return Err(request_error("lost", "job cleanup is unconfirmed").into());
            }
            job_service(session.api.as_ref())?
                .cancel(
                    session.api.clone(),
                    &session.id,
                    connection_actor.as_str(),
                    id,
                )
                .await?;
            Ok(json!({}))
        }
        "declaration" => {
            require(api, &scope, "watch")?;
            declaration(api, Some(&session.id))
        }
        _ => bail!("method not found"),
    }
}
