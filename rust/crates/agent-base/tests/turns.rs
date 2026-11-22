mod support;
#[tokio::test]
async fn command_setup_failure_is_a_failed_tool_result_not_a_hung_or_panicked_turn() {
    let rig = support::Rig::new(vec![
        support::calls(vec![ToolCall::new(
            "bash",
            json!({"command":"invalid\u{0}command"}),
        )]),
        support::text("handled failure"),
    ])
    .await;
    let result = tokio::time::timeout(std::time::Duration::from_secs(3), rig.run("start"))
        .await
        .unwrap();
    assert_eq!(result.outcome, Outcome::Completed);
    assert_eq!(rig.results()[0].status, ToolStatus::Failed);
}

use agent_api::*;
use std::{sync::Arc, time::Duration};
use support::*;

#[tokio::test]
async fn model_read_answer_uses_project_tools_prompt_and_bound_model() {
    let rig = Rig::new(vec![
        calls(vec![ToolCall::new("read", json!({"path":"fact.txt"}))]),
        text("The code is 417."),
    ])
    .await;
    std::fs::write(rig.project.path().join("fact.txt"), "code=417").unwrap();
    let result = rig.run("Read fact.txt and answer.").await;
    assert_eq!(result.outcome, Outcome::Completed);
    assert_eq!(result.steps, 2);
    assert_eq!(rig.results()[0].text, "code=417");
    let data = rig.data();
    let checkpoints: Vec<_> = data
        .entries
        .iter()
        .filter(|e| {
            matches!(
                e.kind.as_str(),
                "model.request" | "model.response" | "tool.started" | "tool.result"
            )
        })
        .collect();
    assert_eq!(
        checkpoints
            .iter()
            .map(|e| e.kind.as_str())
            .collect::<Vec<_>>(),
        [
            "model.request",
            "model.response",
            "tool.started",
            "tool.result",
            "model.request",
            "model.response"
        ]
    );
    assert_eq!(checkpoints[0].scope.step, checkpoints[1].scope.step);
    assert_eq!(checkpoints[2].scope.call, checkpoints[3].scope.call);
    assert_eq!(checkpoints[4].scope.step, checkpoints[5].scope.step);
    assert_ne!(checkpoints[0].scope.step, checkpoints[4].scope.step);
    let requests = rig.probe.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(
        requests[0]
            .system
            .contains("Project instruction: answer briefly.")
    );
    assert!(
        requests[1]
            .messages
            .iter()
            .any(|m| m.role == "tool" && m.text_content().contains("code=417"))
    );
    assert!(requests[0].tools.iter().any(|t| t.name == "ask_user"));
    assert!(
        !serde_json::to_string(&*requests)
            .unwrap()
            .contains("NONEXISTENT-KEY")
    );
}
#[tokio::test]
async fn write_edit_read_and_bash_use_the_session_project() {
    let rig = Rig::new(vec![
        calls(vec![
            ToolCall::new("write", json!({"path":"nested/file","content":"one two"})),
            ToolCall::new(
                "edit",
                json!({"path":"nested/file","old":"two","new":"three"}),
            ),
            ToolCall::new("read", json!({"path":"nested/file"})),
            ToolCall::new("bash", json!({"command":"pwd; printf shell-output"})),
        ]),
        text("done"),
    ])
    .await;
    assert_eq!(rig.run("Do the work.").await.outcome, Outcome::Completed);
    let results = rig.results();
    assert_eq!(results.len(), 4);
    assert_eq!(results[2].text, "one three");
    assert!(
        results[3]
            .text
            .contains(rig.project.path().to_str().unwrap())
    );
    assert!(results.iter().all(|r| r.status == ToolStatus::Completed));
}
#[tokio::test]
async fn bash_progress_arrives_before_the_command_finishes() {
    let rig = Rig::new(vec![
        calls(vec![ToolCall::new(
            "bash",
            json!({"command":"printf first; sleep 0.2; printf last"}),
        )]),
        text("done"),
    ])
    .await;
    rig.h
        .submit(&rig.id, "user", "run", Timing::Now, None)
        .await
        .unwrap();
    let h = rig.h.clone();
    let id = rig.id.clone();
    let task = tokio::spawn(async move { h.run_next(&id).await });
    rig.events.wait("tool.progress").await;
    assert!(
        !rig.events
            .values
            .lock()
            .unwrap()
            .iter()
            .any(|e| e.kind == "tool.ended")
    );
    assert_eq!(
        task.await.unwrap().unwrap().unwrap().outcome,
        Outcome::Completed
    );
    assert_eq!(rig.results()[0].text, "firstlast");
}
#[tokio::test]
#[cfg_attr(
    not(target_os = "linux"),
    ignore = "checks the Linux base's immediate cleanup of background work using /proc"
)]
async fn background_shell_returns_and_leaves_no_process() {
    let rig = Rig::new(vec![
        calls(vec![ToolCall::new(
            "bash",
            json!({"command":"sleep 60 & echo $! > child.pid; printf returned"}),
        )]),
        text("done"),
    ])
    .await;
    let result = tokio::time::timeout(Duration::from_secs(3), rig.run("run"))
        .await
        .unwrap();
    assert_eq!(result.outcome, Outcome::Completed);
    let pid = std::fs::read_to_string(rig.project.path().join("child.pid")).unwrap();
    assert!(!std::path::Path::new(&format!("/proc/{}", pid.trim())).exists());
}
#[tokio::test]
async fn failures_unknown_tools_and_invalid_input_each_have_one_result() {
    let rig = Rig::new(vec![
        calls(vec![
            ToolCall::new("missing", json!({})),
            ToolCall::new("read", json!({"path":73})),
            ToolCall::new("bash", json!({"command":"exit 7"})),
        ]),
        text("done"),
    ])
    .await;
    assert_eq!(rig.run("run").await.outcome, Outcome::Completed);
    assert_eq!(rig.results().len(), 3);
    let results = rig.results();
    assert_eq!(results[0].status, ToolStatus::Refused);
    assert!(results[1..].iter().all(|r| r.status == ToolStatus::Failed));
}
#[tokio::test]
async fn output_gate_holds_every_piece_until_it_can_redact_a_split_secret() {
    let rig = Rig::with(vec![], vec![], vec!["SECRET42".into()], json!({})).await;
    let scope = Scope::session(&rig.id);
    for text in ["a SEC", "RET42 b"] {
        let event = Event::new(&scope, "model.delta", json!(text));
        let output = rig
            .h
            .output(
                &scope,
                Output {
                    recipient: "viewer".into(),
                    value: json!(event),
                    stream: Some("split".into()),
                    end: false,
                },
            )
            .await
            .unwrap();
        assert!(
            output.is_none(),
            "a partial secret must not reach the recipient"
        );
    }
    let output = rig
        .h
        .output(
            &scope,
            Output {
                recipient: "viewer".into(),
                value: json!(Event::new(&scope, "model.end", Value::Null)),
                stream: Some("split".into()),
                end: true,
            },
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(output["content"], "a [REDACTED] b");
    assert_eq!(output["end"], true);
}
#[tokio::test]
async fn bash_streaming_keeps_utf8_characters_split_across_pipe_reads_intact() {
    let rig = Rig::new(vec![
        calls(vec![ToolCall::new(
            "bash",
            json!({"command":"printf '\\342'; sleep 0.05; printf '\\202\\254'"}),
        )]),
        text("done"),
    ])
    .await;
    assert_eq!(rig.run("run").await.outcome, Outcome::Completed);
    assert_eq!(rig.results()[0].text, "€");
    let live = rig
        .events
        .values
        .lock()
        .unwrap()
        .iter()
        .filter(|e| e.kind == "tool.progress")
        .map(|e| e.content.as_str().unwrap_or(""))
        .collect::<String>();
    assert_eq!(live, "€");
}
struct Refusal;
impl Plugin for Refusal {
    fn name(&self) -> &str {
        "test.refusal"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.on(
            "runtime.before.tool",
            Order::Normal,
            handler(|_, _, _| {
                Box::pin(async {
                    Ok(HookResult {
                        refused: Some("test policy".into()),
                        ..HookResult::default()
                    })
                })
            }),
        );
        Ok(())
    }
}
#[tokio::test]
async fn refusing_a_tool_does_not_run_it_and_records_exactly_one_result() {
    let rig = Rig::with(
        vec![
            calls(vec![ToolCall::new(
                "write",
                json!({"path":"forbidden","content":"bad"}),
            )]),
            text("refused"),
        ],
        vec![Arc::new(Refusal)],
        vec![],
        json!({}),
    )
    .await;
    assert_eq!(rig.run("run").await.outcome, Outcome::Completed);
    assert!(!rig.project.path().join("forbidden").exists());
    assert_eq!(rig.results().len(), 1);
    assert_eq!(rig.results()[0].status, ToolStatus::Refused);
}
#[tokio::test]
async fn step_limit_and_model_failure_have_matching_outcomes() {
    let rig = Rig::with(
        vec![calls(vec![ToolCall::new(
            "read",
            json!({"path":"AGENTS.md"}),
        )])],
        vec![],
        vec![],
        json!({"step_limit":1}),
    )
    .await;
    assert_eq!(rig.run("run").await.outcome, Outcome::Limit);
    assert_eq!(rig.results().len(), 1);
    let rig = Rig::new(vec![provider_fake::Script::failure(FailureKind::Temporary)]).await;
    assert_eq!(rig.run("fail").await.outcome, Outcome::Failed);
}
#[tokio::test]
async fn cancelling_a_model_request_returns_queued_input() {
    let mut delayed = text("late");
    delayed.delay_ms = 5000;
    let rig = Rig::new(vec![delayed]).await;
    rig.h
        .submit(&rig.id, "user", "start", Timing::Now, None)
        .await
        .unwrap();
    let h = rig.h.clone();
    let id = rig.id.clone();
    let task = tokio::spawn(async move { h.run_next(&id).await });
    rig.events.wait("step.start").await;
    rig.h
        .submit(&rig.id, "user", "steer", Timing::Steer, None)
        .await
        .unwrap();
    rig.h
        .submit(&rig.id, "user", "after", Timing::After, None)
        .await
        .unwrap();
    let returned = rig.h.cancel(&rig.id).await.unwrap();
    assert_eq!(
        returned.iter().map(|i| i.text.as_str()).collect::<Vec<_>>(),
        vec!["steer", "after"]
    );
    assert_eq!(
        task.await.unwrap().unwrap().unwrap().outcome,
        Outcome::Cancelled
    );
    assert!(rig.h.run_next(&rig.id).await.unwrap().is_none());
}
#[tokio::test]
async fn cancelling_bash_records_one_cancelled_result_and_stops_the_command() {
    use std::{io::Read, os::unix::fs::OpenOptionsExt};
    let rig = Rig::new(vec![calls(vec![ToolCall::new(
        "bash",
        json!({"command":"exec 3>lifetime; sleep 60 & printf ready; wait"}),
    )])])
    .await;
    let lifetime = rig.project.path().join("lifetime");
    assert!(
        std::process::Command::new("mkfifo")
            .arg(&lifetime)
            .status()
            .unwrap()
            .success()
    );
    let mut reader = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(lifetime)
        .unwrap();
    rig.h
        .submit(&rig.id, "user", "run", Timing::Now, None)
        .await
        .unwrap();
    let h = rig.h.clone();
    let id = rig.id.clone();
    let task = tokio::spawn(async move { h.run_next(&id).await });
    rig.events.wait("tool.progress").await;
    rig.h.cancel(&rig.id).await.unwrap();
    assert_eq!(
        task.await.unwrap().unwrap().unwrap().outcome,
        Outcome::Cancelled
    );
    assert_eq!(rig.results().len(), 1);
    assert_eq!(rig.results()[0].status, ToolStatus::Cancelled);
    // Progress came after opening the FIFO. EOF proves that neither the shell
    // nor its in-group child still holds the write end.
    assert_eq!(reader.read(&mut [0; 1]).unwrap(), 0);
}
#[tokio::test]
async fn steering_joins_next_step_and_followup_waits_for_a_new_turn() {
    let mut first = calls(vec![ToolCall::new("read", json!({"path":"AGENTS.md"}))]);
    first.delay_ms = 100;
    let rig = Rig::new(vec![first, text("steered"), text("followed up")]).await;
    rig.h
        .submit(
            &rig.id,
            "user",
            "start",
            Timing::Now,
            Some("start-key".into()),
        )
        .await
        .unwrap();
    let duplicate = rig
        .h
        .submit(
            &rig.id,
            "user",
            "start",
            Timing::Now,
            Some("start-key".into()),
        )
        .await
        .unwrap();
    assert!(duplicate.duplicate);
    let h = rig.h.clone();
    let id = rig.id.clone();
    let task = tokio::spawn(async move { h.run_next(&id).await });
    rig.events.wait("step.start").await;
    rig.h
        .submit(&rig.id, "user", "STEERING", Timing::Steer, None)
        .await
        .unwrap();
    rig.h
        .submit(&rig.id, "user", "FOLLOWUP", Timing::After, None)
        .await
        .unwrap();
    assert_eq!(task.await.unwrap().unwrap().unwrap().text, "steered");
    {
        let requests = rig.probe.requests.lock().unwrap();
        let second = serde_json::to_string(&requests[1]).unwrap();
        assert!(second.contains("STEERING"));
        assert!(!second.contains("FOLLOWUP"));
    }
    assert_eq!(
        rig.h.run_next(&rig.id).await.unwrap().unwrap().text,
        "followed up"
    );
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
async fn withdrawn_input_is_returned_and_not_taken() {
    let rig = Rig::new(vec![]).await;
    let receipt = rig
        .h
        .submit(&rig.id, "user", "withdraw", Timing::After, None)
        .await
        .unwrap();
    assert_eq!(
        rig.h.withdraw(&rig.id, &receipt.input).await.unwrap().text,
        "withdraw"
    );
    assert!(rig.h.run_next(&rig.id).await.unwrap().is_none());
}
#[tokio::test]
async fn guardrail_holds_split_secret_for_events_result_history_view_and_model() {
    let mut script = text("a SECRET42 b");
    script.pieces = vec!["a SEC".into(), "RET42 b".into()];
    let rig = Rig::with(
        vec![script, text("next")],
        vec![],
        vec!["SECRET42".into()],
        json!({}),
    )
    .await;
    let result = rig.run("first").await;
    assert_eq!(result.text, "a [REDACTED] b");
    assert!(
        serde_json::to_string(&rig.data())
            .unwrap()
            .contains("SECRET42")
    );
    assert!(
        !serde_json::to_string(&*rig.events.values.lock().unwrap())
            .unwrap()
            .contains("SECRET42")
    );
    assert!(
        !rig.h
            .history_view(&rig.id)
            .await
            .unwrap()
            .to_string()
            .contains("SECRET42")
    );
    rig.run("next").await;
    assert!(
        !serde_json::to_string(&rig.probe.requests.lock().unwrap()[1])
            .unwrap()
            .contains("SECRET42")
    );
}
