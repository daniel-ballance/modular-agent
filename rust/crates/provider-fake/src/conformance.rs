//! Deterministic Provider for docs/bindings/acp.md. Never reads credentials.
use agent_api::*;
use std::sync::Arc;

pub struct ConformancePlugin;
struct Echo;
impl Plugin for ConformancePlugin {
    fn name(&self) -> &str {
        "provider.conformance"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.provide::<dyn ToolSource>("tools.conformance", Arc::new(Nest))?;
        r.provide::<dyn Provider>("provider.conformance", Arc::new(Echo))
    }
}
/// The fixture tool `nest`: starts one nested call and settles as it did.
struct Nest;
#[async_trait]
impl ToolSource for Nest {
    fn tools(&self, _: &SessionData) -> Vec<ToolDefinition> {
        vec![ToolDefinition {
            name: "nest".into(),
            description: "Start one nested call and return its result.".into(),
            input: json!({"type":"object","properties":{"name":{"type":"string"},"input":{"type":"object"}},"required":["name","input"],"additionalProperties":false}),
            read_only: false,
            safe_to_repeat: false,
            parallel: false,
            hints: json!({}),
        }]
    }
    async fn run(
        &self,
        api: Api,
        scope: Scope,
        call: ToolCall,
        cancel: CancellationToken,
    ) -> ToolResult {
        let nested: Result<ToolResult> = async {
            let name = call.input["name"]
                .as_str()
                .ok_or_else(|| anyhow!("name must be a string"))?;
            ensure!(call.input["input"].is_object(), "input must be an object");
            let data = api.snapshot(&scope.session)?;
            session_runtime(api.as_ref(), &data)?
                .nested_tool(
                    api.clone(),
                    scope.clone(),
                    ToolCall::new(name, call.input["input"].clone()),
                    cancel,
                )
                .await
        }
        .await;
        match nested {
            Ok(mut result) => {
                result.call = call.id.clone();
                result
            }
            Err(error) => ToolResult::new(&call, ToolStatus::Failed, error.to_string()),
        }
    }
}
fn info() -> ModelInfo {
    ModelInfo {
        name: "conformance/echo".into(),
        context_window: 128000,
        output_limit: 8192,
        thinking: vec!["off".into(), "low".into()],
        keeps_state: false,
        runs_tools: false,
        extra: Value::Null,
    }
}
#[async_trait]
impl Provider for Echo {
    fn catalog(&self) -> Vec<ModelInfo> {
        vec![info()]
    }
    fn bind(&self, model: &str) -> Result<Arc<dyn ModelAccess>> {
        ensure!(model == "conformance/echo", "unknown conformance model");
        Ok(Arc::new(Self))
    }
}
fn echo(request: &ModelRequest) -> Result<ModelResponse> {
    let Some(user) = request.messages.iter().rposition(|m| m.role == "user") else {
        return Ok(ModelResponse::text("echo: "));
    };
    let text = request.messages[user].text_content();
    let failed = |message: &str| {
        wire::parse_response(json!({"role":"assistant","stop":"failed","content":[],
            "error":{"kind":"other","message":message}}))
    };
    if let Some(reason) = text.strip_prefix("fail:") {
        return failed(reason);
    }
    let Some(tool) = text.strip_prefix("tool:") else {
        return Ok(ModelResponse::text(&format!("echo: {text}")));
    };
    let directive = tool.split_once(' ').and_then(|(name, args)| {
        let input: Value = serde_json::from_str(args).ok()?;
        (input.is_object() && !name.is_empty() && request.tools.iter().any(|t| t.name == name))
            .then_some((name, input))
    });
    let Some((name, input)) = directive else {
        return failed("Invalid tool directive");
    };
    if let Some(result) = request.messages[user + 1..]
        .iter()
        .find(|m| m.role == "tool")
    {
        let text: String = result.text_content().chars().take(200).collect();
        return Ok(ModelResponse::text(&format!("done: {text}")));
    }
    Ok(ModelResponse::calls(vec![ToolCall::new(name, input)]))
}

#[async_trait]
impl ModelAccess for Echo {
    fn info(&self) -> ModelInfo {
        info()
    }
    async fn generate(
        &self,
        api: Api,
        scope: Scope,
        request: ModelRequest,
        cancel: CancellationToken,
    ) -> std::result::Result<ModelResponse, ModelFailure> {
        let result = async {
            ensure!(!cancel.is_cancelled(), "cancelled");
            let mut response = echo(&request)?;
            // The conformance model meters zero tokens.
            response.usage_reported = true;
            let text = response.text_content();
            if !text.is_empty() && !cancel.is_cancelled() {
                let stream = wire::stream_id();
                let mut piece = Event::new(&scope, "model.delta", json!(text));
                piece.stream = Some(stream.clone());
                api.emit(piece).await?;
                let mut end = Event::new(&scope, "model.end", Value::Null);
                end.stream = Some(stream);
                end.end = true;
                api.emit(end).await?;
            }
            Ok::<_, anyhow::Error>(response)
        }
        .await;
        result.map_err(|e| ModelFailure {
            kind: if cancel.is_cancelled() {
                FailureKind::Cancelled
            } else {
                FailureKind::Other
            },
            message: e.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_is_credential_free_and_has_zero_usage() {
        let provider = Echo;
        assert_eq!(provider.catalog()[0].name, "conformance/echo");
        assert!(!provider.catalog()[0].keeps_state);
        assert!(provider.bind("gpt-6-luna").is_err());
        assert_eq!(ModelResponse::text("echo: hello").usage.output_tokens, 0);
    }
}
