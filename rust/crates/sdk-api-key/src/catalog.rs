//! Model declarations and reasoning controls from the shared API-key table.
use modular_agent::ModelInfo;
use serde_json::{Value, json};

pub(crate) fn models(provider: &str) -> Vec<ModelInfo> {
    table()
        .iter()
        .filter(|m| m["provider"] == provider)
        .map(|m| {
            let mut catalog = m.clone();
            catalog.as_object_mut().unwrap().remove("levels");
            catalog["thinking"] = json!(levels(m));
            serde_json::from_value(catalog).expect("valid API-key model table")
        })
        .collect()
}

const LEVELS: &[&str] = &["off", "minimal", "low", "medium", "high", "xhigh"];

fn table() -> &'static [Value] {
    static TABLE: std::sync::OnceLock<Vec<Value>> = std::sync::OnceLock::new();
    TABLE.get_or_init(|| {
        let table: Value = serde_json::from_str(include_str!("../api-key-models.json"))
            .expect("valid API-key model table");
        table["models"]
            .as_array()
            .expect("API-key model list")
            .clone()
    })
}

fn levels(model: &Value) -> Vec<String> {
    LEVELS
        .iter()
        .filter(|level| model["levels"].get(**level).is_some())
        .map(|level| (*level).into())
        .collect()
}

pub(crate) fn reasoning_fields(
    provider: &str,
    id: &str,
    chosen: Option<&str>,
    max_output: u64,
) -> Option<serde_json::Map<String, Value>> {
    let chosen = chosen?;
    let rank = LEVELS.iter().position(|level| *level == chosen)?;
    let mappings = table()
        .iter()
        .find(|model| model["provider"] == provider && model["id"] == id)?["levels"]
        .as_object()?;
    let mut fields = LEVELS[..=rank]
        .iter()
        .rev()
        .find_map(|level| mappings.get(*level))?
        .clone();
    if fields["thinking"]["type"] == "enabled" {
        let budget = fields["thinking"]["budget_tokens"]
            .as_u64()?
            .min(max_output.saturating_sub(1));
        if budget < 1024 {
            return mappings.get("off")?.as_object().cloned();
        }
        fields["thinking"]["budget_tokens"] = json!(budget);
    }
    fields.as_object().cloned()
}
