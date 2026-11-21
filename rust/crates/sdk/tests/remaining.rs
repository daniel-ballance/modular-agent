use modular_agent::{
    Agent, Code, Command, Disposition, InputChange, OutputDecision, Plugin, Result,
    testing::test_agent,
};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

#[tokio::test]
async fn input_hook_handles_a_key_once_by_running_a_command() -> Result<()> {
    let invocations = Arc::new(AtomicUsize::new(0));
    let hits = invocations.clone();
    let plugin = Plugin::new("shortcuts")
        .command(Command::new("help", "Show help", move |args, _| {
            let hits = hits.clone();
            async move {
                assert_eq!(args, "topics");
                hits.fetch_add(1, Ordering::SeqCst);
                Ok(Some("Help!".into()))
            }
        }))
        .on_input(|_| async { Ok(InputChange::HandleCommand("/help topics".into())) });
    let agent = Agent::builder().plugin(plugin).build().await?;
    let session = agent.session().await?;
    for _ in 0..2 {
        let result = session
            .prompt_with("help me", Some("help-1".into()))
            .await?;
        assert_eq!(result.disposition, Disposition::Handled);
    }
    assert_eq!(invocations.load(Ordering::SeqCst), 1);
    assert!(session.last_turn().await?.is_none());
    agent.close().await
}

#[tokio::test]
async fn last_turn_uses_the_receiving_actors_output_gate() -> Result<()> {
    let gate = Plugin::new("redaction").on_output(|output| async move {
        if output.value["method"] != "lastTurn" {
            return Ok(OutputDecision::Allow);
        }
        if output.recipient == "blocked" {
            return Ok(OutputDecision::Block);
        }
        let mut value = output.value;
        value["result"]["text"] = json!("redacted");
        Ok(OutputDecision::Redact(value))
    });
    let agent = test_agent()
        .script(json!([{"text":"original"}]))
        .several_actors(true)
        .plugin(gate)
        .build()
        .await?;
    let session = agent.session().await?;
    session
        .join(modular_agent::Actor {
            id: "blocked".into(),
            kind: "user".into(),
            rights: modular_agent::Rights::only(&["watch"]),
        })
        .await?;
    let prompt = session.prompt("show me").await?;
    let result = session.last_turn().await?.expect("settled turn");
    assert_eq!(result.input_id, prompt.input_id);
    assert_eq!(result.text, "redacted");
    assert_eq!(
        session
            .r#as("blocked")?
            .last_turn()
            .await
            .unwrap_err()
            .code(),
        Code::Withheld
    );
    agent.close().await
}
