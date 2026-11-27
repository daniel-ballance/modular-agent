use super::*;

fn entry(id: &str, kind: &str, value: Value) -> Entry {
    Entry {
        id: id.into(),
        parent: None,
        scope: Scope::default(),
        writer: "test".into(),
        at: 0,
        kind: kind.into(),
        visible: true,
        copies: vec![],
        content: Some(value),
    }
}

fn response(id: &str, names: &[&str]) -> Entry {
    let calls = names
        .iter()
        .map(|name| ToolCall {
            id: (*name).into(),
            ..ToolCall::new("read", json!({}))
        })
        .collect();
    entry(id, "model.response", json!(ModelResponse::calls(calls)))
}

fn result(call: &str) -> Entry {
    let mut entry = entry(
        &format!("result-{call}"),
        "tool.result",
        json!(ToolResult {
            call: call.into(),
            status: ToolStatus::Completed,
            text: call.into(),
            value: None,
        }),
    );
    entry.scope.call = Some(call.into());
    entry
}

fn summary(id: &str, copies: &[&str]) -> Entry {
    let mut entry = entry(id, "summary", json!({"text":id}));
    entry.copies = copies.iter().map(|id| (*id).into()).collect();
    entry
}

#[test]
fn multiple_results_and_late_handoffs_pin_the_complete_step() {
    let mut branch = vec![
        entry("prompt", "input", json!({"text":"goal"})),
        response("parallel", &["first", "late"]),
        result("first"),
        response("next", &["next"]),
        result("next"),
    ];
    let mut handoff = entry("handoff", INTERFACE_HANDOFF, json!({}));
    handoff.visible = false;
    handoff.scope.call = Some("late".into());
    branch.push(handoff.clone());
    for force in [false, true] {
        assert_eq!(cut_before(&context_entries(&branch), 0, force).unwrap(), 0);
    }
    branch.extend([result("late"), response("keep", &["keep"]), result("keep")]);
    branch.push(response("open", &["open"]));
    handoff.id = "open-handoff".into();
    handoff.scope.call = Some("open".into());
    branch.push(handoff);

    let visible = context_entries(&branch);
    let cut = cut_before(&visible, 0, true).unwrap();
    assert_eq!(visible[cut].id, "open");
    assert!(visible[..cut].iter().any(|e| e.id == "result-late"));
    let sources: Vec<_> = visible[..cut].iter().map(|e| e.id.as_str()).collect();
    branch.push(summary("goal and settled outcomes", &sources));
    let messages = messages(&branch).unwrap();
    assert_eq!(
        messages.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(),
        ["user", "assistant", "tool"]
    );
    assert_eq!(messages[2].call.as_deref(), Some("open"));
    assert!(
        messages[2]
            .text_content()
            .contains("Waiting for an Interface")
    );
}

#[test]
fn a_later_summary_can_replace_an_earlier_summary_and_keep_newer_steps() {
    let mut branch = vec![
        entry("prompt", "input", json!({"text":"goal"})),
        response("a", &["a"]),
        result("a"),
        response("b", &["b"]),
        result("b"),
        summary("first summary", &["prompt", "a", "result-a"]),
        response("c", &["c"]),
        result("c"),
    ];
    let visible = context_entries(&branch);
    let cut = cut_before(&visible, 0, false).unwrap();
    assert_eq!(visible[cut].id, "c");
    assert_eq!(
        visible[..cut]
            .iter()
            .map(|e| e.id.as_str())
            .collect::<Vec<_>>(),
        ["first summary", "b", "result-b"]
    );
    branch.push(summary(
        "second summary",
        &["b", "result-b", "first summary"],
    ));
    let compacted = messages(&branch).unwrap();
    assert_eq!(compacted.len(), 3);
    assert!(compacted[0].text_content().contains("second summary"));
    branch[2].content = None;
    let restored = context_entries(&branch);
    assert_eq!(restored[0].id, "prompt");
    assert!(!restored.iter().any(|e| e.kind == "summary"));
}
