use modular_agent::ToolResult;
use serde_json::{Map, Value};

pub(super) fn record_counts(
    want: &Map<String, Value>,
    entries: &[Value],
    mut fail: impl FnMut(String),
) {
    for (kind, count) in want {
        let got = entries
            .iter()
            .filter(|e| e["kind"] == kind.as_str())
            .count();
        if count.as_u64() != Some(got as u64) {
            fail(format!("recordCounts.{kind}: want {count}, got {got}"));
        }
    }
}

pub(super) fn tool_content(w: &Value, g: &ToolResult, mut fail: impl FnMut(String)) {
    if let Some(content) = w.get("content")
        && content.as_array() != Some(&g.content)
    {
        fail(format!(
            "toolResult content: want {content}, got {:?}",
            g.content
        ));
    }
    let actual = g.text();
    if let Some(text) = w["text"].as_str()
        && actual != text
    {
        fail(format!("toolResult text: want {text:?}, got {actual:?}"));
    }
    if let Some(part) = w["contains"].as_str()
        && !actual.contains(part)
    {
        fail(format!(
            "toolResult text: want substring {part:?}, got {actual:?}"
        ));
    }
}
/// Compare the exact recorded source set with the intact ancestors of this start,
/// or with selected ancestors identified by kind and zero-based occurrence.
pub(super) fn turn_sources(
    expect: &Value,
    entries: &[Value],
    turn: Option<&str>,
    mut fail: impl FnMut(String),
) {
    let Some(start) = entries
        .iter()
        .find(|e| e["kind"] == "turnStart" && turn.is_some() && e["turnId"].as_str() == turn)
    else {
        fail("turnSources: no turnStart for the result".into());
        return;
    };
    let by_id: std::collections::HashMap<_, _> = entries
        .iter()
        .filter_map(|e| Some((e["id"].as_str()?, e)))
        .collect();
    let mut branch = Vec::new();
    let mut parent = start["parentId"].as_str();
    while let Some(entry) = parent.and_then(|id| by_id.get(id)) {
        if entry["erased"] != true {
            branch.push(*entry);
        }
        parent = entry["parentId"].as_str();
    }
    branch.reverse();
    let mut want: Vec<_> = if expect["turnSources"] == "branch" {
        branch.iter().map(|e| e["id"].as_str().unwrap()).collect()
    } else {
        let mut ids = Vec::new();
        for item in expect["turnSources"].as_array().unwrap() {
            let source = branch
                .iter()
                .filter(|e| e["kind"] == item["kind"])
                .nth(item["index"].as_u64().unwrap() as usize);
            let Some(id) = source.and_then(|e| e["id"].as_str()) else {
                fail(format!("turnSources: no branch entry for {item}"));
                return;
            };
            ids.push(id);
        }
        ids
    };
    let mut got: Vec<_> = start["sources"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|id| id.as_str().unwrap())
        .collect();
    want.sort_unstable();
    got.sort_unstable();
    if got != want {
        fail(format!("turnSources: want {want:?}, got {got:?}"));
    }
    if let Some(part) = expect["systemIncludes"].as_str()
        && !start["data"]["system"]
            .as_str()
            .is_some_and(|system| system.contains(part))
    {
        fail(format!(
            "systemIncludes: want {part:?}, got {}",
            start["data"]["system"]
        ));
    }
    if let Some(context) = expect.get("context")
        && &start["data"]["context"] != context
    {
        fail(format!(
            "context: want {context}, got {}",
            start["data"]["context"]
        ));
    }
}
