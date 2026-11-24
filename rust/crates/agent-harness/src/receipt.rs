//! A run binds to one real ledger entry, never a separate history entry.
use agent_api::*;

pub enum ReceiptOperation {
    Input(String),
    Answer(String),
    Report(String),
}
pub struct EntryBinding {
    pub session: String,
    pub actor: String,
    pub entry_id: String,
    pub operation: ReceiptOperation,
}
tokio::task_local! { pub static BIND_ENTRY: EntryBinding; }
pub(super) fn bound_id(scope: &Scope, draft: &Draft) -> Option<String> {
    BIND_ENTRY
        .try_with(|b| {
            if b.session != scope.session {
                return None;
            }
            let matches = match &b.operation {
                ReceiptOperation::Input(key) => {
                    matches!(draft.kind.as_str(), "input.accepted" | "command")
                        && draft.content["key"] == *key
                        && scope.actor == b.actor
                }
                ReceiptOperation::Answer(id) => {
                    draft.kind == "request.answer"
                        && draft.content["request"] == *id
                        && draft.content["actor"] == b.actor
                }
                ReceiptOperation::Report(id) => {
                    draft.kind == "tool.result"
                        && scope.call.as_ref() == Some(id)
                        && scope.actor == b.actor
                }
            };
            matches.then(|| b.entry_id.clone())
        })
        .ok()
        .flatten()
}
