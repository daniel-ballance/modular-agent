//! The examples in docs/sdk/guides, run as tests. Each test names its guide section.
//! When an example cannot be written as the guide shows it, the guide or the SDK changes.
use futures_util::StreamExt;
use modular_agent::{Event, Tool, ToolContext, ToolStatus, testing::test_agent};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;

/// 01-first-agent.md, "Test it".
#[tokio::test]
async fn says_hello() -> modular_agent::Result<()> {
    let agent = test_agent()
        .script(json!([{ "text": "Hello." }]))
        .build()
        .await?;
    let turn = agent.session().await?.prompt("Say hello.").await?;
    assert_eq!(turn.text, "Hello.");
    Ok(())
}

/// 01-first-agent.md, "Stream the answer", with the scripted model.
#[tokio::test]
async fn streams_the_answer() -> modular_agent::Result<()> {
    let agent = test_agent()
        .script(json!([{ "text": "Whitby has two piers." }]))
        .build()
        .await?;
    let session = agent.session().await?;
    let mut text = String::new();
    let mut ended = false;
    let mut events = session
        .prompt_stream("Describe Whitby harbour in two sentences.")
        .await?;
    while let Some(event) = events.next().await {
        match event? {
            Event::Text { delta, .. } => text.push_str(&delta),
            Event::TurnEnded { .. } => ended = true,
            _ => (),
        }
    }
    assert_eq!(text, "Whitby has two piers.");
    assert!(ended, "the stream ends with turnEnded");
    Ok(())
}

// 02-add-a-tool.md, "Write the tool".
#[derive(Deserialize, JsonSchema)]
struct TideInput {
    /// The harbour to look up.
    harbour: String,
}

pub fn tide() -> Tool {
    Tool::new("tide", "Today's high tide at a harbour.")
        .read_only()
        .run(|input: TideInput, _cx: ToolContext| async move {
            Ok(format!("High tide at {} is 14:02.", input.harbour))
        })
}

/// 02-add-a-tool.md, "Test it".
#[tokio::test]
async fn looks_up_the_tide() -> modular_agent::Result<()> {
    let agent = test_agent()
        .tool(tide())
        .script(json!([
            { "toolCalls": [{ "name": "tide", "input": { "harbour": "Whitby" } }] },
            { "text": "High tide is at 14:02." }
        ]))
        .build()
        .await?;
    let turn = agent
        .session()
        .await?
        .prompt("When is high tide at Whitby?")
        .await?;
    assert_eq!(turn.text, "High tide is at 14:02.");
    let results = turn.tool_results();
    assert_eq!(results[0].status, ToolStatus::Completed);
    assert_eq!(results[0].text(), "High tide at Whitby is 14:02.");
    Ok(())
}

/// 02-add-a-tool.md: the definition the model sees is shared data's, with `parameters`
/// from the input type and every hint exactly as set.
#[test]
fn the_definition_is_the_shared_shape() {
    let d = tide().definition();
    assert_eq!(d["name"], "tide");
    assert_eq!(d["parameters"]["type"], "object");
    assert_eq!(d["parameters"]["properties"]["harbour"]["type"], "string");
    assert_eq!(
        d["parameters"]["properties"]["harbour"]["description"],
        "The harbour to look up."
    );
    assert_eq!(d["hints"]["readOnly"], true);
    assert_eq!(
        d["hints"]["destructive"], true,
        "read_only sets only readOnly"
    );
}
