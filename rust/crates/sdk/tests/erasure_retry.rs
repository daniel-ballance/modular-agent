use agent_api::HistoryStore;
use history_fs::FileHistory;
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

const SECRET: &str = "Private retry fixture input";

// Read the backing store: Session::history would itself retry.
fn reconciled(store: &FileHistory, sid: &str, target: &str) -> Result<agent_api::SessionData> {
    assert!(store.pending_erasure_ids(sid)?.is_empty());
    let data = store.inspect(sid)?;
    assert!(
        data.entries
            .iter()
            .any(|e| e.id == target && e.content.is_none())
    );
    assert_eq!(
        data.entries.iter().filter(|e| e.kind == "erasure").count(),
        1
    );
    assert!(!json!(data.entries).to_string().contains(SECRET));
    Ok(data)
}

async fn mark_private(store: &FileHistory, session: &modular_agent::Session) -> Result<String> {
    session.prompt(SECRET).await?;
    let before = store.inspect(session.id())?;
    let target = before
        .entries
        .iter()
        .rfind(|e| e.kind == "input")
        .unwrap()
        .id
        .clone();
    let entries: Vec<_> = before
        .entries
        .iter()
        .filter(|e| json!(e).to_string().contains(SECRET))
        .map(|e| e.id.clone())
        .collect();
    assert!(entries.contains(&target));
    store.mark_erasure(session.id(), &entries)?;
    assert!(store.pending_erasure_ids(session.id())?.contains(&target));
    Ok(target)
}

#[tokio::test]
async fn open_session_retries_pending_erasure_on_the_existing_writer() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("history");
    let store = FileHistory::new(&path)?;
    let agent = test_agent()
        .project(dir.path())
        .durability(Durability::Kept)
        .history(file_history(&path)?)
        .script(json!([{"text":"seed"}]))
        .build()
        .await?;
    let open = agent.session().await?;
    let target = mark_private(&store, &open).await?;
    assert_eq!(agent.open_session(open.id()).await?.id(), open.id());
    reconciled(&store, open.id(), &target)?;
    open.set_setting("title", json!("existing writer remains usable"))?;
    Ok(())
}

#[tokio::test]
async fn authorized_direct_command_sees_reconciled_history() -> Result<()> {
    use modular_agent::{Command, Plugin};
    use std::sync::{Arc, OnceLock};
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("history");
    let store = FileHistory::new(&path)?;
    let target = Arc::new(OnceLock::<String>::new());
    let observed = target.clone();
    let callback_path = path.clone();
    let command = Command::new("check_history", "Check persisted history", move |_, cx| {
        let target = observed.clone();
        let path = callback_path.clone();
        async move {
            reconciled(
                &FileHistory::new(&path)?,
                &cx.session_id,
                target.get().unwrap(),
            )?;
            Ok(Some("reconciled".to_owned()))
        }
    });
    let agent = test_agent()
        .project(dir.path())
        .durability(Durability::Kept)
        .history(file_history(&path)?)
        .plugin(Plugin::new("retry-fixture").command(command))
        .script(json!([{"text":"seed"}]))
        .build()
        .await?;
    let session = agent.session().await?;
    target.set(mark_private(&store, &session).await?).unwrap();
    assert_eq!(
        session.run_command("/check_history").await?.as_deref(),
        Some("reconciled")
    );
    Ok(())
}

#[tokio::test]
async fn rewind_retries_pending_erasure_before_committing_position() -> Result<()> {
    use modular_agent::{
        Agent, MoveOptions,
        testing::{SCRIPTED_MODEL, scripted_provider},
    };
    let dir = tempfile::tempdir()?;
    let project = dir.path().join("project");
    assert!(
        std::process::Command::new("git")
            .args(["init", "-q"])
            .arg(&project)
            .status()?
            .success()
    );
    let path = dir.path().join("history");
    let store = FileHistory::new(&path)?;
    let marker = project.join("point.txt");
    std::fs::write(&marker, "saved")?;
    let agent = Agent::builder()
        .project(&project)
        .data_dir(dir.path())
        .durability(Durability::Kept)
        .history(file_history(&path)?)
        .provider(scripted_provider(json!([{"text":"seed"},{"text":"seed"}])))
        .model(SCRIPTED_MODEL)
        .build()
        .await?;
    let session = agent.session().await?;
    session.prompt("Save point").await?;
    let point = store
        .inspect(session.id())?
        .entries
        .iter()
        .find(|e| e.kind == "turn.end")
        .unwrap()
        .id
        .clone();
    let target = mark_private(&store, &session).await?;
    std::fs::write(&marker, "current")?;
    session
        .move_to_with(&point, MoveOptions { rewind: true })
        .await?;
    let data = reconciled(&store, session.id(), &target)?;
    assert_eq!(std::fs::read_to_string(marker)?, "saved");
    assert_eq!(data.position.as_deref(), Some(point.as_str()));
    let erasure = data
        .entries
        .iter()
        .position(|e| e.kind == "erasure")
        .unwrap();
    let rewind = data
        .entries
        .iter()
        .position(|e| e.kind == "position")
        .unwrap();
    assert!(erasure < rewind);
    Ok(())
}

#[tokio::test]
async fn approval_decision_retries_and_retires_only_the_affected_view() -> Result<()> {
    use modular_agent::{Answer, Approval, Tool, ToolContext};
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("history");
    let store = FileHistory::new(&path)?;
    let agent = test_agent()
        .project(dir.path())
        .durability(Durability::Kept)
        .history(file_history(&path)?)
        .approval(Approval::All)
        .max_approval_wait_ms(60_000)
        .setting("approvalWait", json!("untilDeadline"))
        .tool(
            Tool::new("fixture", "Waiting approval fixture")
                .run(|_: serde_json::Value, _: ToolContext| async { Ok("ran") }),
        )
        .script(json!([
            {"toolCalls":[{"name":"fixture","input":{"name":"unaffected"}}]},
            {"toolCalls":[{"name":"fixture","input":{"name":"affected"}}]},
            {"text":"done"}
        ]))
        .build()
        .await?;
    let session = agent.session().await?;
    for name in ["unaffected", "affected"] {
        assert_eq!(
            session
                .prompt(format!("Park {name}"))
                .await?
                .open_tool_calls
                .len(),
            1
        );
    }
    session.wait_idle().await?;
    let questions = session.questions_present().await?;
    let question = |name| {
        questions
            .iter()
            .find(|q| q.call.as_ref().is_some_and(|c| c["input"]["name"] == name))
            .unwrap()
    };
    let (affected, unaffected) = (question("affected"), question("unaffected"));
    let before = store.inspect(session.id())?;
    let entry = before
        .entries
        .iter()
        .find(|e| {
            e.kind == "request.open" && e.content.as_ref().is_some_and(|q| q["id"] == affected.id)
        })
        .unwrap();
    store.mark_erasure(session.id(), std::slice::from_ref(&entry.id))?;
    assert!(store.pending_erasure_ids(session.id())?.contains(&entry.id));
    assert_eq!(
        session
            .answer(&affected.id, Answer::Allow)
            .await
            .unwrap_err()
            .code(),
        Code::Conflict
    );
    reconciled(&store, session.id(), &entry.id)?;
    assert!(session.answer(&affected.id, Answer::Allow).await.is_err());
    // Do not re-poll: the independent view was delivered before erasure.
    session.answer(&unaffected.id, Answer::Allow).await?;
    session.wait_idle().await?;
    assert!(!session.questions()?.iter().any(|q| q.id == affected.id));
    let data = store.inspect(session.id())?;
    let results: Vec<_> = data
        .entries
        .iter()
        .filter(|e| e.kind == "tool.result" && e.scope.call == entry.scope.call)
        .collect();
    assert_eq!(results.len(), 1);
    assert!(
        results[0]
            .content
            .as_ref()
            .is_none_or(|body| body["status"] == "refused")
    );
    assert!(
        !data
            .entries
            .iter()
            .any(|e| e.kind == "tool.started" && e.scope.call == entry.scope.call)
    );
    Ok(())
}
