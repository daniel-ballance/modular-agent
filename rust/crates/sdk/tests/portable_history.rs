use modular_agent::{
    Code, Durability, EntryPage, History, HistoryFault, HistoryResult, LeaseGrant, Plugin,
    PortableHistoryStore, Result, SessionPage, async_trait, testing::test_agent,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex},
};

// Test backend. It deliberately only knows session metadata, leases and opaque rows.
#[derive(Default)]
struct Record {
    metadata: Value,
    lease: Option<String>,
    entries: Vec<Value>,
}
#[derive(Default)]
struct Database {
    records: BTreeMap<String, Record>,
    appends: Vec<String>,
    next: usize,
    reject: bool,
}
#[derive(Clone, Default)]
struct Store(Arc<Mutex<Database>>);
#[async_trait]
impl PortableHistoryStore for Store {
    fn ttl_ms(&self) -> u64 {
        30_000
    }
    async fn create(&self, id: &str, mut metadata: Value) -> HistoryResult<()> {
        metadata["id"] = json!(id);
        let mut db = self.0.lock().unwrap();
        let row = db.records.entry(id.into()).or_default();
        if !row.metadata.is_null() && row.metadata != metadata {
            return Err(HistoryFault::Conflict);
        }
        row.metadata = metadata;
        Ok(())
    }
    async fn acquire(&self, id: &str, _: &str) -> HistoryResult<LeaseGrant> {
        let mut db = self.0.lock().unwrap();
        db.next += 1;
        let proposed = format!("test_{}", db.next);
        let row = db.records.get_mut(id).ok_or(HistoryFault::UnknownSession)?;
        if row.lease.is_some() {
            return Err(HistoryFault::Held {
                retry_after_ms: 30_000,
            });
        }
        row.lease = Some(proposed.clone());
        Ok(LeaseGrant {
            lease: proposed,
            ttl_ms: self.ttl_ms(),
        })
    }
    async fn renew(&self, id: &str, lease: &str) -> HistoryResult<u64> {
        let db = self.0.lock().unwrap();
        let row = db.records.get(id).ok_or(HistoryFault::UnknownSession)?;
        if row.lease.as_deref() != Some(lease) {
            return Err(HistoryFault::Lost);
        }
        Ok(self.ttl_ms())
    }
    async fn release(&self, id: &str, lease: &str) -> HistoryResult<()> {
        let mut db = self.0.lock().unwrap();
        let row = db.records.get_mut(id).ok_or(HistoryFault::UnknownSession)?;
        if row.lease.as_deref() == Some(lease) {
            row.lease = None;
        }
        Ok(())
    }
    async fn append(&self, id: &str, lease: &str, entries: Vec<Value>) -> HistoryResult<u64> {
        let mut db = self.0.lock().unwrap();
        let reject = db.reject;
        let row = db.records.get_mut(id).ok_or(HistoryFault::UnknownSession)?;
        if row.lease.as_deref() != Some(lease) {
            return Err(HistoryFault::Lost);
        }
        if reject {
            return Err(HistoryFault::Unavailable);
        }
        let mut staged = row.entries.clone();
        for entry in entries {
            assert!(entry["id"].is_string() && entry.get("parentId").is_some());
            assert!(
                entry.get("scope").is_none(),
                "native snapshots are not portable entries"
            );
            if let Some(saved) = staged.iter().find(|saved| saved["id"] == entry["id"]) {
                if saved != &entry {
                    return Err(HistoryFault::Conflict);
                }
            } else {
                staged.push(entry);
            }
        }
        let added = staged.len() - row.entries.len();
        row.entries = staged;
        db.appends.push(lease.to_owned());
        Ok(added as u64)
    }
    async fn read(&self, id: &str, after: Option<&str>, _: usize) -> HistoryResult<EntryPage> {
        let db = self.0.lock().unwrap();
        let row = db.records.get(id).ok_or(HistoryFault::UnknownSession)?;
        let at = if let Some(after) = after {
            row.entries
                .iter()
                .position(|e| e["id"] == after)
                .ok_or(HistoryFault::UnknownEntry)?
                + 1
        } else {
            0
        };
        // Small pages stress the adapter's cursor rather than its storage layout.
        let entries = row
            .entries
            .iter()
            .skip(at)
            .take(2)
            .cloned()
            .collect::<Vec<_>>();
        let next = (at + entries.len() < row.entries.len())
            .then(|| entries.last().unwrap()["id"].as_str().unwrap().into());
        Ok(EntryPage {
            session: row.metadata.clone(),
            entries,
            next,
        })
    }
    async fn list(
        &self,
        project: Option<&Path>,
        _: Option<&str>,
        _: usize,
    ) -> HistoryResult<SessionPage> {
        let db = self.0.lock().unwrap();
        Ok(SessionPage {
            sessions: db
                .records
                .values()
                .filter(|r| {
                    !r.entries.is_empty()
                        && project
                            .is_none_or(|p| r.metadata["project"] == p.to_string_lossy().as_ref())
                })
                .map(|r| r.metadata.clone())
                .collect(),
            next: None,
        })
    }
}

#[tokio::test]
async fn portable_registrar_store_keeps_only_appends_with_the_current_lease() -> Result<()> {
    let store = Store::default();
    let project = tempfile::tempdir()?;
    let builder = || {
        let store = store.clone();
        test_agent()
            .project(project.path())
            .durability(Durability::Kept)
            .plugin(
                Plugin::new("portable-store")
                    .setup(move |r| r.history_store(History::from_portable(store.clone(), true)?)),
            )
            .script(json!([{"text":"First"},{"text":"Second"}]))
    };
    let first = builder().build().await.expect("compose first writer");
    let session = first.session().await.expect("create session");
    assert!(
        store.0.lock().unwrap().records.is_empty(),
        "setup does not create a row"
    );
    assert_eq!(
        session.prompt("One").await.expect("first prompt").text,
        "First"
    );
    let id = session.id().to_owned();
    first.close().await.expect("close first writer");
    let previous = store.0.lock().unwrap().appends.clone();
    assert!(!previous.is_empty());
    let second = builder().build().await.expect("compose second writer");
    let session = second
        .open_session(&id)
        .await
        .expect("reopen from opaque record");
    assert_eq!(session.last_turn().await?.unwrap().text, "First");
    assert_eq!(session.prompt("Two").await?.text, "Second");
    {
        let db = store.0.lock().unwrap();
        assert!(
            db.appends[previous.len()..]
                .iter()
                .all(|t| t != &previous[0])
        );
        assert_eq!(
            db.records[&id]
                .entries
                .iter()
                .filter(|e| e["kind"] == "turnEnd")
                .count(),
            2
        );
    }
    store.0.lock().unwrap().records.get_mut(&id).unwrap().lease = Some("other_writer".into());
    assert_eq!(
        session.prompt("Stale writer").await.unwrap_err().code(),
        Code::Lost
    );
    second.close().await
}
