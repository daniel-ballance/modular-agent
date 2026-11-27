//! Enforce the Modular Agent framing rules before passing lines to the ACP SDK.
use agent_api::{CancellationToken, Value, json, wire};
use futures::{AsyncBufReadExt, AsyncWriteExt, Sink, Stream, io::BufReader, sink, stream};
use std::{
    collections::{BTreeMap, BTreeSet},
    io,
    sync::{Arc, Mutex as SyncMutex},
};
use tokio::sync::{Mutex, mpsc};

const LIMIT: usize = 64 * 1024 * 1024;
const LOCAL_REFUSALS: usize = 64;

type Reader = BufReader<blocking::Unblock<io::Stdin>>;
type Writer = Arc<Mutex<blocking::Unblock<io::Stdout>>>;
type SendLine =
    Arc<dyn Fn(String) -> futures::future::BoxFuture<'static, io::Result<()>> + Send + Sync>;

pub(crate) type CheckView = dyn Fn(&str) -> Option<Vec<String>> + Send + Sync;
type InFlight = BTreeMap<String, (String, Option<Vec<String>>)>;
#[derive(Default)]
pub(crate) struct Delivery {
    pub check: SyncMutex<Option<Arc<CheckView>>>,
    requests: SyncMutex<InFlight>,
}
impl Delivery {
    fn stamp(&self, session: &str) -> Option<Vec<String>> {
        self.check.lock().unwrap().clone()?(session)
    }
    fn receive(&self, id: &Value, value: &Value) -> bool {
        let (Some(method), Some(session)) = (
            value["method"].as_str(),
            value["params"]["sessionId"].as_str(),
        ) else {
            return true;
        };
        if matches!(method, "session/close" | "session/load" | "session/resume") {
            return true;
        }
        let stamp = if method == "_modular-agent/erase" {
            None
        } else {
            self.stamp(session)
        };
        let mut requests = self.requests.lock().unwrap();
        if requests.len() >= 1024 {
            return false;
        }
        requests.insert(id.to_string(), (session.into(), stamp));
        true
    }
    fn send(&self, line: String, refuse: &Refusals) -> Option<String> {
        let frame: Value = serde_json::from_str(&line).ok()?;
        if frame["method"].is_string() {
            if let Some(session) = frame["params"]["sessionId"].as_str()
                && self.stamp(session).is_none()
            {
                if let Some(id) = frame.get("id") {
                    refuse.send(error(
                        id,
                        -32000,
                        "withheld",
                        "session delivery is no longer available",
                    ));
                }
                return None;
            }
            return Some(line);
        }
        let id = &frame["id"];
        let request = self.requests.lock().unwrap().remove(&id.to_string());
        if frame["error"].is_object() && frame["error"]["data"]["_meta"].is_null() {
            return Some(line);
        }
        let allowed = if let Some((session, before)) = request {
            self.stamp(&session)
                .is_some_and(|current| before.is_none_or(|stamp| stamp == current))
        } else if let Some(session) = frame["result"]["sessionId"].as_str() {
            self.stamp(session).is_some()
        } else {
            true
        };
        Some(if allowed {
            line
        } else {
            error(
                id,
                -32000,
                "withheld",
                "session delivery is no longer available",
            )
        })
    }
}

fn valid_id(id: &Value) -> bool {
    id.is_string()
        || id
            .as_i64()
            .is_some_and(|n| n.unsigned_abs() <= 9_007_199_254_740_991)
}

fn error(id: &Value, number: i64, code: &str, message: &str) -> String {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":number,"message":message,"data":{"code":code}}})
        .to_string()
}

async fn write_line(writer: &Writer, line: &str) -> io::Result<()> {
    let mut writer = writer.lock().await;
    writer.write_all(line.as_bytes()).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await
}

enum WireReader {
    Stdio(Reader, Vec<u8>),
    WebSocket(mpsc::Receiver<String>),
}
impl WireReader {
    async fn next(&mut self) -> io::Result<Option<Vec<u8>>> {
        match self {
            Self::WebSocket(rx) => Ok(rx.recv().await.map(String::into_bytes)),
            Self::Stdio(reader, bytes) => loop {
                let chunk = reader.fill_buf().await?;
                if chunk.is_empty() {
                    return Ok(None);
                }
                let newline = chunk.iter().position(|&byte| byte == b'\n');
                let length = newline.map_or(chunk.len(), |n| n + 1);
                if bytes.len() + length > LIMIT + 3 {
                    return Ok(None);
                }
                bytes.extend_from_slice(&chunk[..length]);
                reader.consume_unpin(length);
                if newline.is_some() {
                    bytes.pop();
                    if bytes.last() == Some(&b'\r') {
                        bytes.pop();
                    }
                    return Ok(Some(std::mem::take(bytes)));
                }
            },
        }
    }
}
struct Refusals {
    tx: mpsc::Sender<String>,
    disconnected: CancellationToken,
}
impl Refusals {
    fn send(&self, line: String) {
        // A local reply settles the SDK's question. End the stream rather than
        // block or silently drop a reply when the SDK stops draining them.
        if !self.disconnected.is_cancelled() && self.tx.try_send(line).is_err() {
            self.disconnected.cancel();
        }
    }
}

struct Input {
    reader: WireReader,
    write: SendLine,
    refusals: mpsc::Receiver<String>,
    seen: BTreeSet<String>,
    delivery: Arc<Delivery>,
}
impl Input {
    async fn next(&mut self) -> io::Result<Option<String>> {
        loop {
            let frame = tokio::select! {
                msg = self.refusals.recv(), if !self.refusals.is_closed() => {
                    if msg.is_some() { return Ok(msg); }
                    continue;
                }
                frame = self.reader.next() => frame?,
            };
            let Some(frame) = frame else {
                return Ok(None);
            };
            let line = frame.as_slice();
            let oversized = line.len() > LIMIT;
            match wire::decode_json(line) {
                Ok(value) if oversized => {
                    let Some(id) = value.get("id").filter(|id| valid_id(id)) else {
                        return Ok(None);
                    };
                    if value["jsonrpc"] != "2.0"
                        || !value["method"].is_string()
                        || !self.seen.insert(id.to_string())
                    {
                        return Ok(None);
                    }
                    (self.write)(error(
                        id,
                        -32000,
                        "message_too_large",
                        "request is too large",
                    ))
                    .await?;
                }
                Ok(value) if value.is_object() => {
                    if value.get("method").is_some()
                        && let Some(id) = value.get("id")
                        && (!valid_id(id)
                            || !self.seen.insert(id.to_string())
                            || !self.delivery.receive(id, &value))
                    {
                        return Ok(None);
                    }
                    return Ok(Some(String::from_utf8(frame).expect("validated wire JSON")));
                }
                Err(wire::JsonError::TooDeep) if !oversized => {
                    let Ok(value) = serde_json::from_slice::<Value>(line) else {
                        return Ok(None);
                    };
                    if !value["method"].is_string() {
                        return Ok(None);
                    }
                    if let Some(id) = value.get("id") {
                        if !valid_id(id) || !self.seen.insert(id.to_string()) {
                            return Ok(None);
                        }
                        (self.write)(error(
                            id,
                            -32602,
                            "invalid_request",
                            "JSON nesting exceeds 64 levels",
                        ))
                        .await?;
                    }
                }
                _ => return Ok(None),
            }
        }
    }
}

pub(crate) fn stdio(
    delivery: Arc<Delivery>,
) -> impl agent_client_protocol::ConnectTo<agent_client_protocol::Agent> {
    let writer = Arc::new(Mutex::new(blocking::Unblock::new(io::stdout())));
    lines(
        WireReader::Stdio(
            BufReader::new(blocking::Unblock::new(io::stdin())),
            Vec::new(),
        ),
        delivery,
        Arc::new(move |line| {
            let writer = writer.clone();
            Box::pin(async move { write_line(&writer, &line).await })
        }),
    )
}

pub(crate) fn websocket(
    conn: transport_websocket::Connection,
    delivery: Arc<Delivery>,
) -> impl agent_client_protocol::ConnectTo<agent_client_protocol::Agent> {
    lines(
        WireReader::WebSocket(conn.incoming),
        delivery,
        Arc::new(move |line| {
            let writer = conn.outgoing.clone();
            Box::pin(async move {
                writer
                    .send(line)
                    .await
                    .map_err(|_| io::ErrorKind::BrokenPipe.into())
            })
        }),
    )
}

fn lines(
    reader: WireReader,
    delivery: Arc<Delivery>,
    write: SendLine,
) -> impl agent_client_protocol::ConnectTo<agent_client_protocol::Agent> {
    let (outgoing, incoming) = split_lines(reader, delivery, write);
    agent_client_protocol::Lines::new(Box::pin(outgoing), Box::pin(incoming))
}

fn split_lines(
    reader: WireReader,
    delivery: Arc<Delivery>,
    write: SendLine,
) -> (
    impl Sink<String, Error = io::Error>,
    impl Stream<Item = io::Result<String>>,
) {
    // The peer can close its read pipe before EOF on its write pipe. Treat a
    // failed write to that pipe as disconnect, not a failed agent shutdown.
    let disconnected = CancellationToken::new();
    let write: SendLine = Arc::new({
        let disconnected = disconnected.clone();
        move |line| {
            let disconnected = disconnected.clone();
            let write = write.clone();
            Box::pin(async move {
                match disconnected
                    .run_until_cancelled(async { write(line).await })
                    .await
                {
                    None => Ok(()),
                    Some(Err(e)) if e.kind() == io::ErrorKind::BrokenPipe => {
                        disconnected.cancel();
                        Ok(())
                    }
                    Some(result) => result,
                }
            })
        }
    });
    let (tx, refusals) = mpsc::channel(LOCAL_REFUSALS);
    let refuse = Refusals {
        tx,
        disconnected: disconnected.clone(),
    };
    let input = Input {
        reader,
        write: write.clone(),
        refusals,
        seen: BTreeSet::new(),
        delivery: delivery.clone(),
    };
    let incoming = stream::unfold(Some((input, disconnected)), |state| async move {
        let (mut input, disconnected) = state?;
        tokio::select! {
            biased;
            _ = disconnected.cancelled() => None,
            result = input.next() => match result {
                Ok(Some(line)) => Some((Ok(line), Some((input, disconnected)))),
                Ok(None) => None,
                Err(e) => Some((Err(e), None)),
            }
        }
    });
    let outgoing = sink::unfold(
        (write, refuse, delivery),
        |(write, refuse, delivery), line: String| async move {
            if line.len() <= LIMIT {
                if let Some(line) = delivery.send(line, &refuse) {
                    write(line).await?;
                }
            } else if let Ok(frame) = serde_json::from_str::<Value>(&line) {
                if let Some(id) = frame.get("id") {
                    if frame["method"].is_string() {
                        // Withhold an oversized question and settle its SDK waiter locally.
                        refuse.send(error(
                            id,
                            -32000,
                            "withheld",
                            "outbound request is too large",
                        ));
                    } else {
                        write(error(
                            id,
                            -32000,
                            "result_too_large",
                            "response is too large",
                        ))
                        .await?;
                    }
                }
                // An oversized notification is withheld.
            } else {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid outgoing ACP frame",
                ));
            }
            Ok((write, refuse, delivery))
        },
    );
    (outgoing, incoming)
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::{SinkExt, StreamExt, poll};
    use std::task::Poll;

    #[tokio::test]
    async fn a_stalled_acp_reader_cannot_accumulate_local_refusals() {
        let (tx, reader) = mpsc::channel(1);
        let write_started = CancellationToken::new();
        let write: SendLine = Arc::new({
            let write_started = write_started.clone();
            move |_| {
                write_started.cancel();
                Box::pin(std::future::pending())
            }
        });
        let (outgoing, incoming) =
            split_lines(WireReader::WebSocket(reader), Arc::default(), write);
        let mut outgoing = Box::pin(outgoing);
        let mut incoming = Box::pin(incoming);
        // A local validation error is trying to write to the stalled peer, so
        // the SDK's incoming stream is no longer draining local refusals.
        tx.try_send(format!(
            r#"{{"jsonrpc":"2.0","id":0,"method":"test","params":{}0{}}}"#,
            "[".repeat(70),
            "]".repeat(70)
        ))
        .unwrap();
        let next = incoming.next();
        tokio::pin!(next);
        assert!(poll!(&mut next).is_pending());
        assert!(write_started.is_cancelled());

        for id in 1..=LOCAL_REFUSALS + 1 {
            outgoing
                .send(
                    json!({"jsonrpc":"2.0","id":id,"method":"session/request_permission",
                "params":{"sessionId":"withheld"}})
                    .to_string(),
                )
                .await
                .unwrap();
            if id <= LOCAL_REFUSALS {
                assert!(
                    poll!(&mut next).is_pending(),
                    "closed before filling the queue"
                );
            }
        }
        assert!(matches!(poll!(&mut next), Poll::Ready(None)));
    }
}
