use crate::*;
use std::collections::{BTreeMap, BTreeSet};
/// Lossless standard messages plus opaque Provider data; excludes record-only entries.
pub fn messages(entries: &[Entry]) -> Result<Vec<Message>> {
    model_messages(entries, None)
}

/// The feedback belongs only to a new step of this turn, not the general view.
pub fn model_messages(entries: &[Entry], turn: Option<&str>) -> Result<Vec<Message>> {
    let mut result = messages_with_origins(&context_entries(entries), entries)?;
    for feedback in pending_result_feedback(entries, turn) {
        let reason = feedback.content.as_ref().and_then(|v| v["reason"].as_str());
        if let Some(reason) = reason {
            result.push(Message::text("user", reason));
        }
    }
    Ok(result)
}

/// Replace summary sources at their original context position. A later
/// summary can cover an earlier summary as well as newly compacted entries.
pub fn context_entries(branch: &[Entry]) -> Vec<&Entry> {
    let mut rows = BTreeMap::new();
    let mut positions = BTreeMap::new();
    let mut unavailable = BTreeSet::new();
    let input_turns: BTreeSet<_> = branch
        .iter()
        .filter(|e| e.kind == "input" && e.visible && e.content.is_some())
        .filter_map(|e| e.scope.turn.as_deref())
        .collect();
    for (i, entry) in branch.iter().enumerate() {
        let id = entry.id.as_str();
        if entry.content.is_none() {
            unavailable.insert(id);
            continue;
        }
        if !(entry.visible
            || has_turn_context(entry)
                && entry
                    .scope
                    .turn
                    .as_deref()
                    .is_some_and(|turn| input_turns.contains(turn)))
        {
            continue;
        }
        let mut position = i;
        if entry.kind == "summary" {
            // A fork also carries foreign source IDs for erasure. Only
            // remapped IDs can replace entries in this branch's model view.
            let sources = || entry.copies.iter().map(String::as_str);
            if sources().any(|source| unavailable.contains(source)) {
                unavailable.insert(id);
                continue;
            }
            let mut replaced = sources()
                .filter_map(|source| positions.remove(source))
                .peekable();
            if replaced.peek().is_none() {
                unavailable.insert(id);
                continue;
            }
            for at in replaced {
                position = position.min(at);
                rows.remove(&at);
            }
        }
        positions.insert(id, position);
        rows.insert(position, entry);
    }
    rows.into_values().collect()
}

fn has_turn_context(entry: &Entry) -> bool {
    entry.kind == "turn.start"
        && entry.content.as_ref().is_some_and(|v| {
            v["context"]
                .as_array()
                .is_some_and(|parts| !parts.is_empty())
        })
}

/// Include the stored contributions from this turn's system prompt and from
/// the branch's model context, even though snapshots are not visible inputs.
pub fn step_history_source(entry: &Entry, turn: Option<&str>) -> bool {
    entry.content.is_some()
        && (entry.visible && entry.kind != "resultFeedback"
            || has_turn_context(entry)
            || entry.kind == "turn.start"
                && entry.scope.turn.as_deref() == turn
                && entry
                    .content
                    .as_ref()
                    .is_some_and(|v| v["system"].as_str().is_some_and(|s| !s.is_empty())))
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

/// Render selected context entries using the unfiltered branch for Provider
/// provenance. Recording intents need not be in the selected context.
pub fn messages_with_origins(entries: &[&Entry], branch: &[Entry]) -> Result<Vec<Message>> {
    let mut result = vec![];
    for e in entries {
        let Some(value) = e.content.as_ref() else {
            continue;
        };
        match e.kind.as_str() {
            "turn.start" if has_turn_context(e) => {
                let wire = json!({"role":"user","content":value["context"]});
                result.push(Message {
                    role: "user".into(),
                    parts: crate::wire::parts(&wire["content"])?,
                    opaque: json!({"_pluginWire":wire}),
                    call: None,
                });
            }
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
                            e.kind == "tool.result" && e.scope.call.as_ref() == Some(&call.id)
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
