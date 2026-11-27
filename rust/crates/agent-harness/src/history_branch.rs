use super::{
    Harness, OpenSession,
    history_commit::{make_entry, push_setup},
    tenants, waiting_approvals,
};
use agent_api::*;
use std::collections::{BTreeMap, VecDeque};

impl Harness {
    pub(super) fn move_history_position(
        &self,
        scope: &Scope,
        position: Option<String>,
    ) -> Result<()> {
        require(self, scope, "settings")?;
        self.retry_open_erasure_now(&scope.session)?;
        ensure!(
            !jobs(&self.snapshot(&scope.session)?)?
                .iter()
                .any(|j| j.state == JobState::Running),
            OperationError::Busy("cancel jobs before moving position".into())
        );
        ensure!(
            !self.is_running(&scope.session),
            OperationError::Busy("cannot move during a turn".into())
        );
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(&scope.session)
            .ok_or_else(|| OperationError::NotFound("unknown session".into()))?;
        open.check_rewind()?;
        ensure!(
            position
                .as_ref()
                .is_none_or(|p| open.data.entries.iter().any(|e| e.id == *p)),
            OperationError::NotFound("unknown position".into())
        );
        let mut next = open.data.clone();
        ensure!(
            !waiting_approvals::outstanding(&next),
            OperationError::Busy("settle waiting approvals before moving".into())
        );
        let original = next.branch();
        ensure!(
            !original
                .iter()
                .any(|e| interface_handoff(e) && interface_result(&next, e).is_none()),
            OperationError::Busy("settle Interface calls before moving position".into())
        );
        let mut additions: Vec<(Scope, Draft)> = vec![];
        for q in questions(&next)?.into_iter().filter(|q| q.answerable) {
            additions.push((
                q.scope,
                Draft::new(
                    "request.closed",
                    false,
                    json!({"request":q.id,"reason":"noLongerAnswerable"}),
                ),
            ));
        }
        for e in original.iter().filter(|e| e.kind == "tool.call") {
            if next
                .entries
                .iter()
                .any(|r| r.kind == "tool.result" && r.scope.call == e.scope.call)
            {
                continue;
            }
            let call: ToolCall = serde_json::from_value(
                e.content
                    .clone()
                    .ok_or_else(|| anyhow!("erased open call"))?,
            )?;
            let result = if let Some(done) = next
                .entries
                .iter()
                .find(|r| r.kind == "tool.completed" && r.scope.call == e.scope.call)
            {
                done.content
                    .clone()
                    .ok_or_else(|| anyhow!("erased tool completion"))?
            } else {
                json!(ToolResult::new(
                    &call,
                    ToolStatus::Cancelled,
                    "branch abandoned"
                ))
            };
            additions.push((
                e.scope.clone(),
                Draft::new("tool.result", true, result).copying(vec![e.id.clone()]),
            ));
        }
        for input in &open.queue {
            additions.push((
                scope.clone(),
                Draft::new("input.returned", false, json!({"input":input.id})),
            ));
        }
        for (scope, draft) in additions {
            let entry = make_entry(&next, &scope, "harness", draft);
            next.position = Some(entry.id.clone());
            next.entries.push(entry);
        }
        let old = next.position.clone();
        let entry = make_entry(
            &next,
            scope,
            "harness",
            Draft::new("position", false, json!({"from":old,"to":position})),
        );
        next.position = position;
        next.entries.push(entry);
        self.commit(open, &next)?;
        open.data = next;
        open.queue.clear();
        self.invalidate_providers(&scope.session)?;
        Ok(())
    }

    pub(super) fn fork_session(&self, scope: &Scope, position: Option<String>) -> Result<String> {
        require(self, scope, "watch")?;
        require(self, scope, "settings")?;
        self.retry_open_erasure_now(&scope.session)?;
        let _workspace = self.begin_environment_work(&scope.session)?;
        ensure!(
            !self.is_running(&scope.session),
            OperationError::Busy("cannot fork during a turn".into())
        );
        let mut source = self.snapshot(&scope.session)?;
        ensure!(
            !waiting_approvals::outstanding(&source),
            OperationError::Busy("settle waiting approvals before forking".into())
        );
        if let Some(p) = position {
            ensure!(
                source.entries.iter().any(|e| e.id == p),
                OperationError::NotFound("unknown fork point".into())
            );
            source.position = Some(p);
        }
        let branch = source.branch();
        ensure!(
            !questions(&source)?.iter().any(|q| q.answerable)
                && !jobs(&source)?.iter().any(|j| j.state == JobState::Running)
                && !branch.iter().any(|e| e.kind == "tool.call"
                    && !branch
                        .iter()
                        .any(|r| r.kind == "tool.result" && r.scope.call == e.scope.call)),
            OperationError::Busy("settle pending work before forking".into())
        );
        ensure!(
            self.sessions
                .lock()
                .unwrap()
                .get(&scope.session)
                .unwrap()
                .queue
                .is_empty(),
            OperationError::Busy("take or withdraw queued input before forking".into())
        );
        let new_id = id();
        let lease = self.store().map(|s| s.acquire(&new_id)).transpose()?;
        let mut next = SessionData {
            id: new_id.clone(),
            origin: Some((source.id.clone(), source.position.clone())),
            entries: vec![],
            position: None,
            ..source.clone()
        };
        let branch = source.branch();
        let branch: Vec<_> = branch
            .iter()
            .filter(|e| {
                e.writer != "rust.derived"
                    && e.kind != telemetry::TURN_TRACE
                    && !interface_handoff(e)
            })
            .collect();
        for original in &branch {
            let mut entry = (*original).clone();
            entry.id = id();
            entry.parent = next.position.clone();
            entry.scope.session = new_id.clone();
            if let Some(v) = entry.content.as_mut() {
                if entry.kind == "turn.start" {
                    if let Some(value) = v.as_object_mut() {
                        value.remove("traceContext");
                    }
                } else if entry.kind == "request.open" {
                    let mut q: Question = serde_json::from_value(v.clone())?;
                    q.scope.session = new_id.clone();
                    for s in &mut q.route {
                        if *s == source.id {
                            *s = new_id.clone();
                        }
                    }
                    *v = json!(q);
                } else if entry.kind == "request.answer" {
                    let mut answer: Answer = serde_json::from_value(v.clone())?;
                    if answer.session == source.id {
                        answer.session = new_id.clone();
                    }
                    *v = json!(answer);
                }
            }
            if entry.content.is_some() {
                entry.copies.insert(0, original.id.clone());
            } else {
                entry.copies.clear();
            }
            next.position = Some(entry.id.clone());
            next.entries.push(entry);
        }
        // Remap summary coverage to the fork's IDs as well as keeping erasure provenance.
        let map: BTreeMap<_, _> = branch
            .iter()
            .zip(next.entries.iter())
            .map(|(a, b)| (a.id.clone(), b.id.clone()))
            .collect();
        for e in &mut next.entries {
            if let Some(content) = &mut e.content
                && matches!(e.kind.as_str(), "input" | "input.accepted")
                && let Some(input) = content["inputId"].as_str().and_then(|id| map.get(id))
            {
                content["inputId"] = json!(input);
            }
            let mut local: Vec<_> = e
                .copies
                .iter()
                .filter_map(|x| map.get(x).filter(|local| *local != &e.id).cloned())
                .collect();
            e.copies.append(&mut local);
        }
        // The copied branch is display/context, not the fork's setup. Capture
        // the current session settings and membership even at an older fork point.
        if let Some(tenant) = tenants::name(&source) {
            push_setup(&mut next, "tenant", |_| json!({"tenant":tenant}));
        }
        let mut membership = BTreeMap::new();
        let mut limit = None;
        for entry in &source.entries {
            let Some(value) = &entry.content else {
                continue;
            };
            match entry.kind.as_str() {
                "actor.grant" => {
                    if let Some(actor) = value["actor"].as_str() {
                        membership.insert(actor, entry);
                    }
                }
                "actor.identity" => {
                    if let Some(actor) = value["id"].as_str() {
                        membership.insert(actor, entry);
                    }
                }
                "actor.left" => {
                    if let Some(actor) = value["actorId"].as_str() {
                        membership.insert(actor, entry);
                    }
                }
                "limit" => limit = Some(value),
                _ => {}
            }
        }
        for entry in membership.values() {
            push_setup(&mut next, &entry.kind, |_| entry.content.clone().unwrap());
        }
        push_setup(&mut next, "settings", |data| data.settings.clone());
        if let Some(limit) = limit {
            push_setup(&mut next, "limit", |_| limit.clone());
        }
        push_setup(
            &mut next,
            "plugins.changed",
            |data| json!({"active":data.plugins}),
        );
        let empty = SessionData {
            entries: vec![],
            position: None,
            ..next.clone()
        };
        self.reservations()
            .commit(&empty, &next, None, || self.save(&next))?;
        self.sessions.lock().unwrap().insert(
            new_id.clone(),
            OpenSession {
                data: next,
                lease,
                provisional: false,
                commits: None,
                generation: CancellationToken::new(),
                interruption: CancellationToken::new(),
                queue: VecDeque::new(),
                input_contexts: BTreeMap::new(),
                question_contexts: BTreeMap::new(),
                approval_views: Default::default(),
                interrupted: Vec::new(),
                active: None,
                rewinding: false,
                journal_uncertain: false,
                environment_work: 0,
                steer_closed: false,
                continuation_waiters: Default::default(),
                cancel: CancellationToken::new(),
            },
        );
        self.watch_writer(&new_id);
        Ok(new_id)
    }
}
