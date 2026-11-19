use crate::*;
/// Lossless standard messages plus opaque Provider data; excludes record-only entries.
pub fn messages(entries: &[Entry]) -> Result<Vec<Message>> {
    model_messages(entries, None)
}

/// The feedback belongs only to a new step of this turn, not the general view.
pub fn model_messages(entries: &[Entry], turn: Option<&str>) -> Result<Vec<Message>> {
    let mut result = history_messages(entries)?;
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

fn history_messages(entries: &[Entry]) -> Result<Vec<Message>> {
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
                        let r: ToolResult = serde_json::from_value(v.clone())?;
                        if v.get("message").is_some() {
                            r.text
                        } else {
                            format!("{:?}: {}", r.status, r.text)
                        }
                    } else {
                        "Waiting for an answer. This is a view placeholder, not the call's result."
                            .into()
                    };
                    let mut m = Message::text("tool", &text);
                    m.call = Some(call.id.clone());
                    if let Some(v) = done.and_then(|v| v.get("message")) {
                        m.parts = crate::wire::parts(&v["content"])?;
                        m.opaque = json!({"_pluginWire":v});
                    }
                    emitted.insert(call.id);
                    result.push(m);
                }
            }
            "tool.result" => {
                let response: ToolResult = serde_json::from_value(value.clone())?;
                if !emitted.contains(&response.call) {
                    result.push(Message::text(
                        "user",
                        &format!(
                            "Tool call {} (started outside this model context): {:?}: {}",
                            response.call, response.status, response.text
                        ),
                    ));
                }
            }
            _ => (),
        }
    }
    Ok(result)
}
