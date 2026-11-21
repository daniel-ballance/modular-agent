//! A Runtime written against the binding's host callbacks, in either placement.
use crate::{AssistantMessage, Code, Error, HistoryPage, ModelInfo, ModelRequest, Result, Usage};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDeclaration {
    pub id: String,
    pub supports: RuntimeSupport,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RuntimeSupport {
    pub input_during_turn: bool,
    pub waiting_through_restart: bool,
    pub continues_after_restart: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTurn {
    pub session_id: String,
    pub turn_id: String,
    pub started_by: Value,
    pub model: ModelInfo,
    pub model_supports: Value,
    pub settings: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_shape: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCall {
    pub id: String,
    pub name: String,
    pub input: Value,
    pub step_id: Option<String>,
    pub started: bool,
    pub safe_to_repeat: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterruptedTurn {
    pub turn_id: String,
    pub calls: Vec<RuntimeCall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_step: Option<ResumedStep>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumedStep {
    pub step_id: String,
    /// Missing means uncommitted; JSON null means an explicitly committed allow.
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub decision: Option<Value>,
}
fn present<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RuntimeOutcome {
    pub outcome: crate::Outcome,
    pub result: Value,
    pub entries: Vec<String>,
    pub usage: Usage,
}

#[crate::async_trait]
pub trait RuntimePart: Send + Sync + 'static {
    fn declaration(&self) -> RuntimeDeclaration;
    async fn run_turn(&self, turn: RuntimeTurn, cx: RuntimeContext) -> Result<RuntimeOutcome>;
    async fn resume_turn(
        &self,
        turn: RuntimeTurn,
        interrupted: InterruptedTurn,
        cx: RuntimeContext,
    ) -> Result<RuntimeOutcome>;
    async fn continue_open_calls(
        &self,
        turn: RuntimeTurn,
        calls: Vec<RuntimeCall>,
        cx: RuntimeContext,
    ) -> Result<RuntimeOutcome>;
}

#[derive(Clone)]
pub struct RuntimeContext {
    pub session_id: String,
    pub turn_id: String,
    pub started_by: Value,
    host: plugin_stdio::RuntimeContext,
}
impl RuntimeContext {
    pub fn cancelled(&self) -> &CancellationToken {
        self.host.cancelled()
    }
    pub fn log(&self, message: impl std::fmt::Display) {
        eprintln!("Runtime for turn {}: {message}", self.turn_id);
    }
    async fn callback(&self, name: &str, params: Value) -> Result<Value> {
        self.host
            .callback(name, params)
            .await
            .map_err(crate::serve::from_fault)
    }
    pub async fn history(&self, after: Option<&str>) -> Result<HistoryPage> {
        let mut p = json!({"sessionId":self.session_id,"all":true});
        if let Some(after) = after {
            p["after"] = json!(after);
        }
        Ok(serde_json::from_value(self.callback("history", p).await?)?)
    }
    pub async fn new_id(&self) -> Result<String> {
        Ok(serde_json::from_value(
            self.callback("newId", json!({})).await?["id"].clone(),
        )?)
    }
    pub async fn prepare_step(&self, step_id: &str, usage: Usage) -> Result<ModelRequest> {
        Ok(ModelRequest(
            self.callback("prepareStep", json!({"stepId":step_id,"usage":usage}))
                .await?,
        ))
    }
    pub async fn model(&self, step_id: &str, request: ModelRequest) -> Result<AssistantMessage> {
        Ok(AssistantMessage(
            self.callback("model", json!({"stepId":step_id,"request":request}))
                .await?,
        ))
    }
    pub async fn hook(&self, hook: &str, payload: Value) -> Result<Value> {
        self.callback("hook", json!({"hook":hook,"payload":payload}))
            .await
    }
    pub async fn definition(&self, name: &str) -> Result<Option<Value>> {
        let v = self
            .callback("definition", json!({"toolName":name}))
            .await?;
        Ok((!v.is_null()).then_some(v))
    }
    pub async fn run_tool_call(&self, call: Value) -> Result<Value> {
        self.callback("runToolCall", json!({"call":call})).await
    }
    pub async fn record(&self, entry: Value) -> Result<Value> {
        self.callback("record", json!({"entry":entry})).await
    }
    pub async fn take_steering(&self, final_cutoff: bool) -> Result<Vec<Value>> {
        Ok(serde_json::from_value(
            self.callback("takeSteering", json!({"final":final_cutoff}))
                .await?["entries"]
                .clone(),
        )?)
    }
    pub async fn has_steering(&self) -> Result<bool> {
        Ok(self.callback("hasSteering", json!({})).await?["waiting"] == true)
    }
    pub async fn emit(&self, kind: &str, data: Value) -> Result<()> {
        if !kind.contains('.') {
            return Err(Error::new(
                Code::InvalidRequest,
                "custom event type must contain a dot",
            ));
        }
        self.host
            .report(json!({"type":kind,"data":data}))
            .await
            .map_err(crate::serve::from_fault)
    }
}

#[derive(Clone)]
pub(crate) struct Adapter {
    pub handler: Arc<dyn RuntimePart>,
    pub registration: Value,
}
impl Adapter {
    pub(crate) fn new(part: impl RuntimePart) -> Result<Self> {
        let declaration = part.declaration();
        if declaration.id.is_empty()
            || (declaration.supports.waiting_through_restart
                && !declaration.supports.continues_after_restart)
        {
            return Err(Error::new(
                Code::InvalidComposition,
                "invalid Runtime declaration",
            ));
        }
        Ok(Self {
            handler: Arc::new(part),
            registration: serde_json::to_value(declaration)?,
        })
    }
    async fn invoke(
        &self,
        method: &str,
        p: Value,
        host: plugin_stdio::RuntimeContext,
    ) -> Result<Value> {
        let parse = |e: serde_json::Error| Error::new(Code::InvalidRequest, e.to_string());
        let turn: RuntimeTurn = serde_json::from_value(p["turn"].clone()).map_err(parse)?;
        if turn.session_id.is_empty() || turn.turn_id.is_empty() {
            return Err(Error::new(
                Code::InvalidRequest,
                "missing Runtime turn identity",
            ));
        }
        let cx = RuntimeContext {
            session_id: turn.session_id.clone(),
            turn_id: turn.turn_id.clone(),
            started_by: turn.started_by.clone(),
            host,
        };
        let outcome = match method {
            "runtime/runTurn" => self.handler.run_turn(turn, cx).await?,
            "runtime/resumeTurn" => {
                let interrupted: InterruptedTurn =
                    serde_json::from_value(p["interrupted"].clone()).map_err(parse)?;
                if interrupted.turn_id != turn.turn_id {
                    return Err(Error::new(
                        Code::InvalidRequest,
                        "checkpoint belongs to another turn",
                    ));
                }
                self.handler.resume_turn(turn, interrupted, cx).await?
            }
            "runtime/continueOpenCalls" => {
                self.handler
                    .continue_open_calls(
                        turn,
                        serde_json::from_value(p["calls"].clone()).map_err(parse)?,
                        cx,
                    )
                    .await?
            }
            _ => {
                return Err(Error::new(
                    Code::InvalidRequest,
                    "unknown Runtime operation",
                ));
            }
        };
        Ok(serde_json::to_value(outcome)?)
    }
}

#[crate::async_trait]
impl plugin_stdio::RuntimeHandler for Adapter {
    async fn run(
        &self,
        method: &str,
        params: Value,
        context: plugin_stdio::RuntimeContext,
    ) -> std::result::Result<Value, plugin_stdio::rpc::Fault> {
        self.invoke(method, params, context)
            .await
            .map_err(crate::serve::to_fault)
    }
}
