use agent_api::*;
use agent_harness::Harness;
use plugin_stdio::rpc::{Endpoint, Peer, Reply};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio_util::sync::CancellationToken;

struct Probe(bool);
#[async_trait]
impl Endpoint for Probe {
    async fn request(
        &self,
        _: Arc<Peer>,
        _: Value,
        method: &str,
        params: Value,
        _: CancellationToken,
    ) -> Reply {
        if method == "plugin/initialize" {
            assert_eq!(params["historySelect"], 1);
            let name = if self.0 {
                "history-select-probe"
            } else {
                "history-fallback-probe"
            };
            let mut registration = json!({"binding":"modular-agent-plugin/1","name":name});
            if self.0 {
                registration["historySelect"] = json!(1);
            }
            Ok(registration)
        } else {
            Ok(json!({}))
        }
    }
}

#[derive(Clone)]
struct Store {
    files: Arc<history_fs::FileHistory>,
    fresh: Arc<AtomicBool>,
}
impl Plugin for Store {
    fn name(&self) -> &str {
        "fixture.history"
    }
    fn install(&self, registrar: &mut Registrar<'_>) -> Result<()> {
        registrar.provide::<dyn HistoryStore>("history", Arc::new(self.clone()))
    }
}
impl HistoryStore for Store {
    fn supports_erasure(&self) -> bool {
        true
    }
    fn acquire(&self, session: &str) -> Result<Box<dyn Lease>> {
        self.files.acquire(session)
    }
    fn load(&self, session: &str) -> Result<SessionData> {
        self.files.load(session)
    }
    fn save(&self, session: &SessionData) -> Result<()> {
        self.files.save(session)
    }
    fn list(&self, project: Option<&Path>) -> Result<Vec<SessionData>> {
        self.files.list(project)
    }
    fn erase(&self, entries: Vec<String>, held: &[String]) -> Result<Vec<SessionData>> {
        self.files.erase(entries, held)
    }
    fn coordinates_erasure(&self) -> bool {
        self.files.coordinates_erasure()
    }
    fn mark_erasure(
        &self,
        source: &str,
        targets: &[String],
    ) -> Result<std::collections::BTreeMap<String, Vec<String>>> {
        self.files.mark_erasure(source, targets)
    }
    fn reconcile_erasure(&self, session: &str) -> Result<Option<(SessionData, Vec<String>)>> {
        self.files.reconcile_erasure(session)
    }
    fn check_erasure(&self, data: &SessionData) -> Result<()> {
        ensure!(self.fresh.load(Ordering::SeqCst), PendingErasure);
        self.files.check_erasure(data)
    }
}

async fn connect(h: &Arc<Harness>, path: &Path, index: usize, agreed: bool) -> Arc<Peer> {
    let (inside, outside) = tokio::io::duplex(64 * 1024);
    let (read, write) = tokio::io::split(outside);
    let peer = Peer::start(read, write, Arc::new(Probe(agreed)));
    plugin_stdio::load_pipe(
        h,
        inside,
        json!({}),
        path,
        &path.join(format!("plugin-{index}")),
        index,
    )
    .await
    .unwrap();
    peer
}

async fn read(peer: &Peer, session: &str, patch: Value) -> Reply {
    let mut params = json!({"sessionId":session});
    params
        .as_object_mut()
        .unwrap()
        .extend(patch.as_object().unwrap().clone());
    peer.call("host/history", params, None, CancellationToken::new())
        .await
}

#[tokio::test]
async fn selector_keeps_tombstones_and_trace_projection_and_checks_each_current_view() {
    let root = tempfile::tempdir().unwrap();
    let h = Harness::new();
    let store = Store {
        files: Arc::new(history_fs::FileHistory::new(&root.path().join("store")).unwrap()),
        fresh: Arc::new(AtomicBool::new(true)),
    };
    h.load(Arc::new(store.clone())).await.unwrap();
    let selected = connect(&h, root.path(), 0, true).await;
    let fallback = connect(&h, root.path(), 1, false).await;
    let session = h.create(root.path(), json!({})).await.unwrap();
    let scope = Scope::session(&session);
    let turn = Scope {
        turn: Some("target".into()),
        ..scope.clone()
    };
    let start = h
        .append(
            &turn,
            "fixture",
            Draft::new(
                "turn.start",
                false,
                json!({"traceContext":{"traceparent":"private"}}),
            ),
        )
        .unwrap();
    h.append(
        &scope,
        "fixture",
        Draft::new("fixture.unrelated", false, json!({"turnId":"target"})),
    )
    .unwrap();
    let trace = h
        .append(
            &turn,
            "fixture",
            Draft::new(
                telemetry::TURN_TRACE,
                false,
                json!({"traceparent":"private"}),
            ),
        )
        .unwrap();
    let later = Scope {
        turn: Some("later".into()),
        call: Some("call".into()),
        ..scope.clone()
    };
    let erased = h
        .append(
            &later,
            "fixture",
            Draft::new("fixture.settled", false, json!({"secret":"erased"})),
        )
        .unwrap();
    h.erase(&scope, vec![erased.id.clone()]).await.unwrap();

    let query = json!({"all":true,"select":{"turnId":"target","toolCallIds":["call"]}});
    let page = read(&selected, &session, query.clone()).await.unwrap();
    let rows = page["entries"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0]["id"], start.id);
    assert!(rows[0]["data"].get("traceContext").is_none());
    assert_eq!(rows[1]["id"], trace.id);
    assert!(rows[1].get("data").is_none());
    assert_eq!(
        rows[2],
        json!({"id":erased.id,"parentId":erased.parent,"kind":"rust.fixture.settled","erased":true,"turnId":"later","toolCallId":"call"})
    );
    assert_eq!(
        read(&fallback, &session, query).await.unwrap_err().code,
        "invalid_request"
    );
    assert!(read(&fallback, &session, json!({})).await.unwrap()["entries"].is_array());

    let branch = json!({"limit":1,"select":{"turnId":"target"}});
    assert_eq!(
        read(&selected, &session, branch).await.unwrap()["next"],
        start.id
    );
    let after = json!({"after":start.id,"select":{"turnId":"target"}});
    let empty = json!({"select":{"turnId":"missing"}});
    assert_eq!(
        read(&selected, &session, empty.clone()).await.unwrap(),
        json!({"entries":[]})
    );
    store.fresh.store(false, Ordering::SeqCst);
    assert_eq!(
        read(&selected, &session, after.clone())
            .await
            .unwrap_err()
            .code,
        "internal"
    );
    assert_eq!(
        read(&selected, &session, empty).await.unwrap_err().code,
        "internal"
    );
    store.fresh.store(true, Ordering::SeqCst);
    h.move_position(&scope, start.parent).unwrap();
    assert_eq!(
        read(&selected, &session, after).await.unwrap_err().code,
        "invalid_request"
    );

    let wide = Scope {
        turn: Some("wide".into()),
        ..scope
    };
    h.append(
        &wide,
        "fixture",
        Draft::new(
            "fixture.large",
            false,
            json!({"blob":"a".repeat(4 * 1024 * 1024)}),
        ),
    )
    .unwrap();
    h.append(
        &wide,
        "fixture",
        Draft::new("fixture.tail", false, json!({})),
    )
    .unwrap();
    let capped = json!({"select":{"turnId":"wide"}});
    assert_eq!(
        read(&selected, &session, capped).await.unwrap_err().code,
        "result_too_large"
    );

    h.close(&session).await.unwrap();
    h.shutdown().await.unwrap();
}
