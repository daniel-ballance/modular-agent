//! Symmetric, cancellable JSON-RPC over stdio or WebSocket. Each direction has its own id space.
use agent_api::*;
use futures_util::{FutureExt, Sink, SinkExt, Stream, StreamExt, future::BoxFuture, sink, stream};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    sync::{mpsc, oneshot},
    task::JoinSet,
};

#[cfg(test)]
mod trace_tests;

pub const MAX_FRAME: usize = 64 * 1024 * 1024;

fn scope_from_params(params: &Value) -> Option<Scope> {
    let session = params["sessionId"]
        .as_str()
        .or_else(|| params["turn"]["sessionId"].as_str())?;
    let mut scope = Scope::session(session);
    scope.turn = params["turnId"]
        .as_str()
        .or_else(|| params["turn"]["turnId"].as_str())
        .map(str::to_owned);
    scope.step = params["stepId"].as_str().map(str::to_owned);
    Some(scope)
}

fn job_callback(method: &str, params: &Value) -> bool {
    matches!(
        method,
        "host/jobs/progress" | "host/jobs/end" | "host/jobs/resume"
    ) && params["jobId"].is_string()
}

fn work_method(method: &str) -> Option<&'static str> {
    // Bound labels to methods defined by the binding, not strings sent by a peer.
    const WORK: &[&str] = &[
        "env/checkPoint",
        "env/exec",
        "env/exists",
        "env/list",
        "env/output",
        "env/read",
        "env/restore",
        "env/save",
        "env/sessionEnded",
        "env/write",
        "hook/handle",
        "hook/output",
        "host/ask",
        "host/emit",
        "host/env/exec",
        "host/env/exists",
        "host/env/list",
        "host/env/output",
        "host/env/read",
        "host/env/write",
        "host/history",
        "host/hook",
        "host/jobs/end",
        "host/jobs/progress",
        "host/jobs/resume",
        "host/jobs/start",
        "host/jobs/unfinished",
        "host/runtime/definition",
        "host/runtime/hasSteering",
        "host/runtime/hook",
        "host/runtime/model",
        "host/runtime/modelEvent",
        "host/runtime/newId",
        "host/runtime/prepareStep",
        "host/runtime/record",
        "host/runtime/report",
        "host/runtime/runToolCall",
        "host/runtime/takeSteering",
        "host/session",
        "host/tools/call",
        "host/tools/list",
        "jobs/cancel",
        "provider/available",
        "provider/discard",
        "provider/event",
        "provider/models",
        "provider/request",
        "runtime/continueOpenCalls",
        "runtime/resumeTurn",
        "runtime/runTurn",
        "tools/call",
        "tools/changed",
        "tools/list",
        "tools/progress",
    ];
    WORK.iter().copied().find(|name| *name == method)
}
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
        } else if matches!(
            error.downcast_ref::<agent_api::OperationError>(),
            Some(agent_api::OperationError::Busy(_))
        ) {
            "busy"
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
pub trait Endpoint: Send + Sync + 'static {
    async fn request(
        &self,
        peer: Arc<Peer>,
        id: Value,
        method: &str,
        params: Value,
        cancel: CancellationToken,
    ) -> Reply;
    // Admission runs on the reader: capture live scope and register changes here,
    // but leave any delivery or RPC work to the notification worker.
    fn admit_notification(
        self: Arc<Self>,
        _peer: &Arc<Peer>,
        _method: &str,
        _params: Value,
    ) -> Option<Notification> {
        None
    }
    fn request_barrier(&self, _method: &str, _params: &Value) -> Option<NotificationKey> {
        None
    }
    async fn disconnected(&self) {}
}

#[derive(Eq, Ord, PartialEq, PartialOrd)]
pub enum NotificationKey {
    Stream(String),
    Job(String),
}
pub struct Notification {
    pub(crate) barrier: Option<NotificationKey>,
    pub(crate) run: BoxFuture<'static, ()>,
}
type OnEvent = Arc<dyn Fn(Value) + Send + Sync>;
struct Pending {
    reply: oneshot::Sender<(Reply, Option<CancellationToken>)>,
    work: Option<Arc<Work>>,
    method: String,
    context: telemetry::Context,
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
    tx: mpsc::UnboundedSender<(Value, bool)>,
    plugin: OnceLock<String>,
    trace_agreed: AtomicBool,
    serves_plugin: AtomicBool,
    jobs: Mutex<BTreeMap<String, (Scope, telemetry::Operation)>>,
    next: AtomicU64,
    pending: Mutex<BTreeMap<String, Pending>>,
    activity: tokio::sync::Notify,
    incoming: Mutex<BTreeMap<String, CancellationToken>>,
    pub closed: CancellationToken,
    pub finished: CancellationToken,
}
impl Peer {
    pub fn start<R, W>(reader: R, writer: W, endpoint: Arc<dyn Endpoint>) -> Arc<Self>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let incoming = stream::unfold(BufReader::new(reader), |mut reader| async move {
            let mut bytes = Vec::new();
            let n = (&mut reader)
                .take((MAX_FRAME + 3) as u64)
                .read_until(b'\n', &mut bytes)
                .await
                .ok()?;
            if n == 0 || bytes.pop() != Some(b'\n') {
                return None;
            }
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
            (bytes.len() <= MAX_FRAME).then_some((bytes, reader))
        });
        let outgoing = sink::unfold(writer, |mut writer, mut bytes: Vec<u8>| async move {
            bytes.push(b'\n');
            writer.write_all(&bytes).await?;
            writer.flush().await?;
            Ok::<_, std::io::Error>(writer)
        });
        Self::start_frames(incoming, outgoing, endpoint, false)
    }

    pub fn websocket(
        conn: transport_websocket::Connection,
        endpoint: Arc<dyn Endpoint>,
        server: bool,
    ) -> Arc<Self> {
        let incoming = stream::unfold(conn.incoming, |mut rx| async move {
            Some((rx.recv().await?.into_bytes(), rx))
        });
        let outgoing = sink::unfold(conn.outgoing, |tx, bytes| async move {
            tx.send(String::from_utf8(bytes).expect("serialized JSON is UTF-8"))
                .await?;
            Ok::<_, mpsc::error::SendError<String>>(tx)
        });
        Self::start_frames(incoming, outgoing, endpoint, server)
    }

    fn start_frames(
        incoming: impl Stream<Item = Vec<u8>> + Send + 'static,
        outgoing: impl Sink<Vec<u8>> + Send + 'static,
        endpoint: Arc<dyn Endpoint>,
        shutdown_closes: bool,
    ) -> Arc<Self> {
        let (tx, mut rx) = mpsc::unbounded_channel::<(Value, bool)>();
        let peer = Arc::new(Self {
            tx,
            plugin: OnceLock::new(),
            trace_agreed: false.into(),
            serves_plugin: false.into(),
            jobs: Mutex::default(),
            next: AtomicU64::new(1),
            pending: Mutex::default(),
            activity: tokio::sync::Notify::new(),
            incoming: Mutex::default(),
            closed: CancellationToken::new(),
            finished: CancellationToken::new(),
        });
        let p = peer.clone();
        let writer = tokio::spawn(async move {
            let mut outgoing = Box::pin(outgoing);
            while let Some((message, end)) = p.closed.run_until_cancelled(rx.recv()).await.flatten()
            {
                let mut bytes = match serde_json::to_vec(&message) {
                    Ok(b) => b,
                    Err(_) => break,
                };
                if bytes.len() > MAX_FRAME {
                    if let Some(id) = message
                        .get("id")
                        .filter(|_| message.get("method").is_none())
                    {
                        bytes = serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"result exceeds 64 MiB","data":{"code":"result_too_large"}}})).unwrap();
                    } else {
                        break;
                    }
                }
                if !matches!(
                    p.closed.run_until_cancelled(outgoing.send(bytes)).await,
                    Some(Ok(()))
                ) || end
                {
                    break;
                }
            }
            p.close();
        });
        let p = peer.clone();
        tokio::spawn(async move {
            let mut reader = Box::pin(incoming);
            let mut tasks = JoinSet::new();
            let mut used = BTreeSet::new();
            let (notify, mut notifications) = mpsc::channel(1024);
            let byte_budget = Arc::new(tokio::sync::Semaphore::new(2 * MAX_FRAME));
            let mut barriers = BTreeMap::<NotificationKey, CancellationToken>::new();
            let worker = tokio::spawn(async move {
                while let Some((run, _complete, _bytes)) = notifications.recv().await {
                    // A panic must not leave a completion barrier waiting forever.
                    let _ = std::panic::AssertUnwindSafe::<BoxFuture<'static, ()>>(run)
                        .catch_unwind()
                        .await;
                }
            });
            loop {
                while tasks.try_join_next().is_some() {}
                barriers.retain(|_, done| !done.is_cancelled());
                let Some(bytes) = p.closed.run_until_cancelled(reader.next()).await.flatten()
                else {
                    break;
                };
                p.activity.notify_one();
                let line = bytes.as_slice();
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
                        let after = endpoint
                            .request_barrier(&method, &params)
                            .and_then(|key| barriers.get(&key).cloned());
                        tasks.spawn(async move {
                            if let Some(after) = after {
                                cancel.run_until_cancelled(after.cancelled()).await;
                            }
                            let reply = if cancel.is_cancelled() {
                                Err(Fault::new(
                                    "cancelled",
                                    "request cancelled before work started",
                                ))
                            } else if method == "$/ping" {
                                Ok(json!({}))
                            } else {
                                std::panic::AssertUnwindSafe(p.observe_request(
                                    endpoint.as_ref(),
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
                            let end = shutdown_closes && method == "plugin/shutdown";
                            p.respond_frame(id, reply, end);
                        });
                    } else {
                        let context = p.incoming_context(method, &params).0;
                        if let Some(note) = endpoint.clone().admit_notification(&p, method, params)
                        {
                            // Never wait for notification capacity on the reader. In
                            // particular, responses must be able to unblock the worker.
                            // Close on overflow rather than silently dropping ordered work.
                            let Ok(bytes) = byte_budget
                                .clone()
                                .try_acquire_many_owned(line.len() as u32)
                            else {
                                break;
                            };
                            let done = CancellationToken::new();
                            if let Some(key) = note.barrier {
                                barriers.insert(key, done.clone());
                            }
                            if notify
                                .try_send((
                                    Box::pin(telemetry::within(context, note.run)),
                                    done.drop_guard(),
                                    bytes,
                                ))
                                .is_err()
                            {
                                break;
                            }
                        }
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
                    let after = barriers.remove(&NotificationKey::Stream(id.to_string()));
                    let _ = waiter.reply.send((reply, after));
                } else {
                    break;
                }
            }
            p.close();
            for token in p.incoming.lock().unwrap().values() {
                token.cancel()
            }
            worker.abort();
            let _ = worker.await;
            // Cancellation is cooperative, including joined environment cleanup.
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while tasks.join_next().await.is_some() {}
            })
            .await;
            tasks.abort_all();
            while tasks.join_next().await.is_some() {}
            let _ = writer.await;
            endpoint.disconnected().await;
            p.finished.cancel();
        });
        peer
    }
    pub fn monitor_liveness(
        self: &Arc<Self>,
        interval: std::time::Duration,
        deadline: std::time::Duration,
    ) {
        let peer = self.clone();
        tokio::spawn(async move {
            let monitor = async {
                loop {
                    let activity = peer.activity.notified();
                    if peer.pending.lock().unwrap().is_empty() {
                        activity.await;
                        continue;
                    }
                    tokio::select! {
                        biased;
                        _ = activity => continue,
                        _ = tokio::time::sleep(interval) => (),
                    }
                    if peer.pending.lock().unwrap().is_empty() {
                        continue;
                    }
                    if !matches!(
                        tokio::time::timeout(
                            deadline,
                            peer.call("$/ping", json!({}), None, CancellationToken::new())
                        )
                        .await,
                        Ok(Ok(_))
                    ) {
                        peer.close();
                        break;
                    }
                }
            };
            peer.closed.run_until_cancelled(monitor).await;
        });
    }

    /// Call after a successful handshake. Agreement is not authority.
    pub fn configure_trace(&self, name: &str, agreed: bool, serves_plugin: bool) {
        let _ = self.plugin.set(name.to_owned());
        self.serves_plugin.store(serves_plugin, Ordering::Release);
        self.trace_agreed.store(agreed, Ordering::Release);
    }

    fn span(
        &self,
        method: &str,
        scope: Option<&Scope>,
        kind: telemetry::SpanKind,
        cx: &telemetry::Context,
    ) -> Option<telemetry::Operation> {
        let method = work_method(method)?;
        let name = telemetry::name(self.plugin.get()?)?;
        Some(telemetry::Operation::start(
            "modular_agent.plugin.request",
            kind,
            scope,
            vec![
                telemetry::KeyValue::new("modular_agent.plugin.name", name.to_owned()),
                telemetry::KeyValue::new("modular_agent.plugin.method", method),
            ],
            cx,
            vec![],
        ))
    }

    fn inject(&self, method: &str, params: &mut Value, cx: &telemetry::Context) {
        if let Some(p) = params.as_object_mut() {
            p.remove("traceContext");
        }
        let callback = self.serves_plugin.load(Ordering::Acquire);
        if self.trace_agreed.load(Ordering::Acquire)
            && work_method(method).is_some()
            && (!callback || !params["parentRequestId"].is_null() || job_callback(method, params))
            && let Some(carrier) = telemetry::carrier(cx)
            && let Some(p) = params.as_object_mut()
        {
            p.insert("traceContext".into(), carrier);
        }
    }

    fn incoming_context(
        &self,
        method: &str,
        params: &Value,
    ) -> (telemetry::Context, Option<Scope>) {
        if work_method(method).is_none() {
            return (telemetry::Context::new(), None);
        }
        let remote = if self.trace_agreed.load(Ordering::Acquire) {
            telemetry::extract(&params["traceContext"])
        } else {
            None
        };
        if self.serves_plugin.load(Ordering::Acquire) {
            return (remote.unwrap_or_default(), scope_from_params(params));
        }
        let pending = self.pending.lock().unwrap();
        let parent = pending.get(&params["parentRequestId"].to_string());
        if let Some(parent) = parent
            && let Some(work) = &parent.work
            && !work.cancel.is_cancelled()
            && params["sessionId"]
                .as_str()
                .is_none_or(|s| s == work.scope.session)
        {
            let cx = telemetry::same_trace_or(remote, &parent.context);
            return (cx, Some(work.scope.clone()));
        }
        drop(pending);
        if params["parentRequestId"].is_null()
            && job_callback(method, params)
            && let Some(job) = params["jobId"].as_str()
            && let Some((scope, op)) = self.jobs.lock().unwrap().get(job)
            && params["sessionId"]
                .as_str()
                .is_none_or(|id| id == scope.session)
        {
            return (
                telemetry::same_trace_or(remote, &op.context()),
                Some(scope.clone()),
            );
        }
        (telemetry::Context::new(), None)
    }

    async fn observe_request(
        self: &Arc<Self>,
        endpoint: &dyn Endpoint,
        id: Value,
        method: &str,
        mut params: Value,
        cancel: CancellationToken,
    ) -> Reply {
        let (cx, scope) = self.incoming_context(method, &params);
        if method != "plugin/initialize"
            && let Some(p) = params.as_object_mut()
        {
            p.remove("traceContext");
        }
        let span = if scope.is_some() || self.serves_plugin.load(Ordering::Acquire) {
            self.span(method, scope.as_ref(), telemetry::SpanKind::Server, &cx)
        } else {
            None
        };
        let cx = span.as_ref().map_or(cx, telemetry::Operation::context);
        let result = telemetry::within(
            cx,
            endpoint.request(self.clone(), id, method, params, cancel),
        )
        .await;
        if let Some(span) = span
            && result
                .as_ref()
                .is_err_and(|e| !matches!(e.code.as_str(), "busy" | "cancelled" | "refused"))
        {
            span.error("plugin_request_failed");
        }
        result
    }

    pub(crate) fn observe_job(&self, job: &Job) {
        let op = telemetry::Operation::internal("modular_agent.job", &job.scope)
            .interrupted("modular_agent.job.outcome");
        op.attr("modular_agent.job.id", job.id.clone());
        self.jobs
            .lock()
            .unwrap()
            .insert(job.id.clone(), (job.scope.clone(), op));
    }

    pub(crate) fn job_context(&self, job: &str) -> Option<telemetry::Context> {
        self.jobs
            .lock()
            .unwrap()
            .get(job)
            .map(|(_, op)| op.context())
    }

    pub(crate) fn finish_job(&self, job: &str, outcome: &'static str) {
        let ended = self.jobs.lock().unwrap().remove(job);
        if let Some((_, mut op)) = ended {
            op.outcome("modular_agent.job.outcome", outcome);
            if outcome == "failed" {
                op.error("job_failed");
            }
        }
    }

    pub fn close(&self) {
        self.closed.cancel();
        let observations = std::mem::take(&mut *self.jobs.lock().unwrap());
        drop(observations);
        for (_, pending) in std::mem::take(&mut *self.pending.lock().unwrap()) {
            let _ = pending
                .reply
                .send((Err(Fault::new("lost", "plugin connection closed")), None));
        }
    }
    pub fn notify(&self, method: &str, mut params: Value) {
        self.inject(method, &mut params, &telemetry::current());
        let _ = self.tx.send((
            json!({"jsonrpc":"2.0","method":method,"params":params}),
            false,
        ));
    }
    fn respond(&self, id: Value, reply: Reply) {
        self.respond_frame(id, reply, false);
    }
    fn respond_frame(&self, id: Value, reply: Reply, end: bool) {
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
        let _ = self.tx.send((message, end));
    }
    pub fn parent(&self, id: &Value) -> Option<Arc<Work>> {
        self.pending
            .lock()
            .unwrap()
            .get(&id.to_string())
            .and_then(|p| p.work.clone())
    }
    pub(crate) fn handling_output(&self) -> bool {
        self.pending.lock().unwrap().values().any(|p| {
            p.work
                .as_ref()
                .is_some_and(|work| work.method == "hook/output")
        })
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
    pub(crate) fn pending_method(&self, id: &Value, method: &str) -> bool {
        self.pending
            .lock()
            .unwrap()
            .get(&id.to_string())
            .is_some_and(|p| p.method == method)
    }
    pub(crate) fn event_handler(&self, id: &Value, method: &str) -> Option<OnEvent> {
        self.pending
            .lock()
            .unwrap()
            .get(&id.to_string())
            .filter(|p| p.method == method)
            .and_then(|p| p.event.clone())
    }
    pub(crate) async fn call_with_events(
        &self,
        method: &str,
        params: Value,
        work: Option<Arc<Work>>,
        cancel: CancellationToken,
        event: Option<OnEvent>,
    ) -> Reply {
        let scope = work
            .as_ref()
            .map(|w| w.scope.clone())
            .or_else(|| scope_from_params(&params));
        let span = self.span(
            method,
            scope.as_ref(),
            telemetry::SpanKind::Client,
            &telemetry::current(),
        );
        let context = span
            .as_ref()
            .map_or_else(telemetry::current, telemetry::Operation::context);
        let mut params = params;
        if method != "plugin/initialize" {
            self.inject(method, &mut params, &context);
        }
        let reply = self
            .send_call(method, params, work, cancel, event, context)
            .await;
        if let Some(span) = span
            && reply
                .as_ref()
                .is_err_and(|e| !matches!(e.code.as_str(), "busy" | "cancelled" | "refused"))
        {
            span.error("plugin_request_failed");
        }
        reply
    }

    #[allow(clippy::too_many_arguments)]
    async fn send_call(
        &self,
        method: &str,
        params: Value,
        work: Option<Arc<Work>>,
        cancel: CancellationToken,
        event: Option<OnEvent>,
        context: telemetry::Context,
    ) -> Reply {
        let id = format!("r{}", self.next.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        let key = json!(id).to_string();
        {
            let mut pending = self.pending.lock().unwrap();
            if pending.is_empty() {
                self.activity.notify_one();
            }
            pending.insert(
                key.clone(),
                Pending {
                    reply: tx,
                    work,
                    method: method.to_owned(),
                    context,
                    event,
                },
            );
        }
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
        let _ = self.tx.send((frame, false));
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
        let (reply, after) = reply.map_err(|_| Fault::new("lost", "plugin reply lost"))?;
        if let Some(after) = after {
            tokio::select! {
                biased;
                _ = self.closed.cancelled() => return Err(Fault::new("lost", "plugin connection closed during stream delivery")),
                _ = after.cancelled() => (),
            }
        }
        reply
    }
}
