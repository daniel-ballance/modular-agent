mod support;
use agent_api::*;
use std::sync::Arc;
use support::*;
#[tokio::test]
async fn cancelling_a_job_also_closes_its_childs_past_turn_question() {
    let rig = Rig::new(vec![
        calls(vec![ToolCall::new(
            "ask_user",
            json!({"question":"Later?","timeout_ms":1}),
        )])
        .for_task("child"),
    ])
    .await;
    let rt: Arc<dyn Runtime> = capability(rig.h.as_ref(), "runtime").unwrap();
    rt.tool(
        rig.h.clone(),
        Scope::session(&rig.id),
        ToolCall::new("delegate", json!({"task":"child"})),
    )
    .await
    .unwrap();
    let j = jobs(&rig.data()).unwrap().pop().unwrap();
    let child = j.detail["child"].as_str().unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if rig
                .h
                .snapshot(child)
                .unwrap()
                .entries
                .iter()
                .any(|e| e.kind == "turn.end")
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    let ended = job_service(rig.h.as_ref())
        .unwrap()
        .cancel(rig.h.clone(), &rig.id, "user", &j.id)
        .await
        .unwrap();
    assert_eq!(ended.state, JobState::Cancelled);
    let data = rig.h.snapshot(child).unwrap();
    assert!(questions(&data).unwrap().iter().all(|q| !q.answerable));
    assert_eq!(
        data.entries
            .iter()
            .filter(|e| e.kind == "tool.result")
            .count(),
        1
    );
    rig.h.close(&rig.id).await.unwrap();
}
#[tokio::test]
async fn erasure_cannot_restore_revoked_authority_and_removes_queued_content() {
    let rig = Rig::new(vec![]).await;
    let scope = Scope::session(&rig.id);
    let mut cap = Authority::full();
    cap.0.remove("approve");
    rig.h.grant(&scope, "user", cap).unwrap();
    let grant = rig
        .data()
        .entries
        .iter()
        .find(|e| e.kind == "actor.grant")
        .unwrap()
        .id
        .clone();
    assert!(rig.h.erase(&scope, vec![grant]).await.is_err());
    assert!(!rig.h.authority(&rig.id, "user").unwrap().has("approve"));
    let receipt = rig
        .h
        .submit(
            &rig.id,
            "user",
            "erase queued private content",
            Timing::After,
            None,
        )
        .await
        .unwrap();
    rig.h.erase(&scope, vec![receipt.input]).await.unwrap();
    assert!(rig.h.run_next(&rig.id).await.unwrap().is_none());
    assert!(rig.probe.requests.lock().unwrap().is_empty());
}
#[tokio::test]
async fn ui_tool_calls_do_not_need_a_provider_or_model_selection() {
    let root = tempfile::TempDir::new().unwrap();
    let h = agent_harness::Harness::new();
    h.load(Arc::new(runtime_transient::TransientPlugin))
        .await
        .unwrap();
    h.load(Arc::new(environment_local::LocalPlugin {
        state: root.path().join("commands"),
        points: environment_local::PointStore::Copy,
    }))
    .await
    .unwrap();
    h.load(Arc::new(tools_builtin::BuiltinTools)).await.unwrap();
    let project = root.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let id = h.create(&project, json!({})).await.unwrap();
    let rt: Arc<dyn Runtime> = capability(h.as_ref(), "runtime").unwrap();
    let result = rt
        .tool(
            h.clone(),
            Scope::session(&id),
            ToolCall::new("write", json!({"path":"ui.txt","content":"no model"})),
        )
        .await
        .unwrap();
    assert_eq!(result.status, ToolStatus::Completed);
    assert_eq!(
        std::fs::read_to_string(project.join("ui.txt")).unwrap(),
        "no model"
    );
    assert!(h.capability_names("provider.").is_empty());
    h.close(&id).await.unwrap();
}
#[tokio::test]
async fn moving_away_cancels_open_calls_and_fork_refuses_pending_work() {
    let rig = Rig::new(vec![calls(vec![ToolCall::new(
        "ask_user",
        json!({"question":"Later?","timeout_ms":1}),
    )])])
    .await;
    let marker = rig
        .h
        .append(
            &Scope::session(&rig.id),
            "test",
            Draft::new("marker", false, json!({})),
        )
        .unwrap();
    assert_eq!(rig.run("start").await.open_calls.len(), 1);
    assert!(rig.h.fork(&Scope::session(&rig.id), None).is_err());
    rig.h
        .move_position(&Scope::session(&rig.id), Some(marker.id))
        .unwrap();
    assert_eq!(rig.results().len(), 1);
    assert_eq!(rig.results()[0].status, ToolStatus::Cancelled);
    assert!(
        requests(rig.h.as_ref())
            .unwrap()
            .visible(rig.h.as_ref(), &rig.id, "user")
            .unwrap()
            .is_empty()
    );
    assert!(rig.h.run_next(&rig.id).await.unwrap().is_none());
}
#[tokio::test]
async fn forked_recorded_answers_use_the_forks_current_authority() {
    let rig = Rig::new(vec![]).await;
    let svc = requests(rig.h.as_ref()).unwrap();
    svc.presence(&rig.id, "user", true);
    let mut q = Question::new(Scope::session(&rig.id), RequestKind::Approval, "Allow?");
    q.key = Some("key".into());
    q.timeout_ms = Some(1);
    svc.ask(rig.h.clone(), q, CancellationToken::new())
        .await
        .unwrap();
    let q = svc
        .visible(rig.h.as_ref(), &rig.id, "user")
        .unwrap()
        .pop()
        .unwrap();
    svc.answer(rig.h.clone(), &rig.id, "user", &q.id, json!("allow"), false)
        .await
        .unwrap();
    let fork = rig.h.fork(&Scope::session(&rig.id), None).unwrap();
    let mut cap = Authority::full();
    cap.0.remove("approve");
    rig.h.grant(&Scope::session(&fork), "user", cap).unwrap();
    let mut question = Question::new(Scope::session(&fork), RequestKind::Approval, "Allow?");
    question.key = Some("key".into());
    question.timeout_ms = Some(1);
    assert!(matches!(
        svc.ask(rig.h.clone(), question, CancellationToken::new())
            .await
            .unwrap(),
        RequestReply::Declined
    ));
    assert_eq!(questions(&rig.h.snapshot(&fork).unwrap()).unwrap().len(), 2);
}
