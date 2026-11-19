use modular_agent::{
    Agent, Answer, Code, Durability, Gate, Plugin, Result, ServeHistoryOptions, file_history,
    memory_history, serve_history,
    testing::{answers, fixtures, scripted_provider, test_agent},
};
use serde_json::json;

#[tokio::test]
async fn persistent_history_and_local_recovery_need_different_storage() -> Result<()> {
    let data = tempfile::tempdir()?;
    for durability in [Durability::Kept, Durability::Durable] {
        let err = test_agent()
            .durability(durability)
            .build()
            .await
            .err()
            .unwrap();
        assert_eq!(err.code(), Code::InvalidComposition);
        assert!(err.message().contains("persistent history"));
        let err = Agent::builder()
            .durability(durability)
            .history(file_history(data.path())?)
            .build()
            .await
            .err()
            .unwrap();
        assert_eq!(err.code(), Code::InvalidComposition);
        assert!(err.message().contains("local working environment"));
    }
    Ok(())
}

#[tokio::test]
async fn store_capabilities_control_erasure_and_service_eligibility() -> Result<()> {
    let data = tempfile::tempdir()?;
    let memory = serve_history(
        memory_history(),
        ServeHistoryOptions::new(
            "127.0.0.1:0".parse().unwrap(),
            data.path().join("not-opened"),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(memory.code(), Code::NotSupported);
    assert!(memory.message().contains("memory"));

    let agent = test_agent()
        .durability(Durability::Kept)
        .data_dir(data.path())
        .script(json!([{"text":"kept"}]))
        .build()
        .await?;
    let decl = agent.declaration()?;
    assert_eq!(decl["erasure"], true);
    assert_eq!(decl["queuedInputAfterRestart"], "handedBack");
    assert_eq!(decl["queuedJobReportsAfterRestart"], "run");
    let session = agent.session().await?;
    session.prompt("Erase my answer").await?;
    let response = session
        .history()?
        .into_iter()
        .find(|e| e["kind"] == "response")
        .unwrap();
    let id = response["id"].as_str().unwrap();
    let report = session.erase(vec![id.into(), id.into()]).await?;
    assert!(report.erased.iter().any(|entry| entry.id == id));
    assert!(
        session
            .history()?
            .iter()
            .any(|e| e["id"] == id && e["message"].is_null())
    );
    agent.close().await
}

#[tokio::test]
async fn unknown_model_is_refused_before_admission() -> Result<()> {
    let agent = Agent::builder()
        .provider(scripted_provider(json!([])))
        .model("scripted/missing")
        .build()
        .await;
    assert_eq!(agent.err().unwrap().code(), Code::InvalidRequest);
    let agent = test_agent().build().await?;
    let session = agent.session().await?;
    assert_eq!(
        session
            .set_setting("model", json!("scripted/missing"))
            .unwrap_err()
            .code(),
        Code::InvalidRequest
    );
    assert_eq!(
        session.settings()?["model"],
        json!({"provider":"scripted","id":"script"})
    );
    agent.close().await
}

#[tokio::test]
async fn step_after_refusal_fails_turn_with_its_reason_in_both_placements() -> Result<()> {
    for wire in [false, true] {
        let hook =
            Plugin::new("gate").on_step_after(|_| async { Ok(Gate::Refuse("stop here".into())) });
        let builder = test_agent().script(json!([{"text":"not accepted"}]));
        let agent = if wire {
            builder.over_wire(hook)
        } else {
            builder.plugin(hook)
        }
        .build()
        .await?;
        let turn = agent.session().await?.prompt("Go").await?;
        assert!(
            matches!(turn.outcome, Some(modular_agent::Outcome::Failed { error }) if error.contains("stop here"))
        );
        agent.close().await?;
    }
    Ok(())
}

#[tokio::test]
async fn answer_queue_distinguishes_unused_and_unexpected_questions() -> Result<()> {
    let answer = Answer::Value("yes".into());
    assert!(
        answers([answer.clone()])
            .assert_done()
            .unwrap_err()
            .message()
            .contains("1 unused")
    );
    let queue = answers([answer]);
    let agent = test_agent()
        .answers(queue.clone())
        .plugin(fixtures::fixture("confirm").unwrap())
        .script(json!([
            {"toolCalls":[{"name":"confirm","input":{"question":"Expected?"}}]},
            {"toolCalls":[{"name":"confirm","input":{"question":"Extra question?"}}]},
            {"text":"done"}
        ]))
        .build()
        .await?;
    let turn = agent.session().await?.prompt("Go").await?;
    assert_eq!(turn.tool_results()[0].text(), "yes");
    assert_eq!(turn.tool_results()[1].text(), "declined");
    let error = queue.assert_done().unwrap_err();
    assert!(error.message().contains("Extra question?"));
    agent.close().await
}
