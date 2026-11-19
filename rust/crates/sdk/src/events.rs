//! Events and questions, delivered to the app (docs/sdk/api.md#events, #questions).
use crate::tool::{Answer, ToolStatus};
use agent_api as base;
use agent_harness::Harness;
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use std::sync::{Arc, OnceLock, Weak};
use tokio::sync::broadcast;

/// The local actor. The base builds name the local person `user`.
pub(crate) const LOCAL: &str = "user";

/// Something that happened in a session. Each variant is a shared event type.
#[derive(Clone, Debug)]
#[non_exhaustive]
pub enum Event {
    /// Model text as it arrives (`text`).
    Text { session_id: String, delta: String },
    /// A call the model or a tool asked for (`toolCall`).
    ToolCall {
        session_id: String,
        call_id: String,
        name: String,
        input: Value,
    },
    /// Live text progress from a tool.
    ToolOutput {
        session_id: String,
        call_id: String,
        text: String,
    },
    /// A call's settled result (`toolResult`).
    ToolResult {
        session_id: String,
        call_id: String,
        status: ToolStatus,
        text: String,
    },
    /// A question opened for an actor (`questionOpened`).
    QuestionOpened {
        session_id: String,
        question: Question,
    },
    /// The turn ended (`turnEnded`).
    TurnEnded {
        session_id: String,
        outcome: String,
        text: String,
    },
    /// An event the SDK does not type yet, by the base build's own name.
    Other {
        session_id: String,
        kind: String,
        data: Value,
    },
}

impl Event {
    pub fn session_id(&self) -> &str {
        match self {
            Event::Text { session_id, .. }
            | Event::ToolCall { session_id, .. }
            | Event::ToolOutput { session_id, .. }
            | Event::ToolResult { session_id, .. }
            | Event::QuestionOpened { session_id, .. }
            | Event::TurnEnded { session_id, .. }
            | Event::Other { session_id, .. } => session_id,
        }
    }
    fn from_base(e: &base::Event) -> Self {
        let session_id = e.scope.session.clone();
        match e.kind.as_str() {
            "model.delta" => Event::Text {
                session_id,
                delta: e.content.as_str().unwrap_or_default().into(),
            },
            "tool.requested" => Event::ToolCall {
                session_id,
                call_id: e.content["id"].as_str().unwrap_or_default().into(),
                name: e.content["name"].as_str().unwrap_or_default().into(),
                input: e.content["input"].clone(),
            },
            "tool.progress" => Event::ToolOutput {
                session_id,
                call_id: e.scope.call.clone().unwrap_or_default(),
                text: e.content.as_str().unwrap_or_default().into(),
            },
            "tool.ended" => match serde_json::from_value::<base::ToolResult>(e.content.clone()) {
                Ok(r) => Event::ToolResult {
                    session_id,
                    call_id: r.call,
                    status: ToolStatus::from_base(&r.status),
                    text: r.text,
                },
                Err(_) => Event::Other {
                    session_id,
                    kind: e.kind.clone(),
                    data: e.content.clone(),
                },
            },
            "request.opened" => match serde_json::from_value::<base::Question>(e.content.clone()) {
                Ok(q) => Event::QuestionOpened {
                    session_id,
                    question: Question::from_base(&q),
                },
                Err(_) => Event::Other {
                    session_id,
                    kind: e.kind.clone(),
                    data: e.content.clone(),
                },
            },
            "turn.result" => Event::TurnEnded {
                session_id,
                outcome: e.content["outcome"].as_str().unwrap_or("completed").into(),
                text: e.content["text"].as_str().unwrap_or_default().into(),
            },
            _ => Event::Other {
                session_id,
                kind: e.kind.clone(),
                data: e.content.clone(),
            },
        }
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
    pub events: broadcast::Sender<(Option<String>, Event)>,
    pub on_question: Option<QuestionHandler>,
    pub harness: OnceLock<Weak<Harness>>,
}

impl Hub {
    pub fn new(on_question: Option<QuestionHandler>) -> Arc<Self> {
        Arc::new(Hub {
            events: broadcast::channel(4096).0,
            on_question,
            harness: OnceLock::new(),
        })
    }
}

impl base::EventSink for Hub {
    fn send(&self, event: base::Event) {
        let turn = event.scope.turn.clone();
        let event = Event::from_base(&event);
        if let (
            Event::QuestionOpened {
                session_id,
                question,
            },
            Some(handler),
            Some(h),
        ) = (
            &event,
            &self.on_question,
            self.harness.get().and_then(Weak::upgrade),
        ) {
            let (handler, session, question) =
                (handler.clone(), session_id.clone(), question.clone());
            tokio::spawn(async move {
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
            });
        }
        let _ = self.events.send((turn, event));
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
