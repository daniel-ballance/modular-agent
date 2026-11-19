//! Session authority and record-derived requests/jobs. These carry no secret values.
use crate::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Stable and distinct from the terminal actor and from imported actors.
pub const ACP_HOST_ACTOR: &str = "modular-agent-rs/acp-host";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Authority(pub BTreeSet<String>);
impl Authority {
    const RIGHTS: &[&str] = &[
        "watch",
        "propose",
        "input",
        "answer",
        "approve",
        "tools",
        "cancel",
        "settings",
        "erase",
        "grant",
        "jobs",
        "delegate",
        "administer",
    ];

    pub fn full() -> Self {
        Self::only(Self::RIGHTS)
    }
    pub fn only(rights: &[&str]) -> Self {
        Self(rights.iter().map(|s| (*s).into()).collect())
    }
    pub fn has(&self, right: &str) -> bool {
        Self::RIGHTS.contains(&right) && self.0.contains(right)
    }
    pub fn intersect(&self, other: &Self) -> Self {
        Self(self.0.intersection(&other.0).cloned().collect())
    }
    pub fn contains(&self, other: &Self) -> bool {
        other.0.is_subset(&self.0)
    }
}
pub fn actors(data: &SessionData) -> std::collections::BTreeMap<String, Value> {
    let mut actors = std::collections::BTreeMap::new();
    for e in &data.entries {
        let Some(v) = &e.content else { continue };
        match e.kind.as_str() {
            "actor.grant" => {
                if let Some(id) = v["actor"].as_str() {
                    actors.insert(id.into(), json!({"id":id,"kind":v["kind"].as_str().unwrap_or("user"),"rights":v["authority"]}));
                }
            }
            "actor.left" => {
                if let Some(id) = v["actorId"].as_str() {
                    actors.remove(id);
                }
            }
            _ => {}
        }
    }
    actors
}

pub fn require(api: &dyn AgentApi, scope: &Scope, right: &str) -> Result<()> {
    ensure!(
        work_authority(api, scope)?.has(right),
        "actor lacks {right} authority"
    );
    Ok(())
}
/// Work retains admission-time limits as well as each contributor's current rights.
pub fn work_authority(api: &dyn AgentApi, scope: &Scope) -> Result<Authority> {
    let mut cap = api.authority(&scope.session, &scope.actor)?;
    if scope.turn.is_some() {
        for e in api
            .snapshot(&scope.session)?
            .branch()
            .iter()
            .filter(|e| e.kind == "input" && e.scope.turn == scope.turn)
        {
            cap = cap.intersect(&api.authority(&scope.session, &e.scope.actor)?);
            if let Some(v) = e.content.as_ref().and_then(|v| v.get("authority")) {
                cap = cap.intersect(&serde_json::from_value(v.clone())?);
            }
            if let Some(v) = &e.content {
                for key in ["sponsor", "releasedBy"] {
                    if let Some(actor) = v[key].as_str() {
                        cap = cap.intersect(&api.authority(&scope.session, actor)?);
                    }
                }
            }
        }
    }
    Ok(cap)
}
pub fn job_usage(data: &SessionData, job: &str) -> Result<Usage> {
    let turns: BTreeSet<_> = data
        .entries
        .iter()
        .filter(|e| e.kind == "turn.start" && e.scope.job.as_deref() == Some(job))
        .filter_map(|e| e.scope.turn.clone())
        .collect();
    let mut scoped = data.clone();
    scoped.entries.retain(|e| {
        (e.kind == "model.response" && e.scope.job.as_deref() == Some(job))
            || (e.kind == "job.end" && e.scope.turn.as_ref().is_some_and(|t| turns.contains(t)))
    });
    session_usage(&scoped)
}
pub fn session_usage(data: &SessionData) -> Result<Usage> {
    let mut usage = Usage::default();
    for e in &data.entries {
        let Some(v) = &e.content else { continue };
        if e.kind == "model.response" {
            usage.add(&serde_json::from_value::<ModelResponse>(v.clone())?.usage);
        }
        if e.kind == "job.end"
            && let Some(r) = serde_json::from_value::<Job>(v.clone())?.result
        {
            usage.add(&r.usage);
        }
    }
    Ok(usage)
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RequestKind {
    Approval,
    Choice,
    Text,
    Secret,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Question {
    pub id: String,
    pub scope: Scope,
    pub kind: RequestKind,
    pub text: String,
    pub options: Vec<String>,
    pub responders: Vec<String>,
    pub key: Option<String>,
    pub credential: Option<String>,
    pub timeout_ms: Option<u64>,
    pub route: Vec<String>,
    pub answerable: bool,
    pub answer: Option<Answer>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub extra: Value,
}
impl Question {
    pub fn new(scope: Scope, kind: RequestKind, text: &str) -> Self {
        Self {
            id: id(),
            scope,
            kind,
            text: text.into(),
            options: vec![],
            responders: vec!["user".into()],
            key: None,
            credential: None,
            timeout_ms: None,
            route: vec![],
            answerable: true,
            answer: None,
            extra: Value::Null,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Answer {
    pub request: String,
    pub actor: String,
    pub session: String,
    pub value: Value,
    pub declined: bool,
}
#[derive(Clone, Debug)]
pub enum RequestReply {
    Answer(Answer),
    Waiting,
    Declined,
}
pub fn questions(data: &SessionData) -> Result<Vec<Question>> {
    let mut result: Vec<Question> = vec![];
    for e in data.branch() {
        let Some(v) = e.content else { continue };
        match e.kind.as_str() {
            "request.open" => result.push(serde_json::from_value(v)?),
            "request.answer" => {
                let a: Answer = serde_json::from_value(v)?;
                if let Some(q) = result.iter_mut().find(|q| q.id == a.request) {
                    q.answer = Some(a);
                    q.answerable = false;
                }
            }
            "request.closed" | "request.invalidated" => {
                if let Some(q) = result.iter_mut().find(|q| v["request"] == q.id) {
                    q.answerable = false;
                }
            }
            "request.suspended" => {
                if let Some(q) = result.iter_mut().find(|q| v["request"] == q.id) {
                    q.timeout_ms = None;
                }
            }
            _ => (),
        }
    }
    Ok(result)
}
#[async_trait]
pub trait InputRequests: Send + Sync {
    async fn ask(
        &self,
        api: Api,
        question: Question,
        cancel: CancellationToken,
    ) -> Result<RequestReply>;
    async fn answer(
        &self,
        api: Api,
        session: &str,
        actor: &str,
        request: &str,
        value: Value,
        declined: bool,
    ) -> Result<()>;
    fn visible(&self, api: &dyn AgentApi, session: &str, actor: &str) -> Result<Vec<Question>>;
    fn eligible(&self, api: &dyn AgentApi, question: &Question, session: &str, actor: &str)
    -> bool;
    fn presence(&self, session: &str, actor: &str, present: bool);
    fn present(&self, _session: &str) -> Vec<String> {
        vec![]
    }
    fn close_turn(&self, api: &dyn AgentApi, scope: &Scope) -> Result<()> {
        self.close_turn_with_reason(api, scope, "cancelled")
    }
    fn close_turn_with_reason(&self, api: &dyn AgentApi, scope: &Scope, reason: &str)
    -> Result<()>;
}
pub fn requests(api: &dyn AgentApi) -> Result<std::sync::Arc<dyn InputRequests>> {
    capability(api, "input.requests")
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Running,
    #[serde(rename = "cleanupUnconfirmed")]
    CleanupUnconfirmed,
    Completed,
    Failed,
    Cancelled,
    Unknown,
}
impl JobState {
    pub fn is_unfinished(&self) -> bool {
        matches!(self, Self::Running | Self::CleanupUnconfirmed)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Job {
    #[serde(default)]
    pub authority: Authority,
    pub id: String,
    pub scope: Scope,
    pub owner: String,
    pub kind: String,
    pub detail: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    pub report: bool,
    pub state: JobState,
    pub result: Option<TurnResult>,
}
pub fn jobs(data: &SessionData) -> Result<Vec<Job>> {
    let mut result: Vec<Job> = vec![];
    for e in &data.entries {
        if e.kind == "job.end" && e.content.is_none() {
            result.retain(|j| Some(&j.id) != e.scope.job.as_ref());
        }
        let Some(v) = &e.content else { continue };
        if e.kind == "job.start" {
            result.push(serde_json::from_value(v.clone())?);
        } else if e.kind == "job.cleanup_unconfirmed" {
            if let Some(job) = result
                .iter_mut()
                .find(|j| Some(&j.id) == e.scope.job.as_ref())
            {
                job.state = JobState::CleanupUnconfirmed;
            }
        } else if e.kind == "job.end" {
            let ended: Job = serde_json::from_value(v.clone())?;
            if let Some(job) = result.iter_mut().find(|j| j.id == ended.id) {
                *job = ended;
            }
        }
    }
    Ok(result)
}
#[async_trait]
pub trait ExternalJobs: Send + Sync {
    fn owner(&self) -> String;
    async fn cancel(&self, api: Api, job: Job) -> Result<Job>;
}
#[async_trait]
pub trait JobRunner: Send + Sync {
    fn durable(&self) -> bool {
        false
    }
    async fn run(
        &self,
        api: Api,
        job: Job,
        recovering: bool,
        cancel: CancellationToken,
    ) -> Result<TurnResult>;
    async fn stop(&self, _api: Api, _job: &Job) -> Result<()> {
        Ok(())
    }
}
#[async_trait]
pub trait JobService: Send + Sync {
    async fn start(
        &self,
        api: Api,
        scope: Scope,
        owner: &str,
        kind: &str,
        detail: Value,
        report: bool,
    ) -> Result<Job>;
    async fn wait(&self, api: Api, session: &str, job: &str) -> Result<Job>;
    async fn cancel(&self, api: Api, session: &str, actor: &str, job: &str) -> Result<Job>;
    async fn recover(&self, api: Api, session: &str) -> Result<()>;
}
pub fn job_service(api: &dyn AgentApi) -> Result<std::sync::Arc<dyn JobService>> {
    capability(api, "jobs")
}
