use super::*;
use modular_agent::{AgentBuilder, Approval, Durability, Gate, OutputDecision, Tool};

async fn approval_views(builder: AgentBuilder) -> anyhow::Result<(Value, Value)> {
    let dir = tempfile::tempdir()?;
    let agent = builder
        .project(dir.path())
        .data_dir(dir.path().join("data"))
        .durability(Durability::Kept)
        .approval(Approval::All)
        .tool(Tool::new("codemode", "Run a script").run(|_: Value, _| async { Ok("Done") }))
        .provider(scripted_provider(json!([
            {"toolCalls":[{"name":"codemode","input":{"code":"print('model draft')"}}]},
            {"text":"Finished."}
        ])))
        .build()
        .await?;
    let server = serve(&agent, dir.path()).await?;
    let id = thread(&server).await?;
    let client = reqwest::Client::new();
    let get = |suffix: &str| {
        client
            .get(url(&server, &format!("/threads/{id}{suffix}")))
            .bearer_auth(TOKEN)
    };
    let presence = get("/presence").send().await?.error_for_status()?;
    let frames = exchange(&server, input(&id, "script", json!("Run the script"))).await?;
    let terminal = frames.last().unwrap();
    assert_eq!(terminal["type"], "RUN_FINISHED");
    let snapshot: Value = get("").send().await?.error_for_status()?.json().await?;
    drop(presence);
    server.close().await;
    agent.close().await?;
    Ok((
        terminal["outcome"].clone(),
        snapshot["waiting"]["questions"].clone(),
    ))
}

fn waiting() -> AgentBuilder {
    Agent::builder()
        .max_approval_wait_ms(60_000)
        .setting("approvalWait", json!("untilDeadline"))
}

#[tokio::test]
async fn approval_interrupt_and_snapshot_show_the_call_after_tool_before() -> anyhow::Result<()> {
    const CODE: &str = "note = tools.read(path='note.txt')\nprint(note)\n";
    for (builder, covered) in [
        (Agent::builder(), false),
        (Agent::builder().approval_covers_nested(true), true),
        (waiting(), false),
    ] {
        let gate = Plugin::new("prepare-script")
            .on_tool_before(|_| async { Ok(Gate::Change(json!({"code":CODE}))) });
        let (outcome, questions) = approval_views(builder.plugin(gate)).await?;
        assert_eq!(outcome["type"], "interrupt");
        let q = &outcome["interrupts"][0];
        assert_eq!(q["reason"], "approval");
        assert!(q["message"].as_str().unwrap().contains("note.txt"));
        assert_eq!(
            q["metadata"]["modular-agent.approvalCall"],
            json!({"name":"codemode","input":{"code":CODE}})
        );
        assert_eq!(
            q["metadata"].get("modular-agent.coversNested"),
            covered.then_some(json!(true)).as_ref()
        );
        assert_eq!(questions, json!([q]));
    }
    Ok(())
}

#[tokio::test]
async fn redacted_or_blocked_approval_offers_no_interrupt_on_either_surface() -> anyhow::Result<()>
{
    for redact in [true, false] {
        let gate = Plugin::new("hide-call").on_output(move |mut view| async move {
            if view.recipient != "test-client" || view.value["question"]["kind"] != "approval" {
                return Ok(OutputDecision::Allow);
            }
            Ok(if redact {
                view.value["question"]["call"]["input"]["code"] = json!("[redacted]");
                OutputDecision::Redact(view.value)
            } else {
                OutputDecision::Block
            })
        });
        let (outcome, questions) = approval_views(waiting().plugin(gate)).await?;
        assert_eq!(outcome, json!({"type":"success"}));
        assert_eq!(questions, json!([]));
    }
    Ok(())
}
