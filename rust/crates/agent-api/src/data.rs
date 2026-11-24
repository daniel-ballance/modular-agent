use crate::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Scope {
    pub session: String,
    pub actor: String,
    pub turn: Option<String>,
    pub step: Option<String>,
    pub call: Option<String>,
    pub job: Option<String>,
}
impl Scope {
    pub fn session(id: &str) -> Self {
        Self {
            session: id.into(),
            actor: "user".into(),
            ..Self::default()
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub parent: Option<String>,
    pub scope: Scope,
    pub writer: String,
    pub at: u64,
    pub kind: String,
    pub visible: bool,
    pub copies: Vec<String>,
    pub content: Option<Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Draft {
    pub kind: String,
    pub visible: bool,
    pub copies: Vec<String>,
    pub content: Value,
}
impl Draft {
    pub fn new(kind: &str, visible: bool, content: Value) -> Self {
        Self {
            kind: kind.into(),
            visible,
            content,
            copies: vec![],
        }
    }
    pub fn copying(mut self, ids: Vec<String>) -> Self {
        self.copies = ids;
        self
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionData {
    pub id: String,
    pub project: PathBuf,
    pub settings: Value,
    pub plugins: Vec<String>,
    pub position: Option<String>,
    pub entries: Vec<Entry>,
    pub origin: Option<(String, Option<String>)>,
}
impl SessionData {
    pub fn unresolved_rewind(&self) -> Option<&Entry> {
        // A legacy failure record is not a completion. Look past it for the intent.
        let mut positions = self.entries.iter().rev().filter(|e| e.kind == "position");
        let latest = positions.next()?;
        let value = latest.content.as_ref()?;
        if value.get("restore").is_some() {
            Some(latest)
        } else if value["failed"] == true {
            positions
                .find(|e| e.content.as_ref().is_some_and(|c| c["failed"] != true))
                .filter(|e| {
                    e.content
                        .as_ref()
                        .is_some_and(|c| c.get("restore").is_some())
                })
        } else {
            None
        }
    }

    pub fn pending_inputs(&self) -> Vec<(&str, &Entry)> {
        let mut pending = Vec::<(&str, &Entry)>::new();
        for entry in &self.entries {
            let Some(v) = &entry.content else {
                if entry.kind == "input.returned"
                    && entry.writer == "rust.tombstone.inputHandedBack"
                {
                    pending.retain(|(id, _)| !entry.copies.iter().any(|settled| settled == id));
                }
                continue;
            };
            let input = v["inputId"].as_str().unwrap_or(&entry.id);
            match entry.kind.as_str() {
                "input.accepted" => {
                    pending.retain(|(id, _)| *id != input);
                    pending.push((input, entry));
                }
                "input" => pending
                    .retain(|(id, _)| *id != input && !entry.copies.iter().any(|copy| copy == *id)),
                "input.returned" | "input.withdrawn" => pending.retain(|(id, _)| {
                    v["input"] != *id
                        && !v["inputIds"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .any(|n| n == *id)
                }),
                _ => (),
            }
        }
        pending
    }
    pub fn branch(&self) -> Vec<Entry> {
        let by_id: BTreeMap<_, _> = self.entries.iter().map(|e| (e.id.as_str(), e)).collect();
        let mut entries = vec![];
        let mut current = self.position.as_deref();
        while let Some(id) = current {
            let Some(entry) = by_id.get(id) else { break };
            entries.push((*entry).clone());
            current = entry.parent.as_deref();
        }
        entries.reverse();
        if self.entries.iter().any(|e| e.writer == "rust.derived") {
            let mut derived = BTreeMap::<&str, Vec<&Entry>>::new();
            for entry in self.entries.iter().filter(|e| e.writer == "rust.derived") {
                if let Some(parent) = entry.parent.as_deref() {
                    derived.entry(parent).or_default().push(entry);
                }
            }
            let mut branch = vec![];
            for entry in entries {
                let extras = derived.remove(entry.id.as_str());
                branch.push(entry);
                branch.extend(extras.into_iter().flatten().cloned());
            }
            return branch;
        }
        entries
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Input {
    pub id: String,
    pub actor: String,
    pub text: String,
    pub timing: Timing,
    pub key: Option<String>,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Timing {
    Now,
    Steer,
    After,
    Propose,
}
pub fn authority_record(e: &Entry) -> bool {
    matches!(
        e.kind.as_str(),
        "actor.grant"
            | "actor.identity"
            | "actor.left"
            | "tenant"
            | "limit"
            | "position"
            | "job.cleanup_unconfirmed"
    )
}

pub fn erased_input_keys(data: &SessionData, targets: &[String]) -> Vec<Value> {
    data.entries
        .iter()
        .filter_map(|e| {
            if !matches!(e.kind.as_str(), "input.accepted" | "input" | "command")
                || !targets.contains(&e.id)
            {
                return None;
            }
            let stored = e.content.as_ref()?;
            let key = stored["key"].as_str()?;
            let input = stored["inputId"].as_str().unwrap_or(&e.id);
            let admission = data.entries.iter().find(|entry| {
                entry.kind == "input.accepted"
                    && entry
                        .content
                        .as_ref()
                        .is_some_and(|c| c["inputId"].as_str().unwrap_or(&entry.id) == input)
            });
            let actor = &admission.unwrap_or(e).scope.actor;
            let submitter = admission
                .and_then(|entry| entry.content.as_ref())
                .unwrap_or(stored)["submittedBy"]
                .as_str()
                .unwrap_or(actor);
            Some(json!({"inputId":input,"key":key,"actorId":actor,"submittedBy":submitter}))
        })
        .collect()
}
pub fn record_erasure(data: &mut SessionData, entry_ids: Vec<String>, input_keys: Vec<Value>) {
    // Erasing approval evidence ends the unstarted call. Retain terminal
    // identities only: a result derived from erased evidence is also erased.
    let branch = data.branch();
    for request in branch.iter().filter(|e| {
        e.kind == "request.open"
            && e.content
                .as_ref()
                .is_some_and(|v| v["extra"]["approvalWait"] == "untilDeadline")
    }) {
        if data
            .entries
            .iter()
            .any(|r| r.kind == "tool.result" && r.scope.call == request.scope.call)
        {
            continue;
        }
        let affected = branch
            .iter()
            .any(|r| r.scope.call == request.scope.call && entry_ids.contains(&r.id))
            || request.copies.iter().any(|s| entry_ids.contains(s));
        if !affected {
            continue;
        }
        for kind in ["request.closed", "tool.result"] {
            if kind == "request.closed"
                && branch.iter().any(|r| {
                    matches!(r.kind.as_str(), "request.answer" | "request.closed")
                        && r.scope.call == request.scope.call
                })
            {
                continue;
            }
            let entry = Entry {
                id: id(),
                parent: data.position.clone(),
                scope: request.scope.clone(),
                writer: "harness".into(),
                at: now(),
                kind: kind.into(),
                visible: false,
                copies: vec![request.id.clone()],
                content: None,
            };
            data.position = Some(entry.id.clone());
            data.entries.push(entry);
        }
    }
    for checkpoint in data.branch().into_iter().filter(interface_handoff) {
        if !entry_ids.contains(&checkpoint.id)
            && !interface_start(data, &checkpoint).is_some_and(|e| entry_ids.contains(&e.id))
        {
            continue;
        }
        if let Some((scope, draft)) =
            interface_unknown(data, &checkpoint, "Interface handoff erased")
        {
            let entry = Entry {
                id: id(),
                parent: data.position.clone(),
                scope,
                writer: "harness".into(),
                at: now(),
                kind: draft.kind,
                // This terminal settlement belongs to the erased call's copy
                // set. Keep its identity, not a newly readable derived entry.
                visible: false,
                copies: draft.copies,
                content: None,
            };
            data.position = Some(entry.id.clone());
            data.entries.push(entry);
        }
    }
    let entry = Entry {
        id: id(),
        parent: data.position.clone(),
        scope: Scope::session(&data.id),
        writer: "harness".into(),
        at: now(),
        kind: "erasure".into(),
        visible: false,
        copies: vec![],
        content: Some(if input_keys.is_empty() {
            json!({"entryIds":entry_ids})
        } else {
            json!({"entryIds":entry_ids,"inputKeys":input_keys})
        }),
    };
    data.position = Some(entry.id.clone());
    data.entries.push(entry);
}
pub fn input_taken(running: bool, timing: Timing) -> &'static str {
    match (running, timing) {
        (_, Timing::Propose) => "proposed",
        (true, Timing::Steer) => "inTurn",
        (true, _) | (_, Timing::After) => "after",
        _ => "now",
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Receipt {
    pub input: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub erased: bool,
    pub duplicate: bool,
    pub command: Option<Value>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    #[default]
    Completed,
    Cancelled,
    Failed,
    Limit,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
    #[serde(default, skip_serializing_if = "zero_u64")]
    pub cache_write_tokens: u64,
    #[serde(default, skip_serializing_if = "zero_f64")]
    pub cost: f64,
}
fn zero_u64(value: &u64) -> bool {
    *value == 0
}
fn zero_f64(value: &f64) -> bool {
    *value == 0.0
}
impl Usage {
    pub fn add(&mut self, other: &Self) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cached_tokens += other.cached_tokens;
        self.cache_write_tokens += other.cache_write_tokens;
        self.cost += other.cost;
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TurnResult {
    #[serde(default)]
    pub open_calls: Vec<ToolCall>,
    pub outcome: Outcome,
    pub text: String,
    pub error: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_value"
    )]
    pub value: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<String>,
    pub steps: usize,
    pub usage: Usage,
}
fn present_value<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Part {
    Text { text: String },
    ToolCall { call: ToolCall },
    Reasoning { data: Value },
    Other { name: String, data: Value },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
    pub started_by: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub extra: Value,
}
impl ToolCall {
    pub fn new(name: &str, input: Value) -> Self {
        Self {
            id: id(),
            name: name.into(),
            input,
            started_by: "model".into(),
            extra: Value::Null,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    /// Internal suspension marker. Never saved as a tool result.
    Waiting,
    Completed,
    Failed,
    Refused,
    Cancelled,
    NotStarted,
    Unknown,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolResult {
    pub call: String,
    pub status: ToolStatus,
    pub text: String,
    pub value: Option<Value>,
}
impl ToolResult {
    pub fn new(call: &ToolCall, status: ToolStatus, text: impl Into<String>) -> Self {
        let text = text.into();
        let text = if status == ToolStatus::Refused {
            Self::refusal_text(&text)
        } else {
            text
        };
        Self {
            call: call.id.clone(),
            status,
            text,
            value: None,
        }
    }
    /// Give the result content beyond text, such as an image, as shared
    /// Content parts. The text parts together must equal `text`.
    pub fn with_content(mut self, content: Vec<Value>) -> Self {
        let mut wire = json!({"content": content});
        if let Some(value) = self.value.take() {
            wire["value"] = value;
        }
        self.value = Some(json!({"_pluginWire": wire}));
        self
    }
    /// The content set by `with_content` or received over the wire, when it
    /// still matches the text.
    pub fn content(&self) -> Option<&Vec<Value>> {
        let content = self.value.as_ref()?["_pluginWire"]["content"].as_array()?;
        (crate::wire::text(&json!(content)) == self.text).then_some(content)
    }
    pub fn refusal_text(reason: &str) -> String {
        format!("The call was refused and did not run: {reason}")
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input: Value,
    pub read_only: bool,
    pub safe_to_repeat: bool,
    pub parallel: bool,
    /// Additional effect hints and source metadata, retained without interpretation.
    #[serde(default)]
    pub hints: Value,
}
impl ToolDefinition {
    pub fn open_world(&self) -> bool {
        self.hints["openWorld"] == true || self.hints["_wire"]["hints"]["openWorld"] == true
    }
    /// Limit who may start this tool: any of `model`, `ui` and `plugin`.
    /// A call made by another tool counts as `plugin`.
    pub fn for_callers(mut self, callers: &[&str]) -> Self {
        let mut wire = crate::wire::definition(&self);
        wire["callers"] = json!(callers);
        if !self.hints.is_object() {
            self.hints = json!({});
        }
        self.hints["_wire"] = wire;
        self
    }
    pub fn allows(&self, caller: &str) -> bool {
        self.hints["_wire"]["callers"]
            .as_array()
            .is_none_or(|items| items.iter().any(|v| v == caller))
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub parts: Vec<Part>,
    pub call: Option<String>,
    pub opaque: Value,
}
impl Message {
    pub fn text(role: &str, text: &str) -> Self {
        Self {
            role: role.into(),
            parts: vec![Part::Text { text: text.into() }],
            ..Self::default()
        }
    }
    pub fn text_content(&self) -> String {
        self.parts
            .iter()
            .filter_map(|p| {
                if let Part::Text { text } = p {
                    Some(text.as_str())
                } else {
                    None
                }
            })
            .collect()
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ErasureReport {
    pub erased: Vec<String>,
    #[serde(skip)]
    pub qualified: Vec<(String, String)>,
    pub pending: Vec<String>,
    pub out_of_reach: Vec<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ModelRequest {
    pub session: String,
    pub system: String,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolDefinition>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provider_tools: Vec<ToolDefinition>,
    pub thinking: String,
    pub output_limit: u64,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub extra: Value,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ModelResponse {
    pub parts: Vec<Part>,
    pub opaque: Value,
    pub stop: String,
    pub usage: Usage,
    /// True when the Provider reported usage, even if all counts were zero.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub usage_reported: bool,
}
impl ModelResponse {
    pub fn has_usage(&self) -> bool {
        self.usage_reported
            || self.usage.input_tokens > 0
            || self.usage.output_tokens > 0
            || self.usage.cached_tokens > 0
            || self.usage.cache_write_tokens > 0
            || self.usage.cost != 0.0
    }

    pub fn text(text: &str) -> Self {
        Self {
            parts: vec![Part::Text { text: text.into() }],
            stop: "finished".into(),
            ..Self::default()
        }
    }
    pub fn calls(calls: Vec<ToolCall>) -> Self {
        Self {
            parts: calls
                .into_iter()
                .map(|call| Part::ToolCall { call })
                .collect(),
            stop: "tools".into(),
            ..Self::default()
        }
    }
    pub fn text_content(&self) -> String {
        self.parts
            .iter()
            .filter_map(|p| {
                if let Part::Text { text } = p {
                    Some(text.as_str())
                } else {
                    None
                }
            })
            .collect()
    }
    pub fn tool_calls(&self) -> Vec<ToolCall> {
        self.parts
            .iter()
            .filter_map(|p| {
                if let Part::ToolCall { call } = p {
                    Some(call.clone())
                } else {
                    None
                }
            })
            .collect()
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    Temporary,
    ContextTooLarge,
    Credentials,
    Refused,
    Cancelled,
    Other,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModelFailure {
    pub kind: FailureKind,
    pub message: String,
}
impl std::fmt::Display for ModelFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}
impl std::error::Error for ModelFailure {}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ModelInfo {
    pub name: String,
    pub context_window: u64,
    pub output_limit: u64,
    pub thinking: Vec<String>,
    pub keeps_state: bool,
    pub runs_tools: bool,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub extra: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Event {
    pub kind: String,
    pub scope: Scope,
    pub at: u64,
    pub content: Value,
    pub stream: Option<String>,
    pub end: bool,
}
impl Event {
    pub fn new(scope: &Scope, kind: &str, content: Value) -> Self {
        Self {
            kind: kind.into(),
            scope: scope.clone(),
            at: now(),
            content,
            stream: None,
            end: false,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Output {
    pub recipient: String,
    pub value: Value,
    pub stream: Option<String>,
    pub end: bool,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct HookResult {
    #[serde(default)]
    pub suspended: bool,
    pub value: Value,
    pub answered: bool,
    pub stopped: bool,
    pub refused: Option<String>,
}
