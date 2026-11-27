use futures_util::StreamExt;
use modular_agent::{
    Event, Outcome, Plugin, Result, Tool, ToolContext, ToolStatus, testing::test_agent,
};
use serde_json::{Value, json};

#[tokio::test]
async fn typed_hooks_and_events_project_the_checked_shared_shapes() -> Result<()> {
    for served in [false, true] {
        let (send, mut hook) = tokio::sync::mpsc::unbounded_channel();
        let plugin = Plugin::new("typed-hooks").on_step_before(move |step| {
            let send = send.clone();
            async move {
                assert_eq!(step.model.model.provider, "scripted");
                assert_eq!(step.context.step_id.as_deref(), Some(step.step_id.as_str()));
                let history = step.context.history(None).await?;
                assert!(
                    history
                        .entries
                        .iter()
                        .any(|entry| entry["kind"] == "turnStart")
                );
                assert_eq!(step.history.is_none(), served);
                if let Some(history) = step.history {
                    assert!(
                        history
                            .iter()
                            .any(|entry| entry.kind.as_deref() == Some("turnStart"))
                    );
                    assert!(step.usage.is_some());
                }
                send.send(step.step_id).unwrap();
                Ok(None)
            }
        });
        let builder = test_agent()
            .tool(
                Tool::new("example", "A test tool").run(|_: Value, cx: ToolContext| async move {
                    assert!(cx.turn_id().is_some());
                    assert!(cx.step_id().is_some());
                    Ok("tool result")
                }),
            )
            .script(json!([
                {"toolCalls":[{"name":"example","input":{}}],"usage":{"input":3,"output":1}},
                {"text":"answer","usage":{"input":4,"output":2}}
            ]));
        let agent = if served {
            builder.over_wire(plugin)
        } else {
            builder.plugin(plugin)
        }
        .build()
        .await?;
        let session = agent.session().await?;
        let mut stream = session.prompt_stream("Run example").await?;
        let mut tool_seen = false;
        let mut turn_seen = false;
        while let Some(event) = stream.next().await {
            match event? {
                Event::ToolCall(event) => assert_eq!(event.data.call.name, "example"),
                Event::ToolResult(event) => {
                    assert_eq!(event.data.status, ToolStatus::Completed);
                    assert_eq!(event.data.content[0]["text"], "tool result");
                    tool_seen = true;
                }
                Event::TurnEnded(event) => {
                    assert_eq!(event.data.outcome, Outcome::Completed);
                    assert_eq!(event.data.usage.as_ref().unwrap().input, 7);
                    assert_eq!(event.data.result.text.as_deref(), Some("answer"));
                    turn_seen = true;
                }
                _ => {}
            }
        }
        assert!(tool_seen && turn_seen);
        assert!(hook.try_recv().is_ok() && hook.try_recv().is_ok());
        agent.close().await?;
    }
    Ok(())
}

#[test]
fn tool_result_uses_the_id_of_its_wire_shape() -> Result<()> {
    let data = json!({"toolCallId":"event-call","content":[],"status":"completed"});
    assert!(serde_json::from_value::<modular_agent::ToolSettlement>(data.clone()).is_err());
    let mut raw = json!({"type":"toolResult","time":0,"sessionId":"s","data":data});
    let event: Event = serde_json::from_value(raw.clone())?;
    assert!(matches!(&event, Event::ToolResult(v) if v.data.call_id == "event-call"));
    assert_eq!(serde_json::to_value(event)?, raw);
    raw["data"] = json!({"callId":"rpc-call","content":[],"status":"completed"});
    assert!(matches!(
        serde_json::from_value::<Event>(raw)?,
        Event::Custom(_)
    ));
    Ok(())
}

#[test]
fn bare_audio_is_not_a_standard_event() -> Result<()> {
    let raw = json!({"type":"audio","time":0,"sessionId":"s","data":{"delta":"sample"}});
    assert!(matches!(
        serde_json::from_value::<Event>(raw)?,
        Event::Custom(_)
    ));
    Ok(())
}

#[test]
fn event_keeps_unknown_wire_data() -> Result<()> {
    let raw = json!({"type":"sessionInterrupted","time":10,"sessionId":"s","data":{"reason":"writerLost","future":17}});
    let event: Event = serde_json::from_value(raw.clone())?;
    assert!(
        matches!(&event, Event::SessionInterrupted(p) if p.data.reason == modular_agent::InterruptionReason::WriterLost)
    );
    assert_eq!(serde_json::to_value(event)?, raw);
    Ok(())
}
