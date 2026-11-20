//! Enforce the Modular Agent framing rules before passing lines to the ACP SDK.
use agent_api::{Value, json, wire};
use futures::{AsyncBufReadExt, AsyncWriteExt, io::BufReader, sink, stream};
use std::{collections::BTreeSet, io, sync::Arc};
use tokio::sync::{Mutex, mpsc};

const LIMIT: usize = 64 * 1024 * 1024;

type Reader = BufReader<blocking::Unblock<io::Stdin>>;
type Writer = Arc<Mutex<blocking::Unblock<io::Stdout>>>;
type SendLine =
    Arc<dyn Fn(String) -> futures::future::BoxFuture<'static, io::Result<()>> + Send + Sync>;

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
struct Input {
    reader: WireReader,
    write: SendLine,
    refusals: mpsc::UnboundedReceiver<String>,
    seen: BTreeSet<String>,
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
                        && (!valid_id(id) || !self.seen.insert(id.to_string()))
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

pub(crate) fn stdio() -> impl agent_client_protocol::ConnectTo<agent_client_protocol::Agent> {
    let writer = Arc::new(Mutex::new(blocking::Unblock::new(io::stdout())));
    lines(
        WireReader::Stdio(
            BufReader::new(blocking::Unblock::new(io::stdin())),
            Vec::new(),
        ),
        Arc::new(move |line| {
            let writer = writer.clone();
            Box::pin(async move { write_line(&writer, &line).await })
        }),
    )
}

pub(crate) fn websocket(
    conn: transport_websocket::Connection,
) -> impl agent_client_protocol::ConnectTo<agent_client_protocol::Agent> {
    lines(
        WireReader::WebSocket(conn.incoming),
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
    write: SendLine,
) -> impl agent_client_protocol::ConnectTo<agent_client_protocol::Agent> {
    let (refuse, refusals) = mpsc::unbounded_channel();
    let input = Input {
        reader,
        write: write.clone(),
        refusals,
        seen: BTreeSet::new(),
    };
    let incoming = stream::unfold(Some(input), |state| async move {
        let mut input = state?;
        match input.next().await {
            Ok(Some(line)) => Some((Ok(line), Some(input))),
            Ok(None) => None,
            Err(e) => Some((Err(e), None)),
        }
    });
    let outgoing = sink::unfold(
        (write, refuse),
        |(write, refuse), line: String| async move {
            if line.len() <= LIMIT {
                write(line).await?;
            } else if let Ok(frame) = serde_json::from_str::<Value>(&line) {
                if let Some(id) = frame.get("id") {
                    if frame["method"].is_string() {
                        // Withhold an oversized question and settle its SDK waiter locally.
                        let _ = refuse.send(error(
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
            Ok((write, refuse))
        },
    );
    agent_client_protocol::Lines::new(Box::pin(outgoing), Box::pin(incoming))
}
