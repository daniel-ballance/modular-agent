mod support;
#[tokio::test]
async fn summary_usage_is_included_in_the_turn_total() {
    let mut summary = agent_api::ModelResponse::text("summary");
    summary.usage.input_tokens = 10;
    summary.usage.output_tokens = 2;
    let mut normal = agent_api::ModelResponse::text("answer");
    normal.usage.input_tokens = 20;
    normal.usage.output_tokens = 3;
    let rig = Rig::with(
        vec![
            provider_fake::Script::response(summary),
            provider_fake::Script::response(normal),
        ],
        vec![],
        vec![],
        json!({"context_tokens":100}),
    )
    .await;
    seed(&rig, &"long ".repeat(1000));
    let result = rig.run("question").await;
    assert_eq!(result.usage.input_tokens, 30);
    assert_eq!(result.usage.output_tokens, 5);
}
#[tokio::test]
async fn erasing_a_setting_removes_materialized_copies_and_command_observations() {
    let rig = Rig::new(vec![]).await;
    let scope = Scope::session(&rig.id);
    rig.h
        .settings(&scope, json!({"private_note":"SETTING-SECRET"}))
        .unwrap();
    let setting = rig
        .data()
        .entries
        .iter()
        .find(|e| e.kind == "settings")
        .unwrap()
        .id
        .clone();
    rig.h.settings(&scope, json!({"thinking":"high"})).unwrap();
    rig.h
        .submit(&rig.id, "user", "/settings", Timing::Now, None)
        .await
        .unwrap();
    rig.h.erase(&scope, vec![setting]).await.unwrap();
    assert!(
        !serde_json::to_string(&rig.data())
            .unwrap()
            .contains("SETTING-SECRET")
    );
}
#[tokio::test]
async fn the_output_hold_declaration_matches_the_actual_guardrail_configuration() {
    let rig = Rig::new(vec![]).await;
    assert_eq!(rig.h.declaration().unwrap()["holds_output"], false);
    let rig = Rig::with(vec![], vec![], vec!["secret".into()], json!({})).await;
    assert_eq!(rig.h.declaration().unwrap()["holds_output"], true);
    assert!(
        rig.h.declaration().unwrap()["hook_points"]
            .as_array()
            .unwrap()
            .iter()
            .any(|h| h["name"] == "runtime.before.step")
    );
}
use agent_api::*;
use std::sync::Arc;
use support::*;
fn seed(rig: &Rig, text: &str) -> String {
    rig.h
        .append(
            &Scope::session(&rig.id),
            "test",
            Draft::new("input", true, json!({"text":text})),
        )
        .unwrap()
        .id
}
#[tokio::test]
async fn automatic_compaction_appends_summary_and_preserves_original_history() {
    let rig = Rig::with(
        vec![text("concise old facts"), text("answer")],
        vec![],
        vec![],
        json!({"context_tokens":1000}),
    )
    .await;
    let old = seed(&rig, &"old facts ".repeat(2000));
    assert_eq!(rig.run("new request").await.outcome, Outcome::Completed);
    let data = rig.data();
    assert!(
        data.entries
            .iter()
            .any(|e| e.id == old && e.content.is_some())
    );
    let summary = data.entries.iter().find(|e| e.kind == "summary").unwrap();
    assert!(summary.copies.contains(&old));
    let requests = rig.probe.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].tools.is_empty());
    assert!(requests[0].system.contains("Summarize"));
    let normal = serde_json::to_string(&requests[1]).unwrap();
    assert!(normal.contains("concise old facts"));
    assert!(normal.contains("new request"));
    assert!(!normal.contains(&"old facts ".repeat(30)));
}
#[tokio::test]
async fn context_overflow_compacts_and_retries_the_same_step_once() {
    let rig = Rig::new(vec![
        provider_fake::Script::failure(FailureKind::ContextTooLarge),
        text("old summary"),
        text("recovered"),
    ])
    .await;
    seed(&rig, "old details");
    let result = rig.run("new question").await;
    assert_eq!(result.outcome, Outcome::Completed);
    assert_eq!(result.steps, 1);
    assert_eq!(rig.probe.requests.lock().unwrap().len(), 3);
    assert_eq!(
        rig.data()
            .entries
            .iter()
            .filter(|e| e.kind == "summary")
            .count(),
        1
    );
}
#[tokio::test]
async fn repeated_context_failure_is_bounded_and_retains_history() {
    let rig = Rig::new(vec![
        provider_fake::Script::failure(FailureKind::ContextTooLarge),
        text("summary"),
        provider_fake::Script::failure(FailureKind::ContextTooLarge),
    ])
    .await;
    let old = seed(&rig, "old facts");
    assert_eq!(rig.run("new").await.outcome, Outcome::Failed);
    assert_eq!(rig.probe.requests.lock().unwrap().len(), 3);
    assert!(
        rig.data()
            .entries
            .iter()
            .any(|e| e.id == old && e.content.is_some())
    );
}
#[tokio::test]
async fn summary_failure_does_not_delete_or_silently_drop_context() {
    let rig = Rig::with(
        vec![provider_fake::Script::failure(FailureKind::Temporary)],
        vec![],
        vec![],
        json!({"context_tokens":100}),
    )
    .await;
    let old = seed(&rig, &"too long ".repeat(1000));
    assert_eq!(rig.run("new").await.outcome, Outcome::Failed);
    assert!(
        rig.data()
            .entries
            .iter()
            .any(|e| e.id == old && e.content.is_some())
    );
    assert!(!rig.data().entries.iter().any(|e| e.kind == "summary"));
}
#[tokio::test]
async fn compact_command_uses_auxiliary_inference_without_starting_a_turn() {
    let rig = Rig::new(vec![text("first"), text("summary")]).await;
    rig.run("first question").await;
    let before = rig
        .data()
        .entries
        .iter()
        .filter(|e| e.kind == "turn.start")
        .count();
    let receipt = rig
        .h
        .submit(&rig.id, "user", "/compact", Timing::Now, None)
        .await
        .unwrap();
    assert_eq!(receipt.command.unwrap()["compacted"], true);
    assert_eq!(
        rig.data()
            .entries
            .iter()
            .filter(|e| e.kind == "turn.start")
            .count(),
        before
    );
    assert!(rig.h.run_next(&rig.id).await.unwrap().is_none());
}
#[tokio::test]
async fn commands_change_recorded_settings_without_model_inference() {
    let rig = Rig::new(vec![text("answer")]).await;
    for command in ["/model fake", "/thinking high"] {
        rig.h
            .submit(&rig.id, "user", command, Timing::Now, None)
            .await
            .unwrap();
    }
    assert!(rig.probe.requests.lock().unwrap().is_empty());
    assert_eq!(rig.data().settings["thinking"], "high");
    assert_eq!(
        rig.data()
            .entries
            .iter()
            .filter(|e| e.kind == "settings")
            .count(),
        2
    );
    rig.run("question").await;
    assert_eq!(rig.probe.requests.lock().unwrap()[0].thinking, "high");
    rig.h.close(&rig.id).await.unwrap();
    rig.h.open(&rig.id).await.unwrap();
    assert_eq!(rig.data().settings["thinking"], "high");
}
#[tokio::test]
async fn global_settings_merge_with_project_defaults_and_context_follows_project() {
    let rig = Rig::new(vec![text("first"), text("second")]).await;
    std::fs::write(
        rig.root.path().join("settings.json"),
        r#"{"thinking":"medium","output_limit":777,"step_limit":9}"#,
    )
    .unwrap();
    let second = tempfile::TempDir::new().unwrap();
    std::fs::write(
        second.path().join(".modular-agent.json"),
        r#"{"thinking":"high","step_limit":4,"model":"fake"}"#,
    )
    .unwrap();
    std::fs::write(second.path().join("AGENTS.md"), "SECOND-PROJECT-ONLY").unwrap();
    let id = rig.h.create(second.path(), json!({})).await.unwrap();
    let data = rig.h.snapshot(&id).unwrap();
    assert_eq!(data.settings["thinking"], "high");
    assert_eq!(data.settings["output_limit"], 777);
    assert_eq!(data.settings["step_limit"], 4);
    rig.run("first").await;
    rig.h
        .submit(&id, "user", "second", Timing::Now, None)
        .await
        .unwrap();
    rig.h.run_next(&id).await.unwrap();
    let requests = rig.probe.requests.lock().unwrap();
    assert!(!requests[0].system.contains("SECOND-PROJECT-ONLY"));
    assert!(requests[1].system.contains("SECOND-PROJECT-ONLY"));
    assert_eq!(rig.h.list(Some(second.path())).unwrap().len(), 1);
}
#[tokio::test]
async fn input_keys_survive_reopen_and_branches() {
    let rig = Rig::new(vec![text("answer")]).await;
    let receipt = rig
        .h
        .submit(
            &rig.id,
            "user",
            "taken once",
            Timing::Now,
            Some("key".into()),
        )
        .await
        .unwrap();
    rig.h.run_next(&rig.id).await.unwrap();
    rig.h.move_position(&Scope::session(&rig.id), None).unwrap();
    rig.h.close(&rig.id).await.unwrap();
    rig.h.open(&rig.id).await.unwrap();
    let duplicate = rig
        .h
        .submit(
            &rig.id,
            "user",
            "taken once",
            Timing::Now,
            Some("key".into()),
        )
        .await
        .unwrap();
    assert!(duplicate.duplicate);
    assert_eq!(duplicate.input, receipt.input);
    assert!(rig.h.run_next(&rig.id).await.unwrap().is_none());
}
#[tokio::test]
async fn erasure_of_input_reaches_turn_results_summaries_and_forks_but_agent_can_continue() {
    let rig = Rig::new(vec![
        text("COPY-SECRET"),
        text("summary COPY-SECRET"),
        text("after erasure"),
    ])
    .await;
    rig.run("remember COPY-SECRET").await;
    rig.h
        .submit(&rig.id, "user", "/compact", Timing::Now, None)
        .await
        .unwrap();
    let fork = rig.h.fork(&Scope::session(&rig.id), None).unwrap();
    let input = rig
        .data()
        .entries
        .iter()
        .find(|e| e.kind == "input")
        .unwrap()
        .id
        .clone();
    rig.h
        .erase(&Scope::session(&rig.id), vec![input])
        .await
        .unwrap();
    assert!(
        rig.probe.requests.lock().unwrap().is_empty(),
        "controlled Provider recordings must be erased too"
    );
    for session in [&rig.id, &fork] {
        assert!(
            !serde_json::to_string(&rig.h.snapshot(session).unwrap())
                .unwrap()
                .contains("COPY-SECRET")
        );
    }
    for path in std::fs::read_dir(rig.root.path().join("sessions")).unwrap() {
        let path = path.unwrap().path();
        if path.extension().is_some_and(|s| s == "json") {
            assert!(
                !std::fs::read_to_string(path)
                    .unwrap()
                    .contains("COPY-SECRET")
            );
        }
    }
    assert_eq!(rig.run("what now?").await.outcome, Outcome::Completed);
}
#[tokio::test]
async fn keyed_commands_are_taken_once_and_their_receipts_pass_the_output_gate() {
    let rig = Rig::with(
        vec![],
        vec![Arc::new(ExtraCommand)],
        vec!["SECRET".into()],
        json!({}),
    )
    .await;
    let first = rig
        .h
        .submit(
            &rig.id,
            "user",
            "/hello SECRET",
            Timing::Now,
            Some("command-key".into()),
        )
        .await
        .unwrap();
    assert_eq!(first.command.as_ref().unwrap()["hello"], "[REDACTED]");
    let second = rig
        .h
        .submit(
            &rig.id,
            "user",
            "/hello SECRET",
            Timing::Now,
            Some("command-key".into()),
        )
        .await
        .unwrap();
    assert!(second.duplicate);
    assert_eq!(first.input, second.input);
    assert_eq!(second.command.as_ref().unwrap()["hello"], "[REDACTED]");
    assert_eq!(
        rig.data()
            .entries
            .iter()
            .filter(|e| e.kind == "command")
            .count(),
        1
    );
}
#[tokio::test]
async fn model_selection_changes_the_bound_access_without_runtime_selection() {
    let rig = Rig::new(vec![text("first"), text("second")]).await;
    rig.run("first").await;
    rig.h
        .submit(&rig.id, "user", "/model fake-alt", Timing::Now, None)
        .await
        .unwrap();
    rig.run("second").await;
    let models = rig
        .data()
        .entries
        .iter()
        .filter(|e| e.kind == "turn.start")
        .map(|e| {
            e.content.as_ref().unwrap()["model"]["name"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect::<Vec<_>>();
    assert_eq!(models, vec!["fake", "fake-alt"]);
}
#[tokio::test]
async fn a_fork_preserves_the_compacted_model_view() {
    let rig = Rig::new(vec![
        text("old answer"),
        text("summary-only facts"),
        text("fork answer"),
    ])
    .await;
    rig.run("original question").await;
    rig.h
        .submit(&rig.id, "user", "/compact", Timing::Now, None)
        .await
        .unwrap();
    let fork = rig.h.fork(&Scope::session(&rig.id), None).unwrap();
    rig.h
        .submit(&fork, "user", "continue fork", Timing::Now, None)
        .await
        .unwrap();
    assert_eq!(
        rig.h.run_next(&fork).await.unwrap().unwrap().outcome,
        Outcome::Completed
    );
    let request = serde_json::to_string(&rig.probe.requests.lock().unwrap()[2]).unwrap();
    assert!(request.contains("summary-only facts"));
    assert!(!request.contains("original question"));
}
struct ExtraCommand;
impl Plugin for ExtraCommand {
    fn name(&self) -> &str {
        "test.command"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.command(
            "hello",
            handler(|_, scope, v| {
                Box::pin(async move { Ok(answer(json!({"actor":scope.actor,"hello":v["args"]}))) })
            }),
        )
    }
}
#[tokio::test]
async fn plugins_register_slash_commands_without_a_model_request() {
    let rig = Rig::with(vec![], vec![Arc::new(ExtraCommand)], vec![], json!({})).await;
    let receipt = rig
        .h
        .submit(&rig.id, "user", "/hello world", Timing::Now, None)
        .await
        .unwrap();
    assert_eq!(
        receipt.command.unwrap(),
        json!({"actor":"user","hello":"world"})
    );
    assert!(rig.probe.requests.lock().unwrap().is_empty());
}
