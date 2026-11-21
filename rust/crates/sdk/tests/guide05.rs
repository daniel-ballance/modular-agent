use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use modular_agent::{
    Durability, Outcome, Result, Timing, Tool, ToolStatus,
    testing::{restart, test_agent},
};
use serde_json::{Value, json};
use tokio::sync::Notify;

#[tokio::test]
async fn reopens_an_interrupted_session() -> Result<()> {
    for (durability, expected) in [
        (Durability::Kept, "failed"),
        (Durability::Durable, "completed"),
    ] {
        let data_dir = tempfile::tempdir()?;
        let started = Arc::new(Notify::new());
        let starts = Arc::new(AtomicUsize::new(0));
        let lookup = Tool::new("lookup_tide", "Read the tide time.")
            .read_only()
            .safe_to_repeat()
            .run({
                let (started, starts) = (started.clone(), starts.clone());
                move |_: Value, _| {
                    let (started, starts) = (started.clone(), starts.clone());
                    async move {
                        if starts.fetch_add(1, Ordering::Relaxed) == 0 {
                            started.notify_one();
                            std::future::pending::<()>().await;
                        }
                        Ok("14:02")
                    }
                }
            });
        let agent = test_agent()
            .data_dir(data_dir.path())
            .durability(durability)
            .tool(lookup)
            .script(json!([
                { "toolCalls": [{ "name": "lookup_tide", "input": {} }] },
                { "text": "The tide time could not be confirmed." }
            ]))
            .build()
            .await?;
        let session = agent.session().await?;
        let id = session.id().to_owned();
        session.send("Find the tide time.", Timing::Now).await?;
        tokio::time::timeout(Duration::from_secs(5), started.notified())
            .await
            .expect("the tool must start before the crash");

        let agent = restart(agent).await?;
        let reopened = agent.open_session(&id).await?;
        let turn = reopened
            .last_turn()
            .await?
            .expect("recovery settled the turn");
        assert_eq!(turn.outcome.as_ref().map(Outcome::kind), Some(expected));
        assert_eq!(turn.tool_results()[0].status, ToolStatus::OutcomeUnknown);
        assert_eq!(starts.load(Ordering::Relaxed), 1);
        agent.close().await?;
    }
    Ok(())
}
