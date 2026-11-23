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
/// Local transport ceiling. Each connection pins the first recorded grant it
/// encounters for a session, then intersects it with current authority on use.
pub struct ConnectionCeiling {
    actor: String,
    token: Authority,
    grants: std::sync::Mutex<std::collections::BTreeMap<String, Authority>>,
}

tokio::task_local! {
    pub static CONNECTION_CEILING: std::sync::Arc<ConnectionCeiling>;
}

impl ConnectionCeiling {
    pub fn new(actor: String, token: Authority) -> Self {
        Self {
            actor,
            token,
            grants: Default::default(),
        }
    }

    pub fn narrow(session: &str, actor: &str, recorded: Authority) -> Authority {
        CONNECTION_CEILING
            .try_with(|ceiling| {
                if actor != ceiling.actor {
                    return recorded.clone();
                }
                let mut grants = ceiling.grants.lock().unwrap();
                let first = grants
                    .entry(session.into())
                    .or_insert_with(|| recorded.intersect(&ceiling.token));
                recorded.intersect(first)
            })
            .unwrap_or(recorded)
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
    if !work_authority(api, scope)?.has(right) {
        return Err(OperationError::Forbidden(format!("actor lacks {right} authority")).into());
    }
    Ok(())
}
/// Work retains admission-time limits as well as each contributor's current rights.
pub fn work_authority(api: &dyn AgentApi, scope: &Scope) -> Result<Authority> {
    let mut cap = api.authority(&scope.session, &scope.actor)?;
    if scope.turn.is_some() {
        let branch = api.snapshot(&scope.session)?.branch();
        let mut turns = BTreeSet::new();
        let mut cursor = scope.turn.as_deref();
        while let Some(id) = cursor {
            ensure!(turns.insert(id), "cyclic continuation ancestry");
            cursor = branch
                .iter()
                .find(|e| e.kind == "turn.start" && e.scope.turn.as_deref() == Some(id))
                .and_then(|e| e.content.as_ref()?.get("continuesTurnId")?.as_str());
        }
        for e in branch.iter().filter(|e| {
            e.kind == "input" && e.scope.turn.as_deref().is_some_and(|id| turns.contains(id))
        }) {
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
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
/// Whether a leave-open wait elapsed in this invocation without an answer
/// or closure before its deadline. An answer after expiry is not proof that
/// the interrupted invocation relinquished execution.
pub fn expired_leave_open(branch: &[Entry], scope: &Scope) -> bool {
    branch.iter().any(|opened| {
        if opened.kind != "request.open"
            || opened.scope.call != scope.call
            || opened.scope.turn != scope.turn
        {
            return false;
        }
        let Some(question) = opened.content.as_ref() else {
            return false;
        };
        let Some(timeout) = question["timeout_ms"].as_u64() else {
            return false;
        };
        if question["extra"]["whenTimeLimit"] != "leaveOpen" {
            return false;
        }
        let deadline = opened.at.saturating_add(timeout);
        let request = &question["id"];
        now() >= deadline
            && !branch.iter().any(|e| {
                e.at < deadline
                    && matches!(
                        e.kind.as_str(),
                        "request.answer" | "request.closed" | "request.invalidated"
                    )
                    && e.content.as_ref().is_some_and(|v| &v["request"] == request)
            })
    })
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
    /// Commit an in-turn decision only while this exact authenticated route is live.
    async fn answer_on_route(&self, _api: Api, _route: &str, _answer: Answer) -> Result<()> {
        bail!("this question service does not support route-bound answers")
    }
    fn connect_answer_route(&self, session: &str, actor: &str, route: &str, approvals: bool) {
        if approvals {
            self.presence_route(session, actor, route, true);
        }
    }
    async fn decline(
        &self,
        api: Api,
        session: &str,
        actor: &str,
        request: &str,
        _reason: Option<String>,
    ) -> Result<()> {
        self.answer(api, session, actor, request, Value::Null, true)
            .await
    }
    fn recover(&self, _api: &dyn AgentApi, _session: &str) -> Result<()> {
        Ok(())
    }
    fn visible(&self, api: &dyn AgentApi, session: &str, actor: &str) -> Result<Vec<Question>>;
    fn eligible(&self, api: &dyn AgentApi, question: &Question, session: &str, actor: &str)
    -> bool;
    fn presence(&self, session: &str, actor: &str, present: bool);
    fn presence_route(&self, session: &str, actor: &str, _route: &str, present: bool) {
        self.presence(session, actor, present);
    }
    fn detach_presence(&self, _session: &str, _route: &str) {}
    fn present_for_approval(&self, session: &str) -> Vec<String> {
        self.present(session)
    }
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
