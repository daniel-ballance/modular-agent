//! Shared JSON Schema checks. External resources are never retrieved.
use crate::{Result, ToolDefinition, ToolResult, ToolStatus, Value, anyhow, wire};

pub fn compile(schema: &Value) -> Result<jsonschema::Validator> {
    jsonschema::draft202012::options()
        .with_retriever(NoExternalResources)
        .build(schema)
        .map_err(|e| anyhow!("invalid Draft 2020-12 schema: {e}"))
}

struct NoExternalResources;
impl jsonschema::Retrieve for NoExternalResources {
    fn retrieve(
        &self,
        _: &jsonschema::Uri<String>,
    ) -> std::result::Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        Err("external schema references are not supported".into())
    }
}

pub fn check(schema: &Value, value: Option<&Value>) -> Result<()> {
    let value = value.ok_or_else(|| anyhow!("a value is required"))?;
    compile(schema)?
        .validate(value)
        .map_err(|e| anyhow!("at {}: {e}", e.instance_path()))
}

/// Check the post-transform result, not the tool's original reply.
pub fn tool_result(definition: &ToolDefinition, result: &ToolResult) -> Result<()> {
    if result.status == ToolStatus::Completed
        && let Some(schema) = definition.hints["_wire"].get("returns")
    {
        check(schema, wire::result(result).get("value"))
            .map_err(|e| anyhow!("tool {} returned an invalid value: {e}", definition.name))?;
    }
    Ok(())
}
