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

struct Provider {
    revocation: Arc<AtomicBool>,
    lease: CancellationToken,
    erasure: Arc<AtomicU64>,
    prepared: mpsc::Sender<()>,
}
#[async_trait]
impl Endpoint for Provider {
    fn delivery(&self, _: &Peer, method: &str, _: &Value) -> Option<Gate> {
        if method != "provider/request" {
            return None;
        }
        let before = self.erasure.load(Ordering::Acquire);
        let (revoked, lease, erasure) = (
            self.revocation.clone(),
            self.lease.clone(),
            self.erasure.clone(),
        );
        Some(Box::new(move || {
            !revoked.load(Ordering::Acquire)
                && !lease.is_cancelled()
                && erasure.load(Ordering::Acquire) == before
        }))
    }
    async fn request(
        &self,
        _: Arc<Peer>,
        _: Value,
        method: &str,
        _: Value,
        _: CancellationToken,
    ) -> Reply {
        if method == "provider/request" {
            self.prepared.try_send(()).unwrap();
            Ok(json!({"content":"private provider result"}))
        } else {
            Err(Fault::unknown(method))
        }
    }
}

async fn run(websocket: bool, change: &str) {
    let (prepared, mut queued) = mpsc::channel(1);
    let provider = Arc::new(Provider {
        revocation: Arc::default(),
        lease: CancellationToken::new(),
        erasure: Arc::default(),
        prepared,
    });
    let pause = Arc::new(Pause::default());
    let (server, client) = duplex(4096);
    let (reader, writer) = tokio::io::split(server);
    let (stop, stop_writer) = (CancellationToken::new(), provider.clone());
    let server = Socket(writer, reader, pause.clone());
    let client = if websocket {
        let ws = WebSocketStream::from_raw_socket(server, Role::Server, None).await;
        tokio::spawn(transport_websocket::run(
            ws,
            stop.clone(),
            |conn| async move {
                Peer::websocket(conn, stop_writer, true)
                    .finished
                    .cancelled()
                    .await;
            },
        ));
        let ws = WebSocketStream::from_raw_socket(client, Role::Client, None).await;
        Either::Socket(Box::new(ws))
    } else {
        let (reader, writer) = tokio::io::split(server);
        Peer::start(reader, writer, stop_writer);
        Either::Stdio(BufReader::new(client))
    };
    let mut client = client;
    client.send(1, "$/ping").await;
    pause.entered.notified().await;
    client.send(2, "provider/request").await;
    queued.recv().await.unwrap();
    match change {
        "revocation" => provider.revocation.store(true, Ordering::Release),
        "lease" => provider.lease.cancel(),
        "erasure" => {
            provider.erasure.fetch_add(1, Ordering::AcqRel);
        }
        _ => unreachable!(),
    }
    pause.resume.store(true, Ordering::Release);
    pause.write.wake();
    assert_eq!(client.recv().await["id"], 1);
    let reply = client.recv().await;
    assert_eq!(reply["id"], 2);
    assert_eq!(reply["error"]["data"]["code"], "withheld");
    assert!(!reply.to_string().contains("private provider result"));
    client.send(3, "$/ping").await;
    assert_eq!(client.recv().await["result"], json!({}));
    stop.cancel();
}

enum Either {
    Stdio(BufReader<DuplexStream>),
    Socket(Box<WebSocketStream<DuplexStream>>),
}
impl Either {
    async fn send(&mut self, id: u8, method: &str) {
        let line =
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":{"sessionId":"s"}}).to_string();
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

#[tokio::test]
async fn served_provider_rechecks_before_stdio_and_websocket_handoff() {
    for websocket in [false, true] {
        for change in ["revocation", "lease", "erasure"] {
            tokio::time::timeout(Duration::from_secs(5), run(websocket, change))
                .await
                .unwrap();
        }
    }
}
