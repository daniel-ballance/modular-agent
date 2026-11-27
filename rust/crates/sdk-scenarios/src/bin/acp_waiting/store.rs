use super::*;
use base::{HistoryStore, Lease, SessionData};

/// The side log records commit boundaries, not copies of conversation content.
pub struct Store(pub Arc<Fixture>);
struct Writer(Box<dyn Lease>, base::CancellationToken);
impl Lease for Writer {
    fn lost(&self) -> Option<base::CancellationToken> {
        Some(self.1.clone())
    }
    fn check(&self) -> Result<()> {
        ensure!(!self.1.is_cancelled(), "fixture writer was fenced");
        self.0.check()
    }
}
impl HistoryStore for Store {
    fn acquire(&self, id: &str) -> Result<Box<dyn Lease>> {
        Ok(Box::new(Writer(
            self.0.store.acquire(id)?,
            self.0.fence.clone(),
        )))
    }
    fn list(&self, project: Option<&Path>) -> Result<Vec<SessionData>> {
        self.0.store.list(project)
    }
    fn load(&self, id: &str) -> Result<SessionData> {
        self.0.store.load(id)
    }
    fn save(&self, data: &SessionData) -> Result<()> {
        let _lock = self.0.journal.lock().unwrap();
        let n = self.0.store.load(&data.id).map_or(0, |d| d.entries.len());
        ensure!(!self.0.fence.is_cancelled(), "fixture writer was fenced");
        self.0.store.save(data)?;
        if data.entries.len() > n {
            let mut log = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.0.dir.join(format!("{}.commits", data.id)))?;
            writeln!(
                log,
                "{}",
                json!(data.entries[n..].iter().map(|e| &e.id).collect::<Vec<_>>())
            )?;
        }
        self.0.changed.notify_waiters();
        Ok(())
    }
    fn supports_erasure(&self) -> bool {
        true
    }
    fn coordinates_erasure(&self) -> bool {
        true
    }
    fn erase(&self, ids: Vec<String>, held: &[String]) -> Result<Vec<SessionData>> {
        self.0.store.erase(ids, held)
    }
    fn mark_erasure(&self, id: &str, ids: &[String]) -> Result<BTreeMap<String, Vec<String>>> {
        self.0.store.mark_erasure(id, ids)
    }
    fn check_erasure(&self, d: &SessionData) -> Result<()> {
        self.0.store.check_erasure(d)
    }
    fn confirmed_erasure(&self, id: &str) -> Result<Vec<String>> {
        self.0.store.confirmed_erasure(id)
    }
    fn reconcile_erasure(
        &self,
        id: &str,
        write: &mut base::ErasureWrite<'_>,
    ) -> Result<Option<(SessionData, Vec<String>)>> {
        self.0.store.reconcile_erasure(id, write)
    }
}
