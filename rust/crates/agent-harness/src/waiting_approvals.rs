//! Consent for one unstarted model call. Only the writer commits a decision;
//! delivery is deliberately kept on the open session, never in history.
use super::*;

pub type Audience = Arc<dyn Fn(&SessionData, &str) -> Option<Authority> + Send + Sync>;
pub(super) type Audiences = BTreeMap<(String, String), Vec<Audience>>;
pub(super) type Views = BTreeMap<(String, String), (String, ApprovalRoute)>;

pub(super) fn add_sources(data: &SessionData, scope: &Scope, draft: &mut Draft) {
    if let Some(e) = data
        .entries
        .iter()
        .find(|e| marked(e) && e.scope.call == scope.call)
    {
        draft.copies.push(e.id.clone());
        if let Some(a) = decision(
            &data.entries,
            e.content.as_ref().unwrap()["id"].as_str().unwrap_or(""),
        ) {
            draft.copies.push(a.id.clone());
        }
    }
}
pub(super) fn marked(e: &Entry) -> bool {
    e.kind == "request.open"
        && e.content
            .as_ref()
            .is_some_and(|v| v["extra"]["approvalWait"] == "untilDeadline")
}
fn terminal(data: &SessionData, e: &Entry) -> bool {
    data.entries
        .iter()
        .any(|r| r.kind == "tool.result" && r.scope.call == e.scope.call)
}
pub(super) fn outstanding(data: &SessionData) -> bool {
    data.entries.iter().any(|e| marked(e) && !terminal(data, e))
}
fn request(branch: &[Entry], id: &str) -> Option<Entry> {
    branch
        .iter()
        .find(|e| marked(e) && e.content.as_ref().unwrap()["id"] == id)
        .cloned()
}
fn decision<'a>(branch: &'a [Entry], id: &str) -> Option<&'a Entry> {
    branch.iter().find(|e| {
        matches!(e.kind.as_str(), "request.answer" | "request.closed")
            && e.content.as_ref().is_some_and(|v| v["request"] == id)
    })
}
fn binding(data: &SessionData, e: &Entry, q: &Question) -> bool {
    let branch = data.branch();
    let Some(response) = branch.iter().find(|r| {
        r.kind == "model.response"
            && r.scope.turn == e.scope.turn
            && r.scope.step == e.scope.step
            && e.copies.contains(&r.id)
    }) else {
        return false;
    };
    if q.timeout_ms
        .and_then(|ms| e.at.checked_add(ms))
        .is_none_or(|at| Some(at) != q.extra["deadlineAt"].as_u64())
        || q.extra["whenTimeLimit"] != "decline"
        || q.answerable
        || q.scope.turn != e.scope.turn
        || q.scope.step != e.scope.step
        || (data.origin.is_some()
            && e.copies
                .iter()
                .any(|source| !data.entries.iter().any(|r| &r.id == source)))
    {
        return false;
    }
    let offered = branch.iter().any(|r| {
        r.kind == "model.request"
            && r.scope.turn == e.scope.turn
            && r.scope.step == e.scope.step
            && r.content
                .as_ref()
                .and_then(|v| v["tools"].as_array())
                .is_some_and(|t| t.contains(&q.extra["approvalCall"]["name"]))
    });
    offered
        && response
            .content
            .clone()
            .and_then(|v| serde_json::from_value::<ModelResponse>(v).ok())
            .is_some_and(|r| {
                r.tool_calls().iter().any(|c| {
                    Some(&c.id) == e.scope.call.as_ref()
                        && c.name == q.extra["approvalCall"]["name"]
                        && c.started_by == "model"
                })
            })
        && branch.iter().any(|p| {
            p.kind == "tool.pending"
                && p.scope.call == e.scope.call
                && p.scope.turn == e.scope.turn
                && p.scope.step == e.scope.step
                && p.content.as_ref().is_some_and(|v| {
                    v["requestIds"] == json!([q.id]) && v["toolStartedId"].is_null()
                })
        })
        && branch.iter().any(|end| {
            end.kind == "turn.end"
                && end.scope.turn == e.scope.turn
                && end.content.as_ref().is_some_and(|v| {
                    v["outcome"] == "completed"
                        && v["open_calls"].as_array().is_some_and(|cs| {
                            cs.iter()
                                .any(|c| c["id"].as_str() == e.scope.call.as_deref())
                        })
                })
        })
        && q.scope.session == data.id
        && q.scope.call == e.scope.call
        && q.scope.actor == e.scope.actor
}
fn push(next: &mut SessionData, scope: &Scope, draft: Draft) -> Entry {
    let e = make_entry(next, scope, "harness", draft);
    next.position = Some(e.id.clone());
    next.entries.push(e.clone());
    e
}
fn settlement(
    next: &mut SessionData,
    e: &Entry,
    q: &Question,
    reason: &str,
    status: ToolStatus,
) -> Result<()> {
    let branch = next.branch();
    let answer = match decision(&branch, &q.id) {
        Some(a) => a.clone(),
        None => push(
            next,
            &e.scope,
            Draft::new(
                "request.closed",
                false,
                json!({"request":q.id,"reason":reason}),
            )
            .copying(vec![e.id.clone()]),
        ),
    };
    let call = wire::parse_call(&q.extra["approvalCall"])?;
    push(
        next,
        &e.scope,
        Draft::new(
            "tool.result",
            true,
            json!(ToolResult::new(&call, status, reason)),
        )
        .copying(vec![e.id.clone(), answer.id]),
    );
    Ok(())
}
impl Harness {
    pub fn session_generation(&self, session: &str) -> Result<CancellationToken> {
        self.sessions
            .lock()
            .unwrap()
            .get(session)
            .map(|s| s.generation.clone())
            .ok_or_else(|| anyhow!("session is closed"))
    }
    pub fn register_approval_audience(&self, binding: String, principal: String, check: Audience) {
        self.approval_audiences
            .write()
            .unwrap()
            .entry((binding, principal))
            .or_default()
            .push(check);
    }
    pub fn inherit_approval_audiences(&self, other: &Harness) {
        *self.approval_audiences.write().unwrap() =
            other.approval_audiences.read().unwrap().clone();
    }
    fn route_ceiling(
        &self,
        data: &SessionData,
        binding: &str,
        principal: &str,
        actor: &str,
    ) -> Authority {
        if binding == "sdk" && principal == "user" {
            return Authority::full();
        }
        self.approval_audiences
            .read()
            .unwrap()
            .get(&(binding.to_owned(), principal.to_owned()))
            .and_then(|checks| {
                checks
                    .iter()
                    .filter_map(|check| check(data, actor))
                    .reduce(|a, b| a.intersect(&b))
            })
            .unwrap_or_default()
    }
    pub fn configure_approval_wait(&self, max: u64) {
        self.approval_maximum.set(max).expect("configured once");
    }
    pub fn max_approval_wait_ms(&self) -> Option<u64> {
        self.approval_maximum.get().copied()
    }
    pub fn validate_approval_wait(&self, settings: &Value) -> Result<()> {
        if let Some(value) = settings.get("approvalWait") {
            ensure!(
                self.max_approval_wait_ms().is_some(),
                std::io::Error::new(
                    std::io::ErrorKind::Unsupported,
                    "agent does not support waiting approvals"
                )
            );
            ensure!(
                matches!(value.as_str(), Some("untilDeadline" | "live")),
                OperationError::InvalidParams("invalid approvalWait".into())
            );
        }
        Ok(())
    }
    fn approval_rights(
        &self,
        data: &SessionData,
        q: &Question,
        actor: &str,
        principal: &str,
        ceiling: &Authority,
    ) -> Result<Authority> {
        if q.extra["answerers"]
            .as_array()
            .is_some_and(|s| !s.iter().any(|a| a == actor))
        {
            return Ok(Authority::default());
        }
        let a = self.executor_rights(data, actor, ceiling)?;
        let p = self.executor_rights(data, principal, ceiling)?;
        if actor != principal && principal != "user" && !p.has("grant") {
            return Ok(Authority::default());
        }
        Ok(a.intersect(&p))
    }
    pub(super) fn invalidate_ineligible_approval_views(
        &self,
        open: &mut OpenSession,
    ) -> Result<()> {
        let views = std::mem::take(&mut open.approval_views);
        for (key, (id, route)) in views {
            let Some(q) = open
                .data
                .entries
                .iter()
                .find(|e| e.id == id)
                .and_then(|e| e.content.clone())
                .and_then(|v| serde_json::from_value::<Question>(v).ok())
            else {
                continue;
            };
            if !route.live.is_cancelled()
                && eligible(&self.approval_rights(
                    &open.data,
                    &q,
                    &route.actor,
                    &route.principal,
                    &route.ceiling,
                )?)
            {
                open.approval_views.insert(key, (id, route));
            }
        }
        Ok(())
    }
    fn has_approver(&self, data: &SessionData, q: &Question) -> bool {
        std::iter::once("user".to_string())
            .chain(actors(data).into_keys())
            .any(|a| {
                self.approval_rights(data, q, &a, &a, &Authority::full())
                    .is_ok_and(|r| eligible(&r))
            })
    }
    /// Called only while replacing a grant or removing a member. Compare the
    /// same audience on both sides of that change. Presence loss alone is not revocation.
    pub(super) fn close_revoked_questions(
        &self,
        before: &SessionData,
        next: &mut SessionData,
    ) -> Result<bool> {
        if !before.entries.iter().any(|e| e.kind == "request.open") {
            return Ok(false);
        }
        let mut closed = false;
        for q in questions(before)?.into_iter().filter(|q| q.answerable) {
            // A question relayed to another session still has that audience.
            if q.route.iter().any(|s| s != &before.id) {
                continue;
            }
            let approval = q.kind == RequestKind::Approval;
            let present = if approval && !q.waits_for_approval() {
                Some(requests(self)?.present_for_approval(&before.id))
            } else {
                None
            };
            let eligible = |d: &SessionData| {
                std::iter::once("user".to_owned())
                    .chain(actors(d).into_keys())
                    .any(|actor| {
                        q.extra["answerers"]
                            .as_array()
                            .is_none_or(|v| v.iter().any(|a| a == &actor))
                            && present.as_ref().is_none_or(|set| set.contains(&actor))
                            && self
                                .executor_rights(d, &actor, &Authority::full())
                                .is_ok_and(|r| {
                                    r.has("watch")
                                        && r.has(if approval { "approve" } else { "answer" })
                                })
                    })
            };
            if !eligible(before) || eligible(next) {
                continue;
            }
            let Some(open) = before.entries.iter().find(|e| {
                e.kind == "request.open" && e.content.as_ref().is_some_and(|v| v["id"] == q.id)
            }) else {
                continue;
            };
            let expired = q.extra["whenTimeLimit"] == "decline"
                && q.timeout_ms
                    .is_some_and(|ms| open.at.saturating_add(ms) <= now());
            let reason = if expired {
                "timeLimit"
            } else {
                "noLongerAnswerable"
            };
            let mut value = json!({"request":q.id, "reason":reason});
            if !expired {
                value["cause"] = json!("revoked");
            }
            push(
                next,
                &q.scope,
                Draft::new("request.closed", false, value).copying(vec![open.id.clone()]),
            );
            if q.waits_for_approval() {
                settlement(
                    next,
                    open,
                    &q,
                    reason,
                    if expired {
                        ToolStatus::NotStarted
                    } else {
                        ToolStatus::Refused
                    },
                )?;
            }
            closed = true;
        }
        Ok(closed)
    }
    pub(super) fn park(&self, draft: &Question) -> Result<Option<bool>> {
        let Some(max) = self.max_approval_wait_ms() else {
            return Ok(None);
        };
        let scope = &draft.scope;
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(&scope.session)
            .ok_or_else(|| anyhow!("session is closed"))?;
        let data = &open.data;
        if data.settings["approvalWait"] != "untilDeadline"
            || data.settings["_parent"]["session"].is_string()
            || scope.turn.is_none()
            || self.is_interface_tool(draft.extra["approvalCall"]["name"].as_str().unwrap_or(""))
        {
            return Ok(None);
        }
        let branch = data.branch();
        if branch.iter().any(|e| {
            e.scope.call == scope.call
                && (marked(e) || matches!(e.kind.as_str(), "tool.started" | "tool.result"))
        }) {
            return Ok(None);
        }
        let Some(response) = branch.iter().find(|e| {
            e.kind == "model.response"
                && e.scope.turn == scope.turn
                && e.scope.step == scope.step
                && e.content
                    .clone()
                    .and_then(|v| serde_json::from_value::<ModelResponse>(v).ok())
                    .is_some_and(|r| {
                        r.tool_calls().iter().any(|c| {
                            Some(&c.id) == scope.call.as_ref()
                                && c.started_by == "model"
                                && c.name == draft.extra["approvalCall"]["name"]
                        })
                    })
        }) else {
            return Ok(None);
        };
        if !self.has_approver(data, draft) || open.cancel.is_cancelled() {
            return Ok(Some(false));
        }
        let mut q = draft.clone();
        q.responders.clear();
        q.route = vec![scope.session.clone()];
        q.answerable = false;
        let ms = max.min(q.timeout_ms.unwrap_or(max));
        q.timeout_ms = Some(ms);
        let at = now();
        let deadline = at
            .checked_add(ms)
            .filter(|v| *v <= 9_007_199_254_740_991)
            .ok_or_else(|| anyhow!("approval deadline exceeds shared Time"))?;
        q.extra["approvalWait"] = json!("untilDeadline");
        q.extra["deadlineAt"] = json!(deadline);
        let mut next = data.clone();
        let opened = push(
            &mut next,
            scope,
            Draft::new("request.open", false, json!(q)).copying(vec![response.id.clone()]),
        );
        next.entries.last_mut().unwrap().at = at;
        push(
            &mut next,
            scope,
            Draft::new("tool.pending", false, json!({"requestIds":[q.id]}))
                .copying(vec![opened.id]),
        );
        self.commit_approval(open, next)?;
        self.watch_approval(&scope.session, deadline, open.generation.clone());
        Ok(Some(true))
    }
    fn commit_approval(&self, open: &mut OpenSession, next: SessionData) -> Result<()> {
        let from = open.data.entries.len();
        let operation = next.entries[from..]
            .iter()
            .find(|e| {
                matches!(
                    e.kind.as_str(),
                    "request.answer" | "request.closed" | "tool.result"
                )
            })
            .filter(|_| !telemetry::current().span().is_recording())
            .map(|e| Operation::internal("modular_agent.question.answer", &e.scope));
        let _span = operation.as_ref().map(Operation::enter);
        self.commit(open, &next)?;
        open.data = next;
        for e in &open.data.entries[from..] {
            observe_question(&open.data, e);
            let mut events = self.pending_events.lock().unwrap();
            events.push(Event::new(&e.scope, "history.entry", json!(e)));
            if e.kind == "tool.result" {
                if let Some(result) = e
                    .content
                    .clone()
                    .and_then(|v| serde_json::from_value::<ToolResult>(v).ok())
                    && matches!(result.status, ToolStatus::NotStarted | ToolStatus::Refused)
                    && let Some(call) = open
                        .data
                        .entries
                        .iter()
                        .find(|r| marked(r) && r.scope.call == e.scope.call)
                        .and_then(|r| {
                            wire::parse_call(&r.content.as_ref()?["extra"]["approvalCall"]).ok()
                        })
                {
                    telemetry::disposition(&e.scope, &call, &result.status);
                }
                events.push(Event::new(
                    &e.scope,
                    "tool.ended",
                    e.content.clone().unwrap_or_default(),
                ));
            }
        }
        Ok(())
    }
    pub(super) fn finish_approval_turn(
        &self,
        open: &mut OpenSession,
        scope: &Scope,
        result: &mut TurnResult,
    ) -> Result<()> {
        let mut next = open.data.clone();
        for e in open
            .data
            .branch()
            .iter()
            .filter(|e| marked(e) && e.scope.turn == scope.turn)
        {
            if result.outcome != Outcome::Completed && !terminal(&next, e) {
                let q: Question = serde_json::from_value(e.content.clone().unwrap())?;
                let reason = if result.outcome == Outcome::Cancelled {
                    "cancelled"
                } else {
                    "noLongerAnswerable"
                };
                settlement(&mut next, e, &q, reason, ToolStatus::NotStarted)?;
            }
            if terminal(&next, e) {
                result
                    .open_calls
                    .retain(|c| Some(&c.id) != e.scope.call.as_ref());
            }
        }
        if open.data.entries.len() != next.entries.len() {
            self.commit_approval(open, next)?;
        }
        Ok(())
    }
    fn watch_approval(&self, session: &str, deadline: u64, generation: CancellationToken) {
        let h = self.me.clone();
        let id = session.to_string();
        tokio::spawn(async move {
            tokio::select! {biased; _=generation.cancelled()=>return,_=wait_until(deadline)=>{}}
            if let Some(h) = h.upgrade()
                && !generation.is_cancelled()
                && h.reconcile_approvals(&id, false).unwrap_or(false)
            {
                let _ = h.interface_work_ready(&id).await;
            }
        });
    }
    pub(super) fn reconcile_approvals(&self, session: &str, reopen: bool) -> Result<bool> {
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(session)
            .ok_or_else(|| anyhow!("session is closed"))?;
        self.reconcile_open_approvals(open, reopen)
    }
    pub(super) fn wake_settled_approval(&self, session: &str) {
        let h = self.me.clone();
        let id = session.to_owned();
        tokio::spawn(async move {
            if let Some(h) = h.upgrade() {
                let _ = h.interface_work_ready(&id).await;
            }
        });
    }

    pub(super) fn reconcile_open_approvals(
        &self,
        open: &mut OpenSession,
        reopen: bool,
    ) -> Result<bool> {
        if !outstanding(&open.data) {
            return Ok(false);
        }
        let branch = open.data.branch();
        let mut next = open.data.clone();
        for e in branch
            .iter()
            .filter(|e| marked(e) && !terminal(&open.data, e))
        {
            let q: Question = serde_json::from_value(e.content.clone().unwrap())?;
            if let Some(start) = branch
                .iter()
                .find(|r| r.kind == "tool.started" && r.scope.call == e.scope.call)
            {
                if reopen {
                    let done = branch
                        .iter()
                        .find(|r| r.kind == "tool.completed" && r.scope.call == e.scope.call)
                        .and_then(|r| r.content.clone());
                    let call = wire::parse_call(&q.extra["approvalCall"])?;
                    let mut draft = Draft::new(
                        "tool.result",
                        true,
                        done.unwrap_or_else(|| {
                            json!(ToolResult::new(
                                &call,
                                ToolStatus::Unknown,
                                "interrupted after start"
                            ))
                        }),
                    )
                    .copying(vec![start.id.clone()]);
                    add_sources(&next, &start.scope, &mut draft);
                    push(&mut next, &start.scope, draft);
                }
                continue;
            }
            let deadline = q.extra["deadlineAt"].as_u64().unwrap_or(0);
            let ended = branch
                .iter()
                .find(|r| r.kind == "turn.end" && r.scope.turn == e.scope.turn);
            let decision = decision(&branch, &q.id);
            let reason = if self.max_approval_wait_ms().is_none()
                || ended.is_some_and(|r| {
                    r.content
                        .as_ref()
                        .is_none_or(|v| v["outcome"] != "completed")
                }) {
                Some(("noLongerAnswerable", ToolStatus::NotStarted))
            } else if now() >= deadline {
                Some(("timeLimit", ToolStatus::NotStarted))
            } else if next.settings["approvalWait"] != "untilDeadline"
                || q.timeout_ms > self.max_approval_wait_ms()
                || decision.is_some_and(|a| {
                    a.kind == "request.closed"
                        || a.content.as_ref().is_none_or(|v| v["declined"] == true)
                })
            {
                Some(("refused", ToolStatus::Refused))
            } else if decision.is_none() && !self.has_approver(&next, &q) {
                Some(("noLongerAnswerable", ToolStatus::Refused))
            } else {
                None
            };
            if let Some((reason, status)) = reason {
                // A running continuation owns its terminal record. Its final check sees the deadline.
                if !reopen
                    && matches!(&open.active,Some(ActiveTurn::Running(turn)) if branch.iter().any(|s|s.kind=="turn.start" && s.scope.turn.as_ref()==Some(turn) && s.content.as_ref().is_some_and(|v|v["continuesTurnId"].as_str()==q.scope.turn.as_deref())))
                {
                    continue;
                }
                settlement(&mut next, e, &q, reason, status)?;
                open.approval_views.retain(|(_, id), _| id != &q.id);
            } else if reopen {
                self.watch_approval(&next.id, deadline, open.generation.clone());
            }
        }
        if open.data.entries.len() != next.entries.len() {
            self.commit_approval(open, next)?;
            // A settings change or a poll can observe expiry before its timer.
            // In all cases wake the driver from the committed settlement.
            self.wake_settled_approval(&open.data.id);
            return Ok(true);
        }
        Ok(false)
    }
    async fn unchanged_approval(&self, q: &Question, actor: &str, binding: &str) -> bool {
        let projection = q.approval_projection();
        let (recipient, value) = match binding {
            "sdk" => (actor, json!({"question":projection})),
            b if b.starts_with("acp:") => (
                "interface.acp",
                json!({"method":"_modular-agent/requests","result":{"requests":[projection]}}),
            ),
            b if b.starts_with("agui:") => (&b[5..], json!({"question":projection})),
            _ => return false,
        };
        let scope = Scope {
            actor: actor.into(),
            ..Scope::session(&q.scope.session)
        };
        self.output(
            &scope,
            Output {
                recipient: recipient.into(),
                value: value.clone(),
                stream: None,
                end: true,
            },
        )
        .await
        .is_ok_and(|v| v.is_some_and(|v| same_json(&v, &value)))
    }
    pub(super) async fn approval_view(
        &self,
        session: &str,
        id: &str,
        route: &ApprovalRoute,
        answer: Option<(bool, Option<String>)>,
    ) -> Result<bool> {
        self.reconcile_approvals(session, false)?;
        let data = self.snapshot(session)?;
        let branch = data.branch();
        let Some(entry) = request(&branch, id) else {
            return Ok(false);
        };
        let q: Question = serde_json::from_value(entry.content.clone().unwrap())?;
        if decision(&branch, id).is_some() || !binding(&data, &entry, &q) || terminal(&data, &entry)
        {
            return Ok(false);
        }
        let unchanged = self
            .unchanged_approval(&q, &route.actor, &route.binding)
            .await;
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(session)
            .ok_or_else(|| anyhow!("session is closed"))?;
        self.check_open_writer(open)?;
        self.refresh_open_erasure(open)?;
        self.reconcile_open_approvals(open, false)?;
        let key = (route.instance.clone(), id.to_owned());
        open.approval_views
            .retain(|_, (_, r)| !r.live.is_cancelled());
        let permitted =
            self.route_ceiling(&open.data, &route.binding, &route.principal, &route.actor);
        let rights = self.approval_rights(
            &open.data,
            &q,
            &route.actor,
            &route.principal,
            &route.ceiling.intersect(&permitted),
        )?;
        if !unchanged
            || !eligible(&rights)
            || route.live.is_cancelled()
            || !interface_tools::same_authority_record(&data, &open.data, &q.scope)
            || open.data.settings["approvalWait"] != "untilDeadline"
            || terminal(&open.data, &entry)
            || !binding(&open.data, &entry, &q)
            || decision(&open.data.branch(), id).is_some()
            || now() >= q.extra["deadlineAt"].as_u64().unwrap_or(0)
        {
            open.approval_views.remove(&key);
            return Ok(false);
        }
        if let Some((allow, reason)) = answer {
            let Some((seen, delivered)) = open.approval_views.get(&key) else {
                return Ok(false);
            };
            if seen != &entry.id
                || delivered.actor != route.actor
                || delivered.principal != route.principal
                || delivered.binding != route.binding
                || delivered.live.is_cancelled()
            {
                return Ok(false);
            }
            let rights = rights.intersect(&delivered.ceiling);
            if !eligible(&rights) {
                return Ok(false);
            }
            let scope = Scope {
                actor: route.actor.clone(),
                ..q.scope.clone()
            };
            let mut body = json!(Answer {
                request: id.into(),
                actor: route.actor.clone(),
                session: session.into(),
                value: if allow { json!("allow") } else { Value::Null },
                declined: !allow,
                reason
            });
            if allow {
                body["approvalView"] = json!({"requestEntryId":entry.id,"submittedBy":route.principal,"routeId":route.binding,"rights":rights});
            }
            let mut next = open.data.clone();
            push(
                &mut next,
                &scope,
                Draft::new("request.answer", false, body).copying(vec![entry.id.clone()]),
            );
            if !allow {
                settlement(&mut next, &entry, &q, "refused", ToolStatus::Refused)?;
            }
            self.commit_approval(open, next)?;
            open.approval_views.retain(|(_, qid), _| qid != id);
        } else {
            open.approval_views.insert(
                key,
                (
                    entry.id,
                    ApprovalRoute {
                        ceiling: rights,
                        ..route.clone()
                    },
                ),
            );
        }
        Ok(true)
    }
    pub(super) async fn check_approval(
        &self,
        scope: &Scope,
        call: &ToolCall,
        after_start: bool,
    ) -> Result<Option<ToolStatus>> {
        let data = self.snapshot(&scope.session)?;
        let branch = data.branch();
        let Some(e) = branch
            .iter()
            .find(|e| marked(e) && e.scope.call == scope.call)
        else {
            // A continuation with an orphan gate checkpoint must not become
            // an ordinary fresh call just because its request body is gone.
            let orphan = branch.iter().any(|p| {
                p.kind == "tool.pending"
                    && p.scope.call == scope.call
                    && p.scope.turn != scope.turn
                    && p.content.as_ref().is_none_or(|v| {
                        v["toolStartedId"].is_null()
                            && v["requestIds"].as_array().is_none_or(|ids| {
                                ids.is_empty()
                                    || ids.iter().any(|id| {
                                        !branch.iter().any(|q| {
                                            q.kind == "request.open"
                                                && q.scope.call == scope.call
                                                && q.content
                                                    .as_ref()
                                                    .is_some_and(|b| b["id"] == *id)
                                        })
                                    })
                            })
                    })
            });
            return Ok(orphan.then_some(ToolStatus::Refused));
        };
        let denied = Some(ToolStatus::Refused);
        let q: Question = serde_json::from_value(e.content.clone().unwrap())?;
        let starts = branch
            .iter()
            .filter(|r| r.kind == "tool.started" && r.scope.call == scope.call)
            .count();
        if starts > usize::from(after_start) {
            return Ok(Some(ToolStatus::Unknown));
        }
        let deadline = q.extra["deadlineAt"].as_u64().unwrap_or(0);
        if now() >= deadline {
            return Ok(Some(ToolStatus::NotStarted));
        }
        let Some(a) = decision(&branch, &q.id) else {
            return Ok(denied);
        };
        let body = a.content.as_ref().unwrap();
        let proof = &body["approvalView"];
        let (Some(principal), Some(route), Ok(ceiling)) = (
            proof["submittedBy"].as_str(),
            proof["routeId"].as_str(),
            serde_json::from_value::<Authority>(proof["rights"].clone()),
        ) else {
            return Ok(denied);
        };
        if !binding(&data, e, &q)
            || !a.copies.contains(&e.id)
            || a.kind != "request.answer"
            || body["value"] != "allow"
            || body["declined"] != false
            || body["actor"] != a.scope.actor
            || proof["requestEntryId"] != e.id
            || data
                .entries
                .iter()
                .skip_while(|r| r.id != a.id)
                .skip(1)
                .any(|r| {
                    let Some(v) = &r.content else {
                        return authority_record(r);
                    };
                    let who = if r.kind == "actor.left" {
                        &v["actorId"]
                    } else {
                        &v["actor"]
                    };
                    let concerns_actor = who == principal || who == &a.scope.actor;
                    (r.kind == "actor.left" && concerns_actor)
                        || (r.kind == "actor.grant"
                            && concerns_actor
                            && serde_json::from_value::<Authority>(v["authority"].clone())
                                .map_or(true, |g| !eligible(&g)))
                        || (r.kind == "limit"
                            && !v["rights"].is_null()
                            && serde_json::from_value::<Authority>(v["rights"].clone())
                                .map_or(true, |g| !eligible(&g)))
                })
            || terminal(&data, e)
            || self.max_approval_wait_ms().is_none()
            || q.timeout_ms > self.max_approval_wait_ms()
            || data.settings["approvalWait"] != "untilDeadline"
            || !matches!(
                data.settings["approval"].as_str(),
                Some("off" | "ask_always" | "ask_unless_read_only")
            )
            || !branch.iter().any(|s| {
                s.kind == "turn.start"
                    && s.scope.turn == scope.turn
                    && s.content
                        .as_ref()
                        .is_some_and(|v| v["continuesTurnId"].as_str() == e.scope.turn.as_deref())
            })
            || !same_json(&wire::call(call, scope), &q.extra["approvalCall"])
            || !eligible(&self.approval_rights(
                &data,
                &q,
                &a.scope.actor,
                principal,
                &ceiling.intersect(&self.route_ceiling(&data, route, principal, &a.scope.actor)),
            )?)
        {
            return Ok(denied);
        }
        if !self.unchanged_approval(&q, &a.scope.actor, route).await {
            return Ok(denied);
        }
        let current = self.snapshot(&scope.session)?;
        if !interface_tools::same_authority_record(&data, &current, scope)
            || terminal(&current, e)
            || !binding(&current, e, &q)
            || !work_authority(self, scope)?.has("tools")
            || !work_authority(self, &q.scope)?.has("tools")
            || self.cancellation(&scope.session)?.is_cancelled()
        {
            return Ok(denied);
        }
        let registered = self.capability_names("tools.").iter().any(|key| {
            same_json(&self.tool_registration(key), &q.extra["source"])
                && capability::<dyn ToolSource>(self, key).is_ok_and(|s| {
                    s.tools(&current).iter().any(|d| {
                        d.name == call.name
                            && same_json(&q.extra["definition"], &wire::registered_definition(d))
                            && schema::check(&d.input, Some(&call.input)).is_ok()
                    })
                })
        });
        self.check_writer(&scope.session)?;
        Ok(if now() >= deadline {
            Some(ToolStatus::NotStarted)
        } else if !registered {
            denied
        } else {
            None
        })
    }
}
fn eligible(r: &Authority) -> bool {
    r.has("watch") && r.has("approve")
}
