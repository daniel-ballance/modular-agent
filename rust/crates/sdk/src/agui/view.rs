use super::*;
use chrono::{DateTime, SecondsFormat};
use sha2::{Digest, Sha256};
#[derive(Clone)]
pub(super) struct Cursor {
    pub id: String,
    digest: [u8; 32],
    source: [u8; 32],
    count: usize,
    epoch: Option<String>,
    wait: Option<String>,
}
fn digest(v: &Value) -> [u8; 32] {
    Sha256::digest(v.to_string()).into()
}
pub(super) fn epoch(d: &SessionData) -> Option<String> {
    d.entries
        .iter()
        .rev()
        .find(|e| matches!(e.kind.as_str(), "erasure" | "position"))
        .map(|e| e.id.clone())
}
pub(super) fn iso(ms: u64) -> Option<String> {
    DateTime::from_timestamp_millis(i64::try_from(ms).ok()?)
        .map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true))
}
pub(super) fn assistant(step: &str) -> String {
    format!("ma:a:{step}")
}
fn parts(content: &Value) -> Value {
    let parts:Vec<_>=content.as_array().into_iter().flatten().filter_map(|p|match p["type"].as_str(){Some("text")=>Some(json!({"type":"text","text":p["text"].as_str()?})),Some("image")=>Some(json!({"type":"image","source":{"type":"data","value":p["data"].as_str()?,"mimeType":p["mimeType"].as_str()?}})),_=>None}).collect();
    if parts.iter().all(|v| v["type"] == "text") {
        json!(
            parts
                .iter()
                .filter_map(|p| p["text"].as_str())
                .collect::<String>()
        )
    } else {
        json!(parts)
    }
}
pub(super) fn interrupt(q: &base::Question, v: &Value, at: u64) -> Option<Value> {
    let mut interrupt = json!({"id":q.id,"reason":v["kind"],"message":v["question"]});
    interrupt["responseSchema"] = match q.kind {
        base::RequestKind::Approval => {
            interrupt["toolCallId"] = json!(q.scope.call);
            if let Some(call) = v.get("call") {
                interrupt["metadata"]["modular-agent.approvalCall"] = call.clone();
            }
            if q.covers_nested() {
                interrupt["metadata"]["modular-agent.coversNested"] = json!(true);
            }
            json!({"type":"object","properties":{"allow":{"type":"boolean"}},"required":["allow"],"additionalProperties":false})
        }
        base::RequestKind::Choice => json!({"type":"string","enum":v["options"]}),
        _ => json!({"type":"string"}),
    };
    if v["kind"] == "link" {
        let uri = v["details"]
            .as_str()
            .filter(|s| reqwest::Url::parse(s).is_ok())?;
        interrupt["metadata"] = json!({"modular-agent.link":uri});
    }
    if q.extra["whenTimeLimit"] == "decline"
        && let Some(ms) = q.timeout_ms
        && let Some(date) = iso(q.extra["deadlineAt"]
            .as_u64()
            .unwrap_or(at.saturating_add(ms)))
    {
        interrupt["expiresAt"] = json!(date);
    }

    Some(interrupt)
}
impl Service {
    // Replay has the same display gates as the live exchange. A terminal
    // snapshot is not an alternate channel for a withheld text stream.
    async fn replay_text(&self, a: &AguiActor, id: &str, step: &str, text: String) -> R<String> {
        if text.is_empty() {
            return Ok(text);
        }
        let message = assistant(step);
        let shared = self
            .gate(
                a,
                id,
                json!({"type":"text","data":{"stepId":step,"delta":text}}),
            )
            .await?;
        for frame in [
            json!({"type":"TEXT_MESSAGE_START","role":"assistant","messageId":message}),
            json!({"type":"TEXT_MESSAGE_END","messageId":message}),
        ] {
            if self.gate(a, id, frame.clone()).await? != frame {
                return Err(Fail::Withheld);
            }
        }
        let frame=self.gate(a,id,json!({"type":"TEXT_MESSAGE_CONTENT","messageId":message,"delta":shared["data"]["delta"]})).await?;
        Ok(frame["delta"].as_str().ok_or(Fail::Withheld)?.into())
    }
    pub(super) async fn messages(&self, a: &AguiActor, d: &SessionData) -> R<Value> {
        let mut messages = Vec::new();
        let mut settled = BTreeMap::new();
        let mut calls = BTreeMap::new();
        let branch = d.branch();
        for e in &branch {
            if e.content.is_none()
                || !matches!(
                    e.kind.as_str(),
                    "tool.started" | "tool.result" | "input" | "model.response"
                )
            {
                continue;
            }
            let row = base::portable::public_entry(e, d)?;
            let gated = match self.gate(a, &d.id, json!({"entry":row})).await {
                Ok(v) => v,
                Err(Fail::Withheld) => continue,
                Err(e) => return Err(e),
            };
            let row = &gated["entry"];
            let msg = &row["message"];
            match e.kind.as_str() {
                "input" => {
                    if let Some(id) = row["data"]["inputId"].as_str() {
                        messages.push(json!({"role":"user","id":format!("ma:u:{id}"),"content":parts(&msg["content"])}));
                    }
                }
                "model.response" => {
                    let Some(step) = e.scope.step.as_deref() else {
                        continue;
                    };
                    let text = match self
                        .replay_text(a, &d.id, step, base::wire::text(&msg["content"]))
                        .await
                    {
                        Ok(v) => v,
                        Err(Fail::Withheld) => String::new(),
                        Err(e) => return Err(e),
                    };
                    let id = assistant(step);
                    let mut m = json!({"id":id,"role":"assistant","content":text});
                    let ids: Vec<_> = msg["content"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|v| v["type"] == "toolCall")
                        .filter_map(|v| v["id"].as_str().map(str::to_owned))
                        .collect();
                    if !ids.is_empty() {
                        m["toolCalls"] = json!(ids);
                    }
                    messages.push(m);
                }
                "tool.started" => {
                    let call = &row["data"]["call"];
                    if !self
                        .agent
                        .inner
                        .interface_sources
                        .iter()
                        .any(|s| s.tools.iter().any(|t| t["name"] == call["name"]))
                        && let Some(id) = call["id"].as_str()
                    {
                        calls.insert(id.to_owned(),json!({"id":id,"type":"function","function":{"name":call["name"],"arguments":call["input"].to_string()}}));
                    }
                }
                // A nested or actor-initiated call has no assistant call part.
                // Its settlement is an entry, not a tool message in the conversation.
                "tool.result" if e.visible => {
                    let Some(id) = row["toolCallId"].as_str() else {
                        continue;
                    };
                    let content = parts(&msg["content"]);
                    let mut m = json!({"id":format!("ma:t:{id}"),"role":"tool","toolCallId":id,"content":content});
                    if row["data"]["status"] != "completed" {
                        m["error"] = json!(base::wire::text(&msg["content"]));
                        if m["error"] == "" {
                            m["error"] = json!("Tool did not complete.");
                        }
                    }
                    settled.insert(id.to_owned(), ());
                    messages.push(m);
                }
                _ => (),
            }
        }
        for m in &mut messages {
            if let Some(ids) = m.as_object_mut().unwrap().remove("toolCalls") {
                let list: Vec<_> = ids
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| {
                        let id = v.as_str()?;
                        settled.get(id)?;
                        calls.get(id)
                    })
                    .collect();
                if !list.is_empty() {
                    m["toolCalls"] = json!(list);
                }
            }
        }
        messages.retain(|m| {
            m["role"] != "assistant" || m["content"] != "" || m.get("toolCalls").is_some()
        });
        Ok(json!(messages))
    }
    pub(super) fn waits(&self, a: &AguiActor, d: &SessionData) -> R<Vec<(String, String, u64)>> {
        if !self.right(a, &d.id, "tools")? {
            return Ok(vec![]);
        }
        Ok(d.branch()
            .iter()
            .filter(|e| base::interface_handoff(e) && base::interface_result(d, e).is_none())
            .filter_map(|e| {
                let v = e.content.as_ref()?;
                let deadline = v["deadline"].as_u64()?;
                let turn = e.scope.turn.as_ref()?;
                let call = e.scope.call.as_ref()?;
                (v["executorActorId"] == a.id()
                    && v["routeId"] == a.client_id
                    && deadline > base::now()
                    && d.branch().iter().any(|end| {
                        end.kind == "turn.end"
                            && end.scope.turn.as_ref() == Some(turn)
                            && end
                                .content
                                .as_ref()
                                .and_then(|v| v["open_calls"].as_array())
                                .is_some_and(|list| list.iter().any(|v| v["id"] == *call))
                    }))
                .then(|| (turn.clone(), call.clone(), deadline))
            })
            .collect())
    }
    pub(super) async fn questions(
        &self,
        a: &AguiActor,
        d: &SessionData,
        c: &Client,
        offer: bool,
        snapshot: bool,
    ) -> R<Vec<(base::Question, Value)>> {
        let service = base::requests(self.h())?;
        let presence = c.presence.lock().unwrap().clone();
        let delivered = c.questions.lock().unwrap().clone();
        let mut result = vec![];
        for q in base::questions(d)?.into_iter().filter(|q| {
            q.answerable && q.kind != base::RequestKind::Secret && q.credential.is_none()
        }) {
            let approval = q.kind == base::RequestKind::Approval;
            let live = !d
                .entries
                .iter()
                .any(|e| e.kind == "turn.end" && e.scope.turn == q.scope.turn);
            if !self.right(a, &d.id, if approval { "approve" } else { "answer" })?
                || !service.eligible(self.h(), &q, &d.id, a.id())
                || ((live || approval)
                    && (presence.is_none()
                        || (!(offer || snapshot && q.waits_for_approval())
                            && delivered.get(&q.id) != Some(&presence))))
            {
                continue;
            }
            let shared = interface_acp::shared_question(q.clone());
            let view = self.gate(a, &d.id, json!({"question":shared})).await;
            let exact = view.as_ref().is_ok_and(|v| v["question"] == shared);
            if approval && !exact {
                if q.waits_for_approval() {
                    c.questions.lock().unwrap().remove(&q.id);
                } else if offer && let Some(route) = &presence {
                    service.detach_presence(&d.id, route);
                }
                continue;
            }
            let Ok(view) = view else { continue };
            let v = &view["question"];
            let at = d
                .entries
                .iter()
                .find(|e| {
                    e.kind == "request.open" && e.content.as_ref().is_some_and(|v| v["id"] == q.id)
                })
                .map_or(0, |e| e.at);
            let Some(interrupt) = interrupt(&q, v, at) else {
                continue;
            };
            result.push((q, interrupt));
        }
        Ok(result)
    }
    async fn snapshot_value(
        &self,
        a: &AguiActor,
        id: &str,
        c: &Client,
        d: &SessionData,
        token: &str,
        wait: Option<&str>,
    ) -> R<(Value, Cursor)> {
        let http = wait.is_some();
        let messages = self.messages(a, d).await?;
        let last = messages.as_array().and_then(|l| l.last()).map(|m| &m["id"]);
        let mut v = if http {
            let questions = self
                .questions(a, d, c, false, true)
                .await?
                .into_iter()
                .map(|(_, v)| v)
                .collect::<Vec<_>>();
            let calls = self
                .waits(a, d)?
                .into_iter()
                .map(|(_, call, deadline)| json!({"toolCallId":call,"expiresAt":iso(deadline)}))
                .collect::<Vec<_>>();
            json!({"threadId":id,"declaration":self.agent.declaration_for(Some(id),false).map_err(|_|Fail::Lost)?,"messages":messages,"cursor":token,"waitCursor":wait,"lastMessageId":last,"waiting":{"questions":questions,"toolCalls":calls}})
        } else {
            json!({"type":"MESSAGES_SNAPSHOT","messages":messages})
        };
        if http && self.agent.inner.persistent {
            v["runReceipts"] = json!(1);
        }
        let waiting = v.get("waiting").cloned();
        let view = self.gate(a, id, v).await?;
        if http
            && (view["cursor"] != token
                || view.get("runReceipts")
                    != (self.agent.inner.persistent).then(|| json!(1)).as_ref()
                || view["waitCursor"] != json!(wait)
                || view["lastMessageId"] != json!(last)
                || view.get("waiting") != waiting.as_ref())
        {
            return Err(Fail::Withheld);
        }
        let count = view["messages"].as_array().ok_or(Fail::Withheld)?.len();
        if count != messages.as_array().unwrap().len()
            || view["messages"]
                .as_array()
                .unwrap()
                .iter()
                .zip(messages.as_array().unwrap())
                .any(|(m, b)| m["id"] != b["id"] || m["role"] != b["role"])
        {
            return Err(Fail::Withheld);
        }
        let cursor = Cursor {
            id: token.into(),
            digest: digest(&view["messages"]),
            source: digest(&messages),
            count,
            epoch: epoch(d),
            wait: wait.map(str::to_owned),
        };
        Ok((view, cursor))
    }
    pub(super) async fn reconcile(
        &self,
        a: &AguiActor,
        d: &SessionData,
        c: &Client,
        token: Option<&str>,
        copy: &[Value],
    ) -> R<usize> {
        let saved = c.cursor.lock().unwrap().clone();
        let Some(saved) = saved else {
            if token.is_some() {
                return Err(Fail::Cursor);
            }
            return if self.messages(a, d).await? == json!([]) {
                Ok(0)
            } else {
                Err(Fail::Conflict)
            };
        };
        if token.is_some_and(|s| s != saved.id) {
            return Err(Fail::Cursor);
        }
        let (view, current) = self
            .snapshot_value(a, &d.id, c, d, &saved.id, saved.wait.as_deref())
            .await?;
        if current.epoch != saved.epoch
            || current.source != saved.source
            || current.digest != saved.digest
            || copy.len() < saved.count
            || !base::wire::json_eq(&json!(&copy[..saved.count]), &view["messages"])
        {
            return Err(Fail::Conflict);
        }
        Ok(saved.count)
    }
    pub(super) async fn http_snapshot(&self, a: &AguiActor, id: &str, c: &Client) -> R<Response> {
        let d = self.watch(a, id)?;
        let presence = c.presence.lock().unwrap().clone();
        let waiting: Vec<_> = base::questions(&d)?
            .into_iter()
            .filter(base::Question::waits_for_approval)
            .map(|q| q.id)
            .collect();
        c.questions
            .lock()
            .unwrap()
            .retain(|id, _| !waiting.contains(id));
        let (v, cursor) = self
            .snapshot_value(a, id, c, &d, &base::id(), Some(&base::id()))
            .await?;
        let bytes = self.buffer(id, encode(&v)?)?;
        if d.position != self.watch(a, id)?.position {
            return Err(Fail::Conflict);
        }
        for q in v["waiting"]["questions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|q| waiting.iter().any(|id| q["id"] == *id))
        {
            let qid = q["id"].as_str().ok_or(Fail::Withheld)?;
            let route = self.waiting_route(a, c, presence.as_deref().ok_or(Fail::Conflict)?)?;
            if !self.h().deliver_approval(id, qid, &route).await? {
                return Err(Fail::Conflict);
            }
            c.questions
                .lock()
                .unwrap()
                .insert(qid.into(), presence.clone());
        }
        c.wait_cursors
            .lock()
            .unwrap()
            .record(cursor.wait.clone().unwrap(), reads::Boundary::snapshot(&d));
        *c.cursor.lock().unwrap() = Some(cursor);
        Ok(reply(200, "application/json", Body::from(bytes)))
    }
    pub(super) async fn snapshot_pair(
        &self,
        a: &AguiActor,
        id: &str,
        c: &Client,
        d: &SessionData,
    ) -> R<(Vec<Value>, Cursor)> {
        let (v, cur) = self.snapshot_value(a, id, c, d, &base::id(), None).await?;
        let last = v["messages"].as_array().unwrap().last().map(|m| &m["id"]);
        let after = json!({"type":"CUSTOM","name":"modular-agent.history","value":{"cursor":cur.id,"lastMessageId":last}});
        if self.gate(a, id, after.clone()).await? != after {
            return Err(Fail::Withheld);
        }
        Ok((vec![v, after], cur))
    }
}
