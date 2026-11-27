use modular_agent::{
    Actor, Code, Durability, ErasureRetryState, ReconcileErasureOptions, Result, file_history,
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
            .several_actors(true)
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
    held.join(Actor {
        id: "observer".into(),
        kind: "user".into(),
        rights: serde_json::from_value(json!(["watch"]))?,
    })
    .await?;
    let observer = held.r#as("observer")?;
    let position = held.history().await?.last().unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    source.erase(vec![target]).await?;
    assert_eq!(
        observer
            .set_setting("title", json!("denied"))
            .unwrap_err()
            .code(),
        Code::Forbidden
    );
    assert_eq!(
        observer.run_command("/unknown").await.unwrap_err().code(),
        Code::Forbidden
    );
    assert_eq!(observer.fork().err().unwrap().code(), Code::Forbidden);
    assert_eq!(
        observer.move_to(&position).await.unwrap_err().code(),
        Code::Forbidden
    );
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
    held.set_setting("title", json!("authorized"))?;
    let rows = held.history().await?;
    let erasure = rows
        .iter()
        .position(|row| row["kind"] == "erasure")
        .unwrap();
    let setting = rows
        .iter()
        .rposition(|row| row["kind"] == "setting" && row["data"]["value"]["title"] == "authorized")
        .unwrap();
    assert!(erasure < setting);
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

#[tokio::test]
async fn answer_retry_refuses_an_erased_question_without_rebinding() -> Result<()> {
    use agent_api::{Entry, HistoryStore, Question, RequestKind, Scope};
    use modular_agent::Answer;

    let dir = tempfile::tempdir()?;
    let path = dir.path().join("history");
    let store = history_fs::FileHistory::new(&path)?;
    let agent = test_agent()
        .project(dir.path())
        .durability(Durability::Kept)
        .history(file_history(&path)?)
        .script(json!([{"text":"seed"}]))
        .build()
        .await?;
    let session = agent.session().await?;
    session.prompt("seed").await?;
    let id = session.id().to_owned();
    session.close().await?;
    let lease = store.acquire(&id)?;
    let mut data = store.load(&id)?;
    let mut scope = Scope::session(&id);
    scope.turn = data.entries.iter().rev().find_map(|e| e.scope.turn.clone());
    let mut affected = Question::new(
        scope.clone(),
        RequestKind::Text,
        "Private delivered question",
    );
    let mut unaffected = Question::new(
        scope.clone(),
        RequestKind::Text,
        "Independent delivered question",
    );
    affected.route.push(id.clone());
    unaffected.route.push(id.clone());
    for (q, entry) in [(&affected, "affected"), (&unaffected, "unaffected")] {
        data.entries.push(Entry {
            id: entry.into(),
            input_id: None,
            parent: data.position.clone(),
            scope: scope.clone(),
            writer: "fixture".into(),
            at: agent_api::now(),
            kind: "request.open".into(),
            visible: false,
            copies: vec![],
            content: Some(json!(q)),
        });
        data.position = Some(entry.into());
    }
    store.save(&data)?;
    drop(lease);
    let session = agent.open_session(&id).await?;
    assert_eq!(session.questions()?.len(), 2);
    store.mark_erasure(&id, &["affected".into()])?;
    assert_eq!(
        session
            .answer(&affected.id, Answer::Value("do not bind".into()))
            .await
            .unwrap_err()
            .code(),
        Code::Conflict
    );
    assert!(store.pending_erasure_ids(&id)?.is_empty());
    assert!(!session.questions()?.iter().any(|q| q.id == affected.id));
    session
        .answer(&unaffected.id, Answer::Value("keep".into()))
        .await?;
    let rows = session.history().await?;
    assert!(!json!(rows).to_string().contains("do not bind"));
    assert!(json!(rows).to_string().contains("keep"));
    Ok(())
}
