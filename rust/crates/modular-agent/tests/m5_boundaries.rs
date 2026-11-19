mod support;
use agent_api::*;
use provider_openai::Mode;
use std::sync::Arc;
use support::openai::*;

#[tokio::test]
async fn context_overflow_compacts_and_retries_identically_in_the_four_compositions() {
    for mode in [Mode::Stateless, Mode::Stateful] {
        for durable in [false, true] {
            let rig = OpenRig::new(
                mode,
                durable,
                vec![
                    "old answer".into(),
                    Reply::Error(
                        400,
                        json!({"error":{"code":"context_length_exceeded","message":"too large"}}),
                    ),
                    "summary facts".into(),
                    "recovered".into(),
                ],
            )
            .await;
            rig.run("old uncompressed detail").await;
            assert_eq!(rig.run("new question").await.outcome, Outcome::Completed);
            rig.aligned();
            {
                let remote = rig.server.remote.lock().unwrap();
                assert_eq!(remote.requests.len(), 4);
                assert!(remote.requests[2].get("previous_response_id").is_none());
                assert!(remote.requests[3].get("previous_response_id").is_none());
                assert!(
                    !remote.effective[3]
                        .to_string()
                        .contains("old uncompressed detail")
                );
                assert!(remote.effective[3].to_string().contains("summary facts"));
            }
            rig.finish().await;
        }
    }
}

#[tokio::test]
async fn discarding_a_fresh_binding_resets_all_bindings_and_sessions_remain_isolated() {
    let rig = OpenRig::new(
        Mode::Stateful,
        true,
        vec![
            "a1".into(),
            "b1".into(),
            "a2".into(),
            "b2".into(),
            "reset".into(),
            "prompt change".into(),
        ],
    )
    .await;
    let second = rig
        .h
        .create(rig.project.path(), json!({"approval":"off"}))
        .await
        .unwrap();
    rig.run("SESSION-A-ONLY").await;
    rig.run_in(&second, "SESSION-B-ONLY").await;
    rig.run("continue A").await;
    rig.run_in(&second, "continue B").await;
    let selection: Arc<dyn ModelSelection> = capability(rig.h.as_ref(), "model.selection").unwrap();
    let access = selection.select(rig.h.clone(), &rig.scope()).await.unwrap();
    access.discard(&rig.id).await.unwrap();
    rig.run("after explicit discard").await;
    std::fs::write(
        rig.project.path().join("AGENTS.md"),
        "New project instructions.",
    )
    .unwrap();
    rig.run("after system prompt change").await;
    rig.aligned();
    {
        let remote = rig.server.remote.lock().unwrap();
        assert!(remote.requests[2].get("previous_response_id").is_some());
        assert!(remote.requests[3].get("previous_response_id").is_some());
        assert_ne!(
            remote.requests[2]["previous_response_id"],
            remote.requests[3]["previous_response_id"]
        );
        for index in [0, 2, 4, 5] {
            assert!(
                !remote.effective[index]
                    .to_string()
                    .contains("SESSION-B-ONLY")
            );
        }
        for index in [1, 3] {
            assert!(
                !remote.effective[index]
                    .to_string()
                    .contains("SESSION-A-ONLY")
            );
        }
        for index in [4, 5] {
            assert!(remote.requests[index].get("previous_response_id").is_none());
        }
    }
    rig.h.close(&second).await.unwrap();
    rig.finish().await;
}

#[tokio::test]
async fn middleware_changed_views_reset_state_and_cannot_smuggle_vendor_state_or_tools() {
    let rig = OpenRig::new(Mode::Stateful, true, vec!["one".into(), "redacted".into()]).await;
    rig.run("full private context").await;
    *rig.full.1.lock().unwrap() =
        json!({"input":[{"role":"user","content":"a different redacted view"}]});
    rig.run("next").await;
    rig.aligned();
    assert!(
        rig.server.remote.lock().unwrap().requests[1]
            .get("previous_response_id")
            .is_none()
    );
    rig.finish().await;
    for patch in [
        json!({"model":"not-allowed"}),
        json!({"store":false}),
        json!({"previous_response_id":"foreign"}),
        json!({"conversation":"foreign"}),
        json!({"tools":[{"type":"web_search"}]}),
        json!({"context_management":[]}),
        json!({"prompt":{"id":"untracked-server-template"}}),
        json!({"truncation":"auto"}),
        json!({"background":true}),
        json!({"stream":false}),
    ] {
        let rig = OpenRig::new(Mode::Stateful, true, vec![]).await;
        *rig.full.1.lock().unwrap() = patch;
        assert_eq!(rig.run("must fail closed").await.outcome, Outcome::Failed);
        assert!(rig.server.remote.lock().unwrap().requests.is_empty());
        rig.finish().await;
    }
}

#[tokio::test]
async fn server_errors_are_not_retried_and_unknown_ids_are_reported_while_keys_are_redacted() {
    for mode in [Mode::Stateless, Mode::Stateful] {
        let rig = OpenRig::new(mode,true,vec!["one".into(),Reply::Error(503,json!({"error":{"code":"server_error","message":"offline-fixture-key must never appear"}})),"new turn".into()]).await;
        rig.run("first").await;
        let failure = rig.run("server failure").await;
        assert_eq!(failure.outcome, Outcome::Failed);
        assert!(!failure.error.unwrap().contains("offline-fixture-key"));
        assert_eq!(rig.server.remote.lock().unwrap().requests.len(), 2);
        rig.run("new turn").await;
        assert!(
            rig.server.remote.lock().unwrap().requests[2]
                .get("previous_response_id")
                .is_none()
        );
        let report = rig.h.erase(&rig.scope(), vec![]).await.unwrap();
        assert_eq!(
            report
                .out_of_reach
                .iter()
                .any(|s| s.contains("without a received response ID")),
            mode == Mode::Stateful
        );
        rig.finish().await;
    }
}

#[tokio::test]
async fn erasure_history_closes_the_crash_window_before_provider_deletion_intent() {
    let mut rig = OpenRig::new(
        Mode::Stateful,
        true,
        vec!["private answer".into(), "clean".into()],
    )
    .await;
    rig.run("CRASH-PRIVATE").await;
    let input = rig
        .h
        .snapshot(&rig.id)
        .unwrap()
        .entries
        .iter()
        .find(|e| e.kind == "input")
        .unwrap()
        .id
        .clone();
    // Simulate stopping immediately after HistoryStore.erase, before the Provider
    // can set purge_pending. Closing first gives the fixture the writer lease.
    rig.h.close(&rig.id).await.unwrap();
    let store: Arc<dyn HistoryStore> = capability(rig.h.as_ref(), "history").unwrap();
    store.erase(vec![input], &[]).unwrap();
    assert_eq!(rig.server.remote.lock().unwrap().stored.len(), 1);
    rig.h.open(&rig.id).await.unwrap();
    assert!(
        rig.server.remote.lock().unwrap().stored.is_empty(),
        "session preparation must delete old copies before recovery"
    );
    rig.reopen().await;
    assert_eq!(rig.run("clean").await.outcome, Outcome::Completed);
    assert!(
        rig.server.remote.lock().unwrap().requests[1]
            .get("previous_response_id")
            .is_none()
    );
    rig.finish().await;
}

#[tokio::test]
async fn recovery_respects_the_actual_provider_declaration_without_replaying_unknown_effects() {
    for mode in [Mode::Stateless, Mode::Stateful] {
        for durable in [false, true] {
            let mut rig =
                OpenRig::new(mode, durable, vec!["recovered stateless request".into()]).await;
            let provider: Arc<dyn Provider> =
                capability(rig.h.as_ref(), "provider.openai").unwrap();
            let info = provider.bind("gpt-6-luna").unwrap().info();
            let scope = Scope {
                turn: Some(id()),
                step: Some(id()),
                ..rig.scope()
            };
            rig.h.append(&scope,"fixture",Draft::new("turn.start",false,json!({"model":info,"settings":{"step_limit":2},"system":"saved prompt","tools":[]}))).unwrap();
            rig.h
                .append(
                    &scope,
                    "fixture",
                    Draft::new("step.start", false, json!({"index":0})),
                )
                .unwrap();
            rig.h
                .append(
                    &scope,
                    "fixture",
                    Draft::new(
                        "model.request",
                        false,
                        json!({"keeps_state":info.keeps_state,"runs_tools":false}),
                    ),
                )
                .unwrap();
            rig.reopen().await;
            let data = rig.h.snapshot(&rig.id).unwrap();
            let end: TurnResult = serde_json::from_value(
                data.entries
                    .iter()
                    .rev()
                    .find(|e| e.kind == "turn.end")
                    .unwrap()
                    .content
                    .clone()
                    .unwrap(),
            )
            .unwrap();
            let resumes = durable && mode == Mode::Stateless;
            assert_eq!(
                end.outcome,
                if resumes {
                    Outcome::Completed
                } else {
                    Outcome::Failed
                },
                "{mode:?} durable={durable}: {:?}",
                end.error
            );
            assert_eq!(
                rig.server.remote.lock().unwrap().requests.len(),
                usize::from(resumes)
            );
            if durable && mode == Mode::Stateful {
                assert!(end.error.unwrap().contains("unknown outside effects"));
            }
            rig.finish().await;
        }
    }
}
