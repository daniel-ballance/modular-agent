use agent_api::*;
use std::sync::Arc;
pub struct BuiltinTools;
impl Plugin for BuiltinTools {
    fn name(&self) -> &str {
        "tools.builtin"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.provide::<dyn ToolSource>("tools.builtin", Arc::new(Self))
    }
}
fn definition(name: &str, description: &str, fields: &[&str], read_only: bool) -> ToolDefinition {
    let properties: serde_json::Map<_, _> = fields
        .iter()
        .map(|f| (f.to_string(), json!({"type":"string"})))
        .collect();
    ToolDefinition {
        name: name.into(),
        description: description.into(),
        input: json!({"type":"object","properties":properties,"required":fields,"additionalProperties":false}),
        read_only,
        safe_to_repeat: read_only,
        parallel: read_only,
        hints: json!({}),
    }
}
#[async_trait]
impl ToolSource for BuiltinTools {
    fn tools(&self, _: &SessionData) -> Vec<ToolDefinition> {
        vec![
            definition(
                "read",
                "Read a UTF-8 file. Relative paths use the session project.",
                &["path"],
                true,
            ),
            definition(
                "write",
                "Write a UTF-8 file, creating parents.",
                &["path", "content"],
                false,
            ),
            definition(
                "edit",
                "Replace exactly one matching text span in a UTF-8 file.",
                &["path", "old", "new"],
                false,
            ),
            definition(
                "bash",
                "Run bash in the session project. Output is streamed. Ordinary background children are cleaned up when the shell exits.",
                &["command"],
                false,
            ),
        ]
    }
    async fn run(
        &self,
        api: Api,
        scope: Scope,
        call: ToolCall,
        cancel: CancellationToken,
    ) -> ToolResult {
        let result: Result<ToolResult> = async {
            if cancel.is_cancelled() {
                return Ok(ToolResult::new(&call, ToolStatus::Cancelled, "cancelled"));
            }
            let data = api.snapshot(&scope.session)?;
            let env: Arc<dyn WorkingEnvironment> = capability(api.as_ref(), "environment")?;
            let env = env
                .scoped(api.clone(), scope.clone(), cancel.clone())
                .unwrap_or(env);
            let definitions = self.tools(&data);
            let def = definitions
                .iter()
                .find(|d| d.name == call.name)
                .ok_or_else(|| anyhow!("unknown tool"))?;
            let object = call
                .input
                .as_object()
                .ok_or_else(|| anyhow!("tool input must be an object"))?;
            let properties = def.input["properties"].as_object().unwrap();
            ensure!(
                object.keys().all(|k| properties.contains_key(k)),
                "unexpected tool input field"
            );
            for required in def.input["required"].as_array().unwrap() {
                ensure!(
                    object
                        .get(required.as_str().unwrap())
                        .is_some_and(Value::is_string),
                    "missing or invalid field {required}"
                );
            }
            let string = |key: &str| call.input[key].as_str().unwrap_or("");
            let text = match call.name.as_str() {
                "read" => env.read(&data.project, string("path")).await?,
                "write" => {
                    env.write(&data.project, string("path"), string("content"))
                        .await?;
                    "written".into()
                }
                "edit" => {
                    env.edit(&data.project, string("path"), string("old"), string("new"))
                        .await?;
                    "edited".into()
                }
                "bash" => {
                    return env
                        .bash(api, scope, data.project, string("command"), cancel)
                        .await;
                }
                _ => bail!("unknown tool"),
            };
            Ok(ToolResult::new(&call, ToolStatus::Completed, text))
        }
        .await;
        result.unwrap_or_else(|e| {
            ToolResult::new(
                &call,
                if e.downcast_ref::<LostPart>().is_some() {
                    ToolStatus::Unknown
                } else {
                    ToolStatus::Failed
                },
                e.to_string(),
            )
        })
    }
}
