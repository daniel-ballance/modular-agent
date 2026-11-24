use super::*;
use sdk::{Gate, OutputDecision, ToolChange};
async fn choice(api: base::Api, scope: base::Scope) -> Result<()> {
    let mut q = base::Question::new(
        scope.clone(),
        base::RequestKind::Choice,
        "Choose yes or no.",
    );
    q.options = vec!["yes".into(), "no".into()];
    q.timeout_ms = Some(5000);
    q.extra = json!({"whenTimeLimit":"decline"});
    base::requests(api.as_ref())?
        .ask(api.clone(), q, api.cancellation(&scope.session)?)
        .await?;
    Ok(())
}
fn replace(v: &mut Value, from: &str, to: &str) -> bool {
    match v {
        Value::String(s) if s.contains(from) => {
            *s = s.replace(from, to);
            true
        }
        Value::Array(a) => {
            let mut changed = false;
            for v in a {
                changed |= replace(v, from, to);
            }
            changed
        }
        Value::Object(m) => {
            let mut changed = false;
            for v in m.values_mut() {
                changed |= replace(v, from, to);
            }
            changed
        }
        _ => false,
    }
}
pub fn install(b: sdk::AgentBuilder, k: &Arc<Kit>) -> sdk::AgentBuilder {
    let state = k.clone();
    let start = Plugin::new("kit.start").on_turn_start(move |input| {
        let k = state.clone();
        async move {
            let api = k.api()?;
            let mut scope = base::Scope::session(&input.session_id);
            scope.turn = Some(input.turn_id);
            scope.actor = input.context.actor_id;
            if k.name == "questions" {
                choice(api.clone(), scope.clone()).await?;
            }
            if k.name == "crash-continuation"
                && !k.restarted
                && api.snapshot(&scope.session)?.entries.iter().any(|e| {
                    e.kind == "turn.start"
                        && e.scope.turn == scope.turn
                        && e.content
                            .as_ref()
                            .is_some_and(|v| v["continuesTurnId"].is_string())
                })
            {
                k.latch(&scope.session, "duringContinuation");
                std::future::pending::<()>().await;
            }
            Ok(())
        }
    });
    let state = k.clone();
    let transform = Plugin::new("kit.transform")
        .on_tool_before(move |tool| {
            let k = state.clone();
            async move {
                if k.name == "crash-before-handoff" && !k.restarted {
                    k.latch(&tool.session_id, "beforeHandoff");
                    std::future::pending::<()>().await;
                }
                Ok(if tool.input["color"] == "draft-blue" {
                    Gate::Change(json!({"color":"dispatch-blue"}))
                } else {
                    Gate::Allow
                })
            }
        })
        .on_tool_after(|tool| async move {
            Ok(if tool.result.status == sdk::ToolStatus::Completed {
                ToolChange {
                    value: None,
                    content: Some(json!([{"type":"text","text":"Checked frontend result."}])),
                }
            } else {
                ToolChange::default()
            })
        });
    let state = k.clone();
    let gate = Plugin::new("kit.gate").on_output(move |out| {
        let k = state.clone();
        async move {
            let mut v = out.value;
            if k.name == "release-gate"
                && v["type"] == "MESSAGES_SNAPSHOT"
                && k.file(&out.session_id)
                    .is_ok_and(|s| s.entries.iter().any(|e| e.kind == "turn.end"))
            {
                k.latch(&out.session_id, "beforeRelease");
                k.barrier(&out.session_id, "released").await;
            }
            if k.name == "error-gate"
                && (v["binding"] == "modular-agent-agui/1"
                    || v.to_string().contains("provider-diagnostic-sentinel"))
            {
                return Ok(OutputDecision::Block);
            }
            if k.name.starts_with("waiting-")
                && out.recipient == *k.redacted_client.lock().unwrap()
                && v["question"]["kind"] == "approval"
            {
                return Ok(OutputDecision::Block);
            }
            if k.name == "approval-redacted"
                && v["question"]["kind"] == "approval"
                && replace(&mut v, "dispatch-blue", "[redacted]")
            {
                return Ok(OutputDecision::Redact(v));
            }
            if k.name == "state-and-gate"
                && matches!(out.recipient.as_str(), "sibling" | "kit-primary")
            {
                if (out.recipient == "sibling" && v["waiting"].is_object())
                    || v.to_string().contains("withheld-extension-sentinel")
                    || v["type"] == "STATE_DELTA" && v["delta"][0]["value"] == 3
                {
                    return Ok(OutputDecision::Block);
                }
                if v["type"] == "STATE_SNAPSHOT" && v["snapshot"]["counter"] == 0 {
                    if k.latches
                        .lock()
                        .unwrap()
                        .contains(&(out.session_id.clone(), "initialState".into()))
                    {
                        return Ok(OutputDecision::Block);
                    }
                    k.latch(&out.session_id, "initialState");
                }
                if replace(&mut v, "kit-hidden-output-sentinel", "Gated text.") {
                    return Ok(OutputDecision::Redact(v));
                }
            }
            if k.name == "output-size" {
                if v["name"] == "modular-agent.event" && v["value"]["type"] == "kit.oversized" {
                    v["value"]["data"] = json!("x".repeat(64 * 1024 * 1024));
                    return Ok(OutputDecision::Redact(v));
                }
                if out.recipient == "sibling" && v["waiting"].is_object() {
                    v["messages"][0]["content"] = json!("x".repeat(64 * 1024 * 1024));
                    return Ok(OutputDecision::Redact(v));
                }
            }
            Ok(OutputDecision::Allow)
        }
    });
    let state = k.clone();
    let plugin=Plugin::new("kit.state").on_step_before(move|hook|{let k=state.clone();async move{
        if k.name=="output-size"{hook.context.emit("kit.oversized",json!("data")).await?;}
        if k.name=="state-and-gate" {k.barrier(&hook.session_id,"initialState").await;let c=hook.context;
            for (base,n) in [(0,1),(0,2),(1,3),(4,5)]{if n==5{c.emit("modular-agent.agui.stateSnapshot",json!({"revisionId":"4","snapshot":{"counter":4}})).await?;} c.emit("modular-agent.agui.stateDelta",json!({"baseRevisionId":base.to_string(),"revisionId":n.to_string(),"delta":[{"op":"replace","path":"/counter","value":n}]})).await?;}
            c.emit("kit.visible",json!("visible")).await?;c.emit("kit.hidden",json!("withheld-extension-sentinel")).await?;c.emit("kit.raw",json!({"type":"fixture.foreign"})).await?;
            let api=k.api()?;let mut scope=base::Scope::session(&hook.session_id);scope.turn=Some(hook.turn_id);scope.step=Some(hook.step_id);api.append(&scope,"kit.state",base::Draft::new("runtime.private",true,json!({"kind":"kit.visibleEntry","data":{"text":"visible entry"}})))?;
        }Ok(None)
    }});
    let state = k.clone();
    let mixed = Plugin::new("kit.mixed").on_turn_end(move |end| {
        let k = state.clone();
        async move {
            if k.name == "mixed" && !end.result.open_tool_calls.is_empty() {
                let api = k.api()?;
                let mut scope = base::Scope::session(&end.session_id);
                scope.turn = Some(end.turn_id);
                choice(api.clone(), scope).await?;
            }
            Ok(())
        }
    });
    let state = k.clone();
    let other = Plugin::new("kit.other").on_step_before(move |hook| {
        let k = state.clone();
        async move {
            if k.name == "state-and-gate" {
                hook.context
                    .emit(
                        "modular-agent.agui.stateSnapshot",
                        json!({"revisionId":"bad","snapshot":"wrong-plugin-sentinel"}),
                    )
                    .await?;
            }
            Ok(None)
        }
    });
    b.plugin(start)
        .plugin(transform)
        .plugin(plugin)
        .plugin(other)
        .plugin(mixed)
        .plugin(gate)
}
