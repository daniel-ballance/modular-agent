//! Gated events become ACP updates; questions never bypass the request service.
//! https://agentclientprotocol.com/protocol/v1/tool-calls
//! https://agentclientprotocol.com/protocol/v1/elicitation
use super::*;
use std::collections::BTreeSet;
use tokio::sync::{mpsc, oneshot};
pub(crate) enum Message {
    Event(Box<Event>, Box<dyn Send>),
    Flush(oneshot::Sender<()>),
}
pub(crate) fn notify(cx: &ConnectionTo<acp::Client>, id: &str, update: Value) -> Result<()> {
    let notification: SessionNotification =
        serde_json::from_value(json!({"sessionId":id,"update":update}))?;
    cx.send_notification(notification)?;
    Ok(())
}
fn progress_blocks(content: &Value) -> Vec<Value> {
    let Some(parts) = content.as_array() else {
        return vec![
            json!({"type":"content","content":{"type":"text","text":content.as_str().unwrap_or("")}}),
        ];
    };
    parts
        .iter()
        .filter(|part| match part["type"].as_str() {
            Some("text") => part["text"].is_string(),
            Some("image" | "audio") => part["data"].is_string() && part["mimeType"].is_string(),
            _ => false,
        })
        .map(|part| json!({"type":"content","content":part}))
        .collect()
}
fn text(cx: &ConnectionTo<acp::Client>, id: &str, kind: &str, value: &str) -> Result<()> {
    if !value.is_empty() {
        notify(
            cx,
            id,
            json!({"sessionUpdate":kind,"content":{"type":"text","text":value}}),
        )?;
    }
    Ok(())
}
pub(crate) async fn pump(
    session: Arc<Session>,
    mut rx: mpsc::Receiver<Message>,
    cx: ConnectionTo<acp::Client>,
    capabilities: Value,
) {
    let mut streamed = BTreeSet::new();
    let mut thoughts = BTreeSet::new();
    let mut questions = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            biased;
            _ = session.stop.cancelled() => break,
            _ = session.drive_stop.cancelled() => break,
            Some(_) = questions.join_next(), if !questions.is_empty() => {},
            message = rx.recv() => {
                let Some(message) = message else { break };
                let result:Result<()> = match message {
                    Message::Flush(done) => { let _ = done.send(()); Ok(()) },
                    Message::Event(event, _permit) => {
                        // A child has its own history. Only its routed questions surface here.
                        if event.scope.session != session.id && event.kind != "request.opened" { continue; }
                        if session.check_view().is_err() { continue; }
                        let c = event.content;
                        match event.kind.as_str() {
                            "model.delta" => {
                                if !c.as_str().unwrap_or("").is_empty() { streamed.insert(event.scope.turn.clone()); }
                                text(&cx,&session.id,"agent_message_chunk",c.as_str().unwrap_or(""))
                            },
                            "model.thought" => {
                                thoughts.insert(event.scope.turn.clone());
                                text(&cx,&session.id,"agent_thought_chunk",c.as_str().unwrap_or(""))
                            },
                            "session.interrupted" => {
                                streamed.clear();
                                thoughts.clear();
                                questions.abort_all();
                                // The binding's projection of session interrupted (docs/bindings/acp.md, Updates).
                                acp::UntypedMessage::new(
                                    "_modular-agent/interrupted",
                                    json!({"sessionId":session.id,"reason":c["reason"]}),
                                )
                                .and_then(|message| cx.send_notification(message))
                                .map_err(Into::into)
                            },
                            "job.ended" => { session.wake.notify_one(); Ok(()) },
                            "request.answered" => {
                                session.approval_views.lock().unwrap().retain(|(_, id)| c["request"] != *id);
                                session.wake.notify_one();
                                Ok(())
                            },
                            "turn.result" => {
                                // Providers may supply readable reasoning only in their
                                // final response. Never expose encrypted/opaque state.
                                if !thoughts.remove(&event.scope.turn) {
                                    let _ = final_thoughts(&session,&event.scope,&cx).await;
                                }
                                if session.check_view().is_err() { continue; }
                                if let Some(calls) = c["open_calls"].as_array() {
                                    for call in calls { let _ = notify(&cx,&session.id,json!({"sessionUpdate":"tool_call_update","toolCallId":call["id"],"status":"pending"})); }
                                }
                                if streamed.remove(&event.scope.turn) { Ok(()) } else { text(&cx,&session.id,"agent_message_chunk",c["text"].as_str().unwrap_or("")) }
                            },
                            "tool.requested" => {
                                let mut update = json!({"sessionUpdate":"tool_call","toolCallId":c["id"],"title":c["name"],"kind":"other","status":"pending","rawInput":c["input"]});
                                if let Some(parent) = c["extra"]["parentCallId"].as_str() {
                                    update["_meta"] = json!({"modular-agent":{"parentToolCallId":parent}});
                                }
                                notify(&cx,&session.id,update)
                            }
                            "tool.started" => notify(&cx,&session.id,json!({"sessionUpdate":"tool_call_update","toolCallId":event.scope.call,"status":"in_progress"})),
                            "tool.progress" => notify(&cx,&session.id,json!({"sessionUpdate":"tool_call_update","toolCallId":event.scope.call,"content":progress_blocks(&c)})),
                            "tool.ended" => notify(&cx,&session.id,json!({"sessionUpdate":"tool_call_update","toolCallId":c["call"],"status":if c["status"] == "completed" { "completed" } else { "failed" },"rawOutput":c,"content":[{"type":"content","content":{"type":"text","text":c["text"]}}]})),
                            "command.result" => text(&cx,&session.id,"agent_message_chunk",&c.to_string()),
                            "request.opened" => {
                                match serde_json::from_value::<Question>(c) {
                                    Ok(q) => {
                                        let principal = PRINCIPAL.with(Clone::clone);
                                        let ceiling = CONNECTION_CEILING.try_with(Clone::clone).ok();
                                        questions.spawn(with_principal(
                                            principal, ceiling,
                                            question(session.clone(), q, cx.clone(), capabilities.clone()),
                                        ));
                                        Ok(())
                                    },
                                    Err(e) => Err(e.into()),
                                }
                            },
                            _ => Ok(()),
                        }
                    }
                };
                if let Err(error) = result { eprintln!("ACP event delivery failed: {error}"); }
            }
        }
    }
    questions.abort_all();
    while questions.join_next().await.is_some() {}
}
async fn question(
    session: Arc<Session>,
    q: Question,
    cx: ConnectionTo<acp::Client>,
    capabilities: Value,
) {
    if session.check_view().is_err() || q.waits_for_approval() {
        return;
    }
    // Unsupported forms and questions past their turn use requests/answer.
    if q.kind != RequestKind::Approval
        && q.kind != RequestKind::Secret
        && !capabilities["elicitation"]["form"].is_object()
    {
        return;
    }
    if session.api.snapshot(&q.scope.session).is_ok_and(|d| {
        d.branch()
            .iter()
            .any(|e| e.kind == "turn.end" && e.scope.turn == q.scope.turn)
    }) {
        return;
    }
    let result:Result<(Value,bool)> = async {
        let cancel = session.api.cancellation(&q.scope.session)?;
        let response = async {
            if q.kind == RequestKind::Approval {
                let mut params = json!({"sessionId":session.id,
                    "toolCall":{"toolCallId":q.scope.call.clone().unwrap_or_else(||q.id.clone()),
                        "title":q.extra["approvalCall"]["name"],"rawInput":q.extra["approvalCall"]["input"],"status":"pending"},
                    "options":[{"optionId":"allow","name":"Allow","kind":"allow_once"},{"optionId":"refuse","name":"Refuse","kind":"reject_once"}],
                    "_meta":{"modular-agent":{"requestId":q.id,"actorId":connection_actor().as_str()}}});
                let payload = json!({"method":"session/request_permission","params":params});
                let actor = actor_scope(&session.id);
                let gate = |value| session.api.output(&actor, Output { recipient:"interface.acp".into(), value, stream:None, end:true });
                let service = requests(session.api.as_ref())?;
                if !binding::answerable(&session, service.as_ref(), &q) {
                    return std::future::pending().await;
                }
                if !gate(payload.clone()).await?.as_ref().is_some_and(|v| wire::json_eq(v, &payload)) {
                    let poll = json!({"method":"_modular-agent/requests","result":binding::poll_payload(&session)?});
                    if let Some(mut view) = gate(poll.clone()).await?
                        && let Some(after) = view["result"]["requests"].as_array_mut()
                    {
                        binding::mark_poll_view(&session, &poll["result"]["requests"], after).await?;
                        if after.iter().any(|v| v["id"] == q.id && v["answerable"] == true) {
                            return std::future::pending().await;
                        }
                    }
                    return Ok((json!("refuse"), false));
                }
                session.check_view()?;
                if !binding::answerable(&session, service.as_ref(), &q) {
                    return std::future::pending().await;
                }
                add_question_trace(&session, &q, &mut params);
                let request: RequestPermissionRequest = serde_json::from_value(params)?;
                session.approval_views.lock().unwrap().insert((connection_actor().as_str().into(), q.id.clone()));
                let response = serde_json::to_value(cx.send_request(request).block_task().await?)?;
                let selected = if response["outcome"]["outcome"] == "selected" {
                    response["outcome"]["optionId"].as_str().unwrap_or_default()
                } else { "refuse" };
                if !matches!(selected, "allow" | "refuse") { return std::future::pending().await; }
                Ok((json!(selected),false))
            } else if q.kind != RequestKind::Secret && capabilities["elicitation"]["form"].is_object() {
                let mut field = json!({"type":"string"});
                if q.kind == RequestKind::Choice { field["enum"] = json!(q.options); }
                let mut params = json!({"sessionId":session.id,"mode":"form","message":q.text,"requestedSchema":{"type":"object","properties":{"answer":field},"required":["answer"]},"_meta":{"modular-agent":{"requestId":q.id,"answerable":q.answerable}}});
                add_question_trace(&session, &q, &mut params);
                let request:CreateElicitationRequest = serde_json::from_value(params)?;
                let response = serde_json::to_value(cx.send_request(request).block_task().await?)?;
                Ok((response["content"]["answer"].clone(),response["action"] != "accept"))
            } else {
                // Form elicitation must never carry a secret. Missing form support fails closed.
                Ok((Value::Null,true))
            }
        };
        tokio::select! { result = response => result, _ = cancel.cancelled() => Ok((Value::Null,true)), _ = session.stop.cancelled() => Ok((Value::Null,true)) }
    }.await;
    let (value, declined) = result.unwrap_or((Value::Null, true));
    if session.check_view().is_ok()
        && let Ok(requests) = requests(session.api.as_ref())
    {
        let _ = requests
            .answer(
                session.api.clone(),
                &session.id,
                connection_actor().as_str(),
                &q.id,
                value,
                declined,
            )
            .await;
    }
}
fn add_question_trace(session: &Session, q: &Question, params: &mut Value) {
    if PRINCIPAL.with(|p| p.trusts_trace())
        && let Some(parent) = session.api.question_trace(&q.scope.session, &q.id)
    {
        params["_meta"]["traceparent"] = json!(parent);
    }
}

fn reasoning(response: &ModelResponse) -> String {
    response
        .parts
        .iter()
        .filter_map(|part| match part {
            Part::Reasoning { data } => Some(
                data["text"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        data["summary"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|s| s["text"].as_str())
                            .collect()
                    }),
            ),
            _ => None,
        })
        .collect()
}
async fn final_thoughts(
    session: &Session,
    scope: &Scope,
    cx: &ConnectionTo<acp::Client>,
) -> Result<()> {
    let thought = session
        .api
        .snapshot(&session.id)?
        .branch()
        .iter()
        .filter(|e| e.kind == "model.response" && e.scope.turn == scope.turn)
        .filter_map(|e| {
            e.content
                .clone()
                .and_then(|c| serde_json::from_value::<ModelResponse>(c).ok())
        })
        .map(|r| reasoning(&r))
        .collect::<String>();
    if !thought.is_empty()
        && let Some(value) = session
            .api
            .output(
                scope,
                Output {
                    recipient: "interface.acp".into(),
                    value: json!(thought),
                    stream: None,
                    end: true,
                },
            )
            .await?
    {
        session.check_view()?;
        text(
            cx,
            &session.id,
            "agent_thought_chunk",
            value.as_str().unwrap_or(""),
        )?;
    }
    Ok(())
}
pub(crate) async fn replay(api: Api, id: &str, cx: &ConnectionTo<acp::Client>) -> Result<()> {
    let scope = crate::actor_scope(id);
    require(api.as_ref(), &scope, "watch")?;
    let data = api.snapshot(id)?;
    for original in data.branch().into_iter().filter(|e| e.content.is_some()) {
        let Some(e) =
            crate::binding::gate_entry(api.as_ref(), &scope, wire::public_entry(&original, &data)?)
                .await?
        else {
            continue;
        };
        require(api.as_ref(), &scope, "watch")?;
        let message = &e["message"];
        match e["kind"].as_str() {
            Some("input") => text(
                cx,
                id,
                "user_message_chunk",
                &wire::text(&message["content"]),
            )?,
            Some("response") => {
                let response = wire::parse_response(message.clone())?;
                text(cx, id, "agent_thought_chunk", &reasoning(&response))?;
                text(cx, id, "agent_message_chunk", &response.text_content())?;
            }
            Some("toolStarted") => {
                let call = &e["data"]["call"];
                let mut update = json!({"sessionUpdate":"tool_call","toolCallId":call["id"],"title":call["name"],"status":"pending","rawInput":call["input"]});
                if let Some(parent) = call["parentCallId"].as_str() {
                    update["_meta"] = json!({"modular-agent":{"parentToolCallId":parent}});
                }
                notify(cx, id, update)?;
            }
            Some("toolResult") => notify(
                cx,
                id,
                json!({"sessionUpdate":"tool_call_update","toolCallId":e["toolCallId"],"status":if e["data"]["status"] == "completed" {"completed"} else {"failed"},"rawOutput":message}),
            )?,
            _ => (),
        }
    }
    Ok(())
}
