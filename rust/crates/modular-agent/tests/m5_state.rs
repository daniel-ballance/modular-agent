mod support;
use agent_api::*;
use provider_openai::Mode;
use std::sync::Arc;
use support::openai::*;

fn matrix() -> [(Mode, bool); 4] {
    [
        (Mode::Stateless, false),
        (Mode::Stateless, true),
        (Mode::Stateful, false),
        (Mode::Stateful, true),
    ]
}
fn has_previous(body: &Value) -> bool {
    body.get("previous_response_id").is_some()
}

#[tokio::test]
async fn identical_tool_and_conversation_contract_with_both_runtimes_and_provider_modes() {
    for (mode, durable) in matrix() {
        let rig = OpenRig::new(
            mode,
            durable,
            vec![
                Reply::Call(ToolCall::new("read", json!({"path":"proof.txt"}))),
                "cedar proof".into(),
                "still cedar".into(),
            ],
        )
        .await;
        std::fs::write(rig.project.path().join("proof.txt"), "cedar proof").unwrap();
        assert_eq!(
            rig.h.declaration().unwrap()["provider_state"],
            mode == Mode::Stateful
        );
        let provider: Arc<dyn Provider> = capability(rig.h.as_ref(), "provider.openai").unwrap();
        assert_eq!(provider.catalog()[0].keeps_state, mode == Mode::Stateful);
        assert_eq!(rig.run("read proof.txt").await.outcome, Outcome::Completed);
        assert_eq!(rig.run("what was the proof?").await.text, "still cedar");
        rig.aligned();
        {
            let remote = rig.server.remote.lock().unwrap();
            assert_eq!(remote.requests.len(), 3);
            assert!(!has_previous(&remote.requests[0]));
            for request in &remote.requests[1..] {
                assert_eq!(has_previous(request), mode == Mode::Stateful);
                assert_eq!(request["store"], mode == Mode::Stateful);
                assert!(!request["instructions"].as_str().unwrap().is_empty());
                assert!(!request["tools"].as_array().unwrap().is_empty());
            }
            if mode == Mode::Stateful {
                assert_eq!(remote.requests[1]["input"].as_array().unwrap().len(), 1);
                assert_eq!(
                    remote.requests[1]["input"][0]["type"],
                    "function_call_output"
                );
                assert_eq!(remote.requests[2]["input"].as_array().unwrap().len(), 1);
                assert_eq!(
                    remote.requests[2]["input"][0]["content"],
                    "what was the proof?"
                );
            }
        }
        let data = rig.h.snapshot(&rig.id).unwrap();
        assert_eq!(
            data.entries
                .iter()
                .filter(|e| e.kind == "tool.result")
                .count(),
            1
        );
        assert!(
            data.entries
                .iter()
                .filter(|e| e.kind == "model.request")
                .all(|e| e.content.as_ref().unwrap()["keeps_state"] == (mode == Mode::Stateful))
        );
        rig.finish().await;
    }
}

#[tokio::test]
async fn move_even_to_an_identical_view_and_fork_start_fresh_without_changing_files() {
    for (mode, durable) in matrix() {
        let rig = OpenRig::new(
            mode,
            durable,
            vec![
                "one".into(),
                "two".into(),
                "new branch".into(),
                "fork".into(),
                "parent".into(),
            ],
        )
        .await;
        rig.run("first fact").await;
        let first = rig.h.snapshot(&rig.id).unwrap().position;
        rig.run("discarded branch fact").await;
        let last = rig.h.snapshot(&rig.id).unwrap().position;
        // Away and back still explicitly invalidates, even if the final view is identical.
        rig.h.move_position(&rig.scope(), first.clone()).unwrap();
        rig.h.move_position(&rig.scope(), last).unwrap();
        rig.run("same view after moving").await;
        assert!(!has_previous(
            &rig.server.remote.lock().unwrap().requests[2]
        ));
        rig.h.move_position(&rig.scope(), first).unwrap();
        let fork = rig.h.fork(&rig.scope(), None).unwrap();
        rig.run_in(&fork, "fork continuation").await;
        rig.run("parent continuation").await;
        rig.aligned();
        {
            let remote = rig.server.remote.lock().unwrap();
            for request in &remote.requests[3..] {
                assert!(!has_previous(request));
                assert!(!request.to_string().contains("discarded branch fact"));
            }
        }
        rig.h.close(&fork).await.unwrap();
        rig.finish().await;
    }
}

#[tokio::test]
async fn compaction_auxiliary_request_and_new_summary_view_never_inherit_hidden_context() {
    for (mode, durable) in matrix() {
        let rig = OpenRig::new(
            mode,
            durable,
            vec![
                "old answer".into(),
                "concise facts".into(),
                "after compact".into(),
                "continued".into(),
            ],
        )
        .await;
        rig.run("large old detail").await;
        assert_eq!(
            rig.h.command(&rig.scope(), "compact", "").await.unwrap()["compacted"],
            true
        );
        rig.run("new question").await;
        rig.run("next question").await;
        rig.aligned();
        {
            let remote = rig.server.remote.lock().unwrap();
            assert!(
                !has_previous(&remote.requests[1]),
                "summary has its own instructions and context"
            );
            assert!(
                !has_previous(&remote.requests[2]),
                "summary view resets the main chain"
            );
            assert_eq!(has_previous(&remote.requests[3]), mode == Mode::Stateful);
            assert!(remote.effective[2].to_string().contains("concise facts"));
            assert!(!remote.effective[2].to_string().contains("large old detail"));
        }
        let data = rig.h.snapshot(&rig.id).unwrap();
        assert!(data.entries.iter().any(
            |e| e.kind == "input" && e.content.as_ref().unwrap()["text"] == "large old detail"
        ));
        rig.finish().await;
    }
}

#[tokio::test]
async fn erasure_deletes_every_remote_copy_including_summary_abandoned_chain_and_fork() {
    for (mode, durable) in matrix() {
        let rig = OpenRig::new(
            mode,
            durable,
            vec![
                "PRIVATE-TOKEN".into(),
                "summary PRIVATE-TOKEN".into(),
                "fork copied PRIVATE-TOKEN".into(),
                "parent".into(),
                "unknown".into(),
                "unknown in fork".into(),
            ],
        )
        .await;
        rig.run("remember PRIVATE-TOKEN").await;
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
        rig.h.command(&rig.scope(), "compact", "").await.unwrap();
        let fork = rig.h.fork(&rig.scope(), None).unwrap();
        rig.run_in(&fork, "continue fork").await;
        rig.run("continue parent").await;
        let report = rig.h.erase(&rig.scope(), vec![input]).await.unwrap();
        assert!(!report.erased.is_empty());
        assert!(report.out_of_reach.iter().any(|s| s.contains("delivered")));
        {
            let remote = rig.server.remote.lock().unwrap();
            assert!(remote.stored.is_empty());
            assert_eq!(
                remote.deleted.len(),
                if mode == Mode::Stateful { 4 } else { 0 }
            );
        }
        for id in [&rig.id, &fork] {
            assert!(
                !serde_json::to_string(&rig.h.snapshot(id).unwrap())
                    .unwrap()
                    .contains("PRIVATE-TOKEN")
            );
        }
        rig.run("what was erased?").await;
        rig.run_in(&fork, "what was erased?").await;
        rig.aligned();
        {
            let remote = rig.server.remote.lock().unwrap();
            for request in &remote.requests[4..] {
                assert!(!has_previous(request));
                assert!(!request.to_string().contains("PRIVATE-TOKEN"));
            }
        }
        rig.h.close(&fork).await.unwrap();
        rig.finish().await;
    }
}

#[tokio::test]
async fn restart_seeds_from_history_but_keeps_response_ids_for_later_erasure() {
    for (mode, durable) in matrix() {
        let mut rig = OpenRig::new(
            mode,
            durable,
            vec![
                "private answer".into(),
                "reopened answer".into(),
                "clean".into(),
            ],
        )
        .await;
        rig.run("RESTART-PRIVATE").await;
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
        rig.reopen().await;
        rig.run("continue after restart").await;
        assert!(!has_previous(
            &rig.server.remote.lock().unwrap().requests[1]
        ));
        rig.aligned();
        rig.h.erase(&rig.scope(), vec![input]).await.unwrap();
        assert!(rig.server.remote.lock().unwrap().stored.is_empty());
        assert_eq!(
            rig.server.remote.lock().unwrap().deleted.len(),
            if mode == Mode::Stateful { 2 } else { 0 }
        );
        rig.run("clean continuation").await;
        assert!(!has_previous(
            &rig.server.remote.lock().unwrap().requests[2]
        ));
        rig.finish().await;
    }
}

#[tokio::test]
async fn unavailable_previous_response_retries_full_context_only_after_definite_rejection() {
    let rig = OpenRig::new(Mode::Stateful, true, vec!["one".into(), "two".into()]).await;
    rig.run("first").await;
    rig.server.remote.lock().unwrap().stored.clear();
    assert_eq!(rig.run("second").await.outcome, Outcome::Completed);
    rig.aligned();
    {
        let remote = rig.server.remote.lock().unwrap();
        assert_eq!(remote.requests.len(), 3);
        assert!(has_previous(&remote.requests[1]));
        assert!(!has_previous(&remote.requests[2]));
        assert_eq!(remote.effective[1], rig.full.0.lock().unwrap()[1]["input"]);
    }
    rig.finish().await;
}

#[tokio::test]
async fn failed_or_incomplete_streams_do_not_advance_chains_and_known_ids_remain_erasable() {
    for created in [false, true] {
        let rig = OpenRig::new(
            Mode::Stateful,
            true,
            vec!["one".into(), Reply::Broken(created), "after failure".into()],
        )
        .await;
        rig.run("remember STREAM-PRIVATE").await;
        assert_eq!(rig.run("broken request").await.outcome, Outcome::Failed);
        assert_eq!(rig.run("try a new turn").await.outcome, Outcome::Completed);
        assert!(!has_previous(
            &rig.server.remote.lock().unwrap().requests[2]
        ));
        rig.aligned();
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
        let report = rig.h.erase(&rig.scope(), vec![input]).await.unwrap();
        assert_eq!(
            report
                .out_of_reach
                .iter()
                .any(|s| s.contains("without a received response ID")),
            !created
        );
        assert_eq!(
            rig.server.remote.lock().unwrap().deleted.len(),
            if created { 3 } else { 2 }
        );
        rig.finish().await;
    }
}

#[tokio::test]
async fn deletion_failure_is_not_acknowledged_and_cleanup_barrier_survives_restart() {
    let mut rig = OpenRig::new(
        Mode::Stateful,
        true,
        vec!["private answer".into(), "clean answer".into()],
    )
    .await;
    rig.run("DELETE-PRIVATE").await;
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
    rig.server.remote.lock().unwrap().refuse_delete = true;
    assert!(
        rig.h
            .erase(&rig.scope(), vec![input])
            .await
            .unwrap_err()
            .to_string()
            .contains("deletion failed")
    );
    assert!(
        !serde_json::to_string(&rig.h.snapshot(&rig.id).unwrap())
            .unwrap()
            .contains("DELETE-PRIVATE")
    );
    assert_eq!(
        rig.run("blocked until cleanup").await.outcome,
        Outcome::Failed
    );
    assert!(
        rig.reopen_result().await.is_err(),
        "reopening also fails closed while deletion is unavailable"
    );
    assert_eq!(rig.server.remote.lock().unwrap().requests.len(), 1);
    rig.server.remote.lock().unwrap().refuse_delete = false;
    rig.h.open(&rig.id).await.unwrap();
    rig.h.erase(&rig.scope(), vec![]).await.unwrap();
    assert!(rig.server.remote.lock().unwrap().stored.is_empty());
    assert_eq!(rig.run("continue safely").await.outcome, Outcome::Completed);
    assert!(!has_previous(
        &rig.server.remote.lock().unwrap().requests[1]
    ));
    rig.finish().await;
}

#[tokio::test]
async fn cancellation_invalidates_chain_and_still_inventories_the_created_response() {
    let rig = OpenRig::new(
        Mode::Stateful,
        true,
        vec!["one".into(), Reply::Wait, "after cancel".into()],
    )
    .await;
    rig.run("first").await;
    rig.h
        .submit(&rig.id, "user", "wait for cancel", Timing::Now, None)
        .await
        .unwrap();
    let h = rig.h.clone();
    let id = rig.id.clone();
    let turn = tokio::spawn(async move { h.run_next(&id).await.unwrap().unwrap() });
    // Wait for the durable response.created inventory, not just the HTTP request.
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let path = rig
                .root
                .path()
                .join("openai")
                .join(format!("{}.json", rig.id));
            let inventory: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            if inventory["responses"].as_array().unwrap().len() == 2 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    rig.h.cancel(&rig.id).await.unwrap();
    assert_eq!(turn.await.unwrap().outcome, Outcome::Cancelled);
    rig.run("after cancel").await;
    assert!(!has_previous(
        &rig.server.remote.lock().unwrap().requests[2]
    ));
    rig.aligned();
    rig.h.erase(&rig.scope(), vec![]).await.unwrap();
    assert_eq!(rig.server.remote.lock().unwrap().deleted.len(), 3);
    rig.finish().await;
}
