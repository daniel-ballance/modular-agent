mod support;

use agent_api::*;
use support::*;

#[derive(Clone, Copy)]
enum Trigger {
    Threshold,
    Overflow,
    Command,
}

async fn compact_one_turn(trigger: Trigger) {
    let old = ToolCall::new("read", json!({"path":"old.txt"}));
    let recent = ToolCall::new("read", json!({"path":"recent.txt"}));
    let mut script = vec![calls(vec![old.clone()]), calls(vec![recent.clone()])];
    let goal = "Compare the two files and identify their purpose";
    let summary_text = "Goal: compare the files. The old file was inspected.";
    if matches!(trigger, Trigger::Command) {
        script.extend([text("comparison complete"), text(summary_text)]);
    } else {
        if matches!(trigger, Trigger::Overflow) {
            script.push(provider_fake::Script::failure(FailureKind::ContextTooLarge));
        }
        script.extend([text(summary_text), text("comparison complete")]);
    }
    let settings = if matches!(trigger, Trigger::Threshold) {
        json!({"context_tokens": 1100, "keep_recent_tokens": 500})
    } else {
        json!({})
    };
    let rig = Rig::with(script, vec![], vec![], settings).await;
    std::fs::write(
        rig.project.path().join("old.txt"),
        "OLD-RESULT ".repeat(500),
    )
    .unwrap();
    std::fs::write(
        rig.project.path().join("recent.txt"),
        "verbatim recent result",
    )
    .unwrap();
    assert_eq!(rig.run(goal).await.outcome, Outcome::Completed);
    if matches!(trigger, Trigger::Command) {
        let reply = rig
            .h
            .submit(&rig.id, "user", "/compact", Timing::Now, None)
            .await
            .unwrap();
        assert_eq!(reply.command.unwrap()["compacted"], true);
    }

    let data = rig.data();
    let branch = data.branch();
    let summary = branch.iter().find(|e| e.kind == "summary").unwrap();
    assert_eq!(branch.iter().filter(|e| e.kind == "summary").count(), 1);
    let old_result = branch
        .iter()
        .find(|e| e.kind == "tool.result" && e.scope.call.as_ref() == Some(&old.id))
        .unwrap();
    let old_step = branch
        .iter()
        .find(|e| e.kind == "model.response" && e.scope.step == old_result.scope.step)
        .unwrap();
    let input = branch.iter().find(|e| e.kind == "input").unwrap();
    assert_eq!(
        summary.copies,
        [input.id.clone(), old_step.id.clone(), old_result.id.clone()]
    );

    let view = messages(&branch).unwrap();
    assert_eq!(
        view.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(),
        ["user", "assistant", "tool", "assistant"]
    );
    assert!(view[0].text_content().contains(summary_text));
    assert!(matches!(&view[1].parts[..], [Part::ToolCall { call }] if call.id == recent.id));
    assert_eq!(view[2].call.as_ref(), Some(&recent.id));
    assert!(view[2].text_content().contains("verbatim recent result"));
    {
        let requests = rig.probe.requests.lock().unwrap();
        let auxiliary = requests
            .iter()
            .find(|request| request.system.contains("Summarize"))
            .unwrap();
        let transcript = serde_json::to_string(&auxiliary.messages).unwrap();
        assert!(transcript.contains(goal) && transcript.contains("OLD-RESULT"));
        assert!(!transcript.contains("verbatim recent result"));
        if !matches!(trigger, Trigger::Command) {
            let last = &requests.last().unwrap().messages;
            assert_eq!(
                last.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(),
                ["user", "assistant", "tool"]
            );
            assert_eq!(last[2].call.as_ref(), Some(&recent.id));
            assert_eq!(last[2].text_content(), view[2].text_content());
        }
    }
    rig.h
        .erase(&Scope::session(&rig.id), vec![old_result.id.clone()])
        .await
        .unwrap();
    let erased = rig.data().branch();
    assert!(
        !erased
            .iter()
            .any(|e| e.id == summary.id && e.content.is_some())
    );
    assert!(
        !serde_json::to_string(&messages(&erased).unwrap())
            .unwrap()
            .contains(summary_text)
    );
}

#[tokio::test]
async fn automatic_compaction_can_shorten_one_long_turn() {
    compact_one_turn(Trigger::Threshold).await;
}

#[tokio::test]
async fn overflow_retries_with_compacted_single_turn_history() {
    compact_one_turn(Trigger::Overflow).await;
}

#[tokio::test]
async fn compact_command_keeps_the_end_of_a_single_tool_turn() {
    compact_one_turn(Trigger::Command).await;
}
