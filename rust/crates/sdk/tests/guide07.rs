use std::time::Duration;

use modular_agent::{
    Gate, Order, Outcome, Plugin, Result, Tool, ToolChange, ToolStatus, TurnAddition,
    testing::test_agent,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc;

#[derive(Deserialize, JsonSchema)]
struct Harbour {
    harbour: String,
}

fn tide_preview(ended: mpsc::UnboundedSender<String>) -> Plugin {
    Plugin::new("tide-preview")
        .on_turn_before(|_| async {
            Ok(TurnAddition {
                system: Some("Give the local time.".into()),
                ..Default::default()
            })
        })
        .on_turn_before_with(Order::Last, |_| async {
            Ok(TurnAddition {
                system: Some("Keep the report short.".into()),
                ..Default::default()
            })
        })
        .on_turn_before_with(Order::First, |_| async {
            Ok(TurnAddition {
                system: Some("Report high tides.".into()),
                ..Default::default()
            })
        })
        .on_tool_before(|call| async move {
            if call.name != "preview_tide" {
                return Ok(Gate::Allow);
            }
            Ok(match call.input["harbour"].as_str() {
                Some("closed") => Gate::Refuse("That station is closed.".into()),
                Some("old-town") => Gate::Change(json!({"harbour": "Whitby"})),
                _ => Gate::Allow,
            })
        })
        .on_tool_after(|call| async move {
            if call.call.name == "preview_tide" && call.result.status == ToolStatus::Completed {
                let text = call.result.content[0]["text"].as_str().unwrap_or_default();
                return Ok(ToolChange {
                    content: Some(json!([{"type": "text", "text": format!("Preview: {text}")}])),
                    ..Default::default()
                });
            }
            Ok(ToolChange::default())
        })
        .on_step_after(|_| async { Ok(Gate::Refuse("Preview stops after one step.".into())) })
        .on_turn_end(move |turn| {
            let ended = ended.clone();
            async move {
                let _ = ended.send(turn.outcome.kind().into());
                Ok(())
            }
        })
}

#[tokio::test]
async fn previews_tides_in_process_and_served() -> Result<()> {
    for served in [false, true] {
        let (ended, mut observed) = mpsc::unbounded_channel();
        let plugin = tide_preview(ended);
        let builder = test_agent()
            .tool(
                Tool::new("preview_tide", "Find a high tide.")
                    .read_only()
                    .run(
                        |input: Harbour, _| async move { Ok(format!("{}: 14:02", input.harbour)) },
                    ),
            )
            .script(json!([
                {"toolCalls": [
                    {"name": "preview_tide", "input": {"harbour": "old-town"}},
                    {"name": "preview_tide", "input": {"harbour": "closed"}}
                ]},
                {"text": "This step must not run."}
            ]));
        let agent = if served {
            builder.over_wire(plugin)
        } else {
            builder.plugin(plugin)
        }
        .build()
        .await?;
        let session = agent.session().await?;
        let turn = session.prompt("Preview the high tides.").await?;
        let results = turn.tool_results();
        assert_eq!(results[0].status, ToolStatus::Completed);
        assert_eq!(results[0].text(), "Preview: Whitby: 14:02");
        assert_eq!(results[1].status, ToolStatus::Refused);
        assert!(results[1].text().contains("That station is closed."));
        assert!(
            matches!(&turn.outcome, Some(Outcome::Failed { error })
            if error.contains("Preview stops after one step.")),
            "served={served}: {:?}",
            turn.outcome
        );
        assert!(turn.text.is_empty());
        let history = session.history().await?;
        let start = history
            .iter()
            .find(|entry| entry["kind"] == "turnStart")
            .unwrap();
        let expected = [
            "Report high tides.",
            "Give the local time.",
            "Keep the report short.",
        ];
        let lines: Vec<_> = start["data"]["system"]
            .as_str()
            .unwrap()
            .lines()
            .filter(|line| expected.contains(line))
            .collect();
        assert_eq!(lines, expected);
        let kind = tokio::time::timeout(Duration::from_secs(5), observed.recv())
            .await
            .unwrap();
        assert_eq!(kind.as_deref(), Some("failed"));
        agent.close().await?;
    }
    Ok(())
}
