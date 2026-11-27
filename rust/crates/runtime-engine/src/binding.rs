//! Turn execution over the small, asynchronous Runtime host port.
use agent_api::{recovery::*, *};
use futures_util::{StreamExt, stream::FuturesUnordered};
use std::collections::{BTreeMap, BTreeSet};

#[async_trait]
pub trait Host: Sync {
    async fn ask(&self, method: &str, params: Value, cancellable: bool) -> Result<Value>;
    async fn model(&self, step: &Value, request: &Value) -> Result<Value> {
        self.ask("model", json!({"stepId":step,"request":request}), true)
            .await
    }
    async fn history(&self, session: &Value, after: Option<&Value>) -> Result<Value>;
    async fn history_all(&self, session: &Value, after: Option<&Value>) -> Result<Value> {
        self.history(session, after).await
    }
    fn history_select(&self) -> bool {
        false
    }
    async fn selected_history(
        &self,
        _session: &Value,
        _after: Option<&Value>,
        _all: bool,
        _select: &Value,
    ) -> Result<Value> {
        bail!("history selectors are unavailable")
    }
    fn cancelled(&self) -> bool;
    fn entries(&self) -> Value;
}

#[derive(Debug)]
pub struct InvalidResume(pub String);
impl std::fmt::Display for InvalidResume {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for InvalidResume {}

#[derive(Debug)]
pub struct TurnLimit(pub String);
impl std::fmt::Display for TurnLimit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "turn limit: {}", self.0)
    }
}
impl std::error::Error for TurnLimit {}

pub fn registration(durable: bool) -> Value {
    json!({"id": if durable {"durable"} else {"transient"},"supports":{"inputDuringTurn":true,"waitingThroughRestart":durable,"continuesAfterRestart":durable,"interfaceTools":true,"rewinding":false}})
}

pub async fn run(host: &dyn Host, method: &str, p: Value, durable: bool) -> Result<Value> {
    let t = &p["turn"];
    ensure!(
        t["turnId"].is_string() && t["sessionId"].is_string(),
        "missing turn identity"
    );
    let mut prior = vec![];
    if method == "runtime/resumeTurn" {
        prior = recovery_history(host, t, durable).await?;
    }
    let restored = if method == "runtime/resumeTurn" && durable {
        validate_resume(&p, &prior).map_err(|e| InvalidResume(e.to_string()))?
    } else {
        None
    };
    let mut turn = Turn {
        host,
        usage: json!({"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0}),
        writer: if durable {
            "runtime.durable"
        } else {
            "runtime.transient"
        },
        open: vec![],
    };
    for e in &prior {
        if e["kind"] == "response" && !is_auxiliary_response(e, &prior) {
            turn.add_usage(&e["message"]["usage"]);
        }
    }
    let mut result = match turn.execute(method, &p, durable, &prior, restored).await {
        Ok(value) => value,
        Err(e) => {
            if let Some(limit) = e.downcast_ref::<TurnLimit>() {
                json!({"kind":"limit","limit":limit.0})
            } else {
                json!({"kind":"failed","error":e.to_string()})
            }
        }
    };
    if host.cancelled() {
        result = json!({"kind":"cancelled"});
        turn.open.clear();
    }
    let text = result.as_object_mut().and_then(|o| o.remove("text"));
    let value = result.as_object_mut().and_then(|o| o.remove("value"));
    let mut output = json!({"openToolCalls":turn.open});
    if let Some(text) = text {
        output["text"] = text;
    }
    if let Some(value) = value {
        output["value"] = value;
    }
    let _ = turn
        .hook(
            "turn.end",
            &Value::Null,
            json!({"outcome":result,"result":output,"usage":turn.usage}),
        )
        .await;
    Ok(json!({"outcome":result,"result":output,"entries":host.entries(),"usage":turn.usage}))
}

struct Turn<'a> {
    host: &'a dyn Host,
    usage: Value,
    writer: &'static str,
    open: Vec<String>,
}
fn array(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
async fn recovery_history(host: &dyn Host, turn: &Value, durable: bool) -> Result<Vec<Value>> {
    let session = &turn["sessionId"];
    let turn_id = &turn["turnId"];
    let selector = json!({"turnId":turn_id});
    let selected = host.history_select().then_some(&selector);
    let mut branch = read_history(host, session, false, selected).await?;
    branch.retain(|e| e["turnId"] == *turn_id);
    if selected.is_some() {
        let start = branch
            .iter()
            .find(|e| e["kind"] == "turnStart" && e["erased"] != true)
            .ok_or_else(|| {
                InvalidResume("Cannot establish the interrupted turn checkpoint".into())
            })?;
        if start["continuesTurnId"].is_null()
            && !branch
                .iter()
                .find(|e| e["kind"] == "input")
                .is_some_and(|e| e["erased"] != true)
        {
            return Err(InvalidResume("Cannot establish the interrupted turn input".into()).into());
        }
    }
    if !durable {
        return Ok(branch);
    }

    // Branch choice selects the answered step. Kept history also proves gate
    // decisions and global terminal facts, including erased result envelopes.
    let kept = if selected.is_some() {
        let mut calls: BTreeSet<String> = branch
            .iter()
            .flat_map(|e| {
                e["toolCallId"].as_str().into_iter().chain(
                    array(&e["message"]["content"])
                        .iter()
                        .filter(|part| e["kind"] == "response" && part["type"] == "toolCall")
                        .filter_map(|part| part["id"].as_str()),
                )
            })
            .map(str::to_owned)
            .collect();
        if let Some(origin_id) = branch
            .iter()
            .find(|e| e["kind"] == "turnStart")
            .and_then(|e| e["continuesTurnId"].as_str())
        {
            let origin =
                read_history(host, session, false, Some(&json!({"turnId":origin_id}))).await?;
            let open = origin
                .iter()
                .find(|e| e["turnId"] == origin_id && e["kind"] == "turnEnd" && e["erased"] != true)
                .and_then(|e| e["data"]["result"]["openToolCalls"].as_array())
                .ok_or_else(|| {
                    InvalidResume("Cannot establish the originating turn checkpoint".into())
                })?;
            for id in open {
                calls.insert(
                    id.as_str()
                        .filter(|id| !id.is_empty())
                        .ok_or_else(|| InvalidResume("Invalid originating call ID".into()))?
                        .to_owned(),
                );
            }
        }
        let calls: Vec<_> = calls.into_iter().collect();
        let mut kept = Vec::new();
        for (index, ids) in calls.chunks(64).enumerate() {
            let mut select = json!({"toolCallIds":ids});
            if index == 0 {
                select["turnId"] = turn_id.clone();
            }
            kept.extend(read_history(host, session, true, Some(&select)).await?);
        }
        if calls.is_empty() {
            kept = read_history(host, session, true, selected).await?;
        }
        kept
    } else {
        read_history(host, session, true, None).await?
    };
    branch.retain(|e| !matches!(e["kind"].as_str(), Some("toolResult" | STEP_AFTER)));
    let mut seen = BTreeSet::new();
    branch.extend(kept.into_iter().filter(|e| {
        (e["kind"] == "toolResult" || (e["kind"] == STEP_AFTER && e["turnId"] == *turn_id))
            && e["id"].as_str().is_none_or(|id| seen.insert(id.to_owned()))
    }));
    Ok(branch)
}

async fn read_history(
    host: &dyn Host,
    session: &Value,
    all: bool,
    select: Option<&Value>,
) -> Result<Vec<Value>> {
    let mut entries = vec![];
    let mut seen = BTreeSet::new();
    let mut cursor = None;
    loop {
        let page = if let Some(select) = select {
            host.selected_history(session, cursor.as_ref(), all, select)
                .await?
        } else if all {
            host.history_all(session, cursor.as_ref()).await?
        } else {
            host.history(session, cursor.as_ref()).await?
        };
        entries.extend(
            page["entries"]
                .as_array()
                .ok_or_else(|| anyhow!("missing history entries"))?
                .iter()
                .cloned(),
        );
        let Some(next) = wire::optional(&page, "next") else {
            return Ok(entries);
        };
        ensure!(
            next.as_str().is_some_and(|id| seen.insert(id.to_owned())),
            "history cursor did not advance"
        );
        cursor = Some(next.clone());
    }
}

fn validate_resume(p: &Value, old: &[Value]) -> Result<Option<(Value, Value)>> {
    let interrupted = &p["interrupted"];
    ensure!(
        interrupted["turnId"] == p["turn"]["turnId"],
        "interrupted turn does not match"
    );
    let step = last_answered_step(old)?;
    match (&step, interrupted.get("lastStep")) {
        (None, None) => {}
        (Some((_, expected)), Some(supplied)) if same_json(expected, supplied) => {}
        _ => bail!("lastStep disagrees with checkpoint"),
    }

    let calls = interrupted["calls"]
        .as_array()
        .ok_or_else(|| anyhow!("missing interrupted calls"))?;
    let mut expected = BTreeMap::new();
    for response in old.iter().filter(|e| {
        e["kind"] == "response"
            && e["data"]["recovery"] != true
            && !is_auxiliary_response(e, old)
            && matches!(
                e["message"]["stop"].as_str(),
                Some("end" | "finished" | "stop" | "toolUse")
            )
    }) {
        for call in array(&response["message"]["content"])
            .iter()
            .filter(|c| c["type"] == "toolCall")
        {
            let id = wire::string(call, "id")?;
            if old.iter().any(|e| {
                matches!(
                    e["kind"].as_str(),
                    Some("toolResult" | "toolPending" | INTERFACE_HANDOFF)
                ) && e["toolCallId"] == id
            }) {
                continue;
            }
            ensure!(
                expected.insert(id, (response, call)).is_none(),
                "duplicate interrupted call"
            );
        }
    }
    for call in calls {
        let id = wire::string(call, "id")?;
        let (response, original) = expected
            .remove(id)
            .ok_or_else(|| anyhow!("unexpected interrupted call"))?;
        let started = old
            .iter()
            .rev()
            .find(|e| e["kind"] == "toolStarted" && e["toolCallId"] == id);
        ensure!(
            call["stepId"] == response["stepId"]
                && call["name"] == original["name"]
                && same_json(&call["input"], &original["arguments"])
                && call["started"] == json!(started.is_some())
                && call["safeToRepeat"].is_boolean()
                && started.is_none_or(
                    |e| e["data"]["safeToRepeat"] == true && call["safeToRepeat"] == true
                ),
            "interrupted call disagrees with checkpoint or is ineligible"
        );
    }
    ensure!(
        expected.is_empty(),
        "answered step has unsettled calls missing from resume"
    );
    Ok(step.map(|(response, checkpoint)| (response["message"].clone(), checkpoint)))
}
fn text(v: &Value) -> String {
    array(v)
        .iter()
        .filter(|p| p["type"] == "text")
        .filter_map(|p| p["text"].as_str())
        .collect()
}
fn call_id(call: &Value) -> &str {
    call["id"].as_str().unwrap_or("")
}
impl Turn<'_> {
    async fn record(
        &mut self,
        kind: &str,
        step: &Value,
        call: &Value,
        visible: bool,
        message: Value,
        data: Value,
    ) -> Result<()> {
        let mut entry =
            json!({"kind":kind,"writer":self.writer,"modelVisible":visible,"data":data});
        if !message.is_null() {
            entry["message"] = message;
        }
        if !step.is_null() {
            entry["stepId"] = step.clone();
        }
        if !call.is_null() {
            entry["toolCallId"] = call.clone();
        }
        self.host
            .ask("record", json!({"entry":entry}), false)
            .await?;
        Ok(())
    }
    async fn hook(&self, name: &str, step: &Value, payload: Value) -> Result<Value> {
        let mut payload = payload;
        if !step.is_null() {
            payload["stepId"] = step.clone();
        }
        self.host
            .ask(
                "hook",
                json!({"hook":name,"stepId":step,"payload":payload}),
                name != "turn.end" && name != "tool.after",
            )
            .await
    }
    fn add_usage(&mut self, value: &Value) {
        for key in ["input", "output", "cacheRead", "cacheWrite"] {
            self.usage[key] =
                json!(self.usage[key].as_u64().unwrap_or(0) + value[key].as_u64().unwrap_or(0));
        }
        self.usage["cost"] =
            json!(self.usage["cost"].as_f64().unwrap_or(0.) + value["cost"].as_f64().unwrap_or(0.));
    }
    async fn batch(&mut self, calls: Vec<Value>, recovering: bool) -> Result<()> {
        let mut jobs = vec![];
        let mut ids = BTreeSet::new();
        for call in calls {
            ensure!(
                !call_id(&call).is_empty() && ids.insert(call_id(&call).to_owned()),
                "invalid or duplicate tool call id"
            );
            let definition = self
                .host
                .ask("definition", json!({"toolName":call["name"]}), true)
                .await?;
            jobs.push((call, definition));
        }
        let first = self.open.len();
        let parallel = jobs.iter().all(|(_, d)| d["parallel"] == true);
        let host = self.host;
        let one = |(call, def): &(Value, Value)| {
            let call = call.clone();
            let def = def.clone();
            async move {
                let result = run_tool(host, &call, &def, recovering).await;
                (call, result)
            }
        };
        if parallel {
            let mut results: FuturesUnordered<_> = jobs.iter().map(one).collect();
            while let Some((call, result)) = results.next().await {
                self.keep_pending(&call, &result?);
            }
            self.open[first..]
                .sort_by_key(|id| jobs.iter().position(|(call, _)| call_id(call) == id));
        } else {
            for job in &jobs {
                let (call, result) = one(job).await;
                self.keep_pending(&call, &result?);
            }
        }
        Ok(())
    }

    fn keep_pending(&mut self, call: &Value, result: &Value) {
        if result["pending"].is_string() {
            self.open.push(call_id(call).into());
        }
    }

    async fn execute(
        &mut self,
        method: &str,
        p: &Value,
        durable: bool,
        old: &[Value],
        restored: Option<(Value, Value)>,
    ) -> Result<Value> {
        let turn = &p["turn"];
        let interrupted = &p["interrupted"];
        let limit = turn["settings"]["maxSteps"].as_u64().unwrap_or(12);
        let mut from = 0;
        let mut reuse = None;
        let mut exact = None;
        if method == "runtime/resumeTurn" {
            let settled: BTreeSet<_> = old
                .iter()
                .filter(|e| e["kind"] == "toolResult")
                .filter_map(|e| e["toolCallId"].as_str())
                .collect();
            let calls: Vec<_> = array(&interrupted["calls"])
                .iter()
                .filter(|call| !settled.contains(call_id(call)))
                .cloned()
                .collect();
            ensure!(
                interrupted["turnId"] == turn["turnId"],
                "interrupted turn does not match"
            );
            if !durable {
                return Ok(
                    json!({"kind":"failed","error":"transient turn interrupted by process exit"}),
                );
            }
            let steps: BTreeSet<_> = old
                .iter()
                .filter(|e| e["kind"] == "response" && !is_auxiliary_response(e, old))
                .filter_map(|e| e["stepId"].as_str())
                .collect();
            from = steps.len() as u64;
            if from == 0 && !calls.is_empty() {
                from = 1;
            }
            let in_flight = old.iter().rev().find(|e| {
                e["kind"] == "modelRequest"
                    && e["data"]["auxiliary"] != true
                    && !old
                        .iter()
                        .any(|r| r["kind"] == "response" && r["stepId"] == e["stepId"])
            });
            if let Some(entry) = in_flight {
                ensure!(
                    entry["data"]["safeToRepeat"] == true && entry["data"]["request"].is_object(),
                    "Interrupted model request was not safe to repeat"
                );
                exact = Some(entry["data"]["request"].clone());
            }
            if let Some((response, checkpoint)) = restored {
                reuse = Some((
                    checkpoint["stepId"].clone(),
                    response,
                    checkpoint.get("decision").cloned(),
                ));
                from = from.saturating_sub(1);
            } else if exact.is_none()
                && calls.is_empty()
                && turn["modelSupports"]["runsTools"] == true
            {
                bail!("Cannot establish whether an interrupted model request was safe to repeat");
            }
            for pending in old
                .iter()
                .filter(|e| e["kind"] == "toolPending" || e["kind"] == INTERFACE_HANDOFF)
            {
                if let Some(id) = pending["toolCallId"].as_str()
                    && !settled.contains(id)
                {
                    self.open.push(id.into());
                }
            }
            self.batch(calls, true).await?;
            let order: Vec<_> = old
                .iter()
                .filter(|e| e["kind"] == "response")
                .flat_map(|e| array(&e["message"]["content"]))
                .filter(|part| part["type"] == "toolCall")
                .map(call_id)
                .collect();
            self.open.sort_by_key(|id| {
                order
                    .iter()
                    .position(|call| call == id)
                    .unwrap_or(usize::MAX)
            });
        } else {
            self.hook("turn.start", &Value::Null, json!({})).await?;
            if method == "runtime/continueOpenCalls" {
                self.batch(array(&p["calls"]).to_vec(), false).await?;
            }
        }
        if !self.open.is_empty() && reuse.is_none() {
            return Ok(json!({"kind":"completed"}));
        }
        // Resolving an existing step does not spend a new attempt.
        let until = if reuse.is_some() {
            limit.max(from.saturating_add(1))
        } else {
            limit
        };
        for _ in from..until {
            if self.host.cancelled() {
                break;
            }
            let (step, response, resumed, decision) =
                if let Some((step, response, decision)) = reuse.take() {
                    (step, response, true, decision)
                } else {
                    let step = self.host.ask("newId", json!({}), true).await?["id"].clone();
                    let request = if let Some(exact) = exact.take() {
                        exact
                    } else {
                        self.host.ask("takeSteering", json!({}), true).await?;
                        self.host
                            .ask(
                                "prepareStep",
                                json!({"stepId":step,"usage":self.usage}),
                                true,
                            )
                            .await?
                    };
                    let (step, response) = self.request(step, request).await?;
                    (step, response, false, None)
                };
            if !resumed && (response["stop"] == "failed" || response["stop"] == "aborted") {
                return Ok(if self.host.cancelled() {
                    json!({"kind":"cancelled"})
                } else {
                    json!({"kind":"failed","error":response["error"]["message"].as_str().unwrap_or("model attempt ended without an answer")})
                });
            }
            let calls: Vec<_> = array(&response["content"])
                .iter()
                .filter(|c| {
                    matches!(response["stop"].as_str(), Some("toolUse" | "finished"))
                        && c["type"] == "toolCall"
                })
                .map(|c| {
                    let mut call = c.clone();
                    let o = call.as_object_mut().unwrap();
                    o.remove("type");
                    call["input"] = o.remove("arguments").unwrap_or(json!({}));
                    call["startedBy"] = json!("model");
                    call["stepId"] = step.clone();
                    call
                })
                .collect();
            let had_calls = !calls.is_empty();
            if !resumed {
                self.batch(calls, false).await?;
            }
            let gate = match decision {
                Some(decision) => json!({"refused":decision["refuse"]}),
                None => {
                    self.hook("step.after", &step, json!({"response":response}))
                        .await?
                }
            };
            let mut end = json!({"kind":"completed","text":text(&response["content"])});
            let carry = if response["stop"] == "length" {
                end["kind"] = json!("limit");
                end["limit"] = json!("output");
                false
            } else if let Some(reason) = gate["refused"].as_str() {
                end = json!({"kind":"failed","error":reason});
                false
            } else if response["stop"] == "failed" || response["stop"] == "aborted" {
                end = json!({"kind":"failed","error":response["error"]["message"].as_str().unwrap_or("model attempt ended without an answer")});
                false
            } else if response["stop"] == "refused" {
                end["kind"] = json!("failed");
                false
            } else if !self.open.is_empty() {
                false
            } else if exact.is_some()
                || had_calls
                || self.host.ask("hasSteering", json!({}), true).await?["waiting"] == true
            {
                true
            } else {
                let mut result = json!({"text":end["text"]});
                if let Some(value) = response.get("value") {
                    end["value"] = value.clone();
                    result["value"] = value.clone();
                }
                let gate = self
                    .hook(
                        "turn.result",
                        &step,
                        json!({"result":result,"shape":turn["resultShape"]}),
                    )
                    .await?;
                if gate["refused"].is_string() {
                    true
                } else {
                    let final_check = self
                        .host
                        .ask("takeSteering", json!({"final":true}), true)
                        .await?;
                    !array(&final_check["entries"]).is_empty()
                }
            };
            if !carry {
                return Ok(end);
            }
        }
        Ok(json!({"kind":"limit","limit":"steps"}))
    }
    async fn request(&mut self, mut step: Value, mut request: Value) -> Result<(Value, Value)> {
        for attempt in 0..2 {
            let response = self.host.model(&step, &request).await?;
            self.add_usage(&response["usage"]);
            self.record(
                "response",
                &step,
                &Value::Null,
                true,
                response.clone(),
                Value::Null,
            )
            .await?;
            if response["stop"] != "failed" || self.host.cancelled() {
                return Ok((step, response));
            }
            let retry = self
                .hook(
                    "model.failed",
                    &step,
                    json!({"error":response["error"],"request":request}),
                )
                .await?;
            let after = self
                .hook("step.after", &step, json!({"response":response}))
                .await?;
            if retry["retry"] != true || after["refused"].is_string() || attempt == 1 {
                return Ok((step, response));
            }
            step = self.host.ask("newId", json!({}), true).await?["id"].clone();
            request = if retry["request"].is_object() {
                retry["request"].clone()
            } else {
                self.host
                    .ask(
                        "prepareStep",
                        json!({"stepId":step,"usage":self.usage}),
                        true,
                    )
                    .await?
            };
        }
        unreachable!()
    }
}

async fn run_tool(host: &dyn Host, call: &Value, def: &Value, recovering: bool) -> Result<Value> {
    ensure!(
        !recovering || call["started"] != true || call["safeToRepeat"] == true,
        "ineligible repeat"
    );
    ensure!(!host.cancelled(), "turn cancelled");
    let mut call = call.clone();
    call.as_object_mut().unwrap().remove("started");
    call.as_object_mut().unwrap().remove("safeToRepeat");
    if !call["startedBy"].is_string() {
        call["startedBy"] = json!("model");
    }
    let step = call["stepId"].clone();
    let gate = host
        .ask(
            "hook",
            json!({"hook":"tool.before","stepId":step,"payload":{"call":call,"definition":def}}),
            true,
        )
        .await?;
    let result = if gate["refused"].is_string() {
        let result = gate
            .get("result")
            .ok_or_else(|| anyhow!("missing committed tool result"))?;
        ensure!(
            result["callId"] == call["id"]
                && matches!(
                    result["status"].as_str(),
                    Some("refused" | "cancelled" | "outcomeUnknown" | "notStarted" | "failed")
                )
                && result["content"].is_array(),
            "invalid committed tool result"
        );
        result.clone()
    } else if gate["pending"].is_string() || gate["pending"] == true {
        return Ok(json!({"callId":call["id"],"pending":"waiting for answer"}));
    } else {
        if let Some(changed) = gate["value"]["call"].as_object() {
            let changed = Value::Object(changed.clone());
            ensure!(
                changed["id"] == call["id"] && changed["name"] == call["name"],
                "tool hook changed call identity"
            );
            call["input"] = changed["input"].clone();
        }
        host.ask("runToolCall", json!({"call":call}), true).await?
    };
    if result["pending"].is_string() {
        return Ok(result);
    }
    if host.cancelled() {
        return Ok(result);
    }
    let reply = host
        .ask(
            "hook",
            json!({"hook":"tool.after","stepId":step,"payload":{"call":call,"result":result}}),
            false,
        )
        .await;
    let reply = reply?;
    let result = wire::optional(&reply, "result").cloned().unwrap_or(result);
    ensure!(
        result["callId"] == call["id"],
        "tool result changed call identity"
    );
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_rejects_missing_or_conflicting_gate_state_and_unsettled_unsafe_call() {
        let call = json!({"id":"c","name":"bash","input":{},"stepId":"s","started":true,"safeToRepeat":false});
        let mut history = vec![
            json!({"kind":"modelRequest","stepId":"s","data":{"tools":[]}}),
            json!({"kind":"response","stepId":"s","message":{"role":"assistant","stop":"toolUse",
                "content":[{"type":"toolCall","id":"c","name":"bash","arguments":{}}]}}),
            json!({"kind":"toolStarted","toolCallId":"c","data":{"safeToRepeat":false}}),
        ];
        let mut params = json!({"turn":{"turnId":"t"},"interrupted":{"turnId":"t","calls":[call],"lastStep":{"stepId":"s"}}});
        assert!(validate_resume(&params, &history).is_err());
        params["interrupted"]["calls"] = json!([]);
        assert!(validate_resume(&params, &history).is_err());

        history
            .push(json!({"kind":"toolResult","toolCallId":"c","data":{"status":"outcomeUnknown"}}));
        assert!(validate_resume(&params, &history).is_ok());
        history.push(json!({"kind":STEP_AFTER,"stepId":"s","data":{"decision":null}}));
        assert!(validate_resume(&params, &history).is_err());
        params["interrupted"]["lastStep"]["decision"] = Value::Null;
        assert!(validate_resume(&params, &history).is_ok());
        params["interrupted"]
            .as_object_mut()
            .unwrap()
            .remove("lastStep");
        assert!(validate_resume(&params, &history).is_err());
    }
}
