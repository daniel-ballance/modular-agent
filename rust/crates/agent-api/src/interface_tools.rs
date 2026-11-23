//! Private checkpoints for tools executed outside the agent.
use crate::*;

pub const INTERFACE_HANDOFF: &str = "modular-agent.interfaceHandoff";
pub const MAX_SHARED_INTEGER: u64 = (1 << 53) - 1;

pub fn interface_handoff(e: &Entry) -> bool {
    e.kind == INTERFACE_HANDOFF && e.writer != "rust.derived"
}

pub fn interface_result(data: &SessionData, handoff: &Entry) -> Option<Entry> {
    data.entries
        .iter()
        .find(|e| e.kind == "tool.result" && e.scope.call == handoff.scope.call)
        .cloned()
}

/// The start and checkpoint are adjacent in both append order and ancestry.
pub fn interface_start<'a>(data: &'a SessionData, handoff: &Entry) -> Option<&'a Entry> {
    let index = data.entries.iter().position(|e| e.id == handoff.id)?;
    // A portable reader may synthesize a tool.call before a real start.
    let start = data.entries[..index]
        .iter()
        .rev()
        .find(|e| e.writer != "rust.derived")?;
    (interface_handoff(handoff)
        && start.kind == "tool.started"
        && start.scope == handoff.scope
        && handoff.parent.as_ref() == Some(&start.id)
        && handoff.copies.contains(&start.id))
    .then_some(start)
}

pub fn interface_unknown(
    data: &SessionData,
    handoff: &Entry,
    reason: &str,
) -> Option<(Scope, Draft)> {
    if interface_result(data, handoff).is_some() {
        return None;
    }
    let id = handoff.scope.call.as_ref()?;
    let mut scope = handoff.scope.clone();
    scope.actor.clear();
    let mut copies = vec![handoff.id.clone()];
    if let Some(start) = interface_start(data, handoff) {
        copies.insert(0, start.id.clone());
    }
    let result = ToolResult {
        call: id.clone(),
        status: ToolStatus::Unknown,
        text: reason.into(),
        value: None,
    };
    Some((
        scope,
        Draft::new("tool.result", true, json!(result)).copying(copies),
    ))
}
