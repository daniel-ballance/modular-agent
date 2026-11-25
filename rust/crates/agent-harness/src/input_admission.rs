use super::{
    Harness, OpenSession, authority::admitted_authority, bytes, history_commit::make_entry,
};
use agent_api::telemetry::{self, Operation};
use agent_api::*;
use std::collections::VecDeque;

fn proposal_source<'a>(data: &'a SessionData, input: &str) -> Result<&'a Entry> {
    data.entries
        .iter()
        .find(|e| {
            e.kind == "input.accepted"
                && e.content.as_ref().is_some_and(|v| {
                    (v["timing"] == "propose" || v["parked"] == true)
                        && (e.id == input || v["inputId"] == input)
                })
        })
        .ok_or_else(|| OperationError::NotFound("unknown proposal".into()).into())
}

fn pending_proposal(open: &OpenSession, input: &str) -> Result<usize> {
    ensure!(
        !input.is_empty(),
        OperationError::InvalidParams("missing proposal id".into())
    );
    proposal_source(&open.data, input)?;
    open.queue
        .iter()
        .position(|i| i.id == input && i.timing == Timing::Propose)
        .ok_or_else(|| OperationError::Conflict("proposal has already settled".into()).into())
}

impl Harness {
    pub async fn submit(
        &self,
        session: &str,
        actor: &str,
        text: &str,
        timing: Timing,
        key: Option<String>,
    ) -> Result<Receipt> {
        let scope = Scope {
            actor: actor.into(),
            ..Scope::session(session)
        };
        self.submit_content_as(&scope, None, wire::text_content(text), timing, key, None)
            .await
    }
    /// Admit a prompt with a schema attached to this admission, not to the session.
    pub async fn submit_shaped(
        &self,
        session: &str,
        actor: &str,
        text: &str,
        key: Option<String>,
        shape: Value,
    ) -> Result<Receipt> {
        let scope = Scope {
            actor: actor.into(),
            ..Scope::session(session)
        };
        self.submit_shaped_as(&scope, None, text, key, shape).await
    }
    pub async fn submit_shaped_as(
        &self,
        scope: &Scope,
        sponsor: Option<&str>,
        text: &str,
        key: Option<String>,
        shape: Value,
    ) -> Result<Receipt> {
        self.submit_content_as(
            scope,
            sponsor,
            wire::text_content(text),
            Timing::Now,
            key,
            Some(shape),
        )
        .await
    }

    pub async fn submit_content_as(
        &self,
        scope: &Scope,
        sponsor: Option<&str>,
        content: Value,
        timing: Timing,
        key: Option<String>,
        result_shape: Option<Value>,
    ) -> Result<Receipt> {
        let span = Operation::internal("modular_agent.input.admit", scope);
        let receipt = span
            .run(self.admit_content(scope, sponsor, content, timing, key, result_shape))
            .await;
        if let Ok(receipt) = &receipt
            && !receipt.input.is_empty()
        {
            span.attr("modular_agent.input.id", receipt.input.clone());
        }
        receipt
    }

    async fn admit_content(
        &self,
        scope: &Scope,
        sponsor: Option<&str>,
        content: Value,
        timing: Timing,
        key: Option<String>,
        result_shape: Option<Value>,
    ) -> Result<Receipt> {
        if let Some(shape) = &result_shape {
            schema::compile(shape)?;
        }
        wire::parts(&content)?;
        let text = wire::text(&content);
        let session = scope.session.as_str();
        let actor = scope.actor.as_str();
        let own = self.authority(session, actor)?;
        let authority = match sponsor {
            Some(s) => own.intersect(&self.authority(session, s)?),
            None => own.clone(),
        };
        ensure!(
            authority.has(if timing == Timing::Propose {
                "propose"
            } else {
                "input"
            }),
            OperationError::Forbidden("actor lacks input authority".into())
        );
        let admission = self
            .admissions
            .lock()
            .unwrap()
            .entry(session.into())
            .or_default()
            .clone();
        let _admission = match admission.try_lock() {
            Ok(guard) => guard,
            Err(_) => {
                let wait = Operation::internal("modular_agent.capacity.wait", scope);
                wait.attr("modular_agent.capacity.scope", "session");
                wait.run(admission.lock()).await
            }
        };
        let _workspace = self.start_environment_work(session, true)?;
        let submitter = sponsor.unwrap_or(actor);
        if let Some(ref key) = key {
            let data = self.snapshot(session)?;
            if data
                .entries
                .iter()
                .filter(|e| e.kind == "erasure")
                .filter_map(|e| e.content.as_ref()?.get("inputKeys")?.as_array())
                .flatten()
                .any(|r| {
                    r["key"] == *key
                        && r["actorId"] == actor
                        && r["submittedBy"].as_str().unwrap_or(actor) == submitter
                })
            {
                return Ok(Receipt {
                    input: String::new(),
                    duplicate: true,
                    erased: true,
                    command: None,
                });
            }
            if let Some(e) = data.entries.iter().find(|e| {
                matches!(e.kind.as_str(), "input.accepted" | "command")
                    && e.scope.actor == actor
                    && e.content.as_ref().is_some_and(|c| {
                        c["key"] == *key && c["submittedBy"].as_str().unwrap_or(actor) == submitter
                    })
            }) {
                let command = if e.kind == "command" {
                    self.output(
                        scope,
                        Output {
                            recipient: "interface".into(),
                            value: e.content.as_ref().unwrap()["result"].clone(),
                            stream: None,
                            end: true,
                        },
                    )
                    .await?
                } else {
                    None
                };
                return Ok(Receipt {
                    input: e
                        .content
                        .as_ref()
                        .and_then(|c| c["inputId"].as_str())
                        .unwrap_or(&e.id)
                        .into(),
                    duplicate: true,
                    erased: false,
                    command,
                });
            }
        }
        let payload = bytes::size(&(&text, &content, &key, &result_shape));
        let reservation = self
            .reservations()
            .admit(&self.snapshot(session)?, payload)
            .inspect_err(|e| {
                if e.is::<OperationError>() {
                    telemetry::event("modular_agent.capacity.refused", scope, vec![]);
                }
            })?;
        // A proposal is data, not a command. Do not run input hooks with
        // broader authority than the connection and actor share.
        let input_payload = json!({"text":text,"content":content,"actor":actor,"timing":timing});
        let reply = if timing == Timing::Propose || authority != own {
            HookResult {
                value: input_payload,
                ..HookResult::default()
            }
        } else {
            self.invoke(&self.points["input"], scope, input_payload)
                .await?
        };
        if reply.stopped {
            let entry = self.append(
                scope,
                "commands",
                Draft::new(
                    "command",
                    false,
                    json!({"text":text,"result":reply.value,"key":key,"submittedBy":submitter}),
                )
                .copying(
                    self.snapshot(session)?
                        .entries
                        .iter()
                        .map(|e| e.id.clone())
                        .collect(),
                ),
            )?;
            self.emit(Event::new(scope, "command.result", reply.value.clone()))
                .await?;
            return Ok(Receipt {
                input: entry.id,
                duplicate: false,
                erased: false,
                command: self
                    .output(
                        scope,
                        Output {
                            recipient: "interface".into(),
                            value: reply.value,
                            stream: None,
                            end: true,
                        },
                    )
                    .await?,
            });
        }
        let content = if reply.value["content"] != content && reply.value["content"].is_array() {
            reply.value["content"].clone()
        } else if let Some(changed) = reply.value["text"]
            .as_str()
            .filter(|changed| *changed != text)
        {
            wire::text_content(changed)
        } else {
            content
        };
        wire::parts(&content)?;
        let text = wire::text(&content);
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(session)
            .ok_or_else(|| OperationError::NotFound("unknown session".into()))?;
        let mut next = open.data.clone();
        if !next.settings.as_object().is_none_or(|o| o.is_empty())
            && !next.entries.iter().any(|e| e.kind == "settings")
        {
            let baseline = make_entry(
                &next,
                &Scope::session(session),
                "harness",
                Draft::new("settings", false, next.settings.clone()),
            );
            next.position = Some(baseline.id.clone());
            next.entries.push(baseline);
        }
        let timing = if open.steer_closed && open.active.is_some() && timing == Timing::Steer {
            Timing::After
        } else {
            timing
        };
        let mut entry = make_entry(
            &next,
            scope,
            "harness",
            Draft::new(
                "input.accepted",
                false,
                json!({"text":text,"content":content,"key":key,"timing":timing,
                       "authority":authority,"sponsor":sponsor,"submittedBy":submitter,"taken":input_taken(open.active.is_some(), timing)}),
            ),
        );
        let content = entry.content.as_mut().unwrap();
        content["inputId"] = json!(entry.id);
        if let Some(shape) = result_shape {
            content["resultShape"] = shape;
        }
        next.position = Some(entry.id.clone());
        next.entries.push(entry.clone());
        self.commit_reserved(open, &next, Some(reservation))?;
        open.data = next;
        open.input_contexts
            .retain(|id, _| open.queue.iter().any(|input| &input.id == id));
        let cx = telemetry::current();
        if telemetry::traceparent(&cx).is_some() {
            open.input_contexts.insert(entry.id.clone(), cx);
        }
        open.queue.push_back(Input {
            id: entry.id.clone(),
            actor: actor.into(),
            text,
            timing,
            key,
        });
        self.pending_events.lock().unwrap().push(Event::new(
            scope,
            "input.accepted",
            json!({"input":entry.id,"timing":timing}),
        ));
        Ok(Receipt {
            input: entry.id,
            duplicate: false,
            erased: false,
            command: None,
        })
    }

    pub async fn withdraw(&self, session: &str, input: &str) -> Result<Input> {
        let _workspace = self.begin_environment_work(session)?;
        let value = {
            let mut sessions = self.sessions.lock().unwrap();
            let open = sessions
                .get_mut(session)
                .ok_or_else(|| OperationError::NotFound("unknown session".into()))?;
            let i = open
                .queue
                .iter()
                .position(|x| x.id == input)
                .ok_or_else(|| anyhow!("input already taken"))?;
            open.queue.remove(i).unwrap()
        };
        let scope = Scope::session(session);
        self.append(
            &scope,
            "harness",
            Draft::new("input.withdrawn", false, json!({"input":input})),
        )?;
        self.emit(Event::new(&scope, "input.withdrawn", json!(value)))
            .await?;
        let view = self
            .output(
                &scope,
                Output {
                    recipient: "interface".into(),
                    value: json!(value),
                    stream: None,
                    end: true,
                },
            )
            .await?
            .ok_or_else(|| anyhow!("withdrawn input blocked by output gate"))?;
        Ok(serde_json::from_value(view)?)
    }

    pub(super) async fn release_proposal(
        &self,
        scope: &Scope,
        input: &str,
        timing: Timing,
        declined: bool,
    ) -> Result<&'static str> {
        require(self, scope, "input")?;
        ensure!(
            timing != Timing::Propose && !input.is_empty(),
            OperationError::InvalidParams("invalid proposal id or release timing".into())
        );
        let data = self.snapshot(&scope.session)?;
        let source = proposal_source(&data, input)?;
        let releaser = self.authority(&scope.session, &scope.actor)?;
        let admitted = source.content.as_ref().unwrap();
        let cap = admitted_authority(
            self,
            &scope.session,
            self.authority(&scope.session, &source.scope.actor)?,
            admitted,
        )?
        .intersect(&releaser);
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(&scope.session)
            .ok_or_else(|| anyhow!("session closed"))?;
        let i = pending_proposal(open, input)?;
        open.check_rewind()?;
        let timing = if timing == Timing::Steer
            && (admitted["parked"] == true || (open.active.is_some() && open.steer_closed))
        {
            Timing::After
        } else {
            timing
        };
        let (record_scope, draft, taken) = if declined {
            (
                scope.clone(),
                Draft::new("input.returned", false, json!({"input":input})),
                "handedBack",
            )
        } else {
            let ready_work = open.queue.iter().any(|i| i.timing != Timing::Propose)
                || !open.interrupted.is_empty();
            let taken = if open.active.is_none() && ready_work {
                "after"
            } else {
                input_taken(open.active.is_some(), timing)
            };
            let mut value = admitted.clone();
            value["inputId"] = json!(input);
            value["timing"] = json!(timing);
            value["authority"] = json!(cap);
            value["releasedBy"] = json!(scope.actor);
            value["taken"] = json!(taken);
            (
                source.scope.clone(),
                Draft::new("input.accepted", false, value),
                taken,
            )
        };
        let mut next = open.data.clone();
        let entry = make_entry(&next, &record_scope, "harness", draft);
        next.position = Some(entry.id.clone());
        next.entries.push(entry);
        self.commit(open, &next)?;
        open.data = next;
        let mut proposal = open.queue.remove(i).unwrap();
        if !declined {
            proposal.timing = timing;
            open.queue.push_back(proposal);
        }
        Ok(taken)
    }

    pub(super) async fn remove_proposal(
        &self,
        scope: &Scope,
        sponsor: &str,
        input: &str,
    ) -> Result<()> {
        let shared = self
            .authority(&scope.session, &scope.actor)?
            .intersect(&self.authority(&scope.session, sponsor)?);
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(&scope.session)
            .ok_or_else(|| anyhow!("session closed"))?;
        let i = pending_proposal(open, input)?;
        ensure!(
            open.queue[i].actor == scope.actor || shared.has("input"),
            OperationError::Forbidden("cannot withdraw another actor's proposal".into())
        );
        ensure!(
            scope.actor == sponsor || shared.has("propose") || shared.has("input"),
            OperationError::Forbidden("connection cannot act for proposer".into())
        );
        open.check_rewind()?;
        let mut next = open.data.clone();
        let entry = make_entry(
            &next,
            scope,
            "harness",
            Draft::new("input.withdrawn", false, json!({"input":input})),
        );
        next.position = Some(entry.id.clone());
        next.entries.push(entry);
        self.commit(open, &next)?;
        open.data = next;
        open.queue.remove(i);
        Ok(())
    }

    pub(super) fn steering_pending(&self, session: &str) -> Result<bool> {
        Ok(self
            .sessions
            .lock()
            .unwrap()
            .get(session)
            .ok_or_else(|| OperationError::NotFound("unknown session".into()))?
            .queue
            .iter()
            .any(|i| i.timing == Timing::Steer))
    }

    pub(super) fn take_steering_inner(
        &self,
        scope: &Scope,
        final_check: bool,
    ) -> Result<Vec<Input>> {
        let inputs = {
            let mut sessions = self.sessions.lock().unwrap();
            let open = sessions
                .get_mut(&scope.session)
                .ok_or_else(|| OperationError::NotFound("unknown session".into()))?;
            let mut inputs = vec![];
            let mut rest = VecDeque::new();
            for i in open.queue.drain(..) {
                if i.timing == Timing::Steer {
                    inputs.push(i)
                } else {
                    rest.push_back(i)
                }
            }
            open.queue = rest;
            if final_check && inputs.is_empty() {
                open.steer_closed = true;
            }
            inputs
        };
        for input in &inputs {
            let data = self.snapshot(&scope.session)?;
            let mut cap = self.authority(&scope.session, &input.actor)?;
            let accepted = data
                .entries
                .iter()
                .rev()
                .find(|e| {
                    e.kind == "input.accepted"
                        && e.content
                            .as_ref()
                            .is_some_and(|v| v["inputId"] == input.id || e.id == input.id)
                })
                .and_then(|e| e.content.as_ref());
            if let Some(v) = accepted {
                cap = admitted_authority(self, &scope.session, cap, v)?;
            }
            let mut taken =
                json!({"text":input.text,"inputId":input.id,"key":input.key,"authority":cap});
            if let Some(content) = accepted
                .and_then(|v| v.get("content"))
                .filter(|v| v.is_array())
            {
                taken["message"] = json!({"role":"user","content":content});
            }
            for key in ["sponsor", "releasedBy"] {
                if let Some(value) = accepted.and_then(|v| wire::optional(v, key)) {
                    taken[key] = value.clone();
                }
            }
            let input_scope = Scope {
                actor: input.actor.clone(),
                ..scope.clone()
            };
            self.append(
                &input_scope,
                "harness",
                Draft::new("input", true, taken).copying(vec![input.id.clone()]),
            )?;
        }
        Ok(inputs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use history_fs::HistoryPlugin;
    use std::sync::Arc;

    #[tokio::test]
    async fn retry_pending_erasure_after_waiting_for_input_admission() -> Result<()> {
        let project = tempfile::tempdir()?;
        let harness = Harness::new();
        harness
            .load(Arc::new(HistoryPlugin {
                root: project.path().join("history"),
            }))
            .await?;
        let session = harness.create(project.path(), json!({})).await?;
        let key = Some("private-input".into());
        let first = harness
            .submit(&session, "user", "erase me", Timing::After, key.clone())
            .await?;

        let admission = harness.admissions.lock().unwrap()[&session].clone();
        let gate = admission.lock().await;
        let retry = harness.submit(&session, "user", "erase me", Timing::After, key);
        tokio::pin!(retry);
        tokio::select! {
            biased;
            _ = &mut retry => bail!("input did not wait for admission"),
            _ = std::future::ready(()) => {}
        }
        let store = harness.store().unwrap();
        store.mark_erasure(&session, std::slice::from_ref(&first.input))?;
        drop(gate);

        let receipt = retry.await?;
        assert!(receipt.erased && receipt.duplicate);
        let data = store.load(&session)?;
        assert!(
            data.entries
                .iter()
                .any(|e| e.id == first.input && e.content.is_none())
        );
        Ok(())
    }
}
