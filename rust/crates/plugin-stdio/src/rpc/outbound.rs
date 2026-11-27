use super::*;
use std::{future::poll_fn, pin::Pin};

pub type Gate = Box<dyn Fn() -> bool + Send + 'static>;

pub(super) struct Queued {
    frame: Prepared,
    _bytes: tokio::sync::OwnedSemaphorePermit,
}

impl Queued {
    pub fn into_frame(self) -> Prepared {
        self.frame
    }
}

pub(super) struct Prepared {
    pub end: bool,
    bytes: Option<Box<[u8]>>,
    gate: Option<Gate>,
    cancelled: Option<Gate>,
    refusal: Option<Box<[u8]>>,
    request_key: Option<String>,
    peer: Weak<Peer>,
    overflowed: Option<CancellationToken>,
}

impl Prepared {
    fn new(
        message: Value,
        end: bool,
        gate: Option<Gate>,
        cancelled: Option<Gate>,
        request_key: Option<String>,
    ) -> Result<Self, Fault> {
        let id = message
            .get("id")
            .filter(|_| message.get("method").is_none());
        let error = |id, code, message| {
            serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,
            "error":{"code":-32000,"message":message,"data":{"code":code}}}))
            .unwrap()
        };
        let too_large = || {
            let subject = if request_key.is_some() {
                "request"
            } else {
                "message"
            };
            Fault::new("result_too_large", format!("{subject} exceeds 64 MiB"))
        };
        let mut bytes = serde_json::to_vec(&message).map_err(|e| Fault::new("internal", e))?;
        if bytes.len() > MAX_FRAME {
            bytes = error(
                id.ok_or_else(too_large)?,
                "result_too_large",
                "result exceeds 64 MiB",
            );
        }
        let refusal = id.filter(|_| gate.is_some()).map(|id| {
            // Preserve protocol rejection semantics but never stale error details.
            let original = &message["error"];
            if let (Some(number), Some(code)) =
                (original["code"].as_i64(), original["data"]["code"].as_str())
            {
                serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,
                        "error":{"code":number,"message":code,"data":{"code":code}}}))
                .unwrap()
            } else {
                error(id, "withheld", "plugin delivery is no longer available")
            }
        });
        if bytes.len() > MAX_FRAME
            || refusal
                .as_ref()
                .is_some_and(|bytes| bytes.len() > MAX_FRAME)
        {
            return Err(too_large());
        }
        Ok(Self {
            end,
            bytes: Some(bytes.into_boxed_slice()),
            gate,
            cancelled,
            refusal: refusal.map(Vec::into_boxed_slice),
            request_key,
            peer: Weak::new(),
            overflowed: None,
        })
    }

    pub fn bind(&mut self, peer: &Arc<Peer>) {
        self.peer = Arc::downgrade(peer);
        self.overflowed = Some(peer.overflowed.clone());
    }

    fn queued_bytes(&self) -> u32 {
        // Count retained alternatives as well as the stdio line delimiter.
        (self.bytes.as_ref().map_or(0, |b| b.len())
            + self.refusal.as_ref().map_or(0, |b| b.len())
            + 1) as u32
    }

    fn refuse(&mut self, code: &'static str, message: &'static str) {
        if let Some(key) = self.request_key.take()
            && let Some(peer) = self.peer.upgrade()
        {
            peer.refuse(&key, code, message);
        }
    }

    fn recheck(&mut self) {
        if self.gate.as_ref().is_some_and(|check| !check()) {
            self.gate = None;
            self.cancelled = None;
            self.bytes = self.refusal.take();
            self.refuse("withheld", "plugin delivery is no longer available");
        } else if self.cancelled.as_ref().is_some_and(|check| check()) {
            self.gate = None;
            self.cancelled = None;
            self.bytes = None;
            self.refuse("cancelled", "cancelled before transport handoff");
        }
    }

    pub fn websocket(mut self) -> Option<String> {
        // The socket writer may still hold one frame when a stalled peer is
        // closed. Do not drain it on overload (normal shutdown can still drain).
        if self
            .overflowed
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            return None;
        }
        self.recheck();
        self.bytes
            .map(|bytes| String::from_utf8(bytes.into_vec()).expect("serialized JSON is UTF-8"))
    }

    pub async fn stdio(mut self, writer: &mut (impl AsyncWrite + Unpin)) -> std::io::Result<()> {
        let written = poll_fn(|cx| {
            // A pending poll has accepted no bytes. Recheck on the next poll too.
            self.recheck();
            match &self.bytes {
                Some(bytes) => Pin::new(&mut *writer).poll_write(cx, bytes),
                None => std::task::Poll::Ready(Ok(0)),
            }
        })
        .await?;
        if let Some(bytes) = self.bytes {
            if written == 0 {
                return Err(std::io::ErrorKind::WriteZero.into());
            }
            writer.write_all(&bytes[written..]).await?;
            writer.write_all(b"\n").await?;
            writer.flush().await?;
        }
        Ok(())
    }
}

impl Peer {
    pub(super) fn send_frame(&self, message: Value, end: bool, gate: Option<Gate>) {
        if !self.closed.is_cancelled() {
            match Prepared::new(message, end, gate, None, None) {
                Ok(frame) => self.enqueue(frame),
                Err(_) => self.close(),
            }
        }
    }

    fn enqueue(&self, frame: Prepared) {
        if self.closed.is_cancelled() {
            return;
        }
        // Never await capacity: the same connection carries cancellation and
        // settlement. Fail all waiters rather than delaying or dropping a frame.
        if let Ok(bytes) = self
            .outbound_bytes
            .clone()
            .try_acquire_many_owned(frame.queued_bytes())
            && self
                .tx
                .try_send(Queued {
                    frame,
                    _bytes: bytes,
                })
                .is_ok()
        {
            return;
        }
        self.overflowed.cancel();
        self.close();
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) async fn send_call(
        &self,
        method: &str,
        params: Value,
        work: Option<Arc<Work>>,
        cancel: CancellationToken,
        event: Option<OnEvent>,
        context: telemetry::Context,
    ) -> Reply {
        if self.closed.is_cancelled() {
            return Err(Fault::new("lost", "plugin connection closed"));
        }
        let id = format!("r{}", self.next.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        let key = json!(id).to_string();
        let parent = params.get("parentRequestId").and_then(|id| {
            self.incoming
                .lock()
                .unwrap()
                .get(&id.to_string())
                .map(|request| request.callbacks.clone())
        });
        let (gate, cancelled) = if let Some((parent_gate, parent_cancelled)) =
            self.parent_delivery_parts(method, &params)
        {
            let caller = cancel.clone();
            let cancelled: Gate = Box::new(move || {
                caller.is_cancelled() || parent_cancelled.as_ref().is_some_and(|c| c())
            });
            (Some(parent_gate), Some(cancelled))
        } else if let Some(w) = work.as_ref().filter(|w| !w.scope.session.is_empty()) {
            let scoped = w
                .api
                .upgrade()
                .map(|api| outbound::scoped(&api, &w.scope, method));
            let caller = cancel.clone();
            let signal = w.cancel.clone();
            (
                Some(Box::new(move || scoped.as_ref().is_some_and(|check| check())) as Gate),
                Some(Box::new(move || caller.is_cancelled() || signal.is_cancelled()) as Gate),
            )
        } else {
            let caller = cancel.clone();
            (None, Some(Box::new(move || caller.is_cancelled()) as Gate))
        };
        let frame = Prepared::new(
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
            false,
            gate,
            cancelled,
            Some(key.clone()),
        )?;
        {
            let mut pending = self.pending.lock().unwrap();
            if self.closed.is_cancelled() {
                return Err(Fault::new("lost", "plugin connection closed"));
            }
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
                    abandoned: false,
                    _parent: parent,
                },
            );
        }
        self.enqueue(frame);
        let mut outgoing = Outgoing {
            peer: self,
            id: &id,
            key: &key,
            reply: Some(rx),
            cancel_deadline: None,
        };
        let reply = tokio::select! {
            result = outgoing.reply.as_mut().unwrap() => result,
            _ = cancel.cancelled() => {
                let deadline = outgoing.cancel();
                match timeout_at(deadline, outgoing.reply.as_mut().unwrap()).await {
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

    pub(crate) fn parent_delivery(&self, method: &str, params: &Value) -> Option<Gate> {
        let (gate, cancelled) = self.parent_delivery_parts(method, params)?;
        Some(Box::new(move || {
            gate() && !cancelled.as_ref().is_some_and(|c| c())
        }))
    }

    fn parent_delivery_parts(&self, method: &str, params: &Value) -> Option<(Gate, Option<Gate>)> {
        if method == "tools/changed" {
            return None;
        }
        let id = params
            .get("parentRequestId")
            .filter(|id| !id.is_null())?
            .to_string();
        let token = self
            .incoming
            .lock()
            .unwrap()
            .get(&id)
            .map(|request| request.cancel.clone());
        let settles = matches!(
            method,
            "host/history"
                | "host/session"
                | "host/declaration"
                | "host/tools/list"
                | "host/env/read"
                | "host/env/list"
                | "host/env/exists"
                | "host/runtime/record"
        ) || method == "host/runtime/hook" && params["hook"] == "turn.end";
        let has_parent = token.is_some();
        let gate: Gate = Box::new(move || has_parent);
        let cancelled = (!settles).then(|| {
            let token = token.clone();
            Box::new(move || token.as_ref().is_some_and(|t| t.is_cancelled())) as Gate
        });
        Some((gate, cancelled))
    }

    pub(super) fn refuse(&self, key: &str, code: &'static str, message: &'static str) {
        if let Some(pending) = self.pending.lock().unwrap().remove(key) {
            let _ = pending.reply.send((Err(Fault::new(code, message)), None));
        }
    }
}

pub(crate) fn scoped(api: &Api, scope: &Scope, method: &str) -> Gate {
    let right = if method == "tools/call"
        || method.starts_with("host/tools/")
        || method.starts_with("host/env/")
        || method == "host/ask"
    {
        "tools"
    } else {
        "watch"
    };
    let generation = api.delivery_generation(&scope.session).ok();
    let ceiling = CONNECTION_CEILING.try_with(Arc::clone).ok();
    let stamp = api.delivery_epoch(&scope.session).ok();
    let api = Arc::downgrade(api);
    let scope = scope.clone();
    Box::new(move || {
        let Some(api) = api.upgrade() else {
            return false;
        };
        generation
            .as_ref()
            .is_some_and(|token| !token.is_cancelled())
            && stamp.as_ref().is_some_and(|expected| {
                api.delivery_epoch(&scope.session)
                    .is_ok_and(|now| &now == expected)
            })
            && {
                let check = || {
                    work_authority(api.as_ref(), &scope)
                        .is_ok_and(|rights| rights.has("watch") && rights.has(right))
                };
                ceiling.as_ref().map_or_else(check, |ceiling| {
                    CONNECTION_CEILING.sync_scope(ceiling.clone(), check)
                })
            }
            && generation
                .as_ref()
                .is_some_and(|token| !token.is_cancelled())
    })
}
