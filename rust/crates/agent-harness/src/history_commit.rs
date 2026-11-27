use super::{Harness, OpenSession, capacity, receipt, waiting_approvals};
use agent_api::telemetry::{self, KeyValue, Operation, SpanKind, TraceContextExt};
use agent_api::*;

pub(super) fn push_setup(
    data: &mut SessionData,
    kind: &str,
    content: impl FnOnce(&SessionData) -> Value,
) {
    let scope = Scope::session(&data.id);
    let entry = make_entry(
        data,
        &scope,
        "harness",
        Draft::new(kind, false, content(data)),
    );
    data.position = Some(entry.id.clone());
    data.entries.push(entry);
}

pub(super) fn make_entry(data: &SessionData, scope: &Scope, writer: &str, draft: Draft) -> Entry {
    // Imported calls are a view over a real response or start, not entries
    // that can be named in a persisted sources list.
    let id = receipt::bound_id(scope, &draft).unwrap_or_else(id);
    let mut seen = std::collections::HashSet::new();
    let copies = draft
        .copies
        .into_iter()
        .map(|id| {
            data.entries
                .iter()
                .find(|entry| entry.writer == "rust.derived" && entry.id == id)
                .and_then(|entry| entry.parent.clone())
                .unwrap_or(id)
        })
        .filter(|id| seen.insert(id.clone()))
        .collect();
    Entry {
        id,
        parent: data.position.clone(),
        input_id: None,
        scope: scope.clone(),
        writer: writer.into(),
        at: now(),
        kind: draft.kind,
        visible: draft.visible,
        copies,
        content: Some(draft.content),
    }
}

pub(super) fn observe_question(data: &SessionData, entry: &Entry) {
    let Some(body) = &entry.content else { return };
    let (q, disposition) = match entry.kind.as_str() {
        "request.open" => (body, None),
        "request.answer" | "request.closed" => {
            let Some(q) = data
                .entries
                .iter()
                .rev()
                .filter(|e| e.kind == "request.open")
                .filter_map(|e| e.content.as_ref())
                .find(|q| q["id"] == body["request"])
            else {
                return;
            };
            let disposition = if entry.kind == "request.answer" {
                if body["declined"] == true {
                    "declined"
                } else if q["kind"] == "secret" {
                    "stored"
                } else {
                    "answered"
                }
            } else {
                body["reason"]
                    .as_str()
                    .filter(|r| {
                        matches!(
                            *r,
                            "timeLimit"
                                | "noLongerAnswerable"
                                | "superseded"
                                | "cancelled"
                                | "turnEnded"
                                | "restart"
                        )
                    })
                    .unwrap_or("declined")
            };
            (q, Some(disposition))
        }
        _ => return,
    };
    let (Some(id), Some(kind @ ("approval" | "text" | "choice" | "form" | "secret"))) =
        (q["id"].as_str(), q["kind"].as_str())
    else {
        return;
    };
    let mut attrs = vec![
        KeyValue::new("modular_agent.question.id", id.to_owned()),
        KeyValue::new("modular_agent.question.kind", kind.to_owned()),
    ];
    if let Some(disposition) = disposition {
        attrs.push(KeyValue::new(
            "modular_agent.question.disposition",
            disposition.to_owned(),
        ));
        let cx = telemetry::current();
        let op = (!cx.span().is_recording())
            .then(|| Operation::internal("modular_agent.question.answer", &entry.scope));
        let _guard = op.as_ref().map(Operation::enter);
        telemetry::event("modular_agent.question.close", &entry.scope, attrs);
    } else {
        telemetry::event("modular_agent.question.open", &entry.scope, attrs);
    }
}

impl Harness {
    /// Subscribe before reading a catch-up watermark. Only the ledger contains facts;
    /// the bounded channel carries wakes, never entry bodies.
    pub fn follow_commits(&self, id: &str) -> Result<tokio::sync::broadcast::Receiver<()>> {
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(id)
            .ok_or_else(|| OperationError::NotFound("session closed".into()))?;
        Ok(open
            .commits
            .get_or_insert_with(|| tokio::sync::broadcast::channel(128).0)
            .subscribe())
    }
    pub(super) fn commit(&self, open: &mut OpenSession, data: &SessionData) -> Result<()> {
        self.commit_reserved(open, data, None)
    }
    pub(super) fn commit_reserved(
        &self,
        open: &mut OpenSession,
        data: &SessionData,
        admission: Option<capacity::Reservation>,
    ) -> Result<()> {
        self.check_open_writer(open)?;
        if open.provisional {
            let admitted = data
                .entries
                .iter()
                .skip(open.data.entries.len())
                .any(|entry| {
                    entry.kind == "input.accepted"
                        || (entry.kind == "command"
                            && receipt::BIND_ENTRY
                                .try_with(|b| b.entry_id == entry.id)
                                .unwrap_or(false))
                        || (entry.kind == "actor.grant"
                            && entry.writer == "interface.acp"
                            && entry
                                .content
                                .as_ref()
                                .is_some_and(|v| v["operatorAdmission"] != true))
                });
            if !admitted {
                return Ok(());
            }
            open.lease = self.store().map(|s| s.acquire(&data.id)).transpose()?;
        }
        if let Ok(Some(id)) =
            receipt::BIND_ENTRY.try_with(|b| (b.session == data.id).then_some(&b.entry_id).cloned())
        {
            ensure!(
                data.entries.iter().filter(|e| e.id == id).count() <= 1,
                OperationError::Conflict("run ID already accepted".into())
            );
        }
        let pool = self.reservations();
        let mut write_failed = false;
        let committed = pool.commit(&open.data, data, admission, || {
            let Some(store) = self.store().filter(|_| Self::should_save(data)) else {
                return Ok(());
            };
            // The first write also commits any setup entries kept only in memory.
            let previous = if Self::should_save(&open.data) {
                open.data.entries.len()
            } else {
                0
            };
            let scope = data
                .entries
                .last()
                .map(|e| e.scope.clone())
                .unwrap_or_else(|| Scope::session(&data.id));
            let op = Operation::internal("modular_agent.history.commit", &scope);
            op.attr(
                "modular_agent.history.entry.count",
                data.entries.len().saturating_sub(previous) as i64,
            );
            let _guard = op.enter();
            let result = store.save(data);
            write_failed = result.is_err();
            op.attr(
                "modular_agent.history.commit.status",
                if result.is_ok() {
                    "committed"
                } else {
                    "uncertain"
                },
            );
            if write_failed {
                op.error("write_failed");
            }
            result
        });
        if let Err(error) = committed {
            if !write_failed || error.is::<PendingErasure>() {
                return Err(error);
            }
            let lost = error.is::<LostPart>()
                || open
                    .lease
                    .as_ref()
                    .is_some_and(|lease| lease.check().is_err());
            self.interrupt(open, if lost { "writerLost" } else { "commitFailed" });
            return Err(LostPart(format!("session commit failed: {error}")).into());
        }
        if let Some(commits) = &open.commits {
            let _ = commits.send(());
        }
        if open.provisional {
            open.provisional = false;
            self.watch_open_writer(open);
        }
        Ok(())
    }
    fn should_save(data: &SessionData) -> bool {
        // An ACP connection joins even a new session, but that join alone
        // must not leave an unused session in the store.
        !data.entries.iter().all(|e| {
            matches!(e.kind.as_str(), "command" | "plugins.changed" | "tenant")
                || (e.kind == "actor.grant"
                    && e.writer == "interface.acp"
                    && e.content
                        .as_ref()
                        .is_some_and(|v| v["operatorAdmission"] == true))
        })
    }
    pub(super) fn save(&self, data: &SessionData) -> Result<()> {
        if let Some(store) = self.store().filter(|_| Self::should_save(data)) {
            store.save(data)?;
        }
        Ok(())
    }

    pub(super) fn publish_history(
        &self,
        scope: &Scope,
        writer: &str,
        drafts: Vec<Draft>,
        input: Option<(String, String)>,
        key: Option<String>,
    ) -> Result<Vec<Entry>> {
        let cap = input
            .as_ref()
            .map(|(_, actor)| self.authority(&scope.session, actor))
            .transpose()?;
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(&scope.session)
            .ok_or_else(|| anyhow!("session not open"))?;
        open.check_rewind()?;
        if let Some(key) = &key
            && open.data.entries.iter().any(|e| {
                matches!(e.kind.as_str(), "input" | "input.accepted")
                    && e.content.as_ref().is_some_and(|v| v["key"] == *key)
            })
        {
            return Ok(vec![]);
        }
        let settling = scope.job.is_some()
            && self.store().is_some_and(|store| {
                store
                    .check_erasure(&open.data)
                    .is_err_and(|error| error.is::<PendingErasure>())
            });
        let input = if settling { None } else { input };
        let mut next = open.data.clone();
        let mut entries = vec![];
        let mut report = None;
        for mut draft in drafts {
            if settling && draft.kind == "job.end" {
                let mut job: Job = serde_json::from_value(draft.content)?;
                job.detail = Value::Null;
                job.report = false;
                job.result = None;
                draft = Draft::new("job.end", false, json!(job));
            }
            if draft.kind == "job.end"
                && draft.content["report"] == true
                && let Some((text, _)) = &input
            {
                let content = draft
                    .content
                    .get("wireResult")
                    .cloned()
                    .unwrap_or_else(|| json!([{"type":"text","text":text}]));
                draft.content["wireResult"] = content.clone();
                report = Some(content);
            }
            let entry = make_entry(&next, scope, writer, draft);
            next.position = Some(entry.id.clone());
            next.entries.push(entry.clone());
            entries.push(entry);
        }
        let queued = input.map(|(text, actor)| {
            let input_scope = Scope { actor: actor.clone(), ..scope.clone() };
            let mut value = json!({"text":text,"key":key,"timing":Timing::After,"authority":cap,"taken":"after"});
            if let Some(content) = report {
                value["content"] = content;
                value["parked"] = json!(!self.registry.read().unwrap().declaration()["job_reports_start_turns"].as_bool().unwrap_or(false));
            }
            let entry = make_entry(
                &next,
                &input_scope,
                writer,
                Draft::new("input.accepted", false, value),
            );
            let input = Input {
                id: entry.id.clone(),
                actor,
                text,
                timing: if entry.content.as_ref().is_some_and(|v| v["parked"] == true) {
                    Timing::Propose
                } else {
                    Timing::After
                },
                key,
            };
            next.position = Some(entry.id.clone());
            next.entries.push(entry.clone());
            entries.push(entry);
            input
        });
        self.commit(open, &next)?;
        open.data = next;
        if let Some(input) = queued {
            let cx = telemetry::current();
            let job = telemetry::link(&cx).into_iter().collect();
            let op = Operation::start(
                "modular_agent.input.admit",
                SpanKind::Internal,
                Some(scope),
                vec![KeyValue::new("modular_agent.input.id", input.id.clone())],
                &cx,
                job,
            );
            if telemetry::traceparent(&op.context()).is_some() {
                open.input_contexts.insert(input.id.clone(), op.context());
            }
            open.queue.push_back(input);
        }
        for entry in &entries {
            self.pending_events.lock().unwrap().push(Event::new(
                scope,
                "history.entry",
                json!(entry),
            ));
        }
        Ok(entries)
    }

    pub(super) fn append_history(
        &self,
        scope: &Scope,
        writer: &str,
        mut draft: Draft,
    ) -> Result<Entry> {
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(&scope.session)
            .ok_or_else(|| anyhow!("session not open"))?;
        open.check_rewind()?;
        if draft.kind == "turn.end"
            && (self.has_interface_tools() || waiting_approvals::outstanding(&open.data))
        {
            let mut result = serde_json::from_value(draft.content.clone())?;
            self.finish_open_interface_turn(open, scope, &mut result)?;
            draft.content["open_calls"] = json!(result.open_calls);
        }
        if draft.kind == "request.answer"
            && let Some(q) = open.data.entries.iter().find(|e| {
                e.kind == "request.open"
                    && e.content
                        .as_ref()
                        .is_some_and(|v| v["id"] == draft.content["request"])
            })
            && !draft.copies.contains(&q.id)
        {
            draft.copies.push(q.id.clone());
        }
        if draft.kind == "tool.result" {
            ensure!(
                !open
                    .data
                    .entries
                    .iter()
                    .any(|e| e.kind == "tool.result" && e.scope.call == scope.call),
                "tool call already has a result"
            );
        }
        if matches!(draft.kind.as_str(), "tool.started" | "tool.result") {
            waiting_approvals::add_sources(&open.data, scope, &mut draft);
        }
        let entry = make_entry(&open.data, scope, writer, draft);
        let mut next = open.data.clone();
        next.position = Some(entry.id.clone());
        next.entries.push(entry.clone());
        let revoked = matches!(entry.kind.as_str(), "actor.grant" | "actor.left")
            && self.close_revoked_questions(&open.data, &mut next)?;
        let settled_wait = revoked
            && next.entries[open.data.entries.len()..]
                .iter()
                .any(|e| e.kind == "tool.result");
        self.commit(open, &next)?;
        open.data = next;
        if revoked {
            requests(self)?.decisions_changed();
            if settled_wait {
                self.wake_settled_approval(&open.data.id);
            }
        }
        if let Some(content) = &entry.content {
            match entry.kind.as_str() {
                "request.open" => {
                    if let Some(id) = content["id"].as_str()
                        && let Some(parent) = telemetry::traceparent(&telemetry::current())
                    {
                        open.question_contexts.insert(id.into(), parent);
                    }
                }
                "request.answer" | "request.closed" => {
                    if let Some(id) = content["request"].as_str() {
                        open.question_contexts.remove(id);
                    }
                }
                _ => {}
            }
        }
        if authority_record(&entry) {
            self.invalidate_ineligible_approval_views(open)?;
        }
        if entry.kind == "turn.end" || authority_record(&entry) {
            self.reconcile_open_approvals(open, false)?;
        }
        observe_question(&open.data, &entry);
        self.pending_events
            .lock()
            .unwrap()
            .push(Event::new(scope, "history.entry", json!(entry)));
        Ok(entry)
    }
}
