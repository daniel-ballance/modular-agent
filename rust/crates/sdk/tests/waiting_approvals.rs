use modular_agent::{Answer, Approval, Durability, Tool, ToolContext};
use modular_agent::{Code, Result, SessionOptions, testing::test_agent};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

#[tokio::test]
async fn an_allow_delivered_after_turn_end_buys_one_start() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let count = Arc::new(AtomicUsize::new(0));
    let counter = count.clone();
    let agent = test_agent()
        .durability(Durability::Kept)
        .data_dir(dir.path())
        .approval(Approval::All)
        .max_approval_wait_ms(60_000)
        .setting("approvalWait", json!("untilDeadline"))
        .tool(
            Tool::new("bump", "Increment once").run(move |_: Value, _: ToolContext| {
                counter.fetch_add(1, Ordering::SeqCst);
                async { Ok("done") }
            }),
        )
        .script(json!([{"toolCalls":[{"name":"bump","input":{}}]},{"text":"Done."}]))
        .build()
        .await?;
    let session = agent.session().await?;
    let result = session.prompt("bump").await?;
    assert_eq!(result.open_tool_calls.len(), 1, "{result:?}");
    session.wait_idle().await?;
    assert_eq!(count.load(Ordering::SeqCst), 0);
    let id = &session.questions()?[0].id;
    assert!(session.answer(id, Answer::Allow).await.is_err());
    let q = session.questions_present().await?.remove(0);
    assert_eq!(q.id, *id);
    assert_eq!(q.call.unwrap()["name"], "bump");
    session.answer(id, Answer::Allow).await?;
    session.wait_idle().await?;
    let history = session.history().await?;
    let kinds = history
        .iter()
        .map(|v| (&v["kind"], &v["data"]["status"]))
        .collect::<Vec<_>>();
    assert_eq!(count.load(Ordering::SeqCst), 1, "{kinds:?}");
    for kind in [
        "toolStarted",
        "inputAccepted",
        "input",
        "toolResult",
        "inputAnswer",
    ] {
        assert_eq!(
            history.iter().filter(|v| v["kind"] == kind).count(),
            1,
            "{kind}"
        );
    }
    assert!(session.answer(id, Answer::Allow).await.is_err());
    agent.close().await
}

#[tokio::test]
async fn waiting_requires_operator_support() -> Result<()> {
    let agent = test_agent().build().await?;
    let mut options = SessionOptions::default();
    options
        .settings
        .insert("approvalWait".into(), json!("untilDeadline"));
    assert_eq!(
        agent
            .session_with(options)
            .await
            .err()
            .expect("unsupported wait")
            .code(),
        Code::NotSupported
    );
    agent.close().await
}
