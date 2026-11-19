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

pub(crate) type Handle = Arc<dyn Fn(Value) -> BoxFuture<'static, Result<Value>> + Send + Sync>;
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
        Gate::Change(_) => {
            return Err(crate::Error::new(
                crate::Code::InvalidRequest,
                "this gate cannot change its payload",
            ));
        }
    })
}

#[derive(Clone, Debug)]
pub struct ToolBefore {
    pub session_id: String,
    pub call_id: String,
    pub name: String,
    pub input: Value,
    pub definition: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnBefore {
    pub session_id: String,
    pub turn_id: String,
    pub input: Value,
    /// In-process snapshot of the session's project.
    pub project: Option<std::path::PathBuf>,
    /// Tool definitions callable by plugins; absent over the binding.
    pub tools: Option<Vec<Value>>,
}
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct TurnAddition {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<Value>,
    /// History entries used by this contribution. An empty list asserts that
    /// it does not depend on any session history.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<String>>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolAfter {
    pub session_id: String,
    pub call: Value,
    pub result: Value,
}
#[derive(Clone, Debug, Default)]
pub struct ToolChange {
    pub content: Option<Value>,
    pub value: Option<Value>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepAfter {
    pub session_id: String,
    pub turn_id: String,
    pub step_id: String,
    pub response: Value,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnEnd {
    pub session_id: String,
    pub turn_id: String,
    pub outcome: Value,
    pub result: Value,
}

macro_rules! payload {
    ($name:ident { $($field:ident : $ty:ty),* }) => {
        #[derive(Clone, Debug, Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub struct $name { $(pub $field: $ty),* }
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
    when: String
});
payload!(TurnStart {
    session_id: String,
    turn_id: String
});
payload!(StepBefore {
    session_id: String,
    turn_id: String,
    step_id: String,
    model: Value,
    request: Value
});
payload!(ModelFailed {
    session_id: String,
    request: Value,
    error: Value
});
payload!(TurnResultReady {
    session_id: String,
    turn_id: String,
    result: Value,
    shape: Value
});
payload!(ProviderRequest { session_id: Option<String>, provider: String, model: Value, request: Value });
payload!(ProviderResponse { session_id: Option<String>, provider: String, model: Value, message: Value });

#[derive(Clone, Debug)]
pub enum InputChange {
    Pass,
    Change(Value),
    Handle,
}
#[derive(Clone, Debug)]
pub enum ModelDecision {
    Pass,
    Retry(Option<Value>),
    Stop,
}

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
                    handle: Arc::new(move |p| {
                        let f = f.clone();
                        Box::pin(async move {
                            let input = ($decode)(&p)?;
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
            session_id: p["sessionId"].as_str().unwrap_or_default().into(),
            call_id: p["call"]["id"].as_str().unwrap_or_default().into(),
            name: p["call"]["name"].as_str().unwrap_or_default().into(),
            input: p["call"]["input"].clone(),
            definition: p["definition"].clone(),
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
    })
);
registration!(
    on_step_before,
    on_step_before_with,
    "step.before",
    StepBefore,
    Option<Value>,
    decode,
    request_change
);
registration!(
    on_provider_request,
    on_provider_request_with,
    "provider.request",
    ProviderRequest,
    Option<Value>,
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

fn request_change(request: Option<Value>, mut payload: Value) -> Result<Value> {
    Ok(match request {
        None => Value::Null,
        Some(request) => {
            payload["request"] = request;
            json!({"value":payload})
        }
    })
}
