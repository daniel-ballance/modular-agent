//! Events and questions, delivered to the app (docs/sdk/api.md#events, #questions).
use crate::tool::Answer;
use agent_api as base;
use agent_harness::Harness;
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use std::sync::{Arc, OnceLock, Weak};
use tokio::sync::broadcast;

/// The local actor. The base builds name the local person `user`.
pub(crate) const LOCAL: &str = "user";

/// A session event in the SDK's shared, tagged JSON shape. The payload is JSON
/// so plugin-defined event types and future payload fields survive unchanged.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    #[serde(rename = "type")]
    pub event_type: String,
    pub time: u64,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    pub data: Value,
}

impl Event {
    pub(crate) fn new(scope: &base::Scope, time: u64, event_type: &str, data: Value) -> Self {
        Self {
            event_type: event_type.into(),
            time,
            session_id: scope.session.clone(),
            turn_id: scope.turn.clone(),
            step_id: scope.step.clone(),
            tool_call_id: scope.call.clone(),
            job_id: scope.job.clone(),
            data,
        }
    }

    pub(crate) fn entry(entry: &base::Entry, view: Value) -> Self {
        Self::new(&entry.scope, entry.at, "entry", json!({"entry":view}))
    }

    fn from_base(e: &base::Event, api: &dyn base::AgentApi) -> Option<Self> {
        let (kind, data) = match e.kind.as_str() {
            // Internal stream/turn markers; the final gated result ends the turn.
            "model.end" | "turn.end" => return None,
            "model.tool_input" | "model.audio" => {
                let kind = if e.kind == "model.audio" {
                    "audio"
                } else {
                    "toolInput"
                };
                (kind, json!({"delta":e.content}))
            }
            "tool.started" => (
                "toolStarted",
                json!({
                    "call":base::wire::call(&serde_json::from_value(e.content.clone()).ok()?, &e.scope)
                }),
            ),
            "request.opened" => (
                "questionOpened",
                interface_acp::shared_question(serde_json::from_value(e.content.clone()).ok()?),
            ),
            "request.answered" => ("questionAnswered", e.content.clone()),
            "input.accepted" => ("inputAccepted", e.content.clone()),
            "input.withdrawn" => ("inputWithdrawn", e.content.clone()),
            "input.returned" => ("inputHandedBack", e.content.clone()),
            "setting.changed" => ("settingChanged", e.content.clone()),
            "session.start" => ("sessionStarted", e.content.clone()),
            "session.end" => ("sessionEnded", e.content.clone()),
            "step.start" => ("stepStarted", e.content.clone()),
            "step.end" => ("stepEnded", e.content.clone()),
            "job.started" => ("jobStarted", e.content.clone()),
            "job.progress" => ("jobProgress", e.content.clone()),
            "job.ended" => ("jobEnded", e.content.clone()),
            _ => {
                let shared = agent_harness::output_event(e, api).ok()?;
                return Some(Self::new(
                    &e.scope,
                    e.at,
                    shared["type"].as_str()?,
                    shared["data"].clone(),
                ));
            }
        };
        Some(Self::new(&e.scope, e.at, kind, data))
    }
}

/// What kind of answer a question wants.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuestionKind {
    Approval,
    Choice,
    Text,
    Secret,
}

/// A question the agent needs an actor to answer.
#[derive(Clone, Debug)]
pub struct Question {
    pub id: String,
    pub session_id: String,
    pub kind: QuestionKind,
    pub question: String,
    pub options: Vec<String>,
    /// For an approval: the exact call, as shared data's ToolCall.
    pub call: Option<Value>,
}

impl Question {
    fn from_base(q: &base::Question) -> Self {
        Question {
            id: q.id.clone(),
            session_id: q.scope.session.clone(),
            kind: match q.kind {
                base::RequestKind::Approval => QuestionKind::Approval,
                base::RequestKind::Choice => QuestionKind::Choice,
                base::RequestKind::Text => QuestionKind::Text,
                base::RequestKind::Secret => QuestionKind::Secret,
            },
            question: q.text.clone(),
            options: q.options.clone(),
            call: q.extra.get("approvalCall").cloned(),
        }
    }
}

pub(crate) type QuestionHandler = Arc<dyn Fn(Question) -> BoxFuture<'static, Answer> + Send + Sync>;

/// The SDK's Interface: it hears every event and answers questions for the app.
pub(crate) struct Hub {
    pub events: broadcast::Sender<Event>,
    pub on_question: Option<QuestionHandler>,
    pub harness: OnceLock<Weak<Harness>>,
    crash: tokio_util::sync::CancellationToken,
    workers: tokio_util::task::TaskTracker,
}

impl Hub {
    pub fn new(
        on_question: Option<QuestionHandler>,
        crash: tokio_util::sync::CancellationToken,
        workers: tokio_util::task::TaskTracker,
    ) -> Arc<Self> {
        Arc::new(Hub {
            events: broadcast::channel(4096).0,
            on_question,
            harness: OnceLock::new(),
            crash,
            workers,
        })
    }
}

impl base::EventSink for Hub {
    fn send(&self, event: base::Event) {
        let Some(h) = self.harness.get().and_then(Weak::upgrade) else {
            return;
        };
        let question = (event.kind == "request.opened")
            .then(|| serde_json::from_value::<base::Question>(event.content.clone()).ok())
            .flatten()
            .as_ref()
            .map(Question::from_base);
        let event = if event.kind == "history.entry" {
            let Ok(entry) = serde_json::from_value::<base::Entry>(event.content) else {
                return;
            };
            if entry.writer == "rust.derived" {
                return;
            }
            use base::AgentApi;
            let Ok(data) = h.snapshot(&event.scope.session) else {
                return;
            };
            let Ok(view) = base::portable::public_entry(&entry, &data) else {
                return;
            };
            let kind = match entry.kind.as_str() {
                "turn.start" => Some("turnStarted"),
                "actor.identity" => Some("actorJoined"),
                "actor.left" => Some("actorLeft"),
                "position" => Some("positionMoved"),
                "erasure" => Some("entriesErased"),
                "request.closed" => Some("questionClosed"),
                "request.invalidated" => Some("questionNoLongerAnswerable"),
                _ => None,
            };
            if let Some(kind) = kind {
                let _ = self.events.send(Event::new(
                    &entry.scope,
                    entry.at,
                    kind,
                    view["data"].clone(),
                ));
            }
            Event::entry(&entry, view)
        } else {
            let Some(event) = Event::from_base(&event, h.as_ref()) else {
                return;
            };
            event
        };
        if let (Some(question), Some(handler)) = (question, &self.on_question) {
            let (handler, session) = (handler.clone(), event.session_id.clone());
            let crash = self.crash.clone();
            self.workers.spawn(async move {
                tokio::select! { biased; _ = crash.cancelled() => (), _ = async move {
                let id = question.id.clone();
                let (value, declined) = match handler(question).await {
                    Answer::Allow => (json!("allow"), false),
                    Answer::Value(v) => (json!(v), false),
                    Answer::Declined { .. } => (Value::Null, true),
                };
                let api: base::Api = h;
                if let Ok(requests) = base::requests(api.as_ref()) {
                    let _ = requests
                        .answer(api.clone(), &session, LOCAL, &id, value, declined)
                        .await;
                }
                } => () }
            });
        }
        let _ = self.events.send(event);
    }
}

pub(crate) struct HubPlugin(pub Arc<Hub>);

impl base::Plugin for HubPlugin {
    fn name(&self) -> &str {
        "interface.sdk"
    }
    fn install(&self, r: &mut base::Registrar<'_>) -> base::Result<()> {
        r.provide::<dyn base::EventSink>("interface.sdk", self.0.clone())
    }
}
