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
    creates: Vec<(String, Value)>,
    reads: Vec<(Option<String>, usize)>,
    lists: Vec<(Option<String>, usize)>,
    next: usize,
    reject: bool,
    renewal_ms: Option<u64>,
    revoked: Option<tokio_util::sync::CancellationToken>,
}
#[derive(Clone, Default)]
struct Store(Arc<Mutex<Database>>);
#[async_trait]
impl PortableHistoryStore for Store {
    fn ttl_ms(&self) -> u64 {
        self.0.lock().unwrap().renewal_ms.unwrap_or(30_000)
    }
    async fn create(&self, id: &str, mut metadata: Value) -> HistoryResult<()> {
        assert!(metadata.get("id").is_none(), "PUT metadata must omit id");
        let mut db = self.0.lock().unwrap();
        db.creates.push((id.into(), metadata.clone()));
        metadata["id"] = json!(id);
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
            ttl_ms: db.renewal_ms.unwrap_or(30_000),
        })
    }
    async fn renew(&self, id: &str, lease: &str) -> HistoryResult<u64> {
        let db = self.0.lock().unwrap();
        let row = db.records.get(id).ok_or(HistoryFault::UnknownSession)?;
        if row.lease.as_deref() != Some(lease) {
            return Err(HistoryFault::Lost);
        }
        Ok(db.renewal_ms.unwrap_or(30_000))
    }
    fn writer_lost(&self, _: &str, _: &str) -> Option<tokio_util::sync::CancellationToken> {
        self.0.lock().unwrap().revoked.clone()
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
    async fn read(&self, id: &str, after: Option<&str>, limit: usize) -> HistoryResult<EntryPage> {
        assert!((1..=500).contains(&limit));
        let mut db = self.0.lock().unwrap();
        db.reads.push((after.map(str::to_owned), limit));
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
            .take(limit.min(2))
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
        after: Option<&str>,
        limit: usize,
    ) -> HistoryResult<SessionPage> {
        assert!((1..=500).contains(&limit));
        let mut db = self.0.lock().unwrap();
        db.lists.push((after.map(str::to_owned), limit));
        let mut rows: Vec<_> = db
            .records
            .values()
            .filter(|r| {
                !r.entries.is_empty()
                    && project.is_none_or(|p| r.metadata["project"] == p.to_string_lossy().as_ref())
            })
            .collect();
        rows.sort_by_key(|r| {
            (
                std::cmp::Reverse(r.metadata["created"].as_u64()),
                r.metadata["id"].as_str(),
            )
        });
        let at = match after {
            Some(cursor) => {
                rows.iter()
                    .position(|r| r.metadata["id"] == cursor)
                    .ok_or(HistoryFault::UnknownSession)?
                    + 1
            }
            None => 0,
        };
        // Use short pages so a two-session test exercises the next cursor.
        let sessions: Vec<_> = rows
            .iter()
            .skip(at)
            .take(limit.min(1))
            .map(|r| r.metadata.clone())
            .collect();
        let next = (at + sessions.len() < rows.len())
            .then(|| sessions.last().unwrap()["id"].as_str().unwrap().into());
        Ok(SessionPage { sessions, next })
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

#[tokio::test]
async fn portable_registrar_store_receives_metadata_and_binding_pagination() -> Result<()> {
    let store = Store::default();
    let part = store.clone();
    let project = tempfile::tempdir()?;
    let path = project.path().canonicalize()?;
    let agent = test_agent()
        .project(&path)
        .durability(Durability::Kept)
        .plugin(
            Plugin::new("portable-pages")
                .setup(move |r| r.history_store(History::from_portable(part.clone(), true)?)),
        )
        .script(json!([{"text":"Saved"}]))
        .build()
        .await?;
    let first = agent.session().await?;
    let second = agent.session().await?;
    assert!(store.0.lock().unwrap().creates.is_empty());
    assert_eq!(first.prompt("First session").await?.text, "Saved");
    assert_eq!(second.prompt("Second session").await?.text, "Saved");
    let listed = agent.sessions(Some(&path))?;
    assert_eq!(listed.len(), 2);
    assert!(listed.iter().any(|s| s.id == first.id()));
    assert!(listed.iter().any(|s| s.id == second.id()));
    {
        let db = store.0.lock().unwrap();
        assert_eq!(db.creates.len(), 2);
        for ((id, metadata), session) in db.creates.iter().zip([first, second]) {
            assert_eq!(id, session.id());
            assert_eq!(metadata["project"], json!(path));
            assert!(metadata["created"].is_u64());
            assert!(metadata.get("id").is_none());
        }
        let first_listed = db
            .records
            .values()
            .min_by_key(|r| {
                (
                    std::cmp::Reverse(r.metadata["created"].as_u64()),
                    r.metadata["id"].as_str(),
                )
            })
            .unwrap();
        assert_eq!(
            db.lists,
            [
                // Reservation reconstruction scans the backend at startup.
                (None, 500),
                (None, 500),
                (
                    Some(first_listed.metadata["id"].as_str().unwrap().into()),
                    500
                )
            ]
        );
        assert_eq!(
            db.reads
                .iter()
                .filter(|(cursor, _)| cursor.is_none())
                .count(),
            2
        );
        for session in listed {
            let first_cursor = db.records[&session.id].entries[1]["id"].as_str().unwrap();
            assert!(db.reads.contains(&(Some(first_cursor.into()), 500)));
        }
    }
    agent.close().await
}

#[tokio::test]
async fn writer_loss_interrupts_an_idle_session_without_another_write() -> Result<()> {
    use futures_util::StreamExt;
    use modular_agent::{Event, InterruptionReason};
    use std::time::Duration;

    for push in [true, false] {
        let store = Store::default();
        if push {
            store.0.lock().unwrap().revoked = Some(tokio_util::sync::CancellationToken::new());
        } else {
            store.0.lock().unwrap().renewal_ms = Some(900);
        }
        let agent = test_agent()
            .durability(Durability::Kept)
            .history(History::from_portable(store.clone(), true)?)
            .script(json!([{"text":"Ready"}]))
            .build()
            .await?;
        let session = agent.session().await?;
        assert_eq!(session.prompt("Ready?").await?.text, "Ready");
        session.wait_idle().await?;
        let mut events = session.events(None)?;
        let appends = {
            let mut db = store.0.lock().unwrap();
            db.records.get_mut(session.id()).unwrap().lease = Some("revoked".into());
            if let Some(signal) = &db.revoked {
                signal.cancel();
            }
            db.appends.len()
        };
        let interruption = tokio::time::timeout(Duration::from_secs(3), async {
            while let Some(event) = events.next().await {
                if let Event::SessionInterrupted(e) = event? {
                    return Ok::<_, modular_agent::Error>(e.data.reason);
                }
            }
            panic!("event stream ended before interruption");
        })
        .await
        .expect("writer loss was reported without a write")?;
        assert_eq!(interruption, InterruptionReason::WriterLost);
        assert_eq!(store.0.lock().unwrap().appends.len(), appends);
        assert_eq!(
            session.prompt("Stale writer").await.unwrap_err().code(),
            Code::Lost
        );
        agent.close().await?;
    }
    Ok(())
}
