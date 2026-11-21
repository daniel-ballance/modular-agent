use super::*;
use crate::{HttpHistory, io};
use std::{collections::BTreeMap, path::Path};

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
    let expected = json!({"intentId":"original","sessionIds":["z-destination",source,"a-destination"]});
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
