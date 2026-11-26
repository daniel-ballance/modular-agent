//! The shared history representation. Native entries are a working view, not the wire format.
use crate::{wire::*, *};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

fn kind(native: &str) -> String {
    match native {
        "model.response" => "response",
        "model.request" => "modelRequest",
        "result.feedback" => "resultFeedback",
        "input.accepted" => "inputAccepted",
        "input.returned" | "input.withdrawn" => "inputHandedBack",
        "job.start" => "jobStarted",
        "job.end" => "jobEnded",
        "job.cleanup_unconfirmed" => "jobCleanupUnconfirmed",
        "plugins.changed" => "plugins",
        "tool.result" => "toolResult",
        "tool.pending" => "toolPending",
        "tool.started" => "toolStarted",
        "turn.start" => "turnStart",
        "turn.end" => "turnEnd",
        "request.open" => "inputRequest",
        "request.secretAccepted" => "secretAnswerAccepted",
        "request.answer" | "request.closed" | "request.invalidated" => "inputAnswer",
        "actor.grant" | "actor.identity" => "actorJoined",
        "actor.left" => "actorLeft",
        "settings" => "setting",
        "input"
        | "summary"
        | "position"
        | "erasure"
        | "limit"
        | "tenant"
        | "resultFeedback"
        | crate::recovery::STEP_AFTER
        | telemetry::TURN_TRACE
        | INTERFACE_HANDOFF => native,
        s => return format!("rust.{s}"),
    }
    .into()
}

fn native_identity_kind(kind: &str) -> &str {
    match kind {
        "inputAccepted" => "input.accepted",
        "inputHandedBack" => "input.returned",
        "modelRequest" => "model.request",
        "resultFeedback" => "result.feedback",
        "response" => "model.response",
        "toolStarted" => "tool.started",
        "toolResult" => "tool.result",
        "toolPending" => "tool.pending",
        "turnStart" => "turn.start",
        "turnEnd" => "turn.end",
        "jobStarted" => "job.start",
        "jobEnded" => "job.end",
        "jobCleanupUnconfirmed" => "job.cleanup_unconfirmed",
        "inputRequest" => "request.open",
        "inputAnswer" => "request.answer",
        "plugins" => "plugins.changed",
        "actorJoined" => "actor.grant",
        "actorLeft" => "actor.left",
        "setting" => "settings",
        _ => kind.strip_prefix("rust.").unwrap_or(kind),
    }
}

pub fn settings_to_wire(v: &Value) -> Value {
    let mut output = v.clone();
    if let Some(o) = output.as_object_mut() {
        for (local, shared) in [
            ("thinking", "reasoning"),
            ("step_limit", "maxSteps"),
            ("output_limit", "maxOutput"),
            ("model_tools", "modelTools"),
        ] {
            if let Some(value) = o.remove(local) {
                o.insert(shared.into(), value);
            }
        }
        if let Some(approval) = o.get("approval").and_then(Value::as_str) {
            o.insert(
                "approval".into(),
                json!(match approval {
                    "ask_always" => "all",
                    "ask_unless_read_only" => "ask",
                    "never_ask" => "never",
                    other => other,
                }),
            );
        }
        if let Some(name) = o.get("model").and_then(Value::as_str) {
            let (provider, id) = name
                .split_once('/')
                .unwrap_or((native_provider(name), name));
            o.insert("model".into(), json!({"provider":provider,"id":id}));
        }
    }
    output
}
pub fn settings_from_wire(v: &Value) -> Value {
    let mut output = v.clone();
    if let Some(o) = output.as_object_mut() {
        for (local, shared) in [
            ("thinking", "reasoning"),
            ("step_limit", "maxSteps"),
            ("output_limit", "maxOutput"),
            ("model_tools", "modelTools"),
        ] {
            if let Some(value) = o.remove(shared) {
                o.insert(local.into(), value);
            }
        }
        if let Some(approval) = o.get("approval") {
            o.insert(
                "approval".into(),
                json!(match approval.as_str() {
                    Some("off") => "off",
                    Some("all" | "ask_always") => "ask_always",
                    Some("ask" | "ask_unless_read_only") => "ask_unless_read_only",
                    _ => "never_ask",
                }),
            );
        }
        if let Some(model) = o.get("model").filter(|v| v.is_object())
            && let (Some(p), Some(id)) = (model["provider"].as_str(), model["id"].as_str())
        {
            o.insert(
                "model".into(),
                json!(if p == native_provider(id) {
                    id.to_owned()
                } else {
                    format!("{p}/{id}")
                }),
            );
        }
    }
    output
}
pub fn native_provider(id: &str) -> &str {
    if id == "gpt-6-luna" {
        "openai"
    } else if id.starts_with("fake") {
        "fake"
    } else {
        id
    }
}
fn usage(u: &Usage) -> Value {
    json!({"input":u.input_tokens,"output":u.output_tokens,"cacheRead":u.cached_tokens,"cacheWrite":u.cache_write_tokens,"cost":u.cost})
}
/// Shared content of an admission receipt, including older text-only receipts.
pub fn input_content(c: &Value) -> Value {
    if c["content"].is_array() {
        return c["content"].clone();
    }
    let text = c["content"]
        .as_str()
        .or_else(|| c["text"].as_str())
        .unwrap_or_default();
    json!([{"type":"text","text":text}])
}
pub fn input_message(c: &Value) -> Value {
    if c["message"].is_object() {
        return c["message"].clone();
    }
    let mut parts = c["context"].as_array().cloned().unwrap_or_default();
    parts.push(json!({"type":"text","text":c["text"].as_str().unwrap_or_default()}));
    json!({"role":"user","content":parts})
}
/// A history entry for an actor rather than a persistent store.
pub fn public_entry(e: &Entry, session: &SessionData) -> Result<Value> {
    let mut value = entry(e, session)?;
    omit_trace_metadata(&mut value);
    if let Some(message) = value.get_mut("message")
        && message["role"] == "assistant"
    {
        omit_provider_data(message);
    }
    if e.kind == "model.request"
        && let Some(messages) = value
            .pointer_mut("/data/request/messages")
            .and_then(Value::as_array_mut)
    {
        for message in messages {
            if message["role"] == "assistant" {
                omit_provider_data(message);
            }
        }
    }
    Ok(value)
}

pub fn omit_trace_metadata(entry: &mut Value) {
    if entry["kind"] == "inputAnswer"
        && let Some(data) = entry["data"].as_object_mut()
    {
        data.remove("approvalView");
    }
    if entry["kind"] == telemetry::TURN_TRACE || entry["kind"] == INTERFACE_HANDOFF {
        if let Some(object) = entry.as_object_mut() {
            object.remove("data");
        }
    } else if entry["kind"] == "turnStart"
        && let Some(data) = entry["data"].as_object_mut()
    {
        data.remove("traceContext");
    }
}

pub fn entry(e: &Entry, session: &SessionData) -> Result<Value> {
    let k = kind(&e.kind);
    let copied = session.origin.is_some()
        && !e.copies.is_empty()
        && session
            .entries
            .iter()
            .take_while(|entry| !entry.copies.is_empty())
            .any(|entry| entry.id == e.id);
    let sources = if copied {
        &e.copies[..1]
    } else {
        &e.copies[..]
    };
    let Some(c) = &e.content else {
        let mut erased = json!({"id":e.id,"parentId":e.parent,"kind":k,"erased":true});
        for (key, value) in [
            ("turnId", &e.scope.turn),
            ("stepId", &e.scope.step),
            ("toolCallId", &e.scope.call),
            ("jobId", &e.scope.job),
        ] {
            if let Some(value) = value {
                erased[key] = json!(value);
            }
        }
        if e.kind == "input.returned" && e.writer == "rust.tombstone.inputHandedBack" {
            erased["inputIds"] = json!(e.copies);
        }
        if copied {
            erased["sources"] = json!(sources);
        }
        return Ok(erased);
    };
    let mut v = json!({"id":e.id,"parentId":e.parent,"sessionId":e.scope.session,"kind":k,"time":e.at,"writer":e.writer,"modelVisible":e.visible,"actorId":e.scope.actor});
    if e.scope.actor.is_empty() {
        v.as_object_mut().unwrap().remove("actorId");
    }
    for (key, value) in [
        ("turnId", &e.scope.turn),
        ("stepId", &e.scope.step),
        ("toolCallId", &e.scope.call),
        ("jobId", &e.scope.job),
    ] {
        if let Some(value) = value {
            v[key] = json!(value);
        }
    }
    if !sources.is_empty() {
        v["sources"] = json!(sources);
    }
    // Native job actors enforce the job's ceiling in-process. On the wire a
    // job report is attributed to its starting actor, with the job authorizer.
    let report = e.scope.job.as_ref().and_then(|job| {
        (e.scope.actor == format!("job:{job}"))
            .then(|| {
                session
                    .entries
                    .iter()
                    .find(|s| s.kind == "job.start" && s.scope.job.as_ref() == Some(job))
            })
            .flatten()
    });
    if matches!(e.kind.as_str(), "input.accepted" | "input")
        && let Some(start) = report
    {
        v["actorId"] = json!(start.scope.actor);
    }
    let data = match e.kind.as_str() {
        "input.accepted" => {
            let mut value = json!({"inputId":c["inputId"].as_str().unwrap_or(&e.id),"when":c["timing"],
                "content":input_content(c)});
            if let Some(submitter) = c["submittedBy"].as_str().filter(|s| *s != e.scope.actor) {
                value["submittedBy"] = json!(submitter);
            }
            for key in ["key", "releasedBy", "parked", "taken"] {
                if let Some(item) = optional(c, key) {
                    value[key] = item.clone();
                }
            }
            for key in ["authority", "sponsor", "taken", "resultShape"] {
                if let Some(item) = optional(c, key) {
                    value[format!("rust.{key}")] = item.clone();
                }
            }
            if c["releasedBy"].is_string() && c["authority"].is_array() {
                value["rights"] = c["authority"].clone();
            }
            if let Some(job) = &e.scope.job
                && (report.is_some() || c["key"] == format!("job:{job}"))
            {
                value["authorizers"] = json!([{"sessionId":e.scope.session,"jobId":job}]);
                value["rights"] = c
                    .get("authority")
                    .cloned()
                    .unwrap_or_else(|| json!(Authority::only(&["watch"])));
            }
            value
        }
        "input.returned" | "input.withdrawn" => {
            if let Some(ids) = c["inputIds"].as_array() {
                v["inputIds"] = json!(ids);
                json!({"inputIds":ids})
            } else {
                v["inputId"] = c["input"].clone();
                json!({"inputIds":[c["input"]]})
            }
        }
        "model.request" => {
            let model = optional(c, "model")
                .cloned()
                .or_else(|| {
                    session
                        .entries
                        .iter()
                        .find(|start| {
                            start.kind == "turn.start" && start.scope.turn == e.scope.turn
                        })
                        .and_then(|start| {
                            serde_json::from_value::<ModelInfo>(
                                start.content.as_ref()?["model"].clone(),
                            )
                            .ok()
                        })
                        .map(|info| model_request_record(&info)["model"].clone())
                })
                .unwrap_or_else(|| json!({"provider":"unknown","id":"unknown"}));
            let mut intent = json!({"model":model,"safeToRepeat":c["safeToRepeat"].as_bool()
                .unwrap_or(c["keeps_state"] == false && c["runs_tools"] == false),
                "tools":c.get("tools").cloned().unwrap_or_else(||json!([]))});
            for field in ["auxiliary", "request"] {
                if let Some(value) = optional(c, field) {
                    intent[field] = value.clone();
                }
            }
            intent
        }
        "plugins.changed" => json!({"active":c["active"].as_array().into_iter().flatten().map(|v| {
            v.as_str().map(|name|json!({"name":name})).unwrap_or_else(||v.clone())
        }).collect::<Vec<_>>()}),
        "job.start" => {
            let mut value = json!({"kind":c["kind"],"detail":c["detail"],"rights":c["authority"],"rust.report":c["report"]});
            if let Some(key) = optional(c, "key") {
                value["key"] = key.clone();
            }
            value
        }
        "job.cleanup_unconfirmed" => Value::Null,
        "job.end" => {
            let mut outcome = json!({"kind":match c["state"].as_str() {Some("completed")=>"completed",Some("cancelled")=>"cancelled",_=>"failed"}});
            if let Some(error) = optional(&c["result"], "error") {
                outcome["error"] = error.clone();
            }
            let mut value = json!({"outcome":c.get("wireOutcome").unwrap_or(&outcome),"report":c["report"] == true,"rust.state":c["state"],"rust.result":c["result"]});
            if let Some(result) = c.get("wireResult") {
                value["result"] = result.clone();
            } else if let Some(text) = c["result"]["text"].as_str().filter(|s| !s.is_empty()) {
                value["result"] = json!([{"type":"text","text":text}]);
            }
            value
        }
        "input" => {
            v["message"] = input_message(c);
            let mut data = json!({"inputId":c["inputId"].as_str().or_else(||e.copies.first().map(String::as_str)).unwrap_or(&e.id)});
            if let Some(key) = c["key"].as_str().or_else(|| {
                session
                    .entries
                    .iter()
                    .find(|entry| entry.id == data["inputId"])
                    .and_then(|entry| entry.content.as_ref()?.get("key")?.as_str())
            }) {
                data["key"] = json!(key);
            }
            for key in ["authority", "sponsor", "releasedBy"] {
                if let Some(value) = optional(c, key) {
                    data[format!("rust.{key}")] = value.clone();
                }
            }
            data
        }
        "model.response" => {
            if c["recovery"] == true {
                v["message"] = json!({"role":"assistant","stop":"aborted","content":[]});
                json!({"recovery":true})
            } else {
                v["message"] = response(&serde_json::from_value(c.clone())?);
                Value::Null
            }
        }
        "tool.started" => {
            let legacy = session
                .entries
                .iter()
                .find(|entry| entry.kind == "tool.call" && entry.scope.call == e.scope.call)
                .and_then(|entry| entry.content.as_ref());
            let source = c
                .get("call")
                .or_else(|| c.get("id").map(|_| c))
                .or(legacy)
                .ok_or_else(|| anyhow!("missing started call"))?;
            let mut start = json!({"call":call(&serde_json::from_value(source.clone())?,&e.scope),"safeToRepeat":c["safeToRepeat"] == true});
            if let Some(point) = c.get("point") {
                start["point"] = point.clone();
            }
            for field in [
                "source",
                "definition",
                "openWorld",
                "authorizers",
                "rights",
                "approvalCoveredBy",
            ] {
                if let Some(value) = optional(c, field) {
                    start[field] = value.clone();
                }
            }
            start
        }
        "tool.result" => {
            let r: ToolResult = serde_json::from_value(c.clone())?;
            let tool = session
                .entries
                .iter()
                .find(|entry| entry.kind == "tool.call" && entry.scope.call == e.scope.call)
                .and_then(|entry| entry.content.as_ref())
                .and_then(|v| v["name"].as_str())
                .unwrap_or("tool");
            v["message"] = c.get("message").cloned().unwrap_or_else(|| json!({"role":"toolResult","toolCallId":r.call,"toolName":tool,"content":result(&r)["content"],"isError":r.status!=ToolStatus::Completed}));
            let mut data = json!({"status":status(&r.status)});
            if let Some(value) = result(&r).get("value") {
                data["value"] = value.clone();
            }
            data
        }
        "turn.start" => {
            let info =
                serde_json::from_value::<ModelInfo>(c["model"].clone()).unwrap_or_else(|_| {
                    ModelInfo {
                        name: "unknown".into(),
                        context_window: 0,
                        output_limit: 0,
                        thinking: vec![],
                        keeps_state: false,
                        runs_tools: false,
                        extra: Value::Null,
                    }
                });
            let mut model = model_value(&info);
            if !info.name.contains('/') {
                model["provider"] = json!(native_provider(&info.name));
            }
            let tools: Vec<ToolDefinition> =
                serde_json::from_value(c["tools"].clone()).unwrap_or_default();
            let settings = settings_to_wire(&c["settings"]);
            let mut start = json!({"startedBy":c.get("startedBy").cloned().unwrap_or_else(||json!({"kind":"actor","id":e.scope.actor})),"model":{"provider":model["provider"],"id":model["id"]},"system":c["system"].as_str().unwrap_or_default(),"tools":tools.iter().map(definition).collect::<Vec<_>>(),"settings":{}});
            if let Some(origin) = optional(c, "continuesTurnId") {
                v["continuesTurnId"] = origin.clone();
            }
            if let Some(shape) = c["settings"].get("result_shape") {
                start["resultShape"] = shape.clone();
            }
            for key in ["point", "context", "traceContext"] {
                if let Some(value) = c.get(key) {
                    start[key] = value.clone();
                }
            }
            for key in ["maxSteps", "maxOutput", "reasoning"] {
                if let Some(value) = settings.get(key) {
                    start["settings"][key] = value.clone();
                }
            }
            if let Some(resume) = c
                .get("resume")
                .filter(|v| v.as_array().is_some_and(|v| !v.is_empty()))
            {
                start["rust.resume"] = resume.clone();
            }
            if let Some(settings) = c.get("settings") {
                start["rust.settings"] = settings.clone();
            }
            start
        }
        "turn.end" => {
            let r: TurnResult = serde_json::from_value(c.clone())?;
            let mut end = turn_outcome(&r);
            end["usage"] = usage(&r.usage);
            if let Some(id) = optional(c, "inputId") {
                end["inputId"] = id.clone();
            }
            end
        }
        "summary" if copied => {
            json!({"summary":c["text"],"summarizes":e.copies.iter().skip(1).filter(|id| session.entries.iter().any(|entry| &entry.id == *id)).collect::<Vec<_>>()})
        }
        "summary" => json!({"summary":c["text"]}),
        "settings" => json!({"key":"settings","value":settings_to_wire(c)}),
        "actor.grant" => {
            let mut grant = json!({"actor":{"id":c["actor"],"kind":c["kind"].as_str().unwrap_or("user"),"rights":c["authority"]}});
            if c["operatorAdmission"] == true || c["grantedBy"] == "operator" {
                grant["operatorAdmission"] = json!(true);
                v.as_object_mut().unwrap().remove("actorId");
            }
            grant
        }
        "actor.identity" => {
            json!({"actor":{"id":c["id"],"kind":c["kind"],"rights":Authority::full()}})
        }
        "actor.left" => c.clone(),
        "request.open" => {
            let q: Question = serde_json::from_value(c.clone())?;
            let mut request = json!({"id":q.id,"sessionId":q.scope.session,"kind":q.extra["kind"].as_str().map(|s|json!(s)).unwrap_or_else(||json!(q.kind)),"question":q.text,"answerable":q.answerable,"options":q.options});
            if q.covers_nested() {
                request["coversNested"] = json!(true);
            }
            if q.waits_for_approval() {
                request["askedBy"] = json!(q.scope.actor);
            }
            request["rust.route"] = json!(q.route);
            request["rust.responders"] = json!(q.responders);
            request["rust.extra"] = q.extra.clone();
            if let Some(call) = q.scope.call {
                request["toolCallId"] = json!(call);
            }
            if let Some(key) = q.key {
                request["key"] = json!(key);
            }
            if let Some(ms) = q.timeout_ms {
                request["timeLimitMs"] = json!(ms);
            }
            if let Some(name) = q.credential {
                request["credential"] = json!(name);
            }
            for k in [
                "details",
                "whenTimeLimit",
                "approvalWait",
                "deadlineAt",
                "answerers",
            ] {
                if let Some(value) = q.extra.get(k) {
                    request[k] = value.clone();
                }
            }
            v["requestId"] = json!(q.id);
            let mut data = json!({"request":request});
            for (native, shared) in [
                ("approvalCall", "call"),
                ("definition", "definition"),
                ("source", "source"),
            ] {
                if let Some(value) = optional(&q.extra, native) {
                    data[shared] = value.clone();
                }
            }
            data
        }
        "request.closed" | "request.invalidated" => {
            v["requestId"] = c["request"].clone();
            v.as_object_mut().unwrap().remove("actorId");
            let mut data = json!({"requestId":c["request"],"declined":true,"reason":c["reason"].as_str().unwrap_or("noLongerAnswerable"),"rust.closure":e.kind});
            if c["cause"] == "revoked" {
                data["cause"] = json!("revoked");
            }
            data
        }
        "request.secretAccepted" => {
            v["requestId"] = c["requestId"].clone();
            json!({"requestId":c["requestId"],"actorId":c["actorId"],"answerSession":c["answerSession"]})
        }
        "request.answer" => {
            let a: Answer = serde_json::from_value(c.clone())?;
            v["requestId"] = json!(a.request);
            let mut answer =
                json!({"requestId":a.request,"actorId":a.actor,"rust.answerSession":a.session});
            if a.declined {
                answer["declined"] = json!(true);
                if let Some(reason) = a.reason {
                    answer["reason"] = json!(reason);
                }
            } else if let Some(name) = a.value.get("credential") {
                answer["stored"] = name.clone();
            } else if !a.value.is_null() {
                answer["value"] = a.value;
            }
            if let Some(view) = c.get("approvalView") {
                answer["approvalView"] = view.clone();
            }
            answer
        }
        "runtime.private" if c["kind"].as_str().is_some_and(|k| k.contains('.')) => {
            v["kind"] = c["kind"].clone();
            v["writer"] = c.get("writer").cloned().unwrap_or(v["writer"].clone());
            if let Some(message) = c.get("message") {
                v["message"] = message.clone();
            }
            c["data"].clone()
        }
        _ => c.clone(),
    };
    if !data.is_null() {
        if matches!(e.kind.as_str(), "input.accepted" | "input") {
            v["inputId"] = data["inputId"].clone();
        }
        v["data"] = data;
    }
    Ok(v)
}

/// Rebuild a native working view from a session metadata object and kept order.
/// Synthetic call and step entries only exist in memory. They are never sent back.
pub fn session(meta: &Value, entries: &[Value]) -> Result<SessionData> {
    let id = string(meta, "id")?.to_owned();
    let mut data = SessionData {
        id: id.clone(),
        project: PathBuf::from(string(meta, "project")?),
        settings: json!({}),
        plugins: vec![],
        position: None,
        entries: vec![],
        origin: meta["parentSessionId"]
            .as_str()
            .or_else(|| meta["forkedFrom"]["sessionId"].as_str())
            .map(|s| {
                (
                    s.into(),
                    meta["forkedFrom"]["entryId"].as_str().map(str::to_owned),
                )
            }),
    };
    let mut calls = BTreeMap::<String, ToolCall>::new();
    let mut call_ids = BTreeSet::new();
    let mut steps = BTreeSet::new();
    let mut erased: BTreeSet<_> = entries
        .iter()
        .filter(|v| v["kind"] == "erasure")
        .flat_map(|v| {
            v["data"]["entryIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
        })
        .collect();
    erased.extend(
        entries
            .iter()
            .filter(|v| v["erased"] == true)
            .filter_map(|v| v["id"].as_str()),
    );
    let mut copied = data.origin.is_some();
    for v in entries {
        copied &= v["sources"]
            .as_array()
            .is_some_and(|sources| !sources.is_empty());
        let k = string(v, "kind")?;
        let mut payload = v["data"].clone();
        if matches!(k, "inputAccepted" | "input") && v["inputId"].is_string() && v["erased"] != true
        {
            if payload.is_null() {
                payload = json!({});
            }
            if let Some(fields) = payload.as_object_mut() {
                fields.insert("inputId".into(), v["inputId"].clone());
            }
        }
        let d = &payload;
        let field = |key: &str| v[key].as_str().map(str::to_owned);
        let mut e = Entry {
            id: string(v, "id")?.into(),
            parent: field("parentId"),
            scope: Scope {
                session: id.clone(),
                actor: field("actorId")
                    .or_else(|| {
                        d["startedBy"]["id"]
                            .as_str()
                            .filter(|_| d["startedBy"]["kind"] == "actor")
                            .map(str::to_owned)
                    })
                    .unwrap_or_else(|| {
                        if k == "toolResult"
                            && data.entries.iter().any(|checkpoint| {
                                interface_handoff(checkpoint)
                                    && v["sources"].as_array().is_some_and(|ids| {
                                        ids.iter().any(|id| id == &checkpoint.id)
                                    })
                            })
                        {
                            String::new()
                        } else {
                            "user".into()
                        }
                    }),
                turn: field("turnId"),
                step: field("stepId"),
                call: field("toolCallId"),
                job: field("jobId"),
            },
            writer: field("writer").unwrap_or_default(),
            at: v["time"].as_u64().unwrap_or(0),
            kind: k.into(),
            visible: v["modelVisible"] == true,
            copies: serde_json::from_value(optional(v, "sources").cloned().unwrap_or(json!([])))?,
            content: None,
        };
        if k == "position" && !erased.contains(e.id.as_str()) {
            data.position = d["to"].as_str().map(str::to_owned);
        } else {
            data.position = Some(e.id.clone());
        }
        if erased.contains(e.id.as_str())
            && !matches!(k, "actorJoined" | "actorLeft" | "limit" | "tenant")
        {
            e.kind = native_identity_kind(k).into();
            if k == "inputHandedBack" {
                let ids = v["inputId"]
                    .as_str()
                    .or_else(|| d["inputId"].as_str())
                    .map(|id| vec![id.to_owned()])
                    .or_else(|| {
                        serde_json::from_value::<Vec<String>>(
                            v.get("inputIds").unwrap_or(&d["inputIds"]).clone(),
                        )
                        .ok()
                    });
                if let Some(ids) = ids {
                    e.writer = "rust.tombstone.inputHandedBack".into();
                    e.copies = ids;
                }
            }
            e.visible = false;
            data.entries.push(e);
            continue;
        }
        // Recover the local authority identity for a report, but only when
        // its job and attribution agree with a committed job start.
        if matches!(k, "inputAccepted" | "input")
            && let Some(job) = &e.scope.job
            && d["key"] == format!("job:{job}")
            && data.entries.iter().any(|start| {
                start.kind == "job.start"
                    && start.scope.job.as_ref() == Some(job)
                    && start.scope.actor == e.scope.actor
            })
        {
            e.scope.actor = format!("job:{job}");
        }
        let (native, content) = match k {
            "inputAccepted" => {
                let content = input_content(d);
                let mut accepted = json!({"inputId":d["inputId"],"text":text(&content),"content":content,"timing":d["when"],"key":d["key"],
                    "releasedBy":d["releasedBy"],"submittedBy":d["submittedBy"],"authority":d["rust.authority"],"sponsor":d["rust.sponsor"],"taken":d.get("taken").unwrap_or(&d["rust.taken"]),"parked":d["parked"]});
                if let Some(shape) = d.get("rust.resultShape") {
                    accepted["resultShape"] = shape.clone();
                }
                ("input.accepted", accepted)
            }
            "inputHandedBack" => (
                "input.returned",
                if let Some(id) = v["inputId"].as_str().or_else(|| d["inputId"].as_str()) {
                    json!({"input":id})
                } else {
                    let ids = v.get("inputIds").unwrap_or(&d["inputIds"]);
                    json!({"inputIds":ids,"input":ids[0]})
                },
            ),
            "modelRequest" => ("model.request", d.clone()),
            "toolPending" => ("tool.pending", d.clone()),
            crate::recovery::STEP_AFTER => (crate::recovery::STEP_AFTER, d.clone()),
            "resultFeedback" => ("result.feedback", d.clone()),
            "plugins" => {
                data.plugins = d["active"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v["name"].as_str().map(str::to_owned))
                    .collect();
                ("plugins.changed", d.clone())
            }
            "jobStarted" => (
                "job.start",
                json!(Job {
                    id: string(v, "jobId")?.into(),
                    scope: e.scope.clone(),
                    owner: e.writer.clone(),
                    kind: string(d, "kind")?.into(),
                    detail: d["detail"].clone(),
                    key: d["key"].as_str().map(str::to_owned),
                    state: JobState::Running,
                    authority: serde_json::from_value(
                        optional(d, "rights")
                            .cloned()
                            .unwrap_or_else(|| json!(Authority::only(&["watch"])))
                    )?,
                    report: d["rust.report"] == true,
                    result: None,
                }),
            ),
            "jobCleanupUnconfirmed" => ("job.cleanup_unconfirmed", Value::Null),
            "jobEnded" => {
                let job = string(v, "jobId")?;
                let mut ended = data
                    .entries
                    .iter()
                    .find(|e| e.kind == "job.start" && e.scope.job.as_deref() == Some(job))
                    .and_then(|e| e.content.clone())
                    .unwrap_or_else(|| json!({"id":job}));
                ended["state"] = d.get("rust.state").cloned().unwrap_or_else(|| {
                    json!(match d["outcome"]["kind"].as_str() {
                        Some("completed") => "completed",
                        Some("cancelled") => "cancelled",
                        _ => "failed",
                    })
                });
                ended["report"] = d["report"].clone();
                ended["result"] = d.get("rust.result").cloned().unwrap_or_else(|| {
                    json!(TurnResult {
                        text: text(&d["result"]),
                        error: d["outcome"]["error"].as_str().map(str::to_owned),
                        ..Default::default()
                    })
                });
                ended["wireOutcome"] = d["outcome"].clone();
                if let Some(result) = optional(d, "result") {
                    ended["wireResult"] = result.clone();
                }
                ("job.end", ended)
            }
            "input" => {
                let input = string(d, "inputId")?;
                if !copied && !e.copies.iter().any(|id| id == input) {
                    e.copies.insert(0, input.into());
                }
                (
                    "input",
                    json!({"text":text(&v["message"]["content"]),"message":v["message"],"inputId":input,"key":d["key"],"sponsor":d["rust.sponsor"],"releasedBy":d["rust.releasedBy"],"authority":optional(d, "rust.authority").cloned().unwrap_or_else(||json!(Authority::full()))}),
                )
            }
            "turnStart" => {
                let mut m = d["model"].clone();
                m["name"] = m["id"].clone();
                let mut model = model(&m, &json!({}))?;
                if m["id"]
                    .as_str()
                    .is_some_and(|id| m["provider"] == native_provider(id))
                {
                    model.name = m["id"].as_str().unwrap().into();
                }
                let tools = d["tools"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(parse_definition)
                    .collect::<Result<Vec<_>>>()?;
                let mut settings = private_turn_settings(d)?;
                merge(&mut settings, recorded_settings(&d["settings"])?);
                if let Some(shape) = d.get("resultShape") {
                    settings["result_shape"] = shape.clone();
                }
                let mut start = json!({"startedBy":d["startedBy"],"model":model,"system":d["system"],"tools":tools,"settings":settings,"resume":optional(d, "rust.resume").cloned().unwrap_or(json!([])),"point":d["point"],"context":d["context"]});
                if let Some(origin) = optional(v, "continuesTurnId") {
                    start["continuesTurnId"] = origin.clone();
                }
                if let Some(trace) = d.get("traceContext") {
                    start["traceContext"] = trace.clone();
                }
                ("turn.start", start)
            }
            "response" => {
                let response = parse_response(v["message"].clone())?;
                let mut response = json!(response);
                if d["recovery"] == true {
                    response["recovery"] = json!(true);
                }
                ("model.response", response)
            }
            "toolStarted" => {
                let call = parse_call(&d["call"])?;
                (
                    "tool.started",
                    json!({"call":call,"safeToRepeat":d["safeToRepeat"]==true,"approvalCoveredBy":d["approvalCoveredBy"],"point":d["point"],"openWorld":d.get("openWorld").unwrap_or(&d["rust.openWorld"]),"source":d["source"],"definition":d["definition"],"authorizers":d["authorizers"],"rights":d["rights"]}),
                )
            }
            "toolResult" => {
                let r = parse_result(
                    json!({"status":d["status"],"value":d["value"],"content":v["message"]["content"]}),
                    e.scope.call.as_deref().unwrap_or_default(),
                )?;
                let mut value = json!(r);
                value["message"] = v["message"].clone();
                ("tool.result", value)
            }
            "turnEnd" => {
                let mut r = parse_outcome(&d["outcome"], &d["result"], &d["usage"])?;
                r.open_calls = d["result"]["openToolCalls"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| calls.get(v.as_str()?).cloned())
                    .collect();
                r.steps = steps
                    .iter()
                    .filter(|(turn, _): &&(Option<String>, Option<String>)| *turn == e.scope.turn)
                    .count();
                let mut end = json!(r);
                if let Some(id) = optional(d, "inputId") {
                    end["inputId"] = id.clone();
                }
                ("turn.end", end)
            }
            "summary" => {
                if copied && let Some(summarizes) = d.get("summarizes") {
                    e.copies
                        .extend(serde_json::from_value::<Vec<String>>(summarizes.clone())?);
                }
                ("summary", json!({"text":d["summary"]}))
            }
            "setting" => {
                let key = string(d, "key")?;
                let patch = if key == "settings" {
                    d["value"].clone()
                } else {
                    json!({(key):d["value"]})
                };
                if let Some(patch) = recorded_settings(&patch)?.as_object() {
                    for (k, v) in patch {
                        data.settings[k] = v.clone();
                    }
                }
                ("settings", data.settings.clone())
            }
            "actorJoined" => (
                "actor.grant",
                json!({"actor":d["actor"]["id"],"authority":d["actor"]["rights"],"kind":d["actor"]["kind"],"operatorAdmission":d["operatorAdmission"]}),
            ),
            "actorLeft" => ("actor.left", d.clone()),
            "inputRequest" => {
                let r = &d["request"];
                let kind = match r["kind"].as_str() {
                    Some("approval") => RequestKind::Approval,
                    Some("choice") => RequestKind::Choice,
                    Some("secret") => RequestKind::Secret,
                    _ => RequestKind::Text,
                };
                let mut q = Question::new(e.scope.clone(), kind, string(r, "question")?);
                q.id = string(r, "id")?.into();
                q.options =
                    serde_json::from_value(optional(r, "options").cloned().unwrap_or(json!([])))?;
                q.key = r["key"].as_str().map(str::to_owned);
                q.timeout_ms = r["timeLimitMs"].as_u64();
                q.credential = r["credential"].as_str().map(str::to_owned);
                q.answerable = r["answerable"] != false;
                q.route = serde_json::from_value(
                    optional(r, "rust.route").cloned().unwrap_or(json!([id])),
                )?;
                q.responders = serde_json::from_value(
                    optional(r, "rust.responders")
                        .cloned()
                        .unwrap_or(json!(["user"])),
                )?;
                q.extra = optional(r, "rust.extra").cloned().unwrap_or_else(|| {
                    // For a native request, no extra draft fields means the
                    // same thing before and after a restart. The kind is
                    // already stored separately from the draft.
                    if optional(r, "rust.route").is_some() {
                        return Value::Null;
                    }
                    let mut extra = json!({});
                    for k in ["kind", "details", "whenTimeLimit"] {
                        if let Some(value) = optional(r, k) {
                            extra[k] = value.clone();
                        }
                    }
                    extra
                });
                // Only the shared request field describes the view that was offered.
                if let Some(extra) = q.extra.as_object_mut() {
                    extra.remove("coversNested");
                }
                if q.kind == RequestKind::Approval && r["coversNested"] == true {
                    q.extra["coversNested"] = json!(true);
                }
                if r["approvalWait"] == "untilDeadline" {
                    for k in ["approvalWait", "deadlineAt", "whenTimeLimit", "answerers"] {
                        if let Some(v) = r.get(k) {
                            q.extra[k] = v.clone();
                        }
                    }
                    for (field, key) in [
                        ("call", "approvalCall"),
                        ("source", "source"),
                        ("definition", "definition"),
                    ] {
                        q.extra[key] = d[field].clone();
                    }
                }
                ("request.open", json!(q))
            }
            "inputAnswer"
                if d["declined"] == true
                    && (d["actorId"].is_null()
                        || matches!(
                            d["rust.closure"].as_str(),
                            Some("request.closed" | "request.invalidated")
                        )) =>
            {
                let mut data = json!({"request":d["requestId"],"reason":d["reason"]});
                if d["cause"] == "revoked" {
                    data["cause"] = json!("revoked");
                }
                (d["rust.closure"].as_str().unwrap_or("request.closed"), data)
            }
            "secretAnswerAccepted" => ("request.secretAccepted", d.clone()),
            "inputAnswer" => {
                let mut answer = json!(Answer {
                    request: string(d, "requestId")?.into(),
                    actor: string(d, "actorId")?.into(),
                    session: d["rust.answerSession"].as_str().unwrap_or(&id).into(),
                    value: optional(d, "stored")
                        .map(|name| json!({"credential":name}))
                        .unwrap_or_else(|| d["value"].clone()),
                    declined: d["declined"] == true,
                    reason: d["reason"].as_str().map(str::to_owned)
                });
                if let Some(v) = d.get("approvalView") {
                    answer["approvalView"] = v.clone();
                }
                ("request.answer", answer)
            }
            "position"
            | "erasure"
            | "tenant"
            | "limit"
            | telemetry::TURN_TRACE
            | INTERFACE_HANDOFF => (k, d.clone()),
            name if name.starts_with("rust.") => (&name[5..], d.clone()),
            _ => ("runtime.private", v.clone()),
        };
        e.kind = native.into();
        e.content = Some(content);
        let from_response = if native == "model.response" {
            serde_json::from_value::<ModelResponse>(e.content.clone().unwrap())?.tool_calls()
        } else {
            vec![]
        };
        // Direct calls in a foreign history can appear first as toolStarted.
        let direct = if native == "tool.started" {
            vec![serde_json::from_value(
                e.content.as_ref().unwrap()["call"].clone(),
            )?]
        } else {
            vec![]
        };
        if native == "step.start" || native == "model.response" {
            steps.insert((e.scope.turn.clone(), e.scope.step.clone()));
        }
        if native == "tool.call" {
            let c: ToolCall = serde_json::from_value(e.content.clone().unwrap())?;
            if call_ids.contains(&c.id) {
                data.entries.retain(|entry| {
                    !(entry.writer == "rust.derived"
                        && entry.kind == "tool.call"
                        && entry.scope.call.as_ref() == Some(&c.id))
                });
            }
            call_ids.insert(c.id.clone());
            calls.insert(c.id.clone(), c);
        }
        let base = e.clone();
        data.entries.push(e);
        for call in from_response.into_iter().chain(direct) {
            if call_ids.insert(call.id.clone()) {
                let scope = Scope {
                    call: Some(call.id.clone()),
                    ..base.scope.clone()
                };
                data.entries.push(Entry {
                    id: format!("{}.derived.{}", base.id, call.id),
                    parent: Some(base.id.clone()),
                    scope,
                    writer: "rust.derived".into(),
                    at: base.at,
                    kind: "tool.call".into(),
                    visible: false,
                    copies: vec![base.id.clone()],
                    content: Some(json!(call)),
                });
                calls.insert(call.id.clone(), call);
            }
        }
    }
    // Give reconstructed calls the same reachability as their source without becoming
    // heads or changing the parentId of any real entry.
    Ok(data)
}
