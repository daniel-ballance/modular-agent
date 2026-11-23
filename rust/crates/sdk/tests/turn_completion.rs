use futures_util::{StreamExt, pin_mut, poll};
use modular_agent::{
    Durability, OutputDecision, Plugin, Result, file_history, testing::test_agent,
};
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tokio::sync::Notify;

// Keep the Runtime inside its final event after it commits the turnEnd entry.
// The entry is durable, but its presence does not mean the Harness is idle.
#[tokio::test]
async fn prompt_waits_for_the_harness_after_turn_end_is_committed() -> Result<()> {
    let reached = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let gate = Plugin::new("hold-runtime-end").on_output({
        let (reached, release) = (reached.clone(), release.clone());
        move |output| {
            let (reached, release) = (reached.clone(), release.clone());
            async move {
                if output.value["kind"] == "turn.end" {
                    reached.notify_one();
                    release.notified().await;
                }
                Ok(OutputDecision::Allow)
            }
        }
    });
    let agent = test_agent()
        .script(json!([{"text":"done"}]))
        .plugin(gate)
        .build()
        .await?;
    let session = agent.session().await?;
    let prompt = session.prompt("finish");
    pin_mut!(prompt);
    assert!(poll!(&mut prompt).is_pending());
    tokio::time::timeout(Duration::from_secs(10), reached.notified())
        .await
        .expect("Runtime did not reach the turn.end gate");
    assert!(session.is_running());
    assert!(
        poll!(&mut prompt).is_pending(),
        "prompt returned during a turn"
    );
    release.notify_one();
    assert_eq!(prompt.await?.text, "done");
    let fork = session.fork()?;
    session.set_setting("maxSteps", json!(3))?;
    fork.close().await?;
    session.close().await?;
    agent.close().await
}

#[tokio::test]
async fn stream_end_allows_immediate_erasure() -> Result<()> {
    let reached = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let gate = Plugin::new("hold-final-output").on_output({
        let (reached, release) = (reached.clone(), release.clone());
        move |output| {
            let (reached, release) = (reached.clone(), release.clone());
            async move {
                if output.recipient == "interface" && output.value["outcome"].is_string() {
                    reached.notify_one();
                    release.notified().await;
                }
                Ok(OutputDecision::Allow)
            }
        }
    });
    let dir = tempfile::tempdir()?;
    let agent = test_agent()
        .project(dir.path())
        .data_dir(dir.path().join("agent"))
        .durability(Durability::Kept)
        .history(file_history(dir.path().join("history"))?)
        .script(json!([{"text":"done"}]))
        .plugin(gate)
        .build()
        .await?;
    let session = agent.session().await?;
    let mut stream = session.prompt_stream("erase this").await?;
    tokio::time::timeout(Duration::from_secs(10), reached.notified())
        .await
        .expect("Harness did not reach the final output gate");
    // Drain every event available while the final output gate is still held.
    while let std::task::Poll::Ready(Some(event)) = poll!(stream.next()) {
        assert_ne!(event?.event_type, "turnEnded");
    }
    release.notify_one();
    while let Some(event) = stream.next().await {
        if event?.event_type == "turnEnded" {
            let history = session.history().await?;
            let input = history
                .iter()
                .find(|e| e["kind"] == "inputAccepted")
                .unwrap();
            session
                .erase(vec![input["id"].as_str().unwrap().into()])
                .await?;
            assert!(stream.next().await.is_none());
            return agent.close().await;
        }
    }
    panic!("stream ended without turnEnded")
}
