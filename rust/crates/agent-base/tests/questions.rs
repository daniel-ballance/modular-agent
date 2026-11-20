mod support;
use agent_api::*;
use std::{sync::Arc, time::Duration};
use support::*;

async fn start(rig: &Rig) -> tokio::task::JoinHandle<Result<Option<TurnResult>>> {
    rig.h
        .submit(&rig.id, "user", "start", Timing::Now, None)
        .await
        .unwrap();
    let h = rig.h.clone();
    let id = rig.id.clone();
    tokio::spawn(async move { h.run_next(&id).await })
}
fn open(rig: &Rig) -> Question {
    questions(&rig.data())
        .unwrap()
        .into_iter()
        .find(|q| q.answerable)
        .unwrap()
}
async fn answer(rig: &Rig, q: &Question, value: Value) {
    requests(rig.h.as_ref())
        .unwrap()
        .answer(rig.h.clone(), &rig.id, "user", &q.id, value, false)
        .await
        .unwrap();
}
#[tokio::test]
async fn viewer_sees_but_cannot_answer_and_cannot_escalate_a_grant() {
    let rig = Rig::new(vec![]).await;
    let owner = Scope::session(&rig.id);
    rig.h
        .grant(&owner, "viewer", Authority::only(&["watch", "grant"]))
        .unwrap();
    let viewer = Scope {
        actor: "viewer".into(),
        ..owner.clone()
    };
    assert!(rig.h.grant(&viewer, "other", Authority::full()).is_err());
    rig.h
        .grant(&viewer, "other", Authority::only(&["watch"]))
        .unwrap();
    let svc = requests(rig.h.as_ref()).unwrap();
    let mut q = Question::new(owner, RequestKind::Text, "Your name?");
    q.timeout_ms = Some(1);
    assert!(matches!(
        svc.ask(rig.h.clone(), q, CancellationToken::new())
            .await
            .unwrap(),
        RequestReply::Waiting
    ));
    let q = svc
        .visible(rig.h.as_ref(), &rig.id, "viewer")
        .unwrap()
        .pop()
        .unwrap();
    assert!(
        svc.answer(rig.h.clone(), &rig.id, "viewer", &q.id, json!("bad"), false)
            .await
            .is_err()
    );
    answer(&rig, &q, json!("Ada")).await;
    assert!(
        svc.answer(rig.h.clone(), &rig.id, "user", &q.id, json!("again"), false)
            .await
            .is_err()
    );
    assert_eq!(
        rig.data()
            .entries
            .iter()
            .filter(|e| e.kind == "request.answer")
            .count(),
        1
    );
}
#[tokio::test]
async fn ask_user_waits_in_the_same_turn_for_text_and_choice() {
    for (kind, value) in [("text", json!("hello")), ("choice", json!("a"))] {
        let rig = Rig::new(vec![
            calls(vec![ToolCall::new(
                "ask_user",
                json!({"kind":kind,"question":"Answer?","options":["a","b"]}),
            )]),
            text("got answer"),
        ])
        .await;
        let task = start(&rig).await;
        rig.events.wait("request.opened").await;
        assert!(rig.h.is_running(&rig.id));
        let q = open(&rig);
        answer(&rig, &q, value.clone()).await;
        assert_eq!(
            task.await.unwrap().unwrap().unwrap().outcome,
            Outcome::Completed
        );
        assert_eq!(rig.results()[0].text, value.to_string());
        assert_eq!(
            rig.data()
                .entries
                .iter()
                .filter(|e| e.kind == "turn.start")
                .count(),
            1
        );
    }
}
#[tokio::test]
async fn secret_answer_exists_only_in_the_credential_store() {
    let rig = Rig::new(vec![
        calls(vec![ToolCall::new(
            "ask_user",
            json!({"kind":"secret","question":"Token?","credential":"service_token"}),
        )]),
        text("stored service_token"),
    ])
    .await;
    let task = start(&rig).await;
    rig.events.wait("request.opened").await;
    answer(&rig, &open(&rig), json!("UNIQUE-PRIVATE-VALUE-937")).await;
    assert_eq!(
        task.await.unwrap().unwrap().unwrap().outcome,
        Outcome::Completed
    );
    let store: Arc<dyn CredentialStore> = capability(rig.h.as_ref(), "credentials").unwrap();
    assert_eq!(
        store.get("service_token").unwrap(),
        "UNIQUE-PRIVATE-VALUE-937"
    );
    for value in [
        json!(rig.data()),
        json!(*rig.events.values.lock().unwrap()),
        json!(*rig.probe.requests.lock().unwrap()),
    ] {
        assert!(!value.to_string().contains("UNIQUE-PRIVATE-VALUE-937"));
    }
    assert!(rig.results()[0].text.contains("service_token"));
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(rig.root.path().join("answers/credentials.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}
#[tokio::test]
async fn secret_without_destination_is_declined_before_asking() {
    let rig = Rig::new(vec![
        calls(vec![ToolCall::new(
            "ask_user",
            json!({"kind":"secret","question":"Token?"}),
        )]),
        text("declined"),
    ])
    .await;
    assert_eq!(rig.run("start").await.outcome, Outcome::Completed);
    assert!(questions(&rig.data()).unwrap().is_empty());
    assert_eq!(rig.results()[0].status, ToolStatus::Refused);
}
#[tokio::test]
async fn keyed_answer_reuses_only_on_its_branch_and_while_authorized() {
    let rig = Rig::new(vec![]).await;
    let svc = requests(rig.h.as_ref()).unwrap();
    let before = rig
        .h
        .append(
            &Scope::session(&rig.id),
            "test",
            Draft::new("marker", false, json!({})),
        )
        .unwrap()
        .id;
    let mut q = Question::new(Scope::session(&rig.id), RequestKind::Approval, "Allow?");
    q.options = vec!["allow".into(), "refuse".into()];
    q.key = Some("stable".into());
    q.timeout_ms = Some(1);
    svc.presence(&rig.id, "user", true);
    svc.ask(rig.h.clone(), q.clone(), CancellationToken::new())
        .await
        .unwrap();
    answer(&rig, &open(&rig), json!("allow")).await;
    assert!(matches!(
        svc.ask(rig.h.clone(), q.clone(), CancellationToken::new())
            .await
            .unwrap(),
        RequestReply::Answer(_)
    ));
    rig.h
        .grant(
            &Scope::session(&rig.id),
            "user",
            Authority::only(&["watch", "grant", "settings"]),
        )
        .unwrap();
    assert!(matches!(
        svc.ask(rig.h.clone(), q.clone(), CancellationToken::new())
            .await
            .unwrap(),
        RequestReply::Declined
    ));
    assert_eq!(
        rig.data()
            .entries
            .iter()
            .filter(|e| e.kind == "request.open")
            .count(),
        2
    );
    rig.h
        .move_position(&Scope::session(&rig.id), Some(before))
        .unwrap();
    assert!(matches!(
        svc.ask(rig.h.clone(), q, CancellationToken::new())
            .await
            .unwrap(),
        RequestReply::Declined
    ));
    assert_eq!(questions(&rig.data()).unwrap().len(), 1);
}
#[tokio::test]
async fn approval_policies_read_only_always_never_off_and_no_answerer() {
    for (policy, tool, asked, status, present) in [
        (
            "ask_unless_read_only",
            "read",
            false,
            ToolStatus::Completed,
            false,
        ),
        ("ask_always", "read", true, ToolStatus::Completed, true),
        ("ask_always", "write", true, ToolStatus::Refused, true),
        (
            "ask_unless_read_only",
            "write",
            true,
            ToolStatus::Completed,
            true,
        ),
        ("never_ask", "read", false, ToolStatus::Refused, true),
        ("off", "write", false, ToolStatus::Completed, false),
        ("ask_always", "write", false, ToolStatus::Refused, false),
    ] {
        let rig = Rig::with(
            vec![
                calls(vec![ToolCall::new(
                    tool,
                    if tool == "read" {
                        json!({"path":"AGENTS.md"})
                    } else {
                        json!({"path":"AGENTS.md","content":"ok"})
                    },
                )]),
                text("done"),
            ],
            vec![],
            vec![],
            json!({"approval":policy}),
        )
        .await;
        requests(rig.h.as_ref())
            .unwrap()
            .presence(&rig.id, "user", present);
        let task = start(&rig).await;
        if asked {
            rig.events.wait("request.opened").await;
            answer(
                &rig,
                &open(&rig),
                json!(if status == ToolStatus::Refused {
                    "refuse"
                } else {
                    "allow"
                }),
            )
            .await;
        }
        assert_eq!(
            task.await.unwrap().unwrap().unwrap().outcome,
            Outcome::Completed
        );
        assert_eq!(rig.results()[0].status, status, "{policy}/{tool}");
        if !asked {
            assert!(
                !rig.events
                    .values
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|e| e.kind == "request.opened")
            );
        }
    }
}
#[tokio::test]
async fn deadline_leaves_no_result_and_late_answer_starts_a_new_turn() {
    let rig = Rig::new(vec![
        calls(vec![ToolCall::new(
            "ask_user",
            json!({"kind":"choice","question":"Which?","options":["a","b"],"timeout_ms":1}),
        )]),
        text("continued with a"),
    ])
    .await;
    let first = rig.run("start").await;
    assert_eq!(first.outcome, Outcome::Completed);
    assert_eq!(first.limit, None);
    assert_eq!(first.open_calls.len(), 1);
    assert!(rig.results().is_empty());
    assert!(rig.h.run_next(&rig.id).await.unwrap().is_none());
    let q = open(&rig);
    assert!(q.timeout_ms.is_none());
    answer(&rig, &q, json!("a")).await;
    assert_eq!(
        rig.h.run_next(&rig.id).await.unwrap().unwrap().text,
        "continued with a"
    );
    assert_eq!(rig.results().len(), 1);
    assert_eq!(rig.results()[0].status, ToolStatus::Completed);
    assert_eq!(
        rig.data()
            .entries
            .iter()
            .filter(|e| e.kind == "turn.start")
            .count(),
        2
    );
}
#[tokio::test]
async fn expired_approval_leaves_no_open_call_and_cannot_be_answered() {
    let rig = Rig::with(
        vec![calls(vec![ToolCall::new(
            "write",
            json!({"path":"must-not-exist","content":"bad"}),
        )])],
        vec![],
        vec![],
        json!({"approval":"ask_always","approval_timeout_ms":1}),
    )
    .await;
    let svc = requests(rig.h.as_ref()).unwrap();
    svc.presence(&rig.id, "user", true);
    assert!(rig.run("start").await.open_calls.is_empty());
    let question = questions(&rig.data()).unwrap().pop().unwrap();
    assert!(!question.answerable);
    assert!(
        svc.answer(
            rig.h.clone(),
            &rig.id,
            "user",
            &question.id,
            json!("allow"),
            false
        )
        .await
        .is_err()
    );
    assert!(rig.h.run_next(&rig.id).await.unwrap().is_none());
    assert!(!rig.project.path().join("must-not-exist").exists());
    assert_eq!(rig.results()[0].status, ToolStatus::Refused);
}
#[tokio::test]
async fn cancelling_a_wait_closes_the_question_and_records_one_cancelled_result() {
    let rig = Rig::new(vec![calls(vec![ToolCall::new(
        "ask_user",
        json!({"question":"Wait?"}),
    )])])
    .await;
    let task = start(&rig).await;
    rig.events.wait("request.opened").await;
    rig.h.cancel(&rig.id).await.unwrap();
    let result = tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(result.outcome, Outcome::Cancelled);
    assert!(
        questions(&rig.data())
            .unwrap()
            .iter()
            .all(|q| !q.answerable)
    );
    assert_eq!(rig.results().len(), 1);
}
struct Validator;
impl Plugin for Validator {
    fn name(&self) -> &str {
        "test.validator"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.on(
            "runtime.result.ready",
            Order::Normal,
            handler(|_, _, value| {
                Box::pin(async move {
                    Ok(if value["text"] != "valid" {
                        agent_api::answer(json!({"retry_reason":"Return valid, not invalid."}))
                    } else {
                        agent_api::answer(value)
                    })
                })
            }),
        );
        Ok(())
    }
}
#[tokio::test]
async fn validation_sends_the_model_back_with_a_reason_inside_one_turn() {
    let rig = Rig::with(
        vec![text("invalid"), text("valid")],
        vec![Arc::new(Validator)],
        vec![],
        json!({}),
    )
    .await;
    assert_eq!(rig.run("start").await.text, "valid");
    assert_eq!(
        rig.data()
            .entries
            .iter()
            .filter(|e| e.kind == "turn.start")
            .count(),
        1
    );
    assert!(
        rig.probe.requests.lock().unwrap()[1]
            .messages
            .iter()
            .any(|m| m.text_content().contains("Return valid"))
    );
}
#[tokio::test]
async fn ui_calls_share_approval_and_record_the_actor_even_when_refused() {
    for allowed in [true, false] {
        let rig = Rig::with(
            vec![],
            vec![],
            vec![],
            json!({"approval":if allowed { "off" } else { "never_ask" }}),
        )
        .await;
        let runtime: Arc<dyn Runtime> = capability(rig.h.as_ref(), "runtime").unwrap();
        let result = runtime
            .tool(
                rig.h.clone(),
                Scope::session(&rig.id),
                ToolCall::new("write", json!({"path":"ui-file","content":"ui"})),
            )
            .await
            .unwrap();
        assert_eq!(
            result.status,
            if allowed {
                ToolStatus::Completed
            } else {
                ToolStatus::Refused
            }
        );
        let call = rig
            .data()
            .entries
            .into_iter()
            .find(|e| e.kind == "tool.call")
            .unwrap();
        assert_eq!(call.scope.actor, "user");
        assert_eq!(call.content.unwrap()["started_by"], "user");
        assert_eq!(rig.project.path().join("ui-file").exists(), allowed);
        assert!(rig.probe.requests.lock().unwrap().is_empty());
    }
}
