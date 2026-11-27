use modular_agent::ToolResult;
use serde_json::Value;

pub(super) fn tool_content(w: &Value, g: &ToolResult, mut fail: impl FnMut(String)) {
    if let Some(content) = w.get("content")
        && content.as_array() != Some(&g.content)
    {
        fail(format!(
            "toolResult content: want {content}, got {:?}",
            g.content
        ));
    }
    let actual = g.text();
    if let Some(text) = w["text"].as_str()
        && actual != text
    {
        fail(format!("toolResult text: want {text:?}, got {actual:?}"));
    }
    if let Some(part) = w["contains"].as_str()
        && !actual.contains(part)
    {
        fail(format!(
            "toolResult text: want substring {part:?}, got {actual:?}"
        ));
    }
}
