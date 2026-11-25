use super::*;
use crate::{HttpHistory, io};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
};

#[derive(Default)]
struct Snapshots(Mutex<BTreeMap<String, SessionData>>);

struct Exclusive;
impl Lease for Exclusive {}

impl HistoryStore for Snapshots {
    fn supports_service_snapshots(&self) -> bool {
        true
    }

    fn acquire(&self, _: &str) -> agent_api::Result<Box<dyn Lease>> {
        Ok(Box::new(Exclusive))
    }

    fn load(&self, id: &str) -> agent_api::Result<SessionData> {
        self.0
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| OperationError::NotFound(id.into()).into())
    }

    fn save(&self, data: &SessionData) -> agent_api::Result<()> {
        self.0.lock().unwrap().insert(data.id.clone(), data.clone());
        Ok(())
    }

    fn list(&self, _: Option<&Path>) -> agent_api::Result<Vec<SessionData>> {
        Ok(self.0.lock().unwrap().values().cloned().collect())
    }

    fn erase(&self, _: Vec<String>, _: &[String]) -> agent_api::Result<Vec<SessionData>> {
        unreachable!()
    }
}

struct Gated {
    inner: Snapshots,
    stalled: String,
    reached: Mutex<mpsc::Sender<()>>,
    release: Mutex<mpsc::Receiver<()>>,
    watched: String,
    touched: AtomicUsize,
}

impl Gated {
    fn watch(&self, id: &str) {
        if id == self.watched {
            self.touched.fetch_add(1, Ordering::SeqCst);
        }
    }
}

impl HistoryStore for Gated {
    fn supports_service_snapshots(&self) -> bool {
        true
    }

    fn acquire(&self, id: &str) -> agent_api::Result<Box<dyn Lease>> {
        self.inner.acquire(id)
    }

    fn load(&self, id: &str) -> agent_api::Result<SessionData> {
        self.watch(id);
        self.inner.load(id)
    }

    fn save(&self, data: &SessionData) -> agent_api::Result<()> {
        self.watch(&data.id);
        if data.id == self.stalled {
            self.reached.lock().unwrap().send(()).unwrap();
            self.release.lock().unwrap().recv().unwrap();
        }
        self.inner.save(data)
    }

    fn list(&self, project: Option<&Path>) -> agent_api::Result<Vec<SessionData>> {
        self.inner.list(project)
    }

    fn erase(&self, _: Vec<String>, _: &[String]) -> agent_api::Result<Vec<SessionData>> {
        unreachable!()
    }
}

#[test]
fn renewal_does_not_wait_for_another_sessions_commit() -> agent_api::Result<()> {
    let (reached, stalled) = mpsc::channel();
    let (release, held) = mpsc::channel();
    let snapshots = Arc::new(Gated {
        inner: Snapshots::default(),
        stalled: storage_key("unrelated"),
        reached: Mutex::new(reached),
        release: Mutex::new(held),
        watched: storage_key("writer"),
        touched: AtomicUsize::new(0),
    });
    let service = Arc::new(SnapshotStore::new(
        snapshots.clone(),
        Duration::from_secs(30),
        10,
    )?);
    let metadata = json!({"project":"/","created":0});
    io().block_on(service.create("writer", metadata.clone()))
        .unwrap();
    let lease = io()
        .block_on(service.acquire("writer", "owner"))
        .unwrap()
        .lease;
    let unrelated = {
        let service = service.clone();
        std::thread::spawn(move || io().block_on(service.create("unrelated", metadata)))
    };
    stalled
        .recv_timeout(Duration::from_secs(5))
        .expect("the unrelated commit never reached storage");
    let touched = snapshots.touched.load(Ordering::SeqCst);
    let (renewed, answer) = mpsc::channel();
    let renewer = {
        let service = service.clone();
        std::thread::spawn(move || renewed.send(io().block_on(service.renew("writer", &lease))))
    };
    let answer = answer.recv_timeout(Duration::from_secs(5));
    let finished_first = unrelated.is_finished();
    release.send(()).unwrap();
    unrelated.join().unwrap().unwrap();
    renewer.join().unwrap().unwrap();
    let ttl = answer.expect("renewal waited for another session's commit");
    assert_eq!(ttl.unwrap(), 30_000);
    assert!(!finished_first);
    assert_eq!(
        snapshots.touched.load(Ordering::SeqCst),
        touched,
        "renewal loaded or saved its session"
    );
    Ok(())
}

#[test]
fn tombstones_preserve_envelope_ids_only() {
    let entry =
        json!({"id":"e","parentId":null,"kind":"inputRequest","data":{"request":{"id":"nested"}}});
    let mut current = entry.clone();
    current["requestId"] = json!("canonical");
    assert_eq!(tombstone(&current)["requestId"], "canonical");
    assert!(tombstone(&entry).get("requestId").is_none());
    let hand_back =
        json!({"id":"h","parentId":"e","kind":"inputHandedBack","data":{"inputIds":["one","two"]}});
    assert!(tombstone(&hand_back).get("inputIds").is_none());
}

#[test]
fn unverifiable_control_is_fenced_without_writing_it() -> agent_api::Result<()> {
    for settings in [
        json!({"historyTtlBound":1}),
        json!({"historyTtlBound":1,"pendingErasure":{"intents":[]}}),
        json!({"historyTtlBound":1,"pendingErasure":{"intents":[]},"pendingErasureV1":{"intents":[]}}),
        json!({"historyTtlBound":1,"pendingErasureV1":{"intents":[{
            "id":"intent","source":"source","targets":["target"],"plans":[]
        }]}}),
    ] {
        let store = Snapshots::default();
        store.save(&snapshot_data(CONTROL.into(), settings.clone(), vec![]))?;
        assert_eq!(SnapshotStore::prepare_control(&store, 30)?, (false, None));
        assert_eq!(store.load(CONTROL)?.settings, settings);
    }
    Ok(())
}

#[test]
fn publication_keeps_unlisted_destinations_in_the_original_order() -> agent_api::Result<()> {
    let snapshots = Arc::new(Snapshots::default());
    let service = Arc::new(SnapshotStore::new(
        snapshots.clone(),
        Duration::from_secs(30),
        10,
    )?);
    let source = "source";
    for (session, ids) in [
        (source, &["target", "other-target"][..]),
        ("z-destination", &["copy"]),
        ("a-destination", &["other-copy"]),
    ] {
        service
            .save(
                session,
                Snapshot {
                    metadata: json!({"id":session,"project":"/","created":0}),
                    entries: ids
                        .iter()
                        .map(|id| json!({"id":id,"kind":"fixture","data":{}}))
                        .collect(),
                },
            )
            .unwrap();
    }
    let expected =
        json!({"intentId":"original","sessionIds":["z-destination",source,"a-destination"]});
    let (published, repeated) = io().block_on(async {
        let lease = service.acquire(source, "first-writer").await.unwrap().lease;
        let registry = service.erasure_plans(source, None, 500).await.unwrap();
        let mut request = json!({
            "lease":lease,"revision":registry["revision"],"intentId":"original","entryIds":["target"],
            "copies":[
                {"sessionId":"z-destination","recordId":"erase-copy","entryIds":["copy"]},
                {"sessionId":source,"recordId":"erase-target","entryIds":["target"]},
                {"sessionId":"a-destination","recordId":"erase-other-copy","entryIds":["other-copy"]}
            ]
        });
        let published = service.publish_erasure(source, request.clone()).await.unwrap();
        // Simulate retention: the destination drops out of the session list,
        // but its reserved ID and registry plan are still available.
        service.save("z-destination", Snapshot {
            metadata: json!({"id":"z-destination","project":"/","created":0}),
            entries: vec![],
        }).unwrap();
        request["copies"].as_array_mut().unwrap().reverse();
        let repeated = service.publish_erasure(source, request).await.unwrap();
        service.release(source, &lease).await.unwrap();
        (published, repeated)
    });
    let reopened = HttpHistory::from_store(Arc::new(service))?;
    assert!(reopened.list(None)?.iter().all(|s| s.id != "z-destination"));
    assert_eq!(
        reopened.mark_erasure(source, &["target".into()])?,
        BTreeMap::from([
            (source.into(), vec!["target".into()]),
            ("z-destination".into(), vec!["copy".into()]),
            ("a-destination".into(), vec!["other-copy".into()]),
        ]),
    );
    // A source-only publication has no destination IDs, even on recovery.
    for _ in 0..2 {
        assert_eq!(
            reopened.mark_erasure(source, &["other-target".into()])?,
            BTreeMap::from([(source.into(), vec!["other-target".into()])]),
        );
    }
    assert_eq!(published, expected);
    assert_eq!(repeated, expected);
    Ok(())
}
