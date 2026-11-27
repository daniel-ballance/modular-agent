use super::{history_commit::make_entry, *};
use std::collections::BTreeSet;

impl OpenSession {
    pub(super) fn check_rewind(&self) -> Result<()> {
        ensure!(
            !self.rewinding && !self.journal_uncertain && self.data.unresolved_rewind().is_none(),
            RewindError::Busy("rewind is in progress or unresolved".into())
        );
        Ok(())
    }
}

pub(super) struct Reservation {
    harness: Weak<Harness>,
    session: String,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        if let Some(harness) = self.harness.upgrade()
            && let Some(open) = harness.sessions.lock().unwrap().get_mut(&self.session)
        {
            open.rewinding = false;
        }
    }
}

pub(super) struct EnvironmentWork {
    pub harness: Weak<Harness>,
    pub session: String,
}
impl Drop for EnvironmentWork {
    fn drop(&mut self) {
        if let Some(harness) = self.harness.upgrade()
            && let Some(open) = harness.sessions.lock().unwrap().get_mut(&self.session)
        {
            open.environment_work -= 1;
        }
    }
}

fn conflict(err: impl ToString) -> anyhow::Error {
    RewindError::Conflict(err.to_string()).into()
}

impl Harness {
    pub(super) fn check_project_open(
        &self,
        sessions: &BTreeMap<String, OpenSession>,
        data: &SessionData,
    ) -> Result<()> {
        let blocked = self.blocked_projects.lock().unwrap();
        ensure!(
            blocked.get(&data.project).is_none_or(|id| id == &data.id),
            "project has an unresolved rewind"
        );
        for open in sessions.values().filter(|s| s.data.project == data.project) {
            open.check_rewind()?;
            ensure!(
                data.unresolved_rewind().is_none(),
                "cannot recover rewind in a shared project"
            );
        }
        Ok(())
    }

    pub(super) fn reserve_rewind(&self, session: &str) -> Result<(Reservation, SessionData)> {
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get(session)
            .ok_or_else(|| anyhow!("session not open"))?;
        open.check_rewind()?;
        ensure!(
            !open.provisional,
            conflict("cannot rewind before the first input is admitted")
        );
        let data = &open.data;
        ensure!(
            open.active.is_none() && open.environment_work == 0 && open.queue.is_empty(),
            RewindError::Busy("settle pending work before rewinding".into())
        );
        ensure!(
            !sessions
                .values()
                .any(|s| s.data.id != session && s.data.project == data.project),
            RewindError::Conflict("cannot rewind a shared project".into())
        );
        let data = data.clone();
        sessions.get_mut(session).unwrap().rewinding = true;
        Ok((
            Reservation {
                harness: self.me.clone(),
                session: session.into(),
            },
            data,
        ))
    }

    pub(super) async fn rewind_project(
        &self,
        scope: &Scope,
        position: String,
    ) -> Result<Vec<String>> {
        require(self, scope, "settings")?;
        let env: Arc<dyn WorkingEnvironment> =
            capability(self, "environment").map_err(|_| RewindError::NotSupported)?;
        let (_reservation, data) = self.reserve_rewind(&scope.session)?;
        ensure!(env.keeps_points(&data.project), RewindError::NotSupported);
        let branch = data.branch();
        let i = branch
            .iter()
            .position(|e| e.id == position)
            .ok_or_else(|| conflict("rewind target is not on the current branch"))?;
        let target = &branch[i];
        ensure!(
            target.kind != "position" && (target.scope.turn.is_none() || target.kind == "turn.end"),
            conflict("rewind target is not quiescent")
        );
        let suffix = &branch[i + 1..];
        ensure!(
            !jobs(&data)?.iter().any(|j| j.state.is_unfinished())
                && data.pending_inputs().is_empty()
                && !questions(&data)?.iter().any(|q| q.answerable)
                && !branch.iter().any(|e| {
                    match e.kind.as_str() {
                        "turn.start" => !data
                            .entries
                            .iter()
                            .any(|done| done.kind == "turn.end" && done.scope.turn == e.scope.turn),
                        // A waiting call can settle in a later continuation.
                        "tool.call" | "tool.started" => !data.entries.iter().any(|done| {
                            done.kind == "tool.result" && done.scope.call == e.scope.call
                        }),
                        _ => false,
                    }
                }),
            RewindError::Busy("settle pending work before rewinding".into())
        );
        ensure!(
            !data
                .entries
                .iter()
                .skip_while(|e| e.id != position)
                .skip(1)
                .any(|e| matches!(e.kind.as_str(), "job.start" | "job.started")),
            conflict("cannot rewind past work outside the environment")
        );
        self.check_writer(&scope.session)?;
        let mut first = None;
        for e in suffix.iter().filter(|e| {
            e.kind == "turn.start" || (e.kind == "tool.started" && e.scope.turn.is_none())
        }) {
            let point = e
                .content
                .as_ref()
                .and_then(|v| v["point"].as_str())
                .filter(|p| !p.is_empty())
                .ok_or_else(|| conflict(format!("no saved point for {}", e.id)))?;
            ensure!(
                env.check_point(&scope.session, &data.project, point)
                    .await
                    .map_err(conflict)?,
                conflict(format!("saved point is missing or foreign for {}", e.id))
            );
            first.get_or_insert(point);
        }
        let mut seen = BTreeSet::new();
        let out_of_reach = suffix
            .iter()
            .filter(|e| {
                e.kind == "tool.started"
                    && e.content
                        .as_ref()
                        .and_then(|v| v["openWorld"].as_bool())
                        .unwrap_or(true)
            })
            .filter_map(|e| e.scope.call.clone())
            .filter(|call| seen.insert(call.clone()))
            .collect();
        if let Some(point) = first {
            self.check_writer(&scope.session)?;
            let undo = env.save_point(&scope.session, &data.project).await?;
            self.commit_position(scope, Some(position), Some((point, &undo)))?;
            self.finish_rewind(scope, env.as_ref()).await?;
        } else {
            self.commit_position(scope, Some(position), None)?;
        }
        self.invalidate_providers(&scope.session)?;
        Ok(out_of_reach)
    }

    // Commit first, then restore. If the write is ambiguous, do not trust the
    // proposed head unless the exact record can be read under the writer lease.
    fn commit_position(
        &self,
        scope: &Scope,
        to: Option<String>,
        restore: Option<(&str, &str)>,
    ) -> Result<()> {
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(&scope.session)
            .ok_or_else(|| anyhow!("session not open"))?;
        self.check_open_writer(open)?;
        let mut content = json!({"to":to});
        if let Some((point, undo)) = restore {
            content["restore"] = json!({"point":point,"undo":undo});
        }
        let entry = make_entry(
            &open.data,
            scope,
            "harness",
            Draft::new("position", false, content),
        );
        let mut next = open.data.clone();
        next.entries.push(entry.clone());
        next.position = to;
        let pool = self.reservations();
        let before = open.data.clone();
        pool.commit(&before, &next, None, || {
            let Err(error) = self.save(&next) else {
                return Ok(());
            };
            let check_lease = || open.lease.as_ref().map_or(Ok(()), |lease| lease.check());
            let observed = (|| {
                check_lease()?;
                let observed = self
                    .store()
                    .ok_or_else(|| anyhow!("history store is unavailable"))?
                    .load(&scope.session)?;
                check_lease()?;
                Ok::<_, anyhow::Error>(observed)
            })();
            match observed {
                Ok(data)
                    if data.entries.last().is_some_and(|e| {
                        e.id == entry.id
                            && e.parent == entry.parent
                            && e.kind == entry.kind
                            && e.content == entry.content
                    }) => {}
                Ok(data)
                    if data.position == open.data.position
                        && !data.entries.iter().any(|e| e.id == entry.id) =>
                {
                    self.interrupt(open, "commitFailed");
                    return Err(LostPart(format!("rewind commit failed: {error}")).into());
                }
                _ => {
                    open.journal_uncertain = true;
                    let lost = error.is::<LostPart>() || check_lease().is_err();
                    self.interrupt(open, if lost { "writerLost" } else { "commitFailed" });
                    return Err(LostPart("could not reconcile the rewind journal".into()).into());
                }
            }
            Ok(())
        })?;
        open.data = next;
        self.pending_events
            .lock()
            .unwrap()
            .push(Event::new(scope, "history.entry", json!(entry)));
        Ok(())
    }

    pub(super) async fn recover_rewind(&self, scope: &Scope) -> Result<()> {
        let env: Arc<dyn WorkingEnvironment> = capability(self, "environment")?;
        ensure!(
            env.keeps_points(&self.snapshot(&scope.session)?.project),
            "cannot recover rewind without environment points"
        );
        // A successful compensation is safe to reopen, even though the original
        // rewind failed. No other work can append before this completes.
        if let Err(error) = self.finish_rewind(scope, env.as_ref()).await
            && self.snapshot(&scope.session)?.unresolved_rewind().is_some()
        {
            return Err(error);
        }
        self.invalidate_providers(&scope.session)
    }

    async fn finish_rewind(&self, scope: &Scope, env: &dyn WorkingEnvironment) -> Result<()> {
        let data = self.snapshot(&scope.session)?;
        let intent = data
            .unresolved_rewind()
            .ok_or_else(|| anyhow!("missing rewind intent"))?;
        let content = intent.content.as_ref().unwrap();
        let point = wire::string(&content["restore"], "point")?;
        let undo = wire::string(&content["restore"], "undo")?;
        let target = content["to"].as_str().map(str::to_owned);
        let compensating = data
            .entries
            .iter()
            .position(|e| e.id == intent.id)
            .and_then(|i| i.checked_sub(1))
            .map(|i| &data.entries[i])
            .is_some_and(|prior| {
                prior.kind == "position"
                    && prior.parent == target
                    && prior.content.as_ref().is_some_and(|c| {
                        c["restore"]["point"] == undo && c["restore"]["undo"] == point
                    })
            });
        self.check_writer(&scope.session)?;
        match env
            .restore_point(&scope.session, &data.project, point)
            .await
        {
            Ok(()) => self.commit_position(scope, target, None),
            Err(error) if compensating => Err(error.context("rewind undo is unresolved")),
            Err(error) => {
                self.commit_position(scope, intent.parent.clone(), Some((undo, point)))?;
                self.check_writer(&scope.session)?;
                env.restore_point(&scope.session, &data.project, undo)
                    .await
                    .map_err(|undo_error| {
                        anyhow!("rewind failed: {error}; undo is unresolved: {undo_error}")
                    })?;
                self.commit_position(scope, intent.parent.clone(), None)?;
                Err(conflict(format!(
                    "rewind restore failed; original files restored: {error}"
                )))
            }
        }
    }
}
