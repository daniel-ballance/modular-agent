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

/// Shared metadata and the lossless payload, including future fields.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventData {
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
    #[cfg(feature = "agui")]
    #[serde(skip)]
    pub(crate) emitter: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

/// A standard event's typed data and its unmodified wire envelope.
#[derive(Clone, Debug)]
pub struct EventPayload<T> {
    pub data: T,
    info: EventData,
}
impl<T> std::ops::Deref for EventPayload<T> {
    type Target = EventData;
    fn deref(&self) -> &Self::Target {
        &self.info
    }
}
fn typed<T: serde::de::DeserializeOwned>(
    info: EventData,
    event: impl FnOnce(EventPayload<T>) -> Event,
) -> Event {
    let mut data = info.data.clone();
    if info.event_type == "toolResult" {
        // The event identifies the toolCallId. The SDK settlement has the RPC shape.
        let Some(fields) = data.as_object_mut() else {
            return Event::Custom(info);
        };
        let Some(id) = fields.remove("toolCallId") else {
            return Event::Custom(info);
        };
        fields.insert("callId".into(), id);
    }
    match serde_json::from_value(data) {
        Ok(data) => event(EventPayload { data, info }),
        Err(_) => Event::Custom(info),
    }
}

macro_rules! event_types {
    ($($variant:ident: $name:literal => $ty:ty),* $(,)?) => {
        /// A standard event, or an extension retained in its original shape.
        #[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
        #[serde(from = "EventData", into = "EventData")]
        #[non_exhaustive]
        pub enum Event {
            Text { delta: String, info: EventData },
            Reasoning { delta: String, info: EventData },
            $($variant(Box<EventPayload<$ty>>),)*
            Custom(EventData),
        }

        impl From<EventData> for Event {
            fn from(info: EventData) -> Self {
                match info.event_type.as_str() {
                    "text" => Self::Text { delta: info.data["delta"].as_str().unwrap_or_default().into(), info },
                    "reasoning" => Self::Reasoning { delta: info.data["delta"].as_str().unwrap_or_default().into(), info },
                    $($name => typed(info, |payload| Self::$variant(Box::new(payload))),)*
                    _ => Self::Custom(info),
                }
            }
        }
        impl From<Event> for EventData {
            fn from(event: Event) -> Self {
                match event {
                    Event::Text { info, .. } | Event::Reasoning { info, .. } => info,
                    $(Event::$variant(payload) => payload.info,)*
                    Event::Custom(info) => info,
                }
            }
        }
        impl std::ops::Deref for Event {
            type Target = EventData;
            fn deref(&self) -> &Self::Target {
                match self {
                    Event::Text { info, .. } | Event::Reasoning { info, .. } => info,
                    $(Event::$variant(payload) => &payload.info,)*
                    Event::Custom(info) => info,
                }
            }
        }
    };
}

macro_rules! event_data {
    ($name:ident { $($field:ident: $ty:ty),* $(,)? }) => {
        #[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        pub struct $name {
            $(pub $field: $ty,)*
            #[serde(flatten)]
            pub extra: serde_json::Map<String, Value>,
        }
    };
}

event_data!(SessionEvent { reopened: Option<bool> });
#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InterruptionReason {
    CommitFailed,
    WriterLost,
}
event_data!(Interruption {
    reason: InterruptionReason
});
event_data!(ActorEvent { actor_id: Option<String>, id: Option<String>, kind: Option<String>, changed_by: Option<String>, rights: Option<crate::Rights> });
event_data!(InputEvent { input_id: Option<String>, input: Option<String>, timing: Option<crate::Timing>, content: Option<crate::Content> });
event_data!(TurnStartedData { input_id: Option<String>, system: Option<String>, started_by: Option<Value> });
event_data!(TurnEndedData { outcome: crate::Outcome, result: crate::TurnOutput, usage: Option<crate::Usage> });
event_data!(StepEvent { usage: Option<crate::Usage>, response: Option<crate::AssistantMessage> });
event_data!(ToolInputData { delta: String, tool_call_id: Option<String> });
event_data!(AudioData { delta: Value });
event_data!(ToolCallData {
    call: crate::ToolCall
});
event_data!(ToolOutputData {
    tool_call_id: String,
    chunk: String,
    content: Option<crate::Content>
});
event_data!(QuestionResponse { request_id: Option<String>, request: Option<String>, actor_id: Option<String>, declined: Option<bool>, reason: Option<String> });
event_data!(JobStartedData { id: String, owner: String, kind: String, detail: Value, key: Option<String> });
event_data!(JobEndedData { job_id: String, outcome: Option<Value> });
event_data!(HistoryEvent {
    entry: crate::HistoryEntry
});
event_data!(PositionEvent { from: Option<String>, to: Option<String> });
event_data!(ErasureEvent { entry_ids: Vec<String> });
event_data!(SettingEvent { key: Option<String>, value: Option<Value> });
event_data!(PluginEvent { plugin: Option<String>, name: Option<String> });

event_types!(
    SessionStarted: "sessionStarted" => SessionEvent, SessionEnded: "sessionEnded" => SessionEvent,
    SessionInterrupted: "sessionInterrupted" => Interruption,
    ActorJoined: "actorJoined" => ActorEvent, ActorLeft: "actorLeft" => ActorEvent,
    InputAccepted: "inputAccepted" => InputEvent, InputWithdrawn: "inputWithdrawn" => InputEvent,
    InputHandedBack: "inputHandedBack" => InputEvent, TurnStarted: "turnStarted" => TurnStartedData,
    TurnEnded: "turnEnded" => TurnEndedData, StepStarted: "stepStarted" => StepEvent, StepEnded: "stepEnded" => StepEvent,
    ToolInput: "toolInput" => ToolInputData, Audio: "audio" => AudioData, ToolCall: "toolCall" => ToolCallData,
    ToolStarted: "toolStarted" => ToolCallData, ToolOutput: "toolOutput" => ToolOutputData, ToolResult: "toolResult" => crate::ToolSettlement,
    QuestionOpened: "questionOpened" => Question, QuestionAnswered: "questionAnswered" => QuestionResponse,
    QuestionClosed: "questionClosed" => QuestionResponse, QuestionNoLongerAnswerable: "questionNoLongerAnswerable" => QuestionResponse,
    JobStarted: "jobStarted" => JobStartedData, JobProgress: "jobProgress" => crate::Content, JobEnded: "jobEnded" => JobEndedData,
    Entry: "entry" => HistoryEvent, PositionMoved: "positionMoved" => PositionEvent, EntriesErased: "entriesErased" => ErasureEvent,
    SettingChanged: "settingChanged" => SettingEvent, PluginLoaded: "pluginLoaded" => PluginEvent,
    PluginReplaced: "pluginReplaced" => PluginEvent, PluginUnloaded: "pluginUnloaded" => PluginEvent,
);

impl Event {
    pub(crate) fn new(scope: &base::Scope, time: u64, event_type: &str, data: Value) -> Self {
        EventData {
            event_type: event_type.into(),
            #[cfg(feature = "agui")]
            emitter: base::EMITTER.try_with(Clone::clone).ok(),
            time,
            session_id: scope.session.clone(),
            turn_id: scope.turn.clone(),
            step_id: scope.step.clone(),
            tool_call_id: scope.call.clone(),
            job_id: scope.job.clone(),
            data,
            extra: Default::default(),
        }
        .into()
    }

    pub(crate) fn entry(entry: &base::Entry, view: Value) -> Self {
        Self::new(&entry.scope, entry.at, "entry", json!({"entry":view}))
    }

    fn from_base(e: &base::Event, api: &dyn base::AgentApi) -> Option<Self> {
        let (kind, data) = match e.kind.as_str() {
            // Internal stream/turn markers; the final gated result ends the turn.
            "model.end" | "turn.end" => return None,
            "turn.result" => {
                let result: base::TurnResult = serde_json::from_value(e.content.clone()).ok()?;
                let mut data = base::wire::turn_outcome(&result);
                data["turnId"] = json!(e.scope.turn);
                data["usage"] = json!(crate::Usage::from(result.usage));
                ("turnEnded", data)
            }
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
            "request.opened" => ("questionOpened", {
                let mut q =
                    interface_acp::shared_question(serde_json::from_value(e.content.clone()).ok()?);
                q["sessionId"] = json!(e.scope.session);
                q
            }),
            "request.answered" => ("questionAnswered", e.content.clone()),
            "input.accepted" => ("inputAccepted", e.content.clone()),
            "input.withdrawn" => ("inputWithdrawn", e.content.clone()),
            "input.returned" => ("inputHandedBack", e.content.clone()),
            "setting.changed" => ("settingChanged", e.content.clone()),
            "session.start" => ("sessionStarted", e.content.clone()),
            "session.end" => ("sessionEnded", e.content.clone()),
            "session.interrupted" => ("sessionInterrupted", e.content.clone()),
            "actor.joined" => ("actorJoined", e.content.clone()),
            "actor.left" => ("actorLeft", e.content.clone()),
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
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QuestionKind {
    Approval,
    Choice,
    Text,
    Link,
    Secret,
}

/// A question the agent needs an actor to answer.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub id: String,
    pub session_id: String,
    pub kind: QuestionKind,
    pub question: String,
    #[serde(default)]
    pub options: Vec<String>,
    pub details: Option<Value>,
    pub deadline: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_wait: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub covers_nested: bool,
    pub credential: Option<String>,
    /// For an approval: the exact call, as shared data's ToolCall.
    pub call: Option<Value>,
}

impl Question {
    pub(crate) fn from_base(q: &base::Question) -> Self {
        Question {
            id: q.id.clone(),
            session_id: q.scope.session.clone(),
            kind: match q.kind {
                base::RequestKind::Approval => QuestionKind::Approval,
                base::RequestKind::Choice => QuestionKind::Choice,
                base::RequestKind::Text if q.extra["kind"] == "link" => QuestionKind::Link,
                base::RequestKind::Text => QuestionKind::Text,
                base::RequestKind::Secret => QuestionKind::Secret,
            },
            question: q.text.clone(),
            options: q.options.clone(),
            details: q.extra.get("details").cloned(),
            deadline: q.extra["deadlineAt"]
                .as_u64()
                .or_else(|| q.extra["deadline"].as_u64()),
            covers_nested: q.covers_nested(),
            approval_wait: q.extra["approvalWait"].as_str().map(str::to_string),
            credential: q.credential.clone(),
            call: q.extra.get("approvalCall").cloned(),
        }
    }
}

/// A handler may answer, decline by returning no answer, or fail.
pub trait QuestionReply {
    fn into_answer(self) -> Answer;
}

impl QuestionReply for Answer {
    fn into_answer(self) -> Answer {
        self
    }
}
impl QuestionReply for Option<Answer> {
    fn into_answer(self) -> Answer {
        self.unwrap_or(Answer::Declined { reason: None })
    }
}
impl QuestionReply for crate::Result<Answer> {
    fn into_answer(self) -> Answer {
        self.unwrap_or(Answer::Declined { reason: None })
    }
}

pub(crate) type QuestionHandler = Arc<dyn Fn(Question) -> BoxFuture<'static, Answer> + Send + Sync>;

/// The SDK's Interface: it hears every event and answers questions for the app.
pub(crate) struct Hub {
    pub events: broadcast::Sender<Event>,
    pub on_question: Option<QuestionHandler>,
    pub waiting_handlers: std::sync::Mutex<std::collections::BTreeSet<(String, String)>>,
    pub session_handlers: std::sync::Mutex<std::collections::HashMap<String, QuestionHandler>>,
    pub harness: OnceLock<Weak<Harness>>,
    pub inner: OnceLock<Weak<crate::agent::Inner>>,
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
            session_handlers: Default::default(),
            waiting_handlers: Default::default(),
            harness: OnceLock::new(),
            inner: OnceLock::new(),
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
        if event.kind == "turn.result"
            && let Some(inner) = self.inner.get().and_then(Weak::upgrade)
        {
            crate::Session::new(inner, event.scope.session.clone()).offer_waiting_handler();
        }
        let question = (event.kind == "request.opened")
            .then(|| serde_json::from_value::<base::Question>(event.content.clone()).ok())
            .flatten();
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
        if let Some(q) = question {
            let handler = self
                .session_handlers
                .lock()
                .unwrap()
                .get(&q.scope.session)
                .or(self.on_question.as_ref())
                .cloned();
            if let Some(handler) = handler {
                let crash = self.crash.clone();
                let inner = self.inner.get().cloned();
                let mut events = self.events.subscribe();
                self.workers.spawn(async move {
                    let watch = async {
                        use base::AgentApi;
                        loop {
                            let open = h
                                .snapshot(&q.scope.session)
                                .and_then(|d| base::questions(&d))
                                .is_ok_and(|qs| qs.iter().any(|v| v.id == q.id && v.answerable));
                            if !open {
                                break;
                            }
                            if matches!(
                                events.recv().await,
                                Err(broadcast::error::RecvError::Closed)
                            ) {
                                break;
                            }
                        }
                    };
                    let answer = tokio::select! {
                        biased;
                        _ = crash.cancelled() => return,
                        _ = watch => return,
                        reply = handler(Question::from_base(&q)) => reply,
                    };
                    let session = q.scope.session.clone();
                    // If the handler supplied an invalid reply, decline instead of
                    // stranding the tool with a waiting question. A competing
                    // manual reply or pending secret activation is unaffected.
                    let mut answered = self::answer(h.clone(), &session, LOCAL, &q, answer).await;
                    if answered
                        .as_ref()
                        .is_err_and(|error| error.code() == crate::Code::InvalidParams)
                    {
                        answered =
                            self::answer(h, &session, LOCAL, &q, Answer::Declined { reason: None })
                                .await;
                    }
                    if answered.is_ok()
                        && q.scope.call.is_some()
                        && let Some(inner) = inner.and_then(|inner| inner.upgrade())
                    {
                        // If the asking turn is still running, its driver holds the same lock.
                        let embedded = inner
                            .drivers
                            .lock()
                            .unwrap()
                            .get(&session)
                            .is_some_and(|driver| driver.strong_count() != 0);
                        if embedded {
                            drop(crate::Session::new(inner, session).drive());
                        }
                    }
                });
            }
        }
        let _ = self.events.send(event);
    }
}

pub(crate) async fn answer(
    api: base::Api,
    session: &str,
    actor: &str,
    q: &base::Question,
    reply: Answer,
) -> crate::Result<()> {
    use crate::{Code, Error};
    if !q.answerable {
        return Err(Error::new(Code::Conflict, "question is closed"));
    }
    let requests = base::requests(api.as_ref())?;
    if !requests.eligible(api.as_ref(), q, session, actor) {
        return Err(Error::new(Code::Forbidden, "actor may not answer"));
    }
    let value = match reply {
        Answer::Allow if q.kind == base::RequestKind::Approval => json!("allow"),
        Answer::Value(v)
            if q.kind == base::RequestKind::Text
                || q.kind == base::RequestKind::Choice && q.options.contains(&v) =>
        {
            json!(v)
        }
        Answer::Secret(v) if q.kind == base::RequestKind::Secret => json!(v),
        Answer::Declined { reason } => {
            return Ok(requests.decline(api, session, actor, &q.id, reason).await?);
        }
        _ => {
            return Err(Error::new(
                Code::InvalidParams,
                "answer does not match question",
            ));
        }
    };
    requests
        .answer(api, session, actor, &q.id, value, false)
        .await?;
    Ok(())
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
