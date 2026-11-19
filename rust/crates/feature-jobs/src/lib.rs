//! Session-owned work. Runners decide whether and how to recover unfinished work.
use agent_api::*;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;
#[derive(Default)]
pub struct JobsPlugin;
#[derive(Clone, Default)]
struct Jobs {
    live: Arc<Mutex<BTreeMap<String, CancellationToken>>>,
    notify: Arc<Notify>,
}
impl Plugin for JobsPlugin {
    fn name(&self) -> &str {
        "feature.jobs"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        let service = Arc::new(Jobs::default());
        r.provide::<dyn JobService>("jobs", service.clone())?;
        let recover = service.clone();
        r.on(
            "session.start",
            Order::Normal,
            handler(move |api, scope, _| {
                let recover = recover.clone();
                Box::pin(async move {
                    recover.recover(api, &scope.session).await?;
                    Ok(HookResult::default())
                })
            }),
        );
        r.on(
            "session.end",
            Order::First,
            handler(move |api, scope, _| {
                let service = service.clone();
                Box::pin(async move {
                    for job in jobs(&api.snapshot(&scope.session)?)? {
                        let Ok(runner) = capability::<dyn JobRunner>(
                            api.as_ref(),
                            &format!("job.runner.{}", job.owner),
                        ) else {
                            continue;
                        };
                        if job.state == JobState::Running {
                            service
                                .cancel(api.clone(), &scope.session, &scope.actor, &job.id)
                                .await?;
                        }
                        runner.stop(api.clone(), &job).await?;
                    }
                    Ok(HookResult::default())
                })
            }),
        );
        r.declare(json!({"jobs":true,"starts_unasked_turns":true,"job_reports_start_turns":true}));
        Ok(())
    }
}
impl Jobs {
    fn launch(&self, api: Api, job: Job, recovering: bool) -> Result<()> {
        let mut live = self.live.lock().unwrap();
        if live.contains_key(&job.id) {
            return Ok(());
        }
        let runner: Arc<dyn JobRunner> =
            capability(api.as_ref(), &format!("job.runner.{}", job.owner))?;
        let cancel = CancellationToken::new();
        live.insert(job.id.clone(), cancel.clone());
        let service = self.clone();
        tokio::spawn(async move {
            let unknown = recovering && !runner.durable();
            let result = if unknown {
                let _ = runner.stop(api.clone(), &job).await;
                TurnResult { outcome:Outcome::Failed, error:Some("Job interrupted; outcome unknown. Check outside state before relying on it.".into()), ..TurnResult::default() }
            } else {
                runner
                    .run(api.clone(), job.clone(), recovering, cancel.clone())
                    .await
                    .unwrap_or_else(|e| TurnResult {
                        outcome: Outcome::Failed,
                        error: Some(e.to_string()),
                        ..TurnResult::default()
                    })
            };
            let mut ended = job.clone();
            ended.state = if cancel.is_cancelled() {
                JobState::Cancelled
            } else if unknown {
                JobState::Unknown
            } else {
                match result.outcome {
                    Outcome::Completed => JobState::Completed,
                    Outcome::Cancelled => JobState::Cancelled,
                    _ => JobState::Failed,
                }
            };
            ended.result = Some(result.clone());
            let report = if ended.report && ended.state != JobState::Cancelled {
                Some(format!(
                    "Job {} ({}) reported {:?}:\n{}\n{}",
                    ended.id,
                    ended.kind,
                    ended.state,
                    result.text,
                    result.error.as_deref().unwrap_or("")
                ))
            } else {
                None
            };
            ended.report = report.is_some();
            // Ending the job and admitting its report are one history-store commit.
            let saved = api.publish(
                &ended.scope,
                "feature.jobs",
                vec![Draft::new("job.end", false, json!(ended))],
                report.map(|text| (text, format!("job:{}", ended.id))),
                Some(format!("job:{}", ended.id)),
            );
            if let Err(error) = saved {
                let _ = api
                    .emit(Event::new(
                        &ended.scope,
                        "job.error",
                        json!({"error":error.to_string()}),
                    ))
                    .await;
            } else {
                let _ = api
                    .emit(Event::new(&ended.scope, "job.ended", json!(ended)))
                    .await;
            }
            service.live.lock().unwrap().remove(&job.id);
            service.notify.notify_waiters();
        });
        Ok(())
    }
}
#[async_trait]
impl JobService for Jobs {
    async fn start(
        &self,
        api: Api,
        mut scope: Scope,
        owner: &str,
        kind: &str,
        detail: Value,
        report: bool,
    ) -> Result<Job> {
        require(api.as_ref(), &scope, "jobs")?;
        if scope.call.is_some()
            && let Some(job) = jobs(&api.snapshot(&scope.session)?)?
                .into_iter()
                .find(|j| j.owner == owner && j.scope.call == scope.call)
        {
            return Ok(job);
        }
        let id = id();
        scope.job = Some(id.clone());
        let job = Job {
            authority: work_authority(api.as_ref(), &scope)?,
            id,
            scope,
            owner: owner.into(),
            kind: kind.into(),
            detail,
            key: None,
            report,
            state: JobState::Running,
            result: None,
        };
        // Fail before recording work no installed runner can own.
        let _: Arc<dyn JobRunner> = capability(api.as_ref(), &format!("job.runner.{owner}"))?;
        api.append(
            &job.scope,
            owner,
            Draft::new("job.start", false, json!(job)),
        )?;
        api.emit(Event::new(&job.scope, "job.started", json!(job)))
            .await?;
        self.launch(api, job.clone(), false)?;
        Ok(job)
    }
    async fn wait(&self, api: Api, session: &str, id: &str) -> Result<Job> {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let job = jobs(&api.snapshot(session)?)?
                .into_iter()
                .find(|j| j.id == id)
                .ok_or_else(|| anyhow!("unknown job"))?;
            if job.state != JobState::Running {
                return Ok(job);
            }
            // A lost runner must leave the job unfinished, never invent an outcome.
            ensure!(
                self.live.lock().unwrap().contains_key(id),
                "job has no live runner; reopen to recover it"
            );
            notified.await;
        }
    }
    async fn cancel(&self, api: Api, session: &str, actor: &str, id: &str) -> Result<Job> {
        let scope = Scope {
            actor: actor.into(),
            ..Scope::session(session)
        };
        require(api.as_ref(), &scope, "cancel")?;
        let job = jobs(&api.snapshot(session)?)?
            .into_iter()
            .find(|j| j.id == id)
            .ok_or_else(|| anyhow!("unknown job"))?;
        if job.state != JobState::Running {
            return Ok(job);
        }
        if let Some(remote) = api
            .capability_names("external.jobs.")
            .into_iter()
            .filter_map(|key| capability::<dyn ExternalJobs>(api.as_ref(), &key).ok())
            .find(|remote| remote.owner() == job.owner)
        {
            return remote.cancel(api, job).await;
        }
        api.append(
            &scope,
            "feature.jobs",
            Draft::new("job.cancel", false, json!({"job":id})),
        )?;
        if let Some(token) = self.live.lock().unwrap().get(id) {
            token.cancel();
        }
        self.wait(api, session, id).await
    }
    async fn recover(&self, api: Api, session: &str) -> Result<()> {
        for job in jobs(&api.snapshot(session)?)?
            .into_iter()
            .filter(|j| j.state == JobState::Running)
        {
            if capability::<dyn JobRunner>(api.as_ref(), &format!("job.runner.{}", job.owner))
                .is_ok()
            {
                self.launch(api.clone(), job, true)?;
            }
        }
        Ok(())
    }
}
