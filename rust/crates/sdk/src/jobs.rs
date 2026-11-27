//! A plugin owns a job after the call that started it settles.
use crate::{Code, Content, Error, HookContext, Result, tool::Backend};
use agent_api as base;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug)]
pub enum JobOutcome {
    Completed,
    Failed(String),
    Cancelled,
}
impl JobOutcome {
    fn wire(&self) -> Value {
        match self {
            Self::Completed => json!({"kind":"completed"}),
            Self::Failed(error) => json!({"kind":"failed","error":error}),
            Self::Cancelled => json!({"kind":"cancelled"}),
        }
    }
    fn state(&self) -> base::JobState {
        match self {
            Self::Completed => base::JobState::Completed,
            Self::Failed(_) => base::JobState::Failed,
            Self::Cancelled => base::JobState::Cancelled,
        }
    }
}

#[crate::async_trait]
pub trait JobOwner: Send + Sync + 'static {
    /// Stop any running work. The SDK records cancellation if the handler did not end it.
    /// An erasure retry supplies only the job, session and actor IDs, not job detail.
    async fn cancel(&self, job: Job, context: HookContext) -> Result<()>;
    /// Whether this owner takes up unfinished jobs on reopen.
    fn can_resume(&self) -> bool {
        false
    }
    /// Take up an unfinished job before session.start returns, if opted in.
    async fn resume(&self, _job: Job, _context: HookContext) -> Result<()> {
        Ok(())
    }
}

/// Call-scoped access to jobs owned by the plugin handling session.start.
pub struct StartJobs<'a>(pub(crate) &'a HookContext);
impl StartJobs<'_> {
    fn owner(&self) -> Result<(&str, &Owner, &Backend)> {
        let backend = self.0.backend()?;
        let (name, owner) = self.0.job_owner.as_ref().ok_or_else(|| {
            Error::new(
                Code::InvalidRequest,
                "jobs are only available in the owner's session.start hook",
            )
        })?;
        Ok((name, owner, backend))
    }
    pub async fn unfinished(&self) -> Result<Vec<Job>> {
        let (name, owner, backend) = self.owner()?;
        owner.unfinished(backend, name, &self.0.session_id).await
    }
    pub async fn resume(&self, job: &Job) -> Result<()> {
        let (_, owner, _) = self.owner()?;
        if !owner.can_resume()
            || job.session_id != self.0.session_id
            || !job.active.ptr_eq(&Arc::downgrade(&owner.active))
        {
            return Err(Error::new(
                Code::InvalidRequest,
                "this hook cannot resume the job",
            ));
        }
        let job = self
            .unfinished()
            .await?
            .into_iter()
            .find(|candidate| candidate.id == job.id)
            .ok_or_else(|| Error::new(Code::InvalidRequest, "job is no longer unfinished"))?;
        owner.resume(job).await
    }
}

type Active = Arc<Mutex<HashMap<String, Job>>>;
#[derive(Clone)]
pub(crate) struct Owner {
    handler: Arc<dyn JobOwner>,
    active: Active,
    // Serializes the state check with the commit, but never encloses a plugin callback.
    records: Arc<Mutex<()>>,
}
impl Owner {
    pub(crate) fn new(handler: impl JobOwner) -> Self {
        Self {
            handler: Arc::new(handler),
            active: Default::default(),
            records: Default::default(),
        }
    }
    pub(crate) fn can_resume(&self) -> bool {
        self.handler.can_resume()
    }
    fn local_handle(&self, api: &base::Api, record: &base::Job) -> Job {
        let mut job = self.handle(
            &record.id,
            &record.kind,
            record.detail.clone(),
            record.key.clone(),
            &record.scope.session,
            &record.scope.actor,
            Backend::Local {
                api: api.clone(),
                scope: record.scope.clone(),
            },
        );
        job.cleanup_unconfirmed = record.state == base::JobState::CleanupUnconfirmed;
        job
    }
    #[allow(clippy::too_many_arguments)]
    fn handle(
        &self,
        id: &str,
        kind: &str,
        detail: Value,
        key: Option<String>,
        session: &str,
        actor: &str,
        backend: Backend,
    ) -> Job {
        Job {
            id: id.into(),
            kind: kind.into(),
            detail,
            key,
            session_id: session.into(),
            actor_id: actor.into(),
            cleanup_unconfirmed: false,
            cleanup_only: false,
            backend,
            active: Arc::downgrade(&self.active),
            records: self.records.clone(),
            state: Arc::new(tokio::sync::Mutex::new(false)),
            cancelled: CancellationToken::new(),
        }
    }
    pub(crate) async fn start(
        &self,
        context: &crate::ToolContext,
        name: &str,
        kind: &str,
        detail: Value,
        key: Option<&str>,
    ) -> Result<JobStart> {
        let (backend, session, actor) =
            (&context.backend, context.session_id(), context.actor_id());
        if kind.is_empty() {
            return Err(Error::new(Code::InvalidRequest, "job kind is empty"));
        }
        match backend {
            Backend::Local { api, scope } => {
                let (job, record) = {
                    let _guard = self.records.lock().unwrap();
                    base::require(api.as_ref(), scope, "jobs")?;
                    if let Some(key) = key
                        && let Some(record) = base::jobs(&api.snapshot(session)?)?
                            .into_iter()
                            .find(|j| j.key.as_deref() == Some(key))
                    {
                        return Ok(JobStart {
                            id: record.id,
                            job: None,
                        });
                    }
                    let id = base::id();
                    let scope = base::Scope {
                        job: Some(id.clone()),
                        ..scope.clone()
                    };
                    let record = base::Job {
                        id: id.clone(),
                        scope: scope.clone(),
                        owner: name.into(),
                        kind: kind.into(),
                        detail,
                        key: key.map(str::to_owned),
                        report: false,
                        state: base::JobState::Running,
                        result: None,
                        authority: base::work_authority(api.as_ref(), &scope)?,
                    };
                    api.append(
                        &scope,
                        name,
                        base::Draft::new("job.start", false, json!(record)),
                    )?;
                    let job = self.local_handle(api, &record);
                    self.active.lock().unwrap().insert(id, job.clone());
                    (job, record)
                };
                api.emit(base::Event::new(
                    &record.scope,
                    "job.started",
                    json!(record),
                ))
                .await?;
                Ok(JobStart {
                    id: job.id.clone(),
                    job: Some(job),
                })
            }
            Backend::Remote { peer, parent } => {
                let mut p = json!({"parentRequestId":parent,"kind":kind,"detail":detail});
                if let Some(key) = key {
                    p["key"] = json!(key);
                }
                let reply = peer
                    .call("host/jobs/start", p, None, CancellationToken::new())
                    .await
                    .map_err(crate::serve::from_fault)?;
                let id = base::wire::string(&reply, "jobId")?;
                if reply["started"] != true {
                    return Ok(JobStart {
                        id: id.into(),
                        job: None,
                    });
                }
                let job = self.handle(
                    id,
                    kind,
                    detail,
                    key.map(str::to_owned),
                    session,
                    actor,
                    Backend::Remote {
                        peer: peer.clone(),
                        parent: Value::Null,
                    },
                );
                self.active.lock().unwrap().insert(id.into(), job.clone());
                Ok(JobStart {
                    id: id.into(),
                    job: Some(job),
                })
            }
        }
    }
    pub(crate) async fn unfinished(
        &self,
        backend: &Backend,
        owner: &str,
        session: &str,
    ) -> Result<Vec<Job>> {
        match backend {
            Backend::Local { api, .. } => Ok(base::jobs(&api.snapshot(session)?)?
                .into_iter()
                .filter(|r| r.owner == owner && r.state.is_unfinished())
                .map(|r| self.local_handle(api, &r))
                .collect()),
            Backend::Remote { peer, .. } => {
                let backend = Backend::Remote {
                    peer: peer.clone(),
                    parent: Value::Null,
                };
                let reply = peer
                    .call(
                        "host/jobs/unfinished",
                        json!({"sessionId":session}),
                        None,
                        CancellationToken::new(),
                    )
                    .await
                    .map_err(crate::serve::from_fault)?;
                let list = reply["jobs"].as_array().ok_or_else(|| {
                    Error::new(Code::InvalidRequest, "invalid unfinished jobs list")
                })?;
                list.iter()
                    .map(|v| {
                        let mut job = self.handle(
                            base::wire::string(v, "jobId")?,
                            base::wire::string(v, "kind")?,
                            v["detail"].clone(),
                            v["key"].as_str().map(str::to_owned),
                            session,
                            base::wire::string(v, "actorId")?,
                            backend.clone(),
                        );
                        job.cleanup_unconfirmed = v["cleanup"] == "unconfirmed";
                        Ok(job)
                    })
                    .collect()
            }
        }
    }
    pub(crate) async fn resume(&self, job: Job) -> Result<()> {
        if job.cleanup_unconfirmed {
            return Err(Error::new(
                Code::InvalidRequest,
                "cannot resume a job with unconfirmed cleanup",
            ));
        }
        if let Backend::Remote { peer, .. } = &job.backend {
            peer.call(
                "host/jobs/resume",
                json!({"jobId":job.id}),
                None,
                CancellationToken::new(),
            )
            .await
            .map_err(crate::serve::from_fault)?;
        }
        {
            let mut active = self.active.lock().unwrap();
            if active.contains_key(&job.id) {
                return Err(Error::new(Code::InvalidRequest, "job already resumed"));
            }
            active.insert(job.id.clone(), job.clone());
        }
        let context = job.context();
        let _settled = context.settled.clone().drop_guard();
        self.handler.resume(job, context).await
    }
    pub(crate) async fn cleanup_for_erasure(
        &self,
        backend: Backend,
        session: &str,
        actor: &str,
        id: &str,
    ) -> Result<()> {
        let mut job = self.handle(id, "", Value::Null, None, session, actor, backend);
        job.cleanup_only = true;
        job.cancelled.cancel();
        {
            let _guard = self.records.lock().unwrap();
            if let Some(old) = self.active.lock().unwrap().remove(id) {
                old.cancelled.cancel();
            }
        }
        let context = job.context();
        let _settled = context.settled.clone().drop_guard();
        self.handler.cancel(job, context).await
    }
    pub(crate) async fn cancel_id(&self, id: &str) -> Result<()> {
        let job = self
            .active
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| Error::new(Code::InvalidRequest, "unknown active job"))?;
        self.cancel(job).await
    }
    pub(crate) async fn cancel(&self, job: Job) -> Result<()> {
        let context = job.context();
        let _settled = context.settled.clone().drop_guard();
        job.cancelled.cancel();
        self.handler.cancel(job.clone(), context).await?;
        if !*job.state.lock().await {
            job.end(JobOutcome::Cancelled, None, false).await?;
        }
        Ok(())
    }
}

/// Starting with a previously used key returns the existing id and grants no new work.
#[derive(Clone)]
pub struct JobStart {
    pub id: String,
    pub job: Option<Job>,
}

#[derive(Clone)]
pub struct Job {
    pub id: String,
    pub kind: String,
    pub detail: Value,
    pub key: Option<String>,
    pub session_id: String,
    pub actor_id: String,
    pub cleanup_unconfirmed: bool,
    cleanup_only: bool,
    backend: Backend,
    active: std::sync::Weak<Mutex<HashMap<String, Job>>>,
    records: Arc<Mutex<()>>,
    state: Arc<tokio::sync::Mutex<bool>>,
    pub cancelled: CancellationToken,
}
impl Job {
    fn context(&self) -> HookContext {
        let mut context = match &self.backend {
            Backend::Local { api, scope } => HookContext::local(api.clone(), scope.clone()),
            remote => HookContext::remote(
                remote.clone(),
                &json!({"sessionId":self.session_id,"actorId":self.actor_id,"jobId":self.id}),
                self.cancelled.clone(),
            ),
        };
        context.cancelled = self.cancelled.clone();
        context
    }
    pub async fn history(&self, after: Option<&str>) -> Result<crate::HistoryPage> {
        self.check().await?;
        crate::context::history(&self.backend, &self.session_id, after).await
    }
    async fn check(&self) -> Result<()> {
        if *self.state.lock().await
            || self
                .active
                .upgrade()
                .is_none_or(|a| !a.lock().unwrap().contains_key(&self.id))
        {
            return Err(Error::new(Code::InvalidRequest, "job is not active"));
        }
        Ok(())
    }
    pub async fn progress(&self, content: Content) -> Result<()> {
        self.check().await?;
        match &self.backend {
            Backend::Local { api, scope } => {
                api.emit(base::Event::new(scope, "job.progress", json!(content)))
                    .await?
            }
            Backend::Remote { peer, .. } => peer.notify(
                "host/jobs/progress",
                json!({"jobId":self.id,"content":content}),
            ),
        }
        Ok(())
    }
    pub async fn end(
        &self,
        outcome: JobOutcome,
        result: Option<Content>,
        report: bool,
    ) -> Result<()> {
        // Erasure cleanup cannot publish through this handle. The host records
        // a content-free end only if the cancellation handler returns success.
        if self.cleanup_only {
            return Ok(());
        }
        self.check().await?;
        let mut ended = self.state.lock().await;
        if *ended {
            return Err(Error::new(Code::InvalidRequest, "job already ended"));
        }
        let event = match &self.backend {
            Backend::Local { api, scope } => {
                let _guard = self.records.lock().unwrap();
                if self
                    .active
                    .upgrade()
                    .is_none_or(|a| !a.lock().unwrap().contains_key(&self.id))
                {
                    return Err(Error::new(Code::InvalidRequest, "job is not active"));
                }
                let mut job = api
                    .job_records(&scope.session)?
                    .into_iter()
                    .find(|j| j.id == self.id && j.state == base::JobState::Running)
                    .ok_or_else(|| Error::new(Code::InvalidRequest, "job is not running"))?;
                let text = result
                    .as_ref()
                    .map_or_else(String::new, |c| base::wire::text(&json!(c)));
                job.state = outcome.state();
                job.report = report;
                job.result = Some(base::TurnResult {
                    text: text.clone(),
                    error: outcome.wire()["error"].as_str().map(str::to_owned),
                    ..Default::default()
                });
                let mut value = json!(job);
                value["wireOutcome"] = outcome.wire();
                if let Some(content) = result {
                    value["wireResult"] = json!(content);
                }
                api.publish(
                    scope,
                    &job.owner,
                    vec![base::Draft::new("job.end", false, value)],
                    report.then(|| (text, format!("job:{}", job.id))),
                    Some(format!("job:{}", job.id)),
                )?;
                Some((
                    api,
                    base::Event::new(scope, "job.ended", json!({"jobId":self.id})),
                ))
            }
            Backend::Remote { peer, .. } => {
                let mut p = json!({"jobId":self.id,"outcome":outcome.wire(),"report":report});
                if let Some(content) = result {
                    p["result"] = json!(content);
                }
                peer.call("host/jobs/end", p, None, CancellationToken::new())
                    .await
                    .map_err(crate::serve::from_fault)?;
                None
            }
        };
        *ended = true;
        if let Some(active) = self.active.upgrade() {
            active.lock().unwrap().remove(&self.id);
        }
        drop(ended);
        if let Some((api, event)) = event {
            api.emit(event).await?;
        }
        Ok(())
    }
}

pub(crate) struct LocalOwner(pub String, pub Owner);
impl LocalOwner {
    pub(crate) async fn cancel_record(
        &self,
        api: base::Api,
        id: &str,
        session: &str,
    ) -> base::Result<base::Job> {
        let record = base::jobs(&api.snapshot(session)?)?
            .into_iter()
            .find(|job| job.id == id && job.owner == self.0)
            .ok_or_else(|| base::anyhow!("unknown owned job"))?;
        base::ExternalJobs::cancel(self, api, record).await
    }
}
#[crate::async_trait]
impl base::ExternalJobs for LocalOwner {
    fn owner(&self) -> String {
        self.0.clone()
    }
    async fn cleanup_for_erasure(
        &self,
        api: base::Api,
        session: &str,
        actor: &str,
        id: &str,
    ) -> base::Result<()> {
        let scope = base::Scope {
            actor: actor.into(),
            job: Some(id.into()),
            ..base::Scope::session(session)
        };
        // A cleanup-only handle needs no live session or plugin work context.
        self.1
            .cleanup_for_erasure(Backend::Local { api, scope }, session, actor, id)
            .await?;
        Ok(())
    }
    async fn cancel(&self, api: base::Api, job: base::Job) -> base::Result<base::Job> {
        let cancelled =
            tokio::time::timeout(std::time::Duration::from_secs(5), self.1.cancel_id(&job.id))
                .await;
        if !matches!(cancelled, Ok(Ok(()))) {
            let _guard = self.1.records.lock().unwrap();
            self.1.active.lock().unwrap().remove(&job.id);
            if api
                .job_records(&job.scope.session)?
                .iter()
                .any(|j| j.id == job.id && j.state == base::JobState::Running)
            {
                api.append(
                    &job.scope,
                    &self.0,
                    base::Draft::new("job.cleanup_unconfirmed", false, json!({})),
                )?;
                return Err(base::LostPart("job cleanup could not be confirmed".into()).into());
            }
        }
        api.job_records(&job.scope.session)?
            .into_iter()
            .find(|j| j.id == job.id)
            .ok_or_else(|| base::anyhow!("job disappeared"))
    }
}
