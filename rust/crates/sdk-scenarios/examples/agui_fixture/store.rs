use super::*;
use base::{HistoryStore, Lease, SessionData};
use history_fs::FileHistory;
use std::collections::BTreeMap;

/// Keep only IDs in the write journal. Inspection gets entry bodies from the
/// current store, so the journal is not another copy of erased conversation.
pub struct Journal {
    pub inner: FileHistory,
    pub state: Arc<Kit>,
}
impl HistoryStore for Journal {
    fn supports_erasure(&self) -> bool {
        true
    }
    fn coordinates_erasure(&self) -> bool {
        true
    }
    fn acquire(&self, id: &str) -> Result<Box<dyn Lease>> {
        self.inner.acquire(id)
    }
    fn load(&self, id: &str) -> Result<SessionData> {
        self.inner.load(id)
    }
    fn list(&self, p: Option<&Path>) -> Result<Vec<SessionData>> {
        self.inner.list(p)
    }
    fn save(&self, d: &SessionData) -> Result<()> {
        let previous = self.inner.load(&d.id).map_or(0, |s| s.entries.len());
        self.inner.save(d)?;
        let entries = &d.entries[previous.min(d.entries.len())..];
        if !entries.is_empty() {
            self.state.append(
                &format!("{}.batches", d.id),
                json!(entries.iter().map(|e| &e.id).collect::<Vec<_>>()),
            )?;
        }
        for entry in entries {
            match entry.kind.as_str() {
                "request.answer" => self.state.latch(&d.id, "answerCommitted"),
                "tool.result"
                    if d.entries.iter().any(|e| {
                        base::interface_handoff(e) && e.scope.call == entry.scope.call
                    }) =>
                {
                    self.state.latch(&d.id, "reportCommitted")
                }
                "turn.end"
                    if d.entries.iter().any(|s| {
                        s.kind == "turn.start"
                            && s.scope.turn == entry.scope.turn
                            && s.content
                                .as_ref()
                                .is_some_and(|v| v["continuesTurnId"].is_string())
                    }) =>
                {
                    self.state.latch(&d.id, "continuationEnded")
                }
                _ => (),
            }
        }
        self.state.changed.notify_waiters();
        if self.state.name == "crash-after-result"
            && !self.state.restarted
            && entries.iter().any(|e| e.kind == "tool.result")
        {
            tokio::task::block_in_place(|| {
                self.state.latch(&d.id, "afterResult");
                loop {
                    std::thread::park();
                }
            });
        }
        Ok(())
    }
    fn erase(&self, entries: Vec<String>, held: &[String]) -> Result<Vec<SessionData>> {
        self.inner.erase(entries, held)
    }
    fn mark_erasure(
        &self,
        source: &str,
        targets: &[String],
    ) -> Result<BTreeMap<String, Vec<String>>> {
        let marked = self.inner.mark_erasure(source, targets)?;
        if self.state.held(source, "pendingErasure") {
            tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current()
                    .block_on(self.state.pause(source, "pendingErasure"))
            });
        }
        Ok(marked)
    }
    fn check_erasure(&self, d: &SessionData) -> Result<()> {
        self.inner.check_erasure(d)
    }
    fn confirmed_erasure(&self, id: &str) -> Result<Vec<String>> {
        self.inner.confirmed_erasure(id)
    }
    fn reconcile_erasure(&self, id: &str) -> Result<Option<(SessionData, Vec<String>)>> {
        self.inner.reconcile_erasure(id)
    }
}
