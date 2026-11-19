//! Symmetric, cancellable NDJSON RPC. Each direction has its own id space.
use agent_api::*;
use futures_util::FutureExt;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    sync::{mpsc, oneshot},
    task::JoinSet,
};

pub const MAX_FRAME: usize = 64 * 1024 * 1024;
fn valid_id(id: &Value) -> bool {
    id.is_string()
        || id
            .as_i64()
            .is_some_and(|n| (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&n))
}
pub type Reply = std::result::Result<Value, Fault>;
#[derive(Clone, Debug)]
pub struct Fault {
    pub code: String,
    pub message: String,
    pub number: i64,
    pub limit: Option<String>,
}
impl Fault {
    pub fn new(code: &str, message: impl ToString) -> Self {
        Self {
            code: code.into(),
            message: message.to_string(),
            limit: None,
            number: if code == "invalid_request" {
                -32602
            } else {
                -32000
            },
        }
    }
    pub fn unknown(method: &str) -> Self {
        Self {
            number: -32601,
            ..Self::new("method_not_found", format!("unknown method {method}"))
        }
    }
}
impl std::fmt::Display for Fault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for Fault {}
impl From<anyhow::Error> for Fault {
    fn from(error: anyhow::Error) -> Self {
        if let Some(fault) = error.downcast_ref::<Self>() {
            return fault.clone();
        }
        let code = if is_file_not_found(&error) {
            "not_found"
        } else if error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|e| e.kind() == std::io::ErrorKind::Unsupported)
        {
            "not_supported"
        } else {
            "internal"
        };
        Self::new(code, error)
    }
}
pub struct Work {
    pub api: std::sync::Weak<dyn AgentApi>,
    pub scope: Scope,
    pub method: String,
    pub(crate) provider: Option<crate::host::ProviderWork>,
    pub cancel: CancellationToken,
    pub asks: AtomicU64,
    pub changed_tools: Mutex<std::collections::BTreeSet<String>>,
    pub stream: String,
    pub(crate) runtime: Option<Arc<crate::runtime_host::TurnWork>>,
}
impl Work {
    pub fn new(api: &Api, scope: &Scope, method: &str, cancel: CancellationToken) -> Arc<Self> {
        Arc::new(Self {
            api: Arc::downgrade(api),
            scope: scope.clone(),
            method: method.into(),
            provider: None,
            cancel,
            asks: AtomicU64::new(0),
            changed_tools: Mutex::default(),
            stream: crate::wire::stream_id(),
            runtime: None,
        })
    }
}
#[async_trait]
pub trait Endpoint: Send + Sync {
    async fn request(
        &self,
        peer: Arc<Peer>,
        id: Value,
        method: &str,
        params: Value,
        cancel: CancellationToken,
    ) -> Reply;
    async fn notification(&self, _peer: Arc<Peer>, _method: &str, _params: Value) {}
}
type OnEvent = Box<dyn Fn(Value) + Send + Sync>;
struct Pending {
    reply: oneshot::Sender<Reply>,
    work: Option<Arc<Work>>,
    event: Option<OnEvent>,
}
// A host callback may be dropped while it is awaiting a nested RPC. Stop that
// request too, and retire its parent scope rather than leaving it in the map.
struct Outgoing<'a> {
    peer: &'a Peer,
    id: &'a str,
    key: &'a str,
    cancel_sent: bool,
}
impl Drop for Outgoing<'_> {
    fn drop(&mut self) {
        let was_pending = self.peer.pending.lock().unwrap().remove(self.key).is_some();
        if was_pending && !self.cancel_sent {
            self.peer.notify("$/cancel", json!({"id":self.id}));
        }
    }
}
pub struct Peer {
    tx: mpsc::UnboundedSender<Value>,
    next: AtomicU64,
    pending: Mutex<BTreeMap<String, Pending>>,
    incoming: Mutex<BTreeMap<String, CancellationToken>>,
    pub closed: CancellationToken,
    pub finished: CancellationToken,
}
impl Peer {
    pub fn start<R, W>(reader: R, mut writer: W, endpoint: Arc<dyn Endpoint>) -> Arc<Self>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
        let peer = Arc::new(Self {
            tx,
            next: AtomicU64::new(1),
            pending: Mutex::default(),
            incoming: Mutex::default(),
            closed: CancellationToken::new(),
            finished: CancellationToken::new(),
        });
        let p = peer.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    message = rx.recv() => {
                        let Some(message) = message else { break };
                        let mut bytes = match serde_json::to_vec(&message) { Ok(b) => b, Err(_) => break };
                        if bytes.len() > MAX_FRAME {
                            if let Some(id) = message.get("id").filter(|_| message.get("method").is_none()) {
                                bytes = serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"result exceeds 64 MiB","data":{"code":"result_too_large"}}})).unwrap();
                            } else { p.close(); break }
                        }
                        bytes.push(b'\n');
                        if writer.write_all(&bytes).await.is_err() || writer.flush().await.is_err() { p.close(); break }
                    }
                    _ = p.closed.cancelled() => break,
                }
            }
            let _ = writer.shutdown().await;
        });
        let p = peer.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(reader);
            let mut tasks = JoinSet::new();
            let mut used = BTreeSet::new();
            loop {
                let mut bytes = vec![];
                // Take bounds allocation even for a peer that never sends a newline.
                while tasks.try_join_next().is_some() {}
                let mut bounded = (&mut reader).take((MAX_FRAME + 3) as u64);
                let read = bounded.read_until(b'\n', &mut bytes);
                tokio::pin!(read);
                let n = tokio::select! {
                    _ = p.closed.cancelled() => break,
                    n = &mut read => match n { Ok(n) => n, Err(_) => break },
                };
                if n == 0 {
                    break;
                }
                let Some(line) = bytes.strip_suffix(b"\n") else {
                    break;
                };
                let line = line.strip_suffix(b"\r").unwrap_or(line);
                if line.len() > MAX_FRAME {
                    break;
                }
                let m: Value = match agent_api::wire::decode_json(line) {
                    Ok(m) => m,
                    Err(agent_api::wire::JsonError::TooDeep) => {
                        // Recover a request id only if the normal parser can safely
                        // read the envelope. Never answer a response or notification.
                        let Ok(frame) = serde_json::from_slice::<Value>(line) else {
                            break;
                        };
                        if frame.get("result").is_some() || frame.get("error").is_some() {
                            break;
                        }
                        if let Some(id) = frame.get("id").filter(|id| valid_id(id)) {
                            p.respond(
                                id.clone(),
                                Err(Fault::new(
                                    "invalid_request",
                                    "JSON nesting exceeds the supported depth",
                                )),
                            );
                        }
                        continue;
                    }
                    Err(agent_api::wire::JsonError::Invalid) => {
                        p.respond(
                            Value::Null,
                            Err(Fault {
                                number: -32700,
                                ..Fault::new("parse_error", "invalid JSON frame")
                            }),
                        );
                        continue;
                    }
                };
                let response = m.get("result").is_some() || m.get("error").is_some();
                if response {
                    if m["jsonrpc"] != "2.0"
                        || !valid_id(&m["id"])
                        || m.get("method").is_some()
                        || (m.get("result").is_some() == m.get("error").is_some())
                        || m.get("error").is_some_and(|e| {
                            e["code"].as_i64().is_none()
                                || !e["message"].is_string()
                                || !e["data"]["code"].is_string()
                        })
                    {
                        break;
                    }
                } else if m["jsonrpc"] != "2.0"
                    || !m["method"].is_string()
                    || m.get("id").is_some_and(|id| !valid_id(id))
                {
                    p.respond(
                        m.get("id")
                            .filter(|id| valid_id(id))
                            .cloned()
                            .unwrap_or_default(),
                        Err(Fault {
                            number: -32600,
                            ..Fault::new("invalid_request", "invalid RPC envelope")
                        }),
                    );
                    continue;
                }
                if let Some(method) = m["method"].as_str() {
                    let params = agent_api::wire::optional(&m, "params")
                        .cloned()
                        .unwrap_or(json!({}));
                    if method == "$/cancel" {
                        if let Some(token) =
                            p.incoming.lock().unwrap().get(&params["id"].to_string())
                        {
                            token.cancel();
                        }
                    } else if let Some(id) = m.get("id") {
                        let id = id.clone();
                        let key = id.to_string();
                        let cancel = CancellationToken::new();
                        if used.len() == 65_536 || !used.insert(key.clone()) {
                            break;
                        }
                        p.incoming
                            .lock()
                            .unwrap()
                            .insert(key.clone(), cancel.clone());
                        let p = p.clone();
                        let endpoint = endpoint.clone();
                        let method = method.to_string();
                        tasks.spawn(async move {
                            let reply = if cancel.is_cancelled() {
                                Err(Fault::new(
                                    "cancelled",
                                    "request cancelled before work started",
                                ))
                            } else if method == "$/ping" {
                                Ok(json!({}))
                            } else {
                                std::panic::AssertUnwindSafe(endpoint.request(
                                    p.clone(),
                                    id.clone(),
                                    &method,
                                    params,
                                    cancel,
                                ))
                                .catch_unwind()
                                .await
                                .unwrap_or_else(|_| {
                                    Err(Fault::new("internal", "plugin callback panicked"))
                                })
                            };
                            p.incoming.lock().unwrap().remove(&key);
                            p.respond(id, reply);
                        });
                    } else {
                        endpoint.notification(p.clone(), method, params).await;
                    }
                } else if let Some(id) = m.get("id")
                    && let Some(waiter) = p.pending.lock().unwrap().remove(&id.to_string())
                {
                    let reply = if let Some(e) = agent_api::wire::optional(&m, "error") {
                        Err(Fault {
                            code: e["data"]["code"].as_str().unwrap_or("internal").into(),
                            message: e["message"].as_str().unwrap_or("RPC error").into(),
                            number: e["code"].as_i64().unwrap_or(-32000),
                            limit: e["data"]["limit"].as_str().map(str::to_owned),
                        })
                    } else {
                        Ok(m.get("result").cloned().unwrap_or(Value::Null))
                    };
                    let _ = waiter.reply.send(reply);
                } else {
                    break;
                }
            }
            p.close();
            for token in p.incoming.lock().unwrap().values() {
                token.cancel()
            }
            // Cancellation is cooperative, including joined environment cleanup.
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while tasks.join_next().await.is_some() {}
            })
            .await;
            tasks.abort_all();
            while tasks.join_next().await.is_some() {}
            p.finished.cancel();
        });
        peer
    }
    pub fn close(&self) {
        self.closed.cancel();
        for (_, pending) in std::mem::take(&mut *self.pending.lock().unwrap()) {
            let _ = pending
                .reply
                .send(Err(Fault::new("lost", "plugin connection closed")));
        }
    }
    pub fn notify(&self, method: &str, params: Value) {
        let _ = self
            .tx
            .send(json!({"jsonrpc":"2.0","method":method,"params":params}));
    }
    fn respond(&self, id: Value, reply: Reply) {
        let message = match reply {
            Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
            Err(e) => {
                let mut data = json!({"code":e.code});
                if let Some(limit) = e.limit {
                    data["limit"] = json!(limit);
                }
                json!({"jsonrpc":"2.0","id":id,"error":{"code":e.number,"message":e.message,"data":data}})
            }
        };
        let _ = self.tx.send(message);
    }
    pub fn parent(&self, id: &Value) -> Option<Arc<Work>> {
        self.pending
            .lock()
            .unwrap()
            .get(&id.to_string())
            .and_then(|p| p.work.clone())
    }
    pub async fn call(
        &self,
        method: &str,
        params: Value,
        work: Option<Arc<Work>>,
        cancel: CancellationToken,
    ) -> Reply {
        self.call_with_events(method, params, work, cancel, None)
            .await
    }
    pub(crate) fn deliver_event(&self, id: &Value, event: Value) {
        if let Some(on_event) = self
            .pending
            .lock()
            .unwrap()
            .get(&id.to_string())
            .and_then(|p| p.event.as_ref())
        {
            on_event(event);
        }
    }
    pub(crate) async fn call_with_events(
        &self,
        method: &str,
        params: Value,
        work: Option<Arc<Work>>,
        cancel: CancellationToken,
        event: Option<OnEvent>,
    ) -> Reply {
        let id = format!("r{}", self.next.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        let key = json!(id).to_string();
        self.pending.lock().unwrap().insert(
            key.clone(),
            Pending {
                reply: tx,
                work,
                event,
            },
        );
        if self.closed.is_cancelled() {
            self.pending.lock().unwrap().remove(&key);
            return Err(Fault::new("lost", "plugin connection closed"));
        }
        let frame = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        if serde_json::to_vec(&frame)
            .map_err(|e| Fault::new("internal", e))?
            .len()
            > MAX_FRAME
        {
            self.pending.lock().unwrap().remove(&key);
            return Err(Fault::new("result_too_large", "request exceeds 64 MiB"));
        }
        let _ = self.tx.send(frame);
        let mut outgoing = Outgoing {
            peer: self,
            id: &id,
            key: &key,
            cancel_sent: false,
        };
        tokio::pin!(rx);
        let reply = tokio::select! {
            result = &mut rx => result,
            _ = cancel.cancelled() => {
                self.notify("$/cancel", json!({"id":id}));
                outgoing.cancel_sent = true;
                match tokio::time::timeout(std::time::Duration::from_secs(5), &mut rx).await {
                    Ok(r) => r,
                    Err(_) => { self.close(); return Err(Fault::new("lost", "plugin did not settle cancellation within 5 seconds")) }
                }
            }
        };
        reply.unwrap_or_else(|_| Err(Fault::new("lost", "plugin reply lost")))
    }
}
