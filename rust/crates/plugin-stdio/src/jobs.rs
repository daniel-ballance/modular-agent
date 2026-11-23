//! External jobs are identified by the registered plugin name, not the process.
use crate::{host::Shared, rpc::Peer};
use agent_api::*;
use std::sync::Arc;

pub(crate) struct RemoteJobs {
    pub peer: Arc<Peer>,
    pub shared: Arc<Shared>,
}
impl RemoteJobs {
    fn api(&self) -> Result<Api> {
        self.shared
            .api
            .upgrade()
            .ok_or_else(|| anyhow!("host closed"))
    }
    fn owner(&self) -> String {
        self.shared.registration.lock().unwrap()["name"]
            .as_str()
            .unwrap_or_default()
            .into()
    }
    fn own_jobs(&self, api: &Api, session: &str) -> Result<Vec<Job>> {
        ensure!(
            self.shared.sessions.lock().unwrap().contains_key(session),
            "plugin has no access to session"
        );
        let owner = self.owner();
        Ok(jobs(&api.snapshot(session)?)?
            .into_iter()
            .filter(|j| j.owner == owner)
            .collect())
    }
    fn find(&self, api: &Api, id: &str) -> Result<Job> {
        let sessions = self
            .shared
            .sessions
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for session in sessions {
            if let Some(job) = self
                .own_jobs(api, &session)?
                .into_iter()
                .find(|j| j.id == id)
            {
                return Ok(job);
            }
        }
        bail!("unknown job owned by this plugin")
    }
    pub async fn request(&self, method: &str, p: &Value) -> Result<Value> {
        let api = self.api()?;
        let lock = self.shared.job_lock.lock().await;
        match method {
            "host/jobs/start" => {
                let parent = self
                    .peer
                    .parent(&p["parentRequestId"])
                    .ok_or_else(|| anyhow!("job start requires a live parent"))?;
                ensure!(
                    !parent.cancel.is_cancelled() && parent.method != "hook/output",
                    "parent cannot start work"
                );
                let mut scope = parent.scope.clone();
                require(api.as_ref(), &scope, "jobs")?;
                let key = p["key"].as_str().map(str::to_owned);
                if let Some(ref key) = key
                    && let Some(job) = jobs(&api.snapshot(&scope.session)?)?
                        .into_iter()
                        .find(|j| j.owner == self.owner() && j.key.as_ref() == Some(key))
                {
                    return Ok(json!({"jobId":job.id,"started":false}));
                }
                let id = id();
                let authority = work_authority(api.as_ref(), &scope)?;
                scope.job = Some(id.clone());
                let job = Job {
                    id,
                    owner: self.owner(),
                    scope,
                    authority,
                    key,
                    // A binding job may choose to report when it ends.
                    report: true,
                    kind: wire::string(p, "kind")?.into(),
                    detail: p["detail"].clone(),
                    state: JobState::Running,
                    result: None,
                };
                api.append(
                    &job.scope,
                    &job.owner,
                    Draft::new("job.start", false, json!(job)),
                )?;
                self.shared
                    .running_jobs
                    .lock()
                    .unwrap()
                    .insert(job.id.clone());
                self.peer.observe_job(&job);
                drop(lock);
                api.emit(Event::new(&job.scope, "job.started", json!(job)))
                    .await?;
                Ok(json!({"jobId":job.id,"started":true}))
            }
            "host/jobs/unfinished" => {
                let jobs = self.own_jobs(&api, wire::string(p,"sessionId")?)?.into_iter()
                    .filter(|j| j.state.is_unfinished())
                    .map(|j| { let mut v = json!({"jobId":j.id,"kind":j.kind,"detail":j.detail,"actorId":j.scope.actor});
                        if j.state == JobState::CleanupUnconfirmed { v["cleanup"] = json!("unconfirmed"); }
                        if let Some(key) = j.key { v["key"] = json!(key); } v }).collect::<Vec<_>>();
                Ok(json!({"jobs":jobs}))
            }
            "host/jobs/end" | "host/jobs/resume" => {
                let job = self.find(&api, wire::string(p, "jobId")?)?;
                if method == "host/jobs/resume" {
                    api.check_writer(&job.scope.session)?;
                    ensure!(
                        job.state == JobState::Running,
                        "job ended or cleanup is unconfirmed"
                    );
                    ensure!(
                        self.shared
                            .running_jobs
                            .lock()
                            .unwrap()
                            .insert(job.id.clone()),
                        "job is already running on this connection"
                    );
                    self.peer.observe_job(&job);
                    return Ok(json!({}));
                }
                ensure!(
                    job.state != JobState::CleanupUnconfirmed,
                    "job execution revoked"
                );
                if job.state != JobState::Running {
                    let data = api.snapshot(&job.scope.session)?;
                    let ended = data
                        .entries
                        .iter()
                        .rev()
                        .find(|e| e.kind == "job.end" && e.scope.job == job.scope.job)
                        .and_then(|e| e.content.as_ref())
                        .ok_or_else(|| anyhow!("job end is unavailable"))?;
                    ensure!(
                        ended["wireOutcome"] == p["outcome"]
                            && ended["wireResult"] == p["result"]
                            && ended["report"] == p["report"],
                        "job end retry differs from the recorded end"
                    );
                    return Ok(json!({}));
                }
                ensure!(
                    self.shared.running_jobs.lock().unwrap().contains(&job.id),
                    "job has no active execution on this connection"
                );
                let context = self.peer.job_context(&job.id);
                {
                    let _guard = context.map(telemetry::Context::attach);
                    self.record_end(&api, &job, p)?;
                }
                let outcome = match p["outcome"]["kind"].as_str() {
                    Some("completed") => "completed",
                    Some("cancelled") => "cancelled",
                    _ => "failed",
                };
                self.peer.finish_job(&job.id, outcome);
                self.shared.running_jobs.lock().unwrap().remove(&job.id);
                drop(lock);
                api.emit(Event::new(&job.scope, "job.ended", json!({"jobId":job.id})))
                    .await?;
                Ok(json!({}))
            }
            _ => bail!("unknown job request"),
        }
    }
    fn record_end(&self, api: &Api, job: &Job, p: &Value) -> Result<()> {
        let mut ended = job.clone();
        ended.state = match p["outcome"]["kind"].as_str() {
            Some("completed") => JobState::Completed,
            Some("failed") => JobState::Failed,
            Some("cancelled") => JobState::Cancelled,
            _ => bail!("invalid job outcome"),
        };
        ended.report = p["report"]
            .as_bool()
            .ok_or_else(|| anyhow!("report must be boolean"))?;
        let text = wire::text(&p["result"]);
        ended.result = Some(TurnResult {
            text: text.clone(),
            error: p["outcome"]["error"].as_str().map(str::to_owned),
            ..Default::default()
        });
        let mut value = json!(ended);
        if let Some(result) = p.get("result").filter(|v| !v.is_null()) {
            ensure!(result.is_array(), "job result must be content");
            value["wireResult"] = result.clone();
        }
        value["wireOutcome"] = p["outcome"].clone();
        api.publish(
            &job.scope,
            &job.owner,
            vec![Draft::new("job.end", false, value)],
            ended.report.then(|| (text, format!("job:{}", job.id))),
            Some(format!("job:{}", job.id)),
        )?;
        Ok(())
    }
    pub async fn progress(&self, p: &Value) -> Result<()> {
        let api = self.api()?;
        let job = self.find(&api, wire::string(p, "jobId")?)?;
        ensure!(job.state == JobState::Running, "job already ended");
        api.emit(Event::new(&job.scope, "job.progress", p["content"].clone()))
            .await
    }
    pub async fn close_session(&self, api: Api, session: &str) -> Result<()> {
        for job in self
            .own_jobs(&api, session)?
            .into_iter()
            .filter(|j| j.state == JobState::Running)
        {
            if let Err(error) = self.cancel(api.clone(), job).await {
                eprintln!("could not cancel plugin job: {error}");
            }
        }
        Ok(())
    }
}
#[async_trait]
impl ExternalJobs for RemoteJobs {
    fn owner(&self) -> String {
        RemoteJobs::owner(self)
    }
    async fn cancel(&self, api: Api, job: Job) -> Result<Job> {
        ensure!(job.owner == self.owner(), "wrong job owner");
        let confirmation = self
            .peer
            .call(
                "jobs/cancel",
                json!({"jobId":job.id}),
                None,
                CancellationToken::new(),
            )
            .await;
        let _lock = self.shared.job_lock.lock().await;
        let current = self.find(&api, &job.id)?;
        if current.state != JobState::Running {
            return Ok(current);
        }
        self.shared.running_jobs.lock().unwrap().remove(&job.id);
        self.peer.finish_job(&job.id, "interrupted");
        api.append(
            &job.scope,
            &job.owner,
            Draft::new("job.cleanup_unconfirmed", false, json!({})),
        )?;
        let diagnostic = confirmation
            .err()
            .map_or_else(|| "owner did not commit an end".into(), |e| e.to_string());
        Err(LostPart(format!("job cleanup could not be confirmed: {diagnostic}")).into())
    }
}
