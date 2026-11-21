use crate::*;
use std::fmt;

#[derive(Debug)]
pub struct ModelAttemptLimit(pub &'static str);
impl fmt::Display for ModelAttemptLimit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "turn limit: {}", self.0)
    }
}
impl std::error::Error for ModelAttemptLimit {}

#[derive(Clone)]
pub struct ModelAttempt {
    pub writer: &'static str,
    pub tools: Vec<ToolDefinition>,
    pub sources: Vec<String>,
    pub auxiliary: bool,
    pub safe_to_repeat: bool,
    pub replay: Option<Value>,
    pub close_attempt: Option<Entry>,
    pub authorized_wire: Option<Value>,
}

// Compare decimal numbers without rounding through a floating-point value.
fn normalized_number(text: &str) -> Option<(bool, String, i128)> {
    let negative = text.starts_with('-');
    let text = text.strip_prefix('-').unwrap_or(text);
    let (digits, exponent) = text.split_once(['e', 'E']).unwrap_or((text, "0"));
    let (whole, frac) = digits.split_once('.').unwrap_or((digits, ""));
    let digits = [whole, frac].concat();
    let trimmed = digits.trim_matches('0');
    if trimmed.is_empty() {
        return Some((false, String::new(), 0));
    }
    let trailing = digits.len() - digits.trim_end_matches('0').len();
    let exponent = exponent
        .parse::<i128>()
        .ok()?
        .checked_add(trailing as i128 - frac.len() as i128)?;
    Some((negative, trimmed.into(), exponent))
}

pub fn same_json(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => {
            a == b
                || normalized_number(&a.to_string())
                    .zip(normalized_number(&b.to_string()))
                    .is_some_and(|(a, b)| a == b)
        }
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same_json(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(k, a)| b.get(k).is_some_and(|b| same_json(a, b)))
        }
        _ => a == b,
    }
}

/// Intersect a turn's offer with rights and the currently available registrations.
pub fn current_model_tools(
    api: &Api,
    scope: &Scope,
    offer: &[ToolDefinition],
) -> Result<Vec<ToolDefinition>> {
    if !work_authority(api.as_ref(), scope)?.has("tools") {
        return Ok(vec![]);
    }
    let data = api.snapshot(&scope.session)?;
    let mut current = vec![];
    for key in api.capability_names("tools.") {
        current.extend(capability::<dyn ToolSource>(api.as_ref(), &key)?.tools(&data));
    }
    Ok(offer
        .iter()
        .filter(|d| {
            current
                .iter()
                .any(|c| same_json(&wire::definition(d), &wire::definition(c)))
        })
        .cloned()
        .collect())
}

pub fn abort_attempt(api: &dyn AgentApi, writer: &str, old: &Entry) -> Result<()> {
    let aborted = wire::parse_response(json!({"role":"assistant","stop":"aborted","content":[]}))?;
    let mut recorded = json!(aborted);
    recorded["recovery"] = json!(true);
    api.append(
        &old.scope,
        writer,
        Draft::new("model.response", false, recorded).copying(vec![old.id.clone()]),
    )?;
    Ok(())
}

impl ModelAttempt {
    pub fn validate_tools(&self, request: &ModelRequest) -> Result<()> {
        let mut names = std::collections::BTreeSet::new();
        for tool in &request.tools {
            ensure!(
                names.insert(&tool.name)
                    && self.tools.iter().any(|allowed| same_json(
                        &wire::definition(allowed),
                        &wire::definition(tool)
                    )),
                "model request adds or changes an unauthorized tool: {}",
                tool.name
            );
        }
        Ok(())
    }

    /// The sole inference checkpoint. Use the request after the Provider transform.
    pub fn authorize(
        &self,
        api: &dyn AgentApi,
        scope: &Scope,
        info: &ModelInfo,
        request: &ModelRequest,
        cancel: &CancellationToken,
    ) -> Result<Entry> {
        ensure!(!cancel.is_cancelled(), "cancelled");
        ensure!(
            request.session == scope.session,
            "request changed the session"
        );
        if self.auxiliary && scope.turn.is_none() {
            require(api, scope, "input")?;
        }
        self.validate_tools(request)?;
        if !request.tools.is_empty() {
            ensure!(
                work_authority(api, scope)?.has("tools"),
                "tool offer is no longer authorized"
            );
        }
        if api.tenant_budget_reached(&scope.session)? {
            return Err(ModelAttemptLimit("tenantTokens").into());
        }
        api.check_writer(&scope.session)?;
        let data = api.snapshot(&scope.session)?;
        let mut intent = wire::model_request_record(info);
        intent["tools"] = json!(
            request
                .tools
                .iter()
                .map(|tool| &tool.name)
                .collect::<Vec<_>>()
        );
        intent["safeToRepeat"] =
            json!(self.safe_to_repeat && !info.keeps_state && !info.runs_tools);
        if intent["safeToRepeat"] == true {
            intent["request"] = self
                .authorized_wire
                .clone()
                .or_else(|| self.replay.clone())
                .unwrap_or_else(|| wire::request(request, Some(&data)));
        }
        if self.auxiliary {
            intent["auxiliary"] = json!(true);
        } else {
            intent["tracksStepAfter"] = json!(true);
        }
        let draft = Draft::new("model.request", false, intent).copying(self.sources.clone());
        ensure!(
            serde_json::to_vec(&draft.content)?.len() < 4 * 1024 * 1024 - 4096,
            "model intent exceeds the history page limit"
        );
        if let Some(old) = &self.close_attempt {
            abort_attempt(api, self.writer, old)?;
        }
        let entry = api.append(scope, self.writer, draft)?;
        if api.tenant_budget_reached(&scope.session)? {
            abort_attempt(api, self.writer, &entry)?;
            return Err(ModelAttemptLimit("tenantTokens").into());
        }
        ensure!(!cancel.is_cancelled(), "cancelled");
        api.check_writer(&scope.session)?;
        Ok(entry)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_comparison_matches_values_without_rounding() {
        let parse = |s: &str| serde_json::from_str::<Value>(s).unwrap();
        assert!(same_json(
            &parse(r#"{"a":1.00,"b":[-0,2e4]}"#),
            &parse(r#"{"b":[0.0,20000],"a":1}"#)
        ));
        assert!(!same_json(
            &parse("9007199254740992"),
            &parse("9007199254740993.0")
        ));
        assert!(!same_json(&parse("1e400"), &parse("2e400")));
        assert!(!same_json(&parse(r#"{"a":null}"#), &parse("{}")));
    }
}
