//! Enforce the Modular Agent framing rules before passing lines to the ACP SDK.
use agent_api::{Value, json, wire};
use futures::{AsyncBufReadExt, AsyncWriteExt, io::BufReader, sink, stream};
use std::{collections::BTreeSet, io, sync::Arc};
use tokio::sync::{Mutex, mpsc};

const LIMIT: usize = 64 * 1024 * 1024;

type Reader = BufReader<blocking::Unblock<io::Stdin>>;
type Writer = Arc<Mutex<blocking::Unblock<io::Stdout>>>;

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

struct Input {
    reader: Reader,
    writer: Writer,
    refusals: mpsc::UnboundedReceiver<String>,
    bytes: Vec<u8>,
    seen: BTreeSet<String>,
}
impl Input {
    async fn next(&mut self) -> io::Result<Option<String>> {
        loop {
            let chunk = tokio::select! {
                msg = self.refusals.recv(), if !self.refusals.is_closed() => {
                    if msg.is_some() { return Ok(msg); }
                    continue;
                }
                bytes = self.reader.fill_buf() => bytes?,
            };
            if chunk.is_empty() {
                return Ok(None);
            }
            let newline = chunk.iter().position(|&byte| byte == b'\n');
            let length = newline.map_or(chunk.len(), |n| n + 1);
            // An incomplete oversized frame has no safely validated request id.
            if self.bytes.len() + length > LIMIT + 3 {
                return Ok(None);
            }
            self.bytes.extend_from_slice(&chunk[..length]);
            self.reader.consume_unpin(length);
            if newline.is_none() {
                continue;
            }
            let line = self.bytes.strip_suffix(b"\n").unwrap();
            let line = line.strip_suffix(b"\r").unwrap_or(line);
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
                    write_line(
                        &self.writer,
                        &error(id, -32000, "message_too_large", "request is too large"),
                    )
                    .await?;
                }
                Ok(value) if value.is_object() => {
                    if value.get("method").is_some()
                        && let Some(id) = value.get("id")
                        && (!valid_id(id) || !self.seen.insert(id.to_string()))
                    {
                        return Ok(None);
                    }
                    let line = String::from_utf8(line.to_vec()).expect("validated wire JSON");
                    self.bytes.clear();
                    return Ok(Some(line));
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
                        write_line(
                            &self.writer,
                            &error(
                                id,
                                -32602,
                                "invalid_request",
                                "JSON nesting exceeds 64 levels",
                            ),
                        )
                        .await?;
                    }
                }
                _ => return Ok(None),
            }
            self.bytes.clear();
        }
    }
}

pub(crate) fn stdio() -> impl agent_client_protocol::ConnectTo<agent_client_protocol::Agent> {
    let writer = Arc::new(Mutex::new(blocking::Unblock::new(io::stdout())));
    let (refuse, refusals) = mpsc::unbounded_channel();
    let input = Input {
        reader: BufReader::new(blocking::Unblock::new(io::stdin())),
        writer: writer.clone(),
        refusals,
        bytes: Vec::new(),
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
        (writer, refuse),
        |(writer, refuse), line: String| async move {
            if line.len() <= LIMIT {
                write_line(&writer, &line).await?;
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
                        write_line(
                            &writer,
                            &error(id, -32000, "result_too_large", "response is too large"),
                        )
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
            Ok((writer, refuse))
        },
    );
    agent_client_protocol::Lines::new(Box::pin(outgoing), Box::pin(incoming))
}
