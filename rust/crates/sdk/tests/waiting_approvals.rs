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
async fn policies_and_the_default_live_session_do_not_park_calls() -> Result<()> {
    for (policy, mode, readonly, count) in [
        (Approval::Off, "untilDeadline", false, 1),
        (Approval::Never, "untilDeadline", false, 0),
        (Approval::Ask, "untilDeadline", true, 1),
        (Approval::All, "live", false, 0),
    ] {
        let dir = tempfile::tempdir()?;
        let effect = dir.path().join("bumped");
        let path = effect.clone();
        let mut tool = Tool::new("bump", "Bump");
        if readonly {
            tool = tool.read_only();
        }
        let agent = test_agent()
            .data_dir(dir.path())
            .durability(Durability::Kept)
            .approval(policy)
            .max_approval_wait_ms(1000)
            .tool(tool.run(move |_: Value, _| {
                let path = path.clone();
                async move {
                    std::fs::write(path, "1")?;
                    Ok("done")
                }
            }))
            .script(json!([{"toolCalls":[{"name":"bump","input":{}}]},{"text":"Done"}]))
            .build()
            .await?;
        let session = agent.session().await?;
        assert_eq!(session.settings()?["approvalWait"], "live");
        if mode != "live" {
            session.set_setting("approvalWait", json!(mode))?;
        }
        assert!(session.prompt("Bump").await?.open_tool_calls.is_empty());
        assert_eq!(usize::from(effect.exists()), count);
        assert!(!session.history().await?.iter().any(
            |e| e["kind"] == "toolPending" || e["data"]["request"]["approvalWait"].is_string()
        ));
        agent.close().await?;
    }
    for (ms, policy, persistent) in [
        (0, true, true),
        (9_007_199_254_740_992, true, true),
        (50, false, true),
        (50, true, false),
    ] {
        let dir = tempfile::tempdir()?;
        let mut builder = test_agent().max_approval_wait_ms(ms);
        if policy {
            builder = builder.approval(Approval::All)
        }
        if persistent {
            builder = builder.data_dir(dir.path()).durability(Durability::Kept);
        }
        assert_eq!(
            builder.build().await.err().unwrap().code(),
            Code::InvalidComposition
        );
    }
    Ok(())
}

#[tokio::test]
async fn closing_preserves_the_wait_but_erasure_ends_it() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let agent = test_agent()
        .data_dir(dir.path())
        .durability(Durability::Kept)
        .approval(Approval::All)
        .max_approval_wait_ms(60_000)
        .setting("approvalWait", json!("untilDeadline"))
        .tool(Tool::new("bump", "Bump").run(|_: Value, _| async { Ok("unexpected effect") }))
        .script(json!([{"toolCalls":[{"name":"bump","input":{}}]},{"text":"Done"}]))
        .build()
        .await?;
    let session = agent.session().await?;
    session.prompt("Bump").await?;
    let req = session
        .history()
        .await?
        .into_iter()
        .find(|e| e["kind"] == "inputRequest")
        .unwrap();
    let id = session.questions_present().await?.remove(0).id;
    assert!(session.fork().is_err());
    assert!(
        session
            .fork_with(Some(req["sources"][0].as_str().unwrap()))
            .is_err()
    );
    assert!(session.move_to(req["id"].as_str().unwrap()).await.is_err());
    let sid = session.id().to_owned();
    session.close().await?;
    let reopened = agent.open_session(&sid).await?;
    reopened.wait_idle().await?;
    assert!(reopened.answer(&id, Answer::Allow).await.is_err());
    assert_eq!(reopened.questions_present().await?.len(), 1);
    reopened
        .erase(vec![req["id"].as_str().unwrap().into()])
        .await?;
    assert!(reopened.questions_present().await?.is_empty());
    assert!(reopened.answer(&id, Answer::Allow).await.is_err());
    let rows = reopened.history().await?;
    assert!(!rows.iter().any(|e| e["kind"] == "toolStarted"));
    assert!(
        rows.iter()
            .any(|e| e["kind"] == "toolResult" && e["toolCallId"] == req["toolCallId"])
    );
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
