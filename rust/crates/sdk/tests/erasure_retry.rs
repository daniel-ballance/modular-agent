use modular_agent::{
    Code, Durability, ErasureRetryState, ReconcileErasureOptions, Result, file_history,
    testing::test_agent,
};
use serde_json::json;

#[tokio::test]
async fn quiet_retry_never_takes_held_or_out_of_scope_sessions() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let other = tempfile::tempdir()?;
    let history = file_history(dir.path().join("history"))?;
    let build = |project: &std::path::Path| {
        test_agent()
            .project(project)
            .durability(Durability::Kept)
            .history(history.clone())
            .script(json!([{"text":"seed"}]))
            .build()
    };
    let a = build(dir.path()).await?;
    let b = build(dir.path()).await?;
    let outsider = build(other.path()).await?;
    let source = a.session().await?;
    source.prompt("erase this").await?;
    let target = source
        .history()
        .await?
        .into_iter()
        .find(|row| row["kind"] == "input")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let fork = source.fork()?;
    let id = fork.id().to_owned();
    fork.close().await?;
    let held = b.open_session(&id).await?;
    source.erase(vec![target]).await?;
    assert_eq!(a.session_info(&id).unwrap_err().code(), Code::Unavailable);
    assert!(a.sessions(None)?.iter().all(|s| s.id != id));
    let retry = || ReconcileErasureOptions {
        sessions: vec![id.clone()],
        discover: true,
    };
    let scoped = outsider.reconcile_erasure(retry()).await?;
    assert_eq!(scoped[0].state, ErasureRetryState::OutOfScope);
    assert!(scoped[0].pending.is_empty() && scoped[0].erased.is_empty());
    assert_eq!(
        a.reconcile_erasure(retry()).await?[0].state,
        ErasureRetryState::Busy
    );
    held.close().await?;
    assert_eq!(
        a.reconcile_erasure(retry()).await?[0].state,
        ErasureRetryState::Complete
    );
    assert_eq!(
        a.reconcile_erasure(retry()).await?[0].state,
        ErasureRetryState::Complete
    );
    let reopened = a.open_session(&id).await?;
    let rows = reopened.history().await?;
    assert_eq!(
        rows.iter().filter(|row| row["kind"] == "erasure").count(),
        1
    );
    assert!(!json!(rows).to_string().contains("erase this"));
    Ok(())
}
