use futures_util::StreamExt;
use modular_agent::{
    Code, Durability, Gate, Outcome, Plugin, PromptOptions, Result, Tool, ToolChange, ToolOutput,
    ToolStatus,
    testing::{restart, test_agent},
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

#[tokio::test]
async fn validates_tool_input_before_running_in_both_placements() -> Result<()> {
    for over_wire in [false, true] {
        let effects = Arc::new(AtomicUsize::new(0));
        let count = effects.clone();
        let tool = Tool::new("validate", "Validate the input")
            .input_schema(json!({"type":"object","required":["n"],"properties":{"n":{"$ref":"#/$defs/n"}},"$defs":{"n":{"minimum":10}}}))
            .run(move |_: Value, _| {
                count.fetch_add(1, Ordering::Relaxed);
                async { Ok("ran") }
            });
        let plugin = Plugin::new("validation").tool(tool);
        let builder = test_agent().script(json!([
            {"toolCalls":[{"name":"validate","input":{"n":2}},{"name":"validate","input":{"n":12}}]},
            {"text":"done"}
        ]));
        let agent = if over_wire {
            builder.over_wire(plugin)
        } else {
            builder.plugin(plugin)
        }
        .build()
        .await?;
        let result = agent.session().await?.prompt("validate").await?;
        assert_eq!(result.tool_results()[0].status, ToolStatus::Failed);
        assert!(result.tool_results()[0].text().contains("/n"));
        assert_eq!(result.tool_results()[1].status, ToolStatus::Completed);
        assert_eq!(effects.load(Ordering::Relaxed), 1);
        agent.close().await?;
    }
    Ok(())
}

#[tokio::test]
async fn validates_returns_after_the_tool_after_transform() -> Result<()> {
    for over_wire in [false, true] {
        let tool = Tool::new("number", "Return a number")
            .output::<u32>()
            .run(|_: Value, _| async { ToolOutput::value(12) });
        assert_eq!(tool.definition()["returns"]["type"], "integer");
        let plugin = Plugin::new("number-plugin")
            .tool(tool)
            .on_tool_after(|_| async {
                Ok(ToolChange {
                    content: None,
                    value: Some(json!("invalid")),
                })
            });
        let builder = test_agent().script(json!([{"toolCalls":[{"name":"number","input":{}}]}]));
        let agent = if over_wire {
            builder.over_wire(plugin)
        } else {
            builder.plugin(plugin)
        }
        .build()
        .await?;
        let result = agent.session().await?.prompt("number").await?;
        assert!(
            matches!(&result.outcome, Some(Outcome::Failed { error }) if error.contains("invalid value")),
            "{:?}",
            result.outcome
        );
        assert_eq!(result.tool_results().len(), 1);
        assert_eq!(result.tool_results()[0].status, ToolStatus::Completed);
        assert_eq!(result.tool_results()[0].value, None);
        agent.close().await?;
    }
    Ok(())
}

#[tokio::test]
async fn structured_prompt_retries_schema_and_hook_refusals() -> Result<()> {
    let agent = test_agent()
        .plugin(Plugin::new("result-check").on_turn_result(|p| async move {
            Ok(
                if p.result.value.as_ref().is_some_and(|value| value["n"] == 1) {
                    Gate::Refuse("choose a larger number".into())
                } else {
                    Gate::Allow
                },
            )
        }))
        .script(json!([{"text":"not JSON"},{"text":"{\"n\":1}"},{"text":"{\"n\":2}"}]))
        .build()
        .await?;
    let session = agent.session().await?;
    let result = session
        .prompt_with(
            "return a number",
            PromptOptions {
                result: Some(
                    json!({"type":"object","required":["n"],"properties":{"n":{"type":"integer"}}}),
                ),
                ..Default::default()
            },
        )
        .await?;
    assert_eq!(result.outcome, Some(Outcome::Completed));
    assert_eq!(result.value, Some(json!({"n":2})));
    let rows = session.history().await?;
    assert_eq!(
        rows.iter()
            .filter(|e| e["kind"] == "resultFeedback")
            .count(),
        2
    );
    assert!(
        rows.iter()
            .any(|e| e["kind"] == "turnStart" && e["data"]["resultShape"].is_object())
    );
    agent.close().await
}

#[tokio::test]
async fn structured_null_is_not_a_missing_value() -> Result<()> {
    let agent = test_agent()
        .script(json!([{"text":"null"}]))
        .build()
        .await?;
    let result = agent
        .session()
        .await?
        .prompt_with(
            "null",
            PromptOptions {
                result: Some(json!({"type":"null"})),
                ..Default::default()
            },
        )
        .await?;
    assert_eq!(result.value, Some(Value::Null));
    agent.close().await
}

#[tokio::test]
async fn events_replay_from_last_delivered_entry_after_lag() -> Result<()> {
    let noisy = Tool::new("noisy", "Emit progress").run(|_: Value, cx| async move {
        for _ in 0..4200 {
            cx.progress("progress").await?;
        }
        Ok("done")
    });
    let agent = test_agent().tool(noisy).script(json!([
        {"text":"first"},{"toolCalls":[{"name":"noisy","input":{}}]},{"text":"second"}, {"text":"third"}
    ])).build().await?;
    let session = agent.session().await?;
    session.prompt("first").await?;
    let rows = session.history().await?;
    let after = rows[rows.len() - 2]["id"].as_str().unwrap();
    let cursor = rows.last().unwrap()["id"].as_str().unwrap();
    let mut first = session.events(Some(after))?;
    assert!(
        first
            .next()
            .await
            .transpose()?
            .is_some_and(|e| e.event_type == "entry" && e.data["entry"]["id"] == cursor)
    );
    session.prompt("second").await?;
    let lag = first.next().await.unwrap().unwrap_err();
    assert_eq!(lag.code(), Code::Lost);
    assert_eq!(lag.data().unwrap()["fromEntry"], cursor);
    assert!(first.next().await.is_none());
    let after_lag = session.history().await?;
    let mut again = session.events(Some(cursor))?;
    for want in &after_lag[rows.len()..] {
        assert!(
            again
                .next()
                .await
                .transpose()?
                .is_some_and(|e| e.event_type == "entry" && e.data["entry"] == *want)
        );
    }
    session.prompt("third").await?;
    let live = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while let Some(event) = again.next().await.transpose()? {
            if event.event_type == "text" && event.data["delta"] == "third" {
                return Ok::<_, modular_agent::Error>(true);
            }
        }
        Ok(false)
    })
    .await
    .expect("stream should follow live output")?;
    assert!(live);
    agent.close().await
}

#[tokio::test]
async fn restart_leaves_interrupted_call_unsettled_for_recovery() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let called = Arc::new(tokio::sync::Notify::new());
    let notify = called.clone();
    let held = Tool::new("hold", "Hold the call").run(move |_: Value, _| {
        notify.notify_one();
        std::future::pending::<Result<String>>()
    });
    let agent = test_agent()
        .data_dir(dir.path())
        .durability(Durability::Kept)
        .tool(held)
        .script(json!([{"toolCalls":[{"name":"hold","input":{}}]}]))
        .build()
        .await?;
    let session = agent.session().await?;
    let id = session.id().to_owned();
    session.send("start", modular_agent::Timing::Now).await?;
    tokio::time::timeout(std::time::Duration::from_secs(3), called.notified())
        .await
        .expect("call must start");
    let agent = restart(agent).await?;
    let reopened = agent.open_session(&id).await?;
    let result = reopened
        .last_turn()
        .await?
        .expect("recovery settles the interrupted turn");
    assert!(matches!(result.outcome, Some(Outcome::Failed { .. })));
    assert_eq!(result.tool_results()[0].status, ToolStatus::OutcomeUnknown);
    agent.close().await
}

#[tokio::test]
async fn distinguishes_unknown_sessions_and_another_writer() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let build = || {
        test_agent()
            .data_dir(dir.path())
            .durability(Durability::Kept)
            .build()
    };
    let first = build().await?;
    let second = build().await?;
    let error = |value: Result<modular_agent::Session>| value.err().unwrap().code();
    assert_eq!(error(second.open_session("unknown").await), Code::NotFound);
    let session = first.session().await?;
    assert_eq!(
        error(second.open_session(session.id()).await),
        Code::NotFound
    );
    session.prompt("Keep this session").await?;
    assert_eq!(error(second.open_session(session.id()).await), Code::Busy);
    first.close().await?;
    second.close().await
}
