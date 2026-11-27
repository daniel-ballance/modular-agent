//! Typed hook registrations, projected through the shared binding adapters.
use crate::{Plugin, Registrar, Result};
use futures_util::future::BoxFuture;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{future::Future, sync::Arc};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Order {
    First,
    #[default]
    Normal,
    Last,
}
impl Order {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::First => "first",
            Self::Normal => "normal",
            Self::Last => "last",
        }
    }
    pub(crate) fn native(self) -> agent_api::Order {
        match self {
            Self::First => agent_api::Order::First,
            Self::Normal => agent_api::Order::Normal,
            Self::Last => agent_api::Order::Last,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum HookRule {
    Observe,
    Gate,
    Transform,
    Collect,
    FirstAnswer,
}
impl HookRule {
    pub(crate) fn native(self) -> agent_api::Rule {
        use agent_api::Rule;
        match self {
            Self::Observe => Rule::Observe,
            Self::Gate => Rule::Gate,
            Self::Transform => Rule::Transform,
            Self::Collect => Rule::Collect,
            Self::FirstAnswer => Rule::FirstAnswer,
        }
    }
}

/// Invocation authority for a point defined in this plugin instance.
#[derive(Clone)]
pub struct DefinedHook(pub(crate) Arc<std::sync::OnceLock<agent_api::HookPoint>>);

#[derive(Clone, Debug)]
pub enum HookAnswer {
    Pass,
    Value(Value),
    Refuse(String),
}
impl HookAnswer {
    pub(crate) fn native(self) -> agent_api::HookResult {
        match self {
            Self::Pass => agent_api::HookResult::default(),
            Self::Value(value) => agent_api::answer(value),
            Self::Refuse(reason) => agent_api::HookResult {
                refused: Some(reason),
                ..Default::default()
            },
        }
    }
}

#[derive(Clone, Debug)]
pub struct HookReply {
    pub value: Value,
    pub answered: bool,
    pub refused: Option<String>,
}

pub(crate) type Handle =
    Arc<dyn Fn(Value, crate::HookContext) -> BoxFuture<'static, Result<Value>> + Send + Sync>;
pub(crate) struct Hook {
    pub point: &'static str,
    pub order: Order,
    pub handle: Handle,
}

/// A gate's answer. A change is supported only at `tool.before`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Gate {
    Allow,
    Refuse(String),
    Change(Value),
    /// Leave a tool call pending while an actor answers.
    Pending(crate::Ask),
}
fn gate(answer: Gate, p: Value) -> Result<Value> {
    Ok(match answer {
        Gate::Allow => Value::Null,
        Gate::Refuse(reason) => json!({"refuse":reason}),
        Gate::Change(input) if p["call"].is_object() => {
            let mut call = p["call"].clone();
            call["input"] = input;
            json!({"change":{"call":call}})
        }
        Gate::Pending(ask) if p["call"].is_object() => json!({"pendingQuestion":ask}),
        Gate::Change(_) | Gate::Pending(_) => {
            return Err(crate::Error::new(
                crate::Code::InvalidRequest,
                "this gate cannot change its payload",
            ));
        }
    })
}

#[derive(Clone, Debug)]
pub struct ToolBefore {
    pub context: crate::HookContext,
    pub session_id: String,
    pub call_id: String,
    pub name: String,
    pub input: Value,
    pub definition: crate::ToolDefinition,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnBefore {
    #[serde(skip)]
    pub context: crate::HookContext,
    pub session_id: String,
    pub turn_id: String,
    pub input: crate::Content,
    /// In-process snapshot of the session's project.
    pub project: Option<std::path::PathBuf>,
    /// Tool definitions callable by plugins; absent over the binding.
    pub tools: Option<Vec<crate::ToolDefinition>>,
}
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct TurnAddition {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<Value>,
    /// History entries used by this contribution. `None` attributes it to
    /// the current branch; `Some(vec![])` declares no history dependency.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<String>>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolAfter {
    #[serde(skip)]
    pub context: crate::HookContext,
    pub session_id: String,
    pub call: crate::ToolCall,
    pub result: crate::ToolSettlement,
}
#[derive(Clone, Debug, Default)]
pub struct ToolChange {
    pub content: Option<Value>,
    pub value: Option<Value>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepAfter {
    #[serde(skip)]
    pub context: crate::HookContext,
    pub session_id: String,
    pub turn_id: String,
    pub step_id: String,
    pub response: crate::AssistantMessage,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnEnd {
    #[serde(skip)]
    pub context: crate::HookContext,
    pub session_id: String,
    pub turn_id: String,
    pub outcome: crate::Outcome,
    pub result: crate::TurnOutput,
    pub usage: Option<crate::Usage>,
}

macro_rules! payload {
    ($name:ident { $($field:ident : $ty:ty),* }) => {
        #[derive(Clone, Debug, Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub struct $name {
            #[serde(skip)]
            pub context: crate::HookContext,
            $(pub $field: $ty),*
        }
    }
}
payload!(PluginLoad {
    name: String,
    origin: String,
    project: Value
});
payload!(SessionStart {
    session_id: String,
    resumed: bool
});
payload!(SessionEnd { session_id: String });
payload!(InputHook {
    session_id: String,
    actor_id: String,
    content: Value,
    when: crate::Timing
});
payload!(TurnStart {
    session_id: String,
    turn_id: String
});
payload!(StepBefore {
    session_id: String,
    turn_id: String,
    step_id: String,
    model: crate::ModelInfo,
    request: crate::ModelRequest,
    history: Option<Vec<crate::HistoryEntry>>,
    usage: Option<crate::Usage>
});
payload!(ModelFailed {
    session_id: String,
    request: crate::ModelRequest,
    error: crate::ModelError
});
payload!(TurnResultReady {
    session_id: String,
    turn_id: String,
    result: crate::TurnOutput,
    shape: Value
});
payload!(ProviderRequest { session_id: Option<String>, provider: String, model: crate::ModelRef, request: crate::ModelRequest });
payload!(ProviderResponse { session_id: Option<String>, provider: String, model: crate::ModelRef, message: crate::AssistantMessage });

#[derive(Clone, Debug)]
pub enum InputChange {
    Pass,
    Change(Value),
    Handle,
    /// Handle the input by running a registered command instead of a turn.
    HandleCommand(String),
}
#[derive(Clone, Debug)]
pub enum ModelDecision {
    Pass,
    Retry(Option<Value>),
    Stop,
}

// An actor joining or leaving a session.
payload!(SessionMembership {
    session_id: String,
    actor_id: String,
    changed_by: String
});

// One live Provider piece.
payload!(ProviderPiece { session_id: String, step_id: Option<String>, tool_call_id: Option<String>, kind: String, delta: Value });

#[derive(Clone, Debug)]
pub struct OutputView {
    pub context: crate::HookContext,
    pub session_id: String,
    pub recipient: String,
    pub value: Value,
    pub stream: Option<String>,
    pub end: bool,
}

#[derive(Clone, Debug)]
pub enum OutputDecision {
    Allow,
    Block,
    Redact(Value),
}

pub(crate) type LocalHandle = Arc<
    dyn Fn(Value, crate::HookContext) -> BoxFuture<'static, Result<agent_api::HookResult>>
        + Send
        + Sync,
>;
pub(crate) struct LocalRegistration {
    pub point: &'static str,
    pub order: Order,
    pub handle: LocalHandle,
}

macro_rules! local_hook {
    ($name:ident, $point:literal, $payload:ty, $reply:ty, $decode:expr, $encode:expr) => {
        impl Plugin {
            pub fn $name<F, Fut>(mut self, f: F) -> Self
            where
                F: Fn($payload) -> Fut + Send + Sync + 'static,
                Fut: Future<Output = Result<$reply>> + Send + 'static,
            {
                if $point != "output" {
                    self.local_items.push(format!("hook:{}", $point));
                }
                let f = Arc::new(f);
                self.setup(move |r| {
                    let f = f.clone();
                    r.$name(Order::Normal, move |p| f(p));
                    Ok(())
                })
            }
        }
        impl Registrar {
            pub fn $name<F, Fut>(&mut self, order: Order, f: F)
            where
                F: Fn($payload) -> Fut + Send + Sync + 'static,
                Fut: Future<Output = Result<$reply>> + Send + 'static,
            {
                let f = Arc::new(f);
                self.local_hooks.push(LocalRegistration {
                    point: $point,
                    order,
                    handle: Arc::new(move |raw, context| {
                        let f = f.clone();
                        Box::pin(async move {
                            let mut payload: $payload = ($decode)(&raw)?;
                            payload.context = context;
                            ($encode)(f(payload).await?, raw)
                        })
                    }),
                });
            }
        }
    };
}

fn membership(event: &Value) -> Result<SessionMembership> {
    Ok(SessionMembership {
        context: Default::default(),
        session_id: event["scope"]["session"].as_str().unwrap_or("").into(),
        actor_id: event["content"]["actorId"].as_str().unwrap_or("").into(),
        changed_by: event["scope"]["actor"].as_str().unwrap_or("").into(),
    })
}
local_hook!(
    on_session_join,
    "session.join",
    SessionMembership,
    (),
    membership,
    |(), _| Ok(agent_api::HookResult::default())
);
local_hook!(
    on_session_leave,
    "session.leave",
    SessionMembership,
    (),
    membership,
    |(), _| Ok(agent_api::HookResult::default())
);
local_hook!(
    on_provider_piece,
    "provider.piece",
    ProviderPiece,
    (),
    |event: &Value| {
        Ok::<_, crate::Error>(ProviderPiece {
            context: Default::default(),
            session_id: event["scope"]["session"].as_str().unwrap_or("").into(),
            step_id: event["scope"]["step"].as_str().map(str::to_owned),
            tool_call_id: event["scope"]["call"].as_str().map(str::to_owned),
            kind: match event["kind"].as_str() {
                Some("model.delta") => "text",
                Some("model.thought") => "reasoning",
                Some("model.tool_input") => "toolInput",
                _ => "audio",
            }
            .into(),
            delta: event["content"].clone(),
        })
    },
    |(), _| Ok(agent_api::HookResult::default())
);
local_hook!(
    on_output,
    "output",
    OutputView,
    OutputDecision,
    |raw: &Value| {
        Ok::<_, crate::Error>(OutputView {
            context: Default::default(),
            session_id: raw["sessionId"].as_str().unwrap_or("").into(),
            recipient: raw["recipient"].as_str().unwrap_or("").into(),
            value: raw["value"].clone(),
            stream: raw["stream"].as_str().map(str::to_owned),
            end: raw["end"] == true,
        })
    },
    |decision, mut original: Value| {
        // A gate may redact strings but cannot change protocol fields or add output.
        if let OutputDecision::Redact(ref value) = decision
            && agent_harness::apply_redactions(&mut original["value"], value)
        {
            return Ok(agent_api::answer(original));
        }
        if matches!(decision, OutputDecision::Allow) {
            Ok(agent_api::HookResult::default())
        } else {
            Ok(agent_api::HookResult {
                stopped: true,
                ..agent_api::answer(Value::Null)
            })
        }
    }
);

fn decode<T: serde::de::DeserializeOwned>(payload: &Value) -> Result<T> {
    serde_json::from_value(payload.clone()).map_err(Into::into)
}

macro_rules! registration {
    ($name:ident, $with:ident, $point:literal, $in:ty, $out:ty, $decode:expr, $encode:expr) => {
        impl Plugin {
            pub fn $name<F, Fut>(self, f: F) -> Self
            where
                F: Fn($in) -> Fut + Send + Sync + 'static,
                Fut: Future<Output = Result<$out>> + Send + 'static,
            {
                self.$with(Order::Normal, f)
            }
            pub fn $with<F, Fut>(self, order: Order, f: F) -> Self
            where
                F: Fn($in) -> Fut + Send + Sync + 'static,
                Fut: Future<Output = Result<$out>> + Send + 'static,
            {
                let f = Arc::new(f);
                self.setup(move |r| {
                    let f = f.clone();
                    r.$with(order, move |p| f(p));
                    Ok(())
                })
            }
        }
        impl Registrar {
            pub fn $name<F, Fut>(&mut self, f: F)
            where
                F: Fn($in) -> Fut + Send + Sync + 'static,
                Fut: Future<Output = Result<$out>> + Send + 'static,
            {
                self.$with(Order::Normal, f);
            }
            pub fn $with<F, Fut>(&mut self, order: Order, f: F)
            where
                F: Fn($in) -> Fut + Send + Sync + 'static,
                Fut: Future<Output = Result<$out>> + Send + 'static,
            {
                let f = Arc::new(f);
                self.hooks.push(Hook {
                    point: $point,
                    order,
                    handle: Arc::new(move |p, context| {
                        let f = f.clone();
                        Box::pin(async move {
                            let mut input: $in = ($decode)(&p)?;
                            input.context = context;
                            ($encode)(f(input).await?, p)
                        })
                    }),
                });
            }
        }
    };
}

registration!(
    on_tool_before,
    on_tool_before_with,
    "tool.before",
    ToolBefore,
    Gate,
    |p: &Value| -> Result<ToolBefore> {
        Ok(ToolBefore {
            context: Default::default(),
            session_id: p["sessionId"].as_str().unwrap_or_default().into(),
            call_id: p["call"]["id"].as_str().unwrap_or_default().into(),
            name: p["call"]["name"].as_str().unwrap_or_default().into(),
            input: p["call"]["input"].clone(),
            definition: serde_json::from_value(p["definition"].clone())?,
        })
    },
    gate
);
registration!(
    on_tool_after,
    on_tool_after_with,
    "tool.after",
    ToolAfter,
    ToolChange,
    decode,
    |change: ToolChange, mut p: Value| {
        if let Some(content) = change.content {
            p["result"]["content"] = content;
        }
        if let Some(value) = change.value {
            p["result"]["value"] = value;
        }
        Ok(json!({"value":p}))
    }
);
registration!(
    on_turn_before,
    on_turn_before_with,
    "turn.before",
    TurnBefore,
    TurnAddition,
    decode,
    |addition, _| Ok(serde_json::to_value(addition)?)
);
registration!(
    on_step_after,
    on_step_after_with,
    "step.after",
    StepAfter,
    Gate,
    decode,
    gate
);
registration!(
    on_turn_end,
    on_turn_end_with,
    "turn.end",
    TurnEnd,
    (),
    decode,
    |(), _| Ok(Value::Null)
);
registration!(
    on_plugin_load,
    on_plugin_load_with,
    "plugin.load",
    PluginLoad,
    Gate,
    decode,
    gate
);
registration!(
    on_session_start,
    on_session_start_with,
    "session.start",
    SessionStart,
    (),
    decode,
    |(), _| Ok(Value::Null)
);
registration!(
    on_session_end,
    on_session_end_with,
    "session.end",
    SessionEnd,
    (),
    decode,
    |(), _| Ok(Value::Null)
);
registration!(
    on_turn_start,
    on_turn_start_with,
    "turn.start",
    TurnStart,
    (),
    decode,
    |(), _| Ok(Value::Null)
);
registration!(
    on_turn_result,
    on_turn_result_with,
    "turn.result",
    TurnResultReady,
    Gate,
    decode,
    gate
);
registration!(
    on_provider_response,
    on_provider_response_with,
    "provider.response",
    ProviderResponse,
    (),
    decode,
    |(), _| Ok(Value::Null)
);
registration!(
    on_input,
    on_input_with,
    "input",
    InputHook,
    InputChange,
    decode,
    |change, mut p: Value| Ok(match change {
        InputChange::Pass => Value::Null,
        InputChange::Change(content) => {
            p["content"] = content;
            json!({"value":p})
        }
        InputChange::Handle => json!({"value":p,"stop":true}),
        InputChange::HandleCommand(command) => json!({"command":command}),
    })
);
registration!(
    on_step_before,
    on_step_before_with,
    "step.before",
    StepBefore,
    Option<crate::ModelRequest>,
    decode,
    request_change
);
registration!(
    on_provider_request,
    on_provider_request_with,
    "provider.request",
    ProviderRequest,
    Option<crate::ModelRequest>,
    decode,
    request_change
);
registration!(
    on_model_failed,
    on_model_failed_with,
    "model.failed",
    ModelFailed,
    ModelDecision,
    decode,
    |choice, _| Ok(match choice {
        ModelDecision::Pass => Value::Null,
        ModelDecision::Stop => json!({"retry":false}),
        ModelDecision::Retry(None) => json!({"retry":true}),
        ModelDecision::Retry(Some(r)) => json!({"retry":true,"request":r}),
    })
);

fn request_change(request: Option<crate::ModelRequest>, mut payload: Value) -> Result<Value> {
    Ok(match request {
        None => Value::Null,
        Some(request) => {
            payload["request"] = request.0;
            json!({"value":payload})
        }
    })
}
