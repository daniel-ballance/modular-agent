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
    driver: Arc<Driver>,
}

#[derive(Default)]
pub(crate) struct Driver {
    run: tokio::sync::Mutex<()>,
}

#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Timing {
    Now,
    Steer,
    After,
    Propose,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputReceipt {
    pub input_id: String,
    pub duplicate: bool,
    pub erased: bool,
    pub taken: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandedBack {
    pub input_id: String,
    pub content: Value,
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
    pub(crate) fn from_base(name: String, result: base::ToolResult) -> Self {
        let wire = base::wire::result(&result);
        Self {
            call_id: result.call,
            name,
            status: ToolStatus::from_base(&result.status),
            text: result.text,
            value: wire.get("value").cloned(),
        }
    }

    /// The result's text content.
    pub fn text(&self) -> &str {
        &self.text
    }
}

/// Per-admission options for a prompt.
#[derive(Clone, Debug, Default)]
pub struct PromptOptions {
    pub key: Option<String>,
    pub result: Option<Value>,
}
impl From<Option<String>> for PromptOptions {
    fn from(key: Option<String>) -> Self {
        Self { key, result: None }
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
    pub usage: Option<Value>,
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
        let driver = {
            let mut drivers = inner.drivers.lock().unwrap();
            drivers.retain(|_, driver| driver.strong_count() != 0);
            drivers
                .get(&id)
                .and_then(std::sync::Weak::upgrade)
                .unwrap_or_else(|| {
                    let driver = Arc::new(Driver::default());
                    drivers.insert(id.clone(), Arc::downgrade(&driver));
                    driver
                })
        };
        Session { inner, id, driver }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    /// Admit input with timing `now` and wait for the turn that takes it.
    pub async fn prompt(&self, input: impl Into<String>) -> Result<PromptResult> {
        self.prompt_with(input, None).await
    }

    /// Prompt with options. Retrying a key waits for its original turn.
    pub async fn prompt_with(
        &self,
        input: impl Into<String>,
        options: impl Into<PromptOptions>,
    ) -> Result<PromptResult> {
        let mut events = self.inner.hub.events.subscribe();
        let options = options.into();
        let receipt = self
            .admit(input.into(), Timing::Now, options.key, options.result)
            .await?;
        if receipt.taken == "handled" {
            return Ok(no_turn(receipt.input_id, Disposition::Handled));
        }
        let mut run = self.drive();
        loop {
            if let Some(result) = self.result(&receipt.input_id)? {
                return Ok(result);
            }
            tokio::select! {
                update = events.recv() => {
                    if matches!(update, Err(tokio::sync::broadcast::error::RecvError::Closed)) {
                        return Err(Error::new(Code::Lost, "the event stream closed"));
                    }
                }
                done = &mut run => {
                    done.map_err(|e| Error::new(Code::Lost, e.to_string()))??;
                    return Ok(self.result(&receipt.input_id)?
                        .unwrap_or_else(|| no_turn(receipt.input_id, Disposition::HandedBack)));
                }
            }
        }
    }

    /// The events of the turn this input starts, ending with its `TurnEnded`.
    pub async fn prompt_stream(&self, input: impl Into<String>) -> Result<EventStream> {
        self.prompt_stream_with(input, PromptOptions::default())
            .await
    }

    pub async fn prompt_stream_with(
        &self,
        input: impl Into<String>,
        options: PromptOptions,
    ) -> Result<EventStream> {
        let events = self.inner.hub.events.subscribe();
        let receipt = self
            .admit(input.into(), Timing::Now, options.key, options.result)
            .await?;
        if receipt.taken == "handled" {
            return Ok(Box::pin(futures_util::stream::empty()));
        }
        let me = self.clone();
        let run = self.drive();
        Ok(Box::pin(futures_util::stream::unfold(
            Some((events, run, receipt.input_id, me)),
            |state| async move {
                let (mut events, mut run, input, me) = state?;
                loop {
                    tokio::select! {
                        biased;
                        update = events.recv() => match update {
                            Ok((turn, e)) if e.session_id() == me.id && turn.is_some() => {
                                let data = match me.snapshot() {
                                    Ok(data) => data,
                                    Err(e) => return Some((Err(e), None)),
                                };
                                if turn == input_turn(&data, &input) {
                                    let next = (!matches!(e, Event::TurnEnded { .. }))
                                        .then_some((events, run, input, me));
                                    return Some((Ok(e), next));
                                }
                            }
                            Ok(_) => (),
                            Err(e) => return Some((Err(Error::new(Code::Lost, e.to_string())), None)),
                        },
                        done = &mut run => match done {
                            Ok(Ok(())) => return None,
                            Ok(Err(e)) => return Some((Err(e), None)),
                            Err(e) => return Some((Err(Error::new(Code::Lost, e.to_string())), None)),
                        }
                    }
                }
            },
        )))
    }

    fn snapshot(&self) -> Result<base::SessionData> {
        self.inner
            .harness
            .snapshot(&self.id)
            .map_err(|_| Error::new(Code::NotOpen, "session is not open"))
    }

    fn result(&self, id: &str) -> Result<Option<PromptResult>> {
        let data = self.snapshot()?;
        if let Some(turn) = input_turn(&data, id)
            && let Some(end) = data
                .entries
                .iter()
                .find(|e| e.kind == "turn.end" && e.scope.turn.as_ref() == Some(&turn))
        {
            let result = serde_json::from_value(end.content.clone().unwrap_or_default())?;
            return Ok(Some(from_turn(id.into(), &result, Some(turn), &data)));
        }
        Ok(data
            .entries
            .iter()
            .any(|e| {
                e.kind == "input.returned" && e.content.as_ref().is_some_and(|c| c["input"] == id)
            })
            .then(|| no_turn(id.into(), Disposition::HandedBack)))
    }

    async fn admit(
        &self,
        text: String,
        timing: Timing,
        key: Option<String>,
        shape: Option<Value>,
    ) -> Result<InputReceipt> {
        self.snapshot()?;
        let h = &self.inner.harness;
        let receipt = if let Some(shape) = shape {
            base::schema::compile(&shape)
                .map_err(|e| Error::new(Code::InvalidParams, e.to_string()))?;
            h.submit_shaped(&self.id, LOCAL, &text, key, shape).await?
        } else {
            h.submit(
                &self.id,
                LOCAL,
                &text,
                match timing {
                    Timing::Now => base::Timing::Now,
                    Timing::Steer => base::Timing::Steer,
                    Timing::After => base::Timing::After,
                    Timing::Propose => base::Timing::Propose,
                },
                key,
            )
            .await?
        };
        let taken = if receipt.erased {
            "handedBack".into()
        } else {
            self.snapshot()?
                .entries
                .iter()
                .find(|e| {
                    e.id == receipt.input
                        || e.content
                            .as_ref()
                            .is_some_and(|c| c["inputId"] == receipt.input)
                })
                .map(|e| {
                    if e.kind == "command" {
                        "handled"
                    } else {
                        e.content
                            .as_ref()
                            .and_then(|c| c["taken"].as_str())
                            .unwrap_or("now")
                    }
                })
                .unwrap_or("now")
                .to_owned()
        };
        Ok(InputReceipt {
            input_id: receipt.input,
            duplicate: receipt.duplicate,
            erased: receipt.erased,
            taken,
        })
    }

    fn drive(&self) -> tokio::task::JoinHandle<Result<()>> {
        let me = self.clone();
        tokio::spawn(async move {
            let _lock = me.driver.run.lock().await;
            while me.inner.harness.run_next(&me.id).await?.is_some() {}
            Ok(())
        })
    }

    /// Admit input without waiting for its turn.
    pub async fn send(&self, input: impl Into<String>, timing: Timing) -> Result<InputReceipt> {
        self.send_with(input, timing, None).await
    }

    pub async fn send_with(
        &self,
        input: impl Into<String>,
        timing: Timing,
        key: Option<String>,
    ) -> Result<InputReceipt> {
        let receipt = self.admit(input.into(), timing, key, None).await?;
        if !receipt.duplicate && !matches!(receipt.taken.as_str(), "handled" | "proposed") {
            // Dropping the handle detaches the waiter, not the work.
            drop(self.drive());
        }
        Ok(receipt)
    }

    /// Cancel the current turn and hand queued inputs back.
    pub async fn cancel(&self) -> Result<Vec<HandedBack>> {
        self.snapshot()?;
        Ok(self
            .inner
            .harness
            .cancel(&self.id)
            .await?
            .into_iter()
            .map(|i| HandedBack {
                input_id: i.id,
                content: serde_json::json!([{"type":"text","text":i.text}]),
            })
            .collect())
    }

    pub fn settings(&self) -> Result<Value> {
        Ok(base::portable::settings_to_wire(&self.snapshot()?.settings))
    }

    /// This agent refuses to change settings while a turn is running.
    pub fn set_setting(&self, key: &str, value: Value) -> Result<()> {
        self.snapshot()?;
        if key.starts_with('_') {
            return Err(Error::new(
                Code::InvalidParams,
                "internal settings cannot be changed",
            ));
        }
        if self.inner.harness.is_running(&self.id) {
            return Err(Error::new(
                Code::Busy,
                "settings cannot change during a turn",
            ));
        }
        let patch = base::portable::settings_from_wire(&serde_json::json!({key: value}));
        self.inner
            .harness
            .settings(&base::Scope::session(&self.id), patch)?;
        Ok(())
    }

    /// Fork at the current position.
    pub fn fork(&self) -> Result<Session> {
        self.fork_with(None)
    }

    /// Fork at a recorded entry, or at the current position.
    pub fn fork_with(&self, entry_id: Option<&str>) -> Result<Session> {
        let data = self.snapshot()?;
        if entry_id.is_some_and(|id| !data.entries.iter().any(|e| e.id == id)) {
            return Err(Error::new(Code::NotFound, "unknown fork point"));
        }
        let id = self
            .inner
            .harness
            .fork(&base::Scope::session(&self.id), entry_id.map(str::to_owned))?;
        let agent = crate::Agent {
            inner: self.inner.clone(),
        };
        agent.attach(&id)?;
        Ok(Session::new(self.inner.clone(), id))
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

    /// List the commands available to the local actor.
    pub fn commands(&self) -> Result<Vec<String>> {
        self.snapshot()?;
        Ok(self.inner.harness.commands())
    }

    /// Run a command without starting a turn. The result is text, if any.
    pub async fn run_command(&self, line: &str) -> Result<Option<String>> {
        let line = line.trim().trim_start_matches('/');
        let (name, args) = line.split_once(char::is_whitespace).unwrap_or((line, ""));
        if !self.commands()?.iter().any(|command| command == name) {
            return Err(Error::new(
                Code::NotFound,
                format!("unknown command {name}"),
            ));
        }
        let value = self
            .inner
            .harness
            .command(&base::Scope::session(&self.id), name, args.trim())
            .await?;
        Ok(if let Some(content) = value.get("content") {
            Some(base::wire::text(content))
        } else if value.as_object().is_some_and(|object| object.is_empty()) || value.is_null() {
            None
        } else {
            Some(value.to_string())
        })
    }

    /// Close the session after cancelling and settling any queued or running work.
    pub async fn close(&self) -> Result<()> {
        self.cancel().await?;
        let _run = self.driver.run.lock().await;
        Ok(self.inner.harness.close(&self.id).await?)
    }
}

fn input_turn(data: &base::SessionData, id: &str) -> Option<String> {
    data.entries
        .iter()
        .find(|e| {
            matches!(e.kind.as_str(), "input" | "turn.end")
                && e.content.as_ref().is_some_and(|c| c["inputId"] == id)
        })
        .and_then(|e| e.scope.turn.clone())
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
        usage: None,
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
        .collect::<Vec<_>>();
    let tool_results = calls
        .iter()
        .filter_map(|c| {
            tool_results
                .iter()
                .find(|r| r.call == c.id)
                .map(|r| ToolResult::from_base(c.name.clone(), r.clone()))
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
        usage: Some(base::wire::turn_outcome(result)["usage"].clone()),
        tool_results,
    }
}
