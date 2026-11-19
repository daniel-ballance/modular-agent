//! Sessions, prompts and their results (docs/sdk/api.md#sessions-and-turns).
use crate::{
    agent::Inner,
    error::{Code, Error, Result},
    events::{Event, LOCAL},
    tool::ToolStatus,
};
use agent_api as base;
use base::AgentApi;
use futures_util::Stream;
use serde_json::Value;
use std::sync::Arc;

/// A stream of events. Use it with `StreamExt::next`.
pub type EventStream = std::pin::Pin<Box<dyn Stream<Item = Result<Event>> + Send>>;

/// A conversation with its history, settings and actors.
#[derive(Clone)]
pub struct Session {
    inner: Arc<Inner>,
    id: String,
    /// One prompt at a time from this handle: a second waits, then queues its own turn.
    turn: Arc<tokio::sync::Mutex<()>>,
}

/// How a turn ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Completed,
    Cancelled,
    Failed { error: String },
    Limit { limit: String },
}

impl Outcome {
    /// The shared kind: `completed`, `cancelled`, `failed` or `limit`.
    pub fn kind(&self) -> &'static str {
        match self {
            Outcome::Completed => "completed",
            Outcome::Cancelled => "cancelled",
            Outcome::Failed { .. } => "failed",
            Outcome::Limit { .. } => "limit",
        }
    }
}

/// Whether the input started a turn, or was settled without one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Disposition {
    Turn,
    Handled,
    HandedBack,
}

/// A tool call's recorded result.
#[derive(Clone, Debug)]
pub struct ToolResult {
    pub call_id: String,
    pub name: String,
    pub status: ToolStatus,
    pub value: Option<Value>,
    text: String,
}

impl ToolResult {
    /// The result's text content.
    pub fn text(&self) -> &str {
        &self.text
    }
}

/// What `prompt` returns.
#[derive(Clone, Debug)]
pub struct PromptResult {
    pub input_id: String,
    pub disposition: Disposition,
    /// Present when `disposition` is `Turn`.
    pub outcome: Option<Outcome>,
    /// The final answer's text, empty if none.
    pub text: String,
    pub value: Option<Value>,
    pub turn_id: Option<String>,
    pub open_tool_calls: Vec<String>,
    tool_results: Vec<ToolResult>,
}

impl PromptResult {
    /// The turn's recorded results, in call order.
    pub fn tool_results(&self) -> &[ToolResult] {
        &self.tool_results
    }
}

impl Session {
    pub(crate) fn new(inner: Arc<Inner>, id: String) -> Self {
        Session {
            inner,
            id,
            turn: Arc::default(),
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    /// Admit input with timing `now` and wait for the turn that takes it.
    pub async fn prompt(&self, input: impl Into<String>) -> Result<PromptResult> {
        let _turn = self.turn.lock().await;
        let h = &self.inner.harness;
        let receipt = h
            .submit(&self.id, LOCAL, &input.into(), base::Timing::Now, None)
            .await?;
        if receipt.command.is_some() {
            return Ok(no_turn(receipt.input, Disposition::Handled));
        }
        match h.run_next(&self.id).await? {
            None => Ok(no_turn(receipt.input, Disposition::HandedBack)),
            Some(result) => {
                let data = h.snapshot(&self.id)?;
                let turn = data
                    .entries
                    .iter()
                    .rev()
                    .find(|e| e.kind == "turn.end")
                    .and_then(|e| e.scope.turn.clone());
                Ok(from_turn(receipt.input, &result, turn, &data))
            }
        }
    }

    /// The events of the turn this input starts, ending with its `TurnEnded`.
    pub async fn prompt_stream(&self, input: impl Into<String>) -> Result<EventStream> {
        let events = self.inner.hub.events.subscribe();
        let (session, me, input) = (self.id.clone(), self.clone(), input.into());
        let run = tokio::spawn(async move { me.prompt(input).await });
        Ok(Box::pin(futures_util::stream::unfold(
            (events, Some(run), false),
            move |(mut events, run, done)| {
                let session = session.clone();
                async move {
                    if done {
                        return None;
                    }
                    loop {
                        match events.recv().await {
                            Ok(e) if e.session_id() == session => {
                                let end = matches!(e, Event::TurnEnded { .. });
                                return Some((Ok(e), (events, run, end)));
                            }
                            Ok(_) => continue,
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(_) => {
                                let error = match run {
                                    Some(run) => match run.await {
                                        Ok(Err(e)) => e,
                                        _ => Error::new(Code::Lost, "the event stream closed"),
                                    },
                                    None => Error::new(Code::Lost, "the event stream closed"),
                                };
                                return Some((Err(error), (events, None, true)));
                            }
                        }
                    }
                }
            },
        )))
    }

    /// The outcome of the session's most recent turn, as recorded.
    pub fn last_turn(&self) -> Result<Option<PromptResult>> {
        let data = self.inner.harness.snapshot(&self.id)?;
        let Some(end) = data.entries.iter().rev().find(|e| e.kind == "turn.end") else {
            return Ok(None);
        };
        let result: base::TurnResult =
            serde_json::from_value(end.content.clone().unwrap_or_default())?;
        Ok(Some(from_turn(
            String::new(),
            &result,
            end.scope.turn.clone(),
            &data,
        )))
    }

    /// The recorded entries, in the shared format, oldest first.
    ///
    /// Not yet the actor's gated view: every entry the session keeps.
    pub fn history(&self) -> Result<Vec<Value>> {
        let data = self.inner.harness.snapshot(&self.id)?;
        data.entries
            .iter()
            .filter(|e| e.writer != "rust.derived")
            .map(|e| base::portable::entry(e, &data).map_err(Error::from))
            .collect()
    }

    /// Close the session.
    pub async fn close(&self) -> Result<()> {
        Ok(self.inner.harness.close(&self.id).await?)
    }
}

fn no_turn(input_id: String, disposition: Disposition) -> PromptResult {
    PromptResult {
        input_id,
        disposition,
        outcome: None,
        text: String::new(),
        value: None,
        turn_id: None,
        open_tool_calls: vec![],
        tool_results: vec![],
    }
}

fn from_turn(
    input_id: String,
    result: &base::TurnResult,
    turn: Option<String>,
    data: &base::SessionData,
) -> PromptResult {
    let outcome = match result.outcome {
        base::Outcome::Completed => Outcome::Completed,
        base::Outcome::Cancelled => Outcome::Cancelled,
        base::Outcome::Failed => Outcome::Failed {
            error: result.error.clone().unwrap_or_default(),
        },
        base::Outcome::Limit => Outcome::Limit {
            limit: result.limit.clone().unwrap_or_default(),
        },
    };
    let calls: Vec<base::ToolCall> = data
        .entries
        .iter()
        .filter(|e| e.kind == "tool.call" && e.scope.turn == turn)
        .filter_map(|e| serde_json::from_value(e.content.clone()?).ok())
        .collect();
    let tool_results = data
        .entries
        .iter()
        .filter(|e| e.kind == "tool.result" && e.scope.turn == turn)
        .filter_map(|e| serde_json::from_value::<base::ToolResult>(e.content.clone()?).ok())
        .map(|r| ToolResult {
            name: calls
                .iter()
                .find(|c| c.id == r.call)
                .map(|c| c.name.clone())
                .unwrap_or_default(),
            call_id: r.call,
            status: ToolStatus::from_base(&r.status),
            value: r.value,
            text: r.text,
        })
        .collect();
    PromptResult {
        input_id,
        disposition: Disposition::Turn,
        outcome: Some(outcome),
        text: result.text.clone(),
        value: result.value.clone(),
        turn_id: turn,
        open_tool_calls: result.open_calls.iter().map(|c| c.id.clone()).collect(),
        tool_results,
    }
}
