use super::*;
use futures_util::task::AtomicWaker;
use std::{
    io,
    pin::Pin,
    task::{Context, Poll},
};
use tokio::io::{DuplexStream, ReadHalf, WriteHalf, duplex};
use transport_websocket::{
    WebSocketStream,
    tungstenite::{Message, protocol::Role},
};

#[derive(Default)]
struct Pause {
    entered: tokio::sync::Notify,
    resume: AtomicBool,
    write: AtomicWaker,
}
struct Socket(WriteHalf<DuplexStream>, ReadHalf<DuplexStream>, Arc<Pause>);
impl AsyncWrite for Socket {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.2.write.register(cx.waker());
        if !self.2.resume.load(Ordering::Acquire) {
            self.2.entered.notify_one();
            return Poll::Pending;
        }
        Pin::new(&mut self.0).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_shutdown(cx)
    }
}
impl AsyncRead for Socket {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.1).poll_read(cx, bytes)
    }
}

use agent_harness::Harness;
use history_fs::FileHistory;
use std::path::Path;

// Use the filesystem registry, with a revocable lease like a remote history
// store. Losing it releases the underlying writer and notifies the Harness.
struct History {
    files: FileHistory,
    lease: Arc<Mutex<Option<Box<dyn Lease>>>>,
    lost: CancellationToken,
}
struct RevocableLease {
    lease: Arc<Mutex<Option<Box<dyn Lease>>>>,
    lost: CancellationToken,
}
impl Lease for RevocableLease {
    fn check(&self) -> Result<()> {
        ensure!(self.lease.lock().unwrap().is_some(), "writer lease lost");
        Ok(())
    }
    fn lost(&self) -> Option<CancellationToken> {
        Some(self.lost.clone())
    }
}
impl HistoryStore for History {
    fn acquire(&self, session: &str) -> Result<Box<dyn Lease>> {
        *self.lease.lock().unwrap() = Some(self.files.acquire(session)?);
        Ok(Box::new(RevocableLease {
            lease: self.lease.clone(),
            lost: self.lost.clone(),
        }))
    }
    fn load(&self, session: &str) -> Result<SessionData> {
        self.files.load(session)
    }
    fn save(&self, data: &SessionData) -> Result<()> {
        self.files.save(data)
    }
    fn list(&self, project: Option<&Path>) -> Result<Vec<SessionData>> {
        self.files.list(project)
    }
    fn erase(&self, entries: Vec<String>, held: &[String]) -> Result<Vec<SessionData>> {
        self.files.erase(entries, held)
    }
    fn check_erasure(&self, data: &SessionData) -> Result<()> {
        self.files.check_erasure(data)
    }
}
struct InstallHistory(Arc<History>);
impl Plugin for InstallHistory {
    fn name(&self) -> &str {
        "handoff-test.history"
    }
    fn install(&self, registrar: &mut Registrar<'_>) -> Result<()> {
        registrar.provide::<dyn HistoryStore>("history", self.0.clone())
    }
}

struct Host {
    api: Api,
    scope: Scope,
    prepared: tokio::sync::Notify,
    cancel_read: tokio::sync::Notify,
    signal: Mutex<Option<CancellationToken>>,
}
#[async_trait]
impl Endpoint for Host {
    fn delivery(&self, _: &Peer, method: &str, _: &Value) -> Option<Gate> {
        (method == "tools/call").then(|| scoped(&self.api, &self.scope, method))
    }
    async fn request(
        &self,
        peer: Arc<Peer>,
        id: Value,
        method: &str,
        _: Value,
        cancel: CancellationToken,
    ) -> Reply {
        if method != "tools/call" {
            return Err(Fault::unknown(method));
        }
        *self.signal.lock().unwrap() = Some(cancel);
        peer.notify_scoped(
            "host/env/output",
            json!({"parentRequestId":id,"chunk":"private progress"}),
            &self.api,
            &self.scope,
        );
        // On the current-thread runtime the endpoint returns and queues the
        // reply before the test wakes. There are no child callbacks to drain.
        self.prepared.notify_one();
        Ok(json!({"status":"completed","content":"private result"}))
    }
    fn admit_notification(
        self: Arc<Self>,
        _: &Arc<Peer>,
        method: &str,
        _: Value,
    ) -> Option<Notification> {
        if method == "test/afterCancel" {
            self.cancel_read.notify_one();
        }
        None
    }
}

async fn connect(websocket: bool, host: Arc<Host>, pause: Arc<Pause>) -> (Arc<Peer>, Either) {
    let (server, client) = duplex(4096);
    let (reader, writer) = tokio::io::split(server);
    let server = Socket(writer, reader, pause);
    if websocket {
        let ws = WebSocketStream::from_raw_socket(server, Role::Server, None).await;
        let (ready, peer) = oneshot::channel();
        tokio::spawn(transport_websocket::run(
            ws,
            CancellationToken::new(),
            |conn| async move {
                let peer = Peer::websocket(conn, host, false);
                assert!(ready.send(peer.clone()).is_ok());
                peer.finished.cancelled().await;
            },
        ));
        let ws = WebSocketStream::from_raw_socket(client, Role::Client, None).await;
        (peer.await.unwrap(), Either::Socket(Box::new(ws)))
    } else {
        let (reader, writer) = tokio::io::split(server);
        (
            Peer::start(reader, writer, host),
            Either::Stdio(BufReader::new(client)),
        )
    }
}

#[derive(Clone, Copy, Debug)]
enum Change {
    LateCancel,
    Revoke,
    LoseLease,
    PublishErasure,
}

async fn run(websocket: bool, change: Change) -> Result<()> {
    let dir = tempfile::tempdir()?;
    let files = dir.path().join("history");
    let history = Arc::new(History {
        files: FileHistory::new(&files)?,
        lease: Arc::default(),
        lost: CancellationToken::new(),
    });
    let harness = Harness::new();
    harness
        .load(Arc::new(InstallHistory(history.clone())))
        .await?;
    let session = harness.create(dir.path(), json!({})).await?;
    let owner = Scope::session(&session);
    let scope = Scope {
        actor: "member".into(),
        ..owner.clone()
    };
    harness.grant(&owner, &scope.actor, Authority::only(&["watch", "tools"]))?;
    let entry = harness.append(
        &owner,
        "test",
        Draft::new("test.note", true, json!("private history")),
    )?;
    let api: Api = harness;
    let host = Arc::new(Host {
        api: api.clone(),
        scope: scope.clone(),
        prepared: tokio::sync::Notify::new(),
        cancel_read: tokio::sync::Notify::new(),
        signal: Mutex::default(),
    });
    let pause = Arc::new(Pause::default());
    let (peer, mut client) = connect(websocket, host.clone(), pause.clone()).await;
    client
        .send(json!({"jsonrpc":"2.0","id":1,"method":"$/ping"}))
        .await;
    pause.entered.notified().await;
    let params = json!({"sessionId":session});
    client
        .send(json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":params}))
        .await;
    host.prepared.notified().await;
    let cancel = CancellationToken::new();
    let work = Work::new(&api, &scope, "tools/call", cancel.clone());
    let request = peer.call(
        "tools/call",
        json!({"sessionId":session,"input":"private tool input"}),
        Some(work),
        cancel,
    );
    tokio::pin!(request);
    assert!(futures_util::poll!(&mut request).is_pending());

    client
        .send(json!({"jsonrpc":"2.0","method":"$/cancel","params":{"id":2}}))
        .await;
    client
        .send(json!({"jsonrpc":"2.0","method":"test/afterCancel"}))
        .await;
    host.cancel_read.notified().await;
    match change {
        Change::LateCancel => {}
        Change::Revoke => api.grant(&owner, &scope.actor, Authority::default())?,
        Change::LoseLease => {
            history.lease.lock().unwrap().take();
            history.lost.cancel();
            assert!(history.files.acquire(&session).is_ok());
        }
        Change::PublishErasure => {
            // Another registry user publishes intent. The live Harness still
            // holds the old in-memory view; it must consult the store at handoff.
            let copies = FileHistory::new(&files)?.mark_erasure(&session, &[entry.id])?;
            assert_eq!(copies[&session].len(), 1);
        }
    }
    pause.resume.store(true, Ordering::Release);
    pause.write.wake();
    assert_eq!(client.recv().await["id"], 1);
    if matches!(change, Change::LateCancel) {
        assert_eq!(client.recv().await["params"]["chunk"], "private progress");
        let reply = client.recv().await;
        assert_eq!(reply["id"], 2);
        assert_eq!(reply["result"]["status"], "completed");
        assert!(!host.signal.lock().unwrap().as_ref().unwrap().is_cancelled());
        let outbound = client.recv().await;
        assert_eq!(outbound["params"]["input"], "private tool input");
        client
            .send(json!({"jsonrpc":"2.0","id":outbound["id"],"result":{}}))
            .await;
        assert_eq!(request.await.unwrap(), json!({}));
    } else {
        let reply = client.recv().await;
        assert_eq!(reply["id"], 2);
        assert_eq!(reply["error"]["data"]["code"], "withheld");
        assert!(!reply.to_string().contains("private"));
        assert_eq!(request.await.unwrap_err().code, "withheld");
    }
    // The notification must not precede the refused reply, and neither it nor
    // the refused request may appear later on the wire.
    client
        .send(json!({"jsonrpc":"2.0","id":3,"method":"$/ping"}))
        .await;
    assert_eq!(
        client.recv().await,
        json!({"jsonrpc":"2.0","id":3,"result":{}})
    );
    peer.close();
    Ok(())
}

enum Either {
    Stdio(BufReader<DuplexStream>),
    Socket(Box<WebSocketStream<DuplexStream>>),
}
impl Either {
    async fn send(&mut self, frame: Value) {
        let line = frame.to_string();
        match self {
            Self::Stdio(client) => client
                .get_mut()
                .write_all(format!("{line}\n").as_bytes())
                .await
                .unwrap(),
            Self::Socket(client) => client.send(Message::Text(line.into())).await.unwrap(),
        }
    }
    async fn recv(&mut self) -> Value {
        let line = match self {
            Self::Stdio(client) => {
                let mut line = String::new();
                client.read_line(&mut line).await.unwrap();
                line
            }
            Self::Socket(client) => client
                .next()
                .await
                .unwrap()
                .unwrap()
                .into_text()
                .unwrap()
                .to_string(),
        };
        serde_json::from_str(&line).unwrap()
    }
}

#[tokio::test(flavor = "current_thread")]
async fn queued_frames_recheck_the_live_harness_on_stdio_and_websocket() {
    for websocket in [false, true] {
        for change in [
            Change::LateCancel,
            Change::Revoke,
            Change::LoseLease,
            Change::PublishErasure,
        ] {
            tokio::time::timeout(Duration::from_secs(5), run(websocket, change))
                .await
                .unwrap_or_else(|_| panic!("handoff stalled: websocket={websocket}, {change:?}"))
                .unwrap();
        }
    }
}
