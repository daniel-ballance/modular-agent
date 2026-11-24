//! Shared envelopes. Plugin-owned JSON stays opaque, including future fields.
use crate::{Content, ToolStatus};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub parent_id: Option<String>,
    pub kind: Option<String>,
    #[serde(flatten)]
    pub fields: Map<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
    pub actor_id: Option<String>,
    pub parent_call_id: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub returns: Option<Value>,
    #[serde(default)]
    pub parallel: bool,
    #[serde(default)]
    pub hints: ToolHints,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ToolHints {
    pub read_only: bool,
    pub destructive: bool,
    pub open_world: bool,
    pub safe_to_repeat: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}
impl Default for ToolHints {
    fn default() -> Self {
        Self {
            read_only: false,
            destructive: true,
            open_world: true,
            safe_to_repeat: false,
            extra: Map::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSettlement {
    pub call_id: String,
    pub status: ToolStatus,
    pub content: Content,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub value: Option<Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TurnOutput {
    pub text: Option<String>,
    #[serde(deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    pub open_tool_calls: Vec<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

pub(crate) fn present<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}
