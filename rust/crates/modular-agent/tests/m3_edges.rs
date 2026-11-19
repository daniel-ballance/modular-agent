mod support;
use agent_api::*;
use std::{sync::Arc, time::Duration};
use support::*;
#[tokio::test]
async fn prose_authority_is_rejected_before_starting_a_child() {
    let rig = Rig::new(vec![]).await;
    let rt: Arc<dyn Runtime> = capability(rig.h.as_ref(), "runtime").unwrap();
    let result = rt
        .tool(
            rig.h.clone(),
            Scope::session(&rig.id),
            ToolCall::new(
                "delegate",
                json!({"task":"child","authority":["bash exactly once"]}),
            ),
        )
        .await
        .unwrap();
    assert_eq!(result.status, ToolStatus::Failed);
    assert!(result.text.contains("named rights"));
    assert!(jobs(&rig.data()).unwrap().is_empty());
    assert!(rig.probe.requests.lock().unwrap().is_empty());
}
#[test]
fn openai_translates_shared_reasoning_levels_at_the_vendor_boundary() {
    for (shared, effort) in [
        ("off", "none"),
        ("minimal", "minimal"),
        ("low", "low"),
        ("medium", "medium"),
        ("high", "high"),
        ("xhigh", "xhigh"),
    ] {
        let request = ModelRequest {
            thinking: shared.into(),
            ..ModelRequest::default()
        };
        let body = provider_openai::request_body(&request).unwrap();
        assert_eq!(body["reasoning"]["effort"], effort, "{shared}");
        assert_eq!(
            wire::request(&request, None)["settings"]["reasoning"],
            shared
        );
    }
}

#[test]
fn openai_optional_tool_fields_are_strict_only_at_the_vendor_boundary() {
    let definition = ToolDefinition {
        name: "delegate".into(),
        description: "test".into(),
        input: json!({"type":"object","properties":{"task":{"type":"string"},"authority":{"type":"array","items":{"type":"string"}}},"required":["task"]}),
        read_only: false,
        safe_to_repeat: true,
        parallel: false,
        hints: json!({}),
    };
    let request = ModelRequest {
        tools: vec![definition],
        ..ModelRequest::default()
    };
    let body = provider_openai::request_body(&request).unwrap();
    let schema = &body["tools"][0]["parameters"];
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(schema["required"].as_array().unwrap().len(), 2);
    assert_eq!(
        schema["properties"]["authority"]["anyOf"][1]["type"],
        "null"
    );
    let response = json!({"status":"completed","output":[{"type":"function_call","call_id":"c1","name":"delegate","arguments":json!({"task":"child","authority":null}).to_string()}]});
    let normalized = provider_openai::normalize_for(&request, &response).unwrap();
    assert_eq!(normalized.tool_calls()[0].input, json!({"task":"child"}));
    assert!(normalized.opaque.to_string().contains("authority"));
}
#[tokio::test]
async fn steering_narrows_work_to_every_contributor_and_records_its_actor() {
    let mut first = text("thinking");
    first.delay_ms = 30;
    let rig = Rig::new(vec![
        first,
        calls(vec![ToolCall::new(
            "write",
            json!({"path":"forbidden","content":"bad"}),
        )]),
        text("refused"),
    ])
    .await;
    rig.h
        .grant(
            &Scope::session(&rig.id),
            "guest",
            Authority::only(&["watch", "input"]),
        )
        .unwrap();
    rig.h
        .submit(&rig.id, "user", "start", Timing::Now, None)
        .await
        .unwrap();
    let h = rig.h.clone();
    let id = rig.id.clone();
    let task = tokio::spawn(async move { h.run_next(&id).await });
    rig.events.wait("step.start").await;
    rig.h
        .submit(&rig.id, "guest", "please write", Timing::Steer, None)
        .await
        .unwrap();
    assert_eq!(
        task.await.unwrap().unwrap().unwrap().outcome,
        Outcome::Completed
    );
    assert_eq!(rig.results()[0].status, ToolStatus::Refused);
    assert!(!rig.project.path().join("forbidden").exists());
    assert!(
        rig.data()
            .entries
            .iter()
            .any(|e| e.kind == "input" && e.scope.actor == "guest")
    );
}
#[tokio::test]
async fn work_cannot_gain_authority_that_was_missing_when_input_was_admitted() {
    let rig = Rig::new(vec![
        calls(vec![ToolCall::new(
            "write",
            json!({"path":"forbidden","content":"bad"}),
        )]),
        text("refused"),
    ])
    .await;
    rig.h
        .grant(
            &Scope::session(&rig.id),
            "guest",
            Authority::only(&["watch", "input"]),
        )
        .unwrap();
    rig.h
        .submit(&rig.id, "guest", "start", Timing::Now, None)
        .await
        .unwrap();
    rig.h
        .grant(&Scope::session(&rig.id), "guest", Authority::full())
        .unwrap();
    rig.h.run_next(&rig.id).await.unwrap();
    assert_eq!(rig.results()[0].status, ToolStatus::Refused);
}
#[tokio::test]
async fn two_open_calls_wait_for_both_answers_and_new_input_sees_only_view_placeholders() {
    let rig = Rig::new(vec![
        calls(vec![
            ToolCall::new("ask_user", json!({"question":"First?","timeout_ms":1})),
            ToolCall::new("ask_user", json!({"question":"Second?","timeout_ms":1})),
        ]),
        text("still waiting"),
        text("both answered"),
    ])
    .await;
    assert_eq!(rig.run("start").await.open_calls.len(), 2);
    assert!(rig.results().is_empty());
    assert_eq!(rig.run("new input during wait").await.text, "still waiting");
    assert!(
        rig.probe.requests.lock().unwrap()[1]
            .messages
            .iter()
            .any(|m| m.role == "tool" && m.text_content().contains("Waiting"))
    );
    assert!(!rig.data().entries.iter().any(|e| e.kind == "tool.result"));
    let svc = requests(rig.h.as_ref()).unwrap();
    let qs = svc.visible(rig.h.as_ref(), &rig.id, "user").unwrap();
    svc.answer(
        rig.h.clone(),
        &rig.id,
        "user",
        &qs[0].id,
        json!("one"),
        false,
    )
    .await
    .unwrap();
    assert!(
        rig.h.run_next(&rig.id).await.unwrap().is_none(),
        "the whole call group must be ready"
    );
    svc.answer(
        rig.h.clone(),
        &rig.id,
        "user",
        &qs[1].id,
        json!("two"),
        false,
    )
    .await
    .unwrap();
    assert_eq!(
        rig.h.run_next(&rig.id).await.unwrap().unwrap().text,
        "both answered"
    );
    assert_eq!(rig.results().len(), 2);
}
#[tokio::test]
async fn concurrent_answers_accept_exactly_one_and_leaving_the_branch_refuses_an_answer() {
    let rig = Rig::new(vec![]).await;
    let marker = rig
        .h
        .append(
            &Scope::session(&rig.id),
            "test",
            Draft::new("marker", false, json!({})),
        )
        .unwrap();
    let mut q = Question::new(Scope::session(&rig.id), RequestKind::Text, "Answer?");
    q.timeout_ms = Some(1);
    let svc = requests(rig.h.as_ref()).unwrap();
    svc.ask(rig.h.clone(), q, CancellationToken::new())
        .await
        .unwrap();
    let q = svc
        .visible(rig.h.as_ref(), &rig.id, "user")
        .unwrap()
        .pop()
        .unwrap();
    let (a, b) = tokio::join!(
        svc.answer(rig.h.clone(), &rig.id, "user", &q.id, json!("one"), false),
        svc.answer(rig.h.clone(), &rig.id, "user", &q.id, json!("two"), false)
    );
    assert_ne!(a.is_ok(), b.is_ok());
    rig.h
        .move_position(&Scope::session(&rig.id), Some(marker.id))
        .unwrap();
    assert!(
        svc.answer(rig.h.clone(), &rig.id, "user", &q.id, json!("three"), false)
            .await
            .is_err()
    );
}
#[tokio::test]
async fn secret_without_a_writable_store_and_invalid_destinations_never_ask() {
    let h = agent_harness::Harness::new();
    h.load(Arc::new(feature_questions::QuestionsPlugin))
        .await
        .unwrap();
    let root = tempfile::TempDir::new().unwrap();
    let id = h.create(root.path(), json!({})).await.unwrap();
    let mut q = Question::new(Scope::session(&id), RequestKind::Secret, "Secret?");
    q.credential = Some("token".into());
    assert!(matches!(
        requests(h.as_ref())
            .unwrap()
            .ask(h.clone(), q, CancellationToken::new())
            .await
            .unwrap(),
        RequestReply::Declined
    ));
    assert!(
        h.snapshot(&id)
            .unwrap()
            .entries
            .iter()
            .all(|e| e.kind == "plugins.changed")
    );
    let rig = Rig::new(vec![]).await;
    for name in ["openai", "../outside"] {
        let mut q = Question::new(Scope::session(&rig.id), RequestKind::Secret, "Secret?");
        q.credential = Some(name.into());
        assert!(matches!(
            requests(rig.h.as_ref())
                .unwrap()
                .ask(rig.h.clone(), q, CancellationToken::new())
                .await
                .unwrap(),
            RequestReply::Declined
        ));
    }
}
#[tokio::test]
async fn revoking_parent_authority_narrows_an_already_running_child() {
    let mut child = calls(vec![ToolCall::new(
        "write",
        json!({"path":"forbidden","content":"bad"}),
    )])
    .for_task("child");
    child.delay_ms = 30;
    let rig = Rig::new(vec![child, text("refused").for_task("child")]).await;
    let rt: Arc<dyn Runtime> = capability(rig.h.as_ref(), "runtime").unwrap();
    rt.tool(
        rig.h.clone(),
        Scope::session(&rig.id),
        ToolCall::new("delegate", json!({"task":"child"})),
    )
    .await
    .unwrap();
    let j = jobs(&rig.data()).unwrap().pop().unwrap();
    let mut cap = Authority::full();
    cap.0.remove("tools");
    rig.h.grant(&Scope::session(&rig.id), "user", cap).unwrap();
    let ended = tokio::time::timeout(
        Duration::from_secs(2),
        job_service(rig.h.as_ref())
            .unwrap()
            .wait(rig.h.clone(), &rig.id, &j.id),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(ended.state, JobState::Completed);
    assert!(!rig.project.path().join("forbidden").exists());
    let child = j.detail["child"].as_str().unwrap();
    assert!(!rig.h.authority(child, "user").unwrap().has("tools"));
    rig.h.close(&rig.id).await.unwrap();
}
