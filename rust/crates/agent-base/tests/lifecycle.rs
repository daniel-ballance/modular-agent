mod support;
#[tokio::test]
async fn reopening_returns_untaken_input_without_silently_starting_work() {
    let rig = Rig::new(vec![]).await;
    rig.h
        .submit(&rig.id, "user", "QUEUED", Timing::After, None)
        .await
        .unwrap();
    rig.h.close(&rig.id).await.unwrap();
    rig.h.open(&rig.id).await.unwrap();
    assert!(rig.h.run_next(&rig.id).await.unwrap().is_none());
    assert!(
        rig.events
            .values
            .lock()
            .unwrap()
            .iter()
            .any(|e| e.kind == "input.returned" && e.content["text"] == "QUEUED")
    );
}
#[tokio::test]
async fn an_end_observer_failure_does_not_change_the_turn_outcome() {
    struct EndFailure;
    impl Plugin for EndFailure {
        fn name(&self) -> &str {
            "test.end-failure"
        }
        fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
            r.on(
                "runtime.turn.end",
                Order::Normal,
                handler(|_, _, _| Box::pin(async { bail!("end failed") })),
            );
            Ok(())
        }
    }
    let rig = Rig::with(
        vec![text("answer")],
        vec![Arc::new(EndFailure)],
        vec![],
        json!({}),
    )
    .await;
    assert_eq!(rig.run("start").await.outcome, Outcome::Completed);
    assert_eq!(
        rig.data()
            .entries
            .iter()
            .find(|e| e.kind == "turn.end")
            .unwrap()
            .content
            .as_ref()
            .unwrap()["outcome"],
        "completed"
    );
}
use agent_api::*;
use std::sync::Arc;
use support::*;

#[tokio::test]
async fn cancellation_does_not_cancel_independently_owned_plugin_work() {
    let mut delayed = text("late");
    delayed.delay_ms = 5000;
    let rig = Rig::new(vec![delayed]).await;
    // A feature plugin can own work outside the turn. Full jobs arrive in M3.
    let api: Api = rig.h.clone();
    let job_scope = Scope {
        job: Some(id()),
        call: Some(id()),
        ..Scope::session(&rig.id)
    };
    api.append(
        &job_scope,
        "test.job",
        Draft::new("job.start", false, json!({})),
    )
    .unwrap();
    let env: Arc<dyn WorkingEnvironment> = capability(api.as_ref(), "environment").unwrap();
    let project = rig.project.path().to_path_buf();
    let owner_cancel = CancellationToken::new();
    let job = tokio::spawn(async move {
        let result = env
            .bash(
                api.clone(),
                job_scope.clone(),
                project,
                "sleep 0.15; printf survived",
                owner_cancel,
            )
            .await
            .unwrap();
        api.append(
            &job_scope,
            "test.job",
            Draft::new("job.end", false, json!(result)),
        )
        .unwrap();
        result
    });
    rig.h
        .submit(&rig.id, "user", "start", Timing::Now, None)
        .await
        .unwrap();
    let h = rig.h.clone();
    let session = rig.id.clone();
    let turn = tokio::spawn(async move { h.run_next(&session).await });
    rig.events.wait("step.start").await;
    rig.h.cancel(&rig.id).await.unwrap();
    assert_eq!(
        turn.await.unwrap().unwrap().unwrap().outcome,
        Outcome::Cancelled
    );
    assert_eq!(job.await.unwrap().status, ToolStatus::Completed);
    assert_eq!(
        rig.data()
            .entries
            .iter()
            .find(|e| e.kind == "job.end")
            .unwrap()
            .content
            .as_ref()
            .unwrap()["text"],
        "survived"
    );
}
#[cfg(not(feature = "durable-default"))]
#[tokio::test]
async fn transient_reopen_settles_started_and_not_started_calls_once() {
    let rig = Rig::new(vec![]).await;
    let scope = Scope {
        turn: Some(id()),
        step: Some(id()),
        ..Scope::session(&rig.id)
    };
    rig.h
        .append(&scope, "test", Draft::new("turn.start", false, json!({})))
        .unwrap();
    for started in [false, true] {
        let call = ToolCall::new("bash", json!({"command":"must not run"}));
        let scope = Scope {
            call: Some(call.id.clone()),
            ..scope.clone()
        };
        rig.h
            .append(&scope, "test", Draft::new("tool.call", false, json!(call)))
            .unwrap();
        if started {
            rig.h
                .append(&scope, "test", Draft::new("tool.started", false, json!({})))
                .unwrap();
        }
    }
    rig.h.close(&rig.id).await.unwrap();
    rig.h.open(&rig.id).await.unwrap();
    let statuses = rig
        .results()
        .iter()
        .map(|r| r.status.clone())
        .collect::<Vec<_>>();
    assert_eq!(statuses, vec![ToolStatus::NotStarted, ToolStatus::Unknown]);
    rig.h.close(&rig.id).await.unwrap();
    rig.h.open(&rig.id).await.unwrap();
    assert_eq!(rig.results().len(), 2);
}
#[tokio::test]
async fn settings_changes_during_a_turn_are_refused_before_they_change_anything() {
    let mut delayed = text("answer");
    delayed.delay_ms = 100;
    let rig = Rig::new(vec![delayed]).await;
    rig.h
        .submit(&rig.id, "user", "start", Timing::Now, None)
        .await
        .unwrap();
    let h = rig.h.clone();
    let session = rig.id.clone();
    let turn = tokio::spawn(async move { h.run_next(&session).await });
    rig.events.wait("step.start").await;
    assert!(
        rig.h
            .submit(&rig.id, "user", "/thinking high", Timing::Now, None)
            .await
            .is_err()
    );
    assert_eq!(rig.data().settings["thinking"], "low");
    assert_eq!(
        turn.await.unwrap().unwrap().unwrap().outcome,
        Outcome::Completed
    );
}
#[tokio::test]
async fn tool_edits_fail_without_changing_a_file_if_the_match_is_not_unique() {
    let rig = Rig::new(vec![
        calls(vec![ToolCall::new(
            "edit",
            json!({"path":"file","old":"same","new":"changed"}),
        )]),
        text("done"),
    ])
    .await;
    std::fs::write(rig.project.path().join("file"), "same same").unwrap();
    rig.run("edit").await;
    assert_eq!(rig.results()[0].status, ToolStatus::Failed);
    assert_eq!(
        std::fs::read_to_string(rig.project.path().join("file")).unwrap(),
        "same same"
    );
}
#[tokio::test]
async fn erasure_keeps_a_fork_pending_while_its_lease_is_held_elsewhere() {
    let rig = Rig::new(vec![text("private")]).await;
    rig.run("private").await;
    let input = rig
        .data()
        .entries
        .iter()
        .find(|e| e.kind == "input")
        .unwrap()
        .id
        .clone();
    let fork = rig.h.fork(&Scope::session(&rig.id), None).unwrap();
    rig.h.close(&fork).await.unwrap();
    let store = history_fs::FileHistory::new(&rig.root.path().join("sessions")).unwrap();
    let lease = store.acquire(&fork).unwrap();
    let report = rig
        .h
        .erase(&Scope::session(&rig.id), vec![input.clone()])
        .await
        .unwrap();
    assert!(report.erased.contains(&input));
    assert!(
        report
            .qualified
            .iter()
            .any(|(session, id)| session == &fork && report.pending.contains(id))
    );
    assert!(store.check_erasure(&store.load(&fork).unwrap()).is_err());
    drop(lease);
    let report = rig
        .h
        .erase(&Scope::session(&rig.id), vec![input])
        .await
        .unwrap();
    assert!(report.pending.is_empty());
    assert!(store.check_erasure(&store.load(&fork).unwrap()).is_ok());
}
#[tokio::test]
async fn erasure_discovers_copies_without_replaying_legacy_admissions() {
    let rig = Rig::new(vec![text("finished")]).await;
    rig.run("private input").await;
    let input = rig
        .data()
        .entries
        .into_iter()
        .find(|e| e.kind == "input")
        .unwrap();
    let store = history_fs::FileHistory::new(&rig.root.path().join("sessions")).unwrap();
    let project = rig.data().project;
    let mut legacy = SessionData {
        id: "legacy".into(),
        project,
        settings: json!({}),
        plugins: vec![],
        position: Some("copy".into()),
        entries: vec![],
        origin: None,
    };
    let scope = Scope::session(&legacy.id);
    legacy.entries.push(Entry {
        id: "admission".into(),
        input_id: None,
        parent: None,
        scope: scope.clone(),
        writer: "harness".into(),
        at: 0,
        kind: "input.accepted".into(),
        visible: false,
        copies: vec![],
        content: Some(json!({"text":"legacy", "timing":"after", "taken":"after"})),
    });
    legacy.entries.push(Entry {
        id: "copy".into(),
        input_id: None,
        parent: Some("admission".into()),
        scope,
        writer: "test".into(),
        at: 0,
        kind: "summary".into(),
        visible: true,
        copies: vec![input.id.clone()],
        content: Some(json!({"text":"private input"})),
    });
    store.save(&legacy).unwrap();
    let report = rig
        .h
        .erase(&Scope::session(&rig.id), vec![input.id])
        .await
        .unwrap();
    assert!(!report.erased.is_empty());
    assert!(report.pending.iter().any(|id| id == "copy"));
    assert!(store.load("legacy").is_err());
}

#[tokio::test]
async fn output_limit_maps_to_a_limit_outcome() {
    let mut response = ModelResponse::text("partial");
    response.stop = "limit".into();
    let rig = Rig::new(vec![provider_fake::Script::response(response)]).await;
    let result = rig.run("start").await;
    assert_eq!(result.outcome, Outcome::Limit);
    assert_eq!(result.steps, 1);
}
#[tokio::test]
async fn malformed_after_tool_handler_cannot_leave_an_unpaired_call() {
    struct BadHandler;
    impl Plugin for BadHandler {
        fn name(&self) -> &str {
            "test.bad-handler"
        }
        fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
            r.on(
                "runtime.after.tool",
                Order::Normal,
                handler(|_, _, _| Box::pin(async { bail!("handler failed") })),
            );
            Ok(())
        }
    }
    let rig = Rig::with(
        vec![
            calls(vec![ToolCall::new("read", json!({"path":"AGENTS.md"}))]),
            text("done"),
        ],
        vec![Arc::new(BadHandler)],
        vec![],
        json!({}),
    )
    .await;
    assert_eq!(rig.run("run").await.outcome, Outcome::Completed);
    assert_eq!(rig.results().len(), 1);
    assert_eq!(rig.results()[0].status, ToolStatus::Failed);
}
