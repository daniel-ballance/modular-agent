use crate::*;
/// Lossless standard messages plus opaque Provider data; excludes record-only entries.
pub fn messages(entries: &[Entry]) -> Result<Vec<Message>> {
    model_messages(entries, None)
}

/// The feedback belongs only to a new step of this turn, not the general view.
pub fn model_messages(entries: &[Entry], turn: Option<&str>) -> Result<Vec<Message>> {
    let mut result = messages_with_origins(entries, entries)?;
    for feedback in pending_result_feedback(entries, turn) {
        let reason = feedback.content.as_ref().and_then(|v| v["reason"].as_str());
        if let Some(reason) = reason {
            result.push(Message::text("user", reason));
        }
    }
    Ok(result)
}

pub fn pending_result_feedback<'a>(
    entries: &'a [Entry],
    turn: Option<&str>,
) -> impl Iterator<Item = &'a Entry> {
    let last = turn.and_then(|turn| {
        entries.iter().rposition(|e| {
            e.kind == "model.request"
                && e.scope.turn.as_deref() == Some(turn)
                && !e.content.as_ref().is_some_and(|v| v["auxiliary"] == true)
        })
    });
    entries
        .iter()
        .skip(last.map_or(0, |i| i + 1))
        .filter(move |e| {
            turn.is_some()
                && e.scope.turn.as_deref() == turn
                && e.kind == "resultFeedback"
                && e.visible
                && e.content.is_some()
        })
}

/// Project a filtered conversation using the unfiltered branch for Provider
/// provenance. Recording intents need not be in the filtered conversation.
pub fn messages_with_origins(entries: &[Entry], branch: &[Entry]) -> Result<Vec<Message>> {
    let mut result = vec![];
    let mut emitted = std::collections::BTreeSet::new();
    let summarized: std::collections::BTreeSet<_> = entries
        .iter()
        .rev()
        .find(|e| e.kind == "summary" && e.visible && e.content.is_some())
        .into_iter()
        .flat_map(|e| e.copies.iter().map(String::as_str))
        .collect();
    for e in entries {
        if !e.visible || summarized.contains(e.id.as_str()) {
            continue;
        }
        let Some(value) = e.content.as_ref() else {
            continue;
        };
        match e.kind.as_str() {
            "input" | "feedback" => {
                let wire = portable::input_message(value);
                result.push(Message {
                    role: "user".into(),
                    parts: crate::wire::parts(&wire["content"])?,
                    opaque: json!({"_pluginWire":wire}),
                    call: None,
                });
            }
            "plugin.context" => result.push(serde_json::from_value(value.clone())?),
            "summary" => result.push(Message::text(
                "user",
                &format!(
                    "Summary of older history:\n{}",
                    value["text"].as_str().unwrap_or("")
                ),
            )),
            "model.response" => {
                let mut response: ModelResponse = serde_json::from_value(value.clone())?;
                if matches!(response.stop.as_str(), "failed" | "aborted")
                    && response.parts.is_empty()
                {
                    continue;
                }
                if matches!(
                    response.stop.as_str(),
                    "failed" | "aborted" | "refused" | "limit" | "length"
                ) {
                    response
                        .parts
                        .retain(|p| !matches!(p, Part::ToolCall { .. }));
                }
                let calls = response.tool_calls();
                // The committed model intent pins the producing Provider. A
                // response's own model field is not proof of its identity.
                let provider = branch
                    .iter()
                    .rev()
                    .find(|intent| {
                        intent.kind == "model.request"
                            && intent.scope.step.is_some()
                            && intent.scope.step == e.scope.step
                            && intent.scope.turn == e.scope.turn
                            && e.copies.contains(&intent.id)
                    })
                    .and_then(|intent| {
                        intent
                            .content
                            .as_ref()?
                            .get("model")?
                            .get("provider")?
                            .as_str()
                    });
                if let Some(provider) = provider {
                    if !response.opaque.is_object() {
                        response.opaque = json!({});
                    }
                    response.opaque["_providerOwner"] = json!(provider);
                }
                result.push(Message {
                    role: "assistant".into(),
                    parts: response.parts,
                    opaque: response.opaque,
                    call: None,
                });
                for call in calls {
                    let done = entries
                        .iter()
                        .find(|e| {
                            e.kind == "tool.result"
                                && e.visible
                                && !summarized.contains(e.id.as_str())
                                && e.scope.call.as_ref() == Some(&call.id)
                        })
                        .and_then(|e| e.content.as_ref());
                    let text = if let Some(v) = done {
                        // The same text before and after a reopen, so that the
                        // model's context does not change with a restart.
                        serde_json::from_value::<ToolResult>(v.clone())?.text
                    } else if branch.iter().any(|checkpoint| {
                        interface_handoff(checkpoint)
                            && checkpoint.content.is_some()
                            && checkpoint.scope.call.as_ref() == Some(&call.id)
                    }) {
                        "Waiting for an Interface tool result. This is a view placeholder, not the call's result.".into()
                    } else {
                        "Waiting for an answer. This is a view placeholder, not the call's result."
                            .into()
                    };
                    let mut m = Message::text("tool", &text);
                    m.call = Some(call.id.clone());
                    if let Some(v) = done.and_then(|v| v.get("message")) {
                        m.parts = crate::wire::parts(&v["content"])?;
                        m.opaque = json!({"_pluginWire":v});
                    } else if let Some(v) = done {
                        // Not yet through a store: the result still holds its own content.
                        let r: ToolResult = serde_json::from_value(v.clone())?;
                        if r.status == ToolStatus::Completed
                            && let Some(content) = r.content()
                            && content.iter().any(|part| part["type"] != "text")
                        {
                            m.parts = crate::wire::parts(&json!(content))?;
                        }
                    }
                    emitted.insert(call.id);
                    result.push(m);
                }
            }
            // A result with no call in a model response on this branch is an
            // orphan: a call the UI or a plugin started, or a nested call. The
            // shared data binding leaves orphans out of the model's context.
            _ => (),
        }
    }
    Ok(result)
}
