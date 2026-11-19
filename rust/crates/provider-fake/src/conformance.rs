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
#[async_trait]
impl ModelAccess for Echo {
    fn info(&self) -> ModelInfo {
        info()
    }
    async fn generate(
        &self,
        api: Api,
        scope: Scope,
        _request: ModelRequest,
        cancel: CancellationToken,
    ) -> std::result::Result<ModelResponse, ModelFailure> {
        let result = (|| -> Result<ModelResponse> {
            ensure!(!cancel.is_cancelled(), "cancelled");
            let branch = api.snapshot(&scope.session)?.branch();
            let text = branch
                .iter()
                .rev()
                .find(|e| e.kind == "input")
                .and_then(|e| e.content.as_ref())
                .and_then(|c| c["text"].as_str())
                .unwrap_or("");
            if let Some(reason) = text.strip_prefix("fail:") {
                bail!("{reason}");
            }
            if let Some(tool) = text.strip_prefix("tool:") {
                if let Some(result) = branch
                    .iter()
                    .find(|e| e.kind == "tool.result" && e.scope.turn == scope.turn)
                {
                    let text = result
                        .content
                        .as_ref()
                        .and_then(|c| c["text"].as_str())
                        .unwrap_or("");
                    return Ok(ModelResponse::text(&format!(
                        "done: {}",
                        text.chars().take(200).collect::<String>()
                    )));
                }
                let (name, input) = tool
                    .split_once(' ')
                    .ok_or_else(|| anyhow!("expected tool:<name> <json>"))?;
                return Ok(ModelResponse::calls(vec![ToolCall::new(
                    name,
                    serde_json::from_str(input)?,
                )]));
            }
            Ok(ModelResponse::text(&format!("echo: {text}")))
        })();
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
