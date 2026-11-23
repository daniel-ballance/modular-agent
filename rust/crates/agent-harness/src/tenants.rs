use agent_api::*;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone)]
pub struct Tenant {
    pub rights: Authority,
    pub tokens: Option<u64>,
}

pub fn name(data: &SessionData) -> Option<&str> {
    data.tenant_id()
}

// Completed turns carry the portable total. Count individual responses only
// until turnEnd is kept, so a live or interrupted turn counts without duplication.
pub fn used(data: &SessionData) -> Result<u64> {
    let mut ended = BTreeSet::new();
    let mut tokens = 0u64;
    for e in data.entries.iter().filter(|e| e.kind == "turn.end") {
        if let Some(v) = &e.content {
            let result: TurnResult = serde_json::from_value(v.clone())?;
            ended.insert(e.scope.turn.as_ref());
            tokens = tokens
                .saturating_add(result.usage.input_tokens)
                .saturating_add(result.usage.output_tokens);
        }
    }
    for e in data
        .entries
        .iter()
        .filter(|e| e.kind == "model.response" && !ended.contains(&e.scope.turn.as_ref()))
    {
        if let Some(v) = &e.content {
            let response: ModelResponse = serde_json::from_value(v.clone())?;
            tokens = tokens
                .saturating_add(response.usage.input_tokens)
                .saturating_add(response.usage.output_tokens);
        }
    }
    Ok(tokens)
}

pub type Tenants = BTreeMap<String, Tenant>;

pub fn parse(input: &str) -> Result<Tenants> {
    let value: Value = serde_json::from_str(input)?;
    value
        .as_object()
        .ok_or_else(|| anyhow!("tenants must be a JSON object"))?
        .iter()
        .map(|(name, config)| {
            let rights = serde_json::from_value(config["rights"].clone())?;
            let tokens = wire::optional(config, "tokens")
                .map(|v| {
                    v.as_u64()
                        .ok_or_else(|| anyhow!("tenant budget must be a nonnegative integer"))
                })
                .transpose()?;
            Ok((name.clone(), Tenant { rights, tokens }))
        })
        .collect()
}
