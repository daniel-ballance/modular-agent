use super::*;
use std::{future::poll_fn, pin::Pin};

pub type Gate = Box<dyn Fn() -> bool + Send + 'static>;

pub(super) struct Frame {
    pub message: Value,
    pub end: bool,
    pub gate: Option<Gate>,
    pub cancelled: Option<Gate>,
}

pub(super) struct Prepared {
    bytes: Option<Vec<u8>>,
    gate: Option<Gate>,
    cancelled: Option<Gate>,
    refusal: Option<Vec<u8>>,
    on_refusal: Option<Box<dyn FnOnce(&'static str, &'static str) + Send>>,
}

impl Prepared {
    pub fn new(frame: Frame, peer: &Arc<Peer>) -> Option<Self> {
        let id = frame.message.get("id");
        let request = frame.message.get("method").is_some();
        let error = |id, code, message| {
            serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,
            "error":{"code":-32000,"message":message,"data":{"code":code}}}))
            .unwrap()
        };
        let mut bytes = serde_json::to_vec(&frame.message).ok()?;
        if bytes.len() > MAX_FRAME {
            bytes = error(
                id.filter(|_| !request)?,
                "result_too_large",
                "result exceeds 64 MiB",
            );
        }
        let refusal = id.filter(|_| !request && frame.gate.is_some()).map(|id| {
            // Preserve protocol rejection semantics but never stale error details.
            let original = &frame.message["error"];
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
        let on_refusal = id
            .filter(|_| request && (frame.gate.is_some() || frame.cancelled.is_some()))
            .map(|id| {
                let key = id.to_string();
                let peer = Arc::downgrade(peer);
                Box::new(move |code, message| {
                    if let Some(peer) = peer.upgrade() {
                        peer.refuse(&key, code, message);
                    }
                }) as Box<dyn FnOnce(&'static str, &'static str) + Send>
            });
        Some(Self {
            bytes: Some(bytes),
            gate: frame.gate,
            cancelled: frame.cancelled,
            refusal,
            on_refusal,
        })
    }

    fn recheck(&mut self) {
        if self.gate.as_ref().is_some_and(|check| !check()) {
            self.gate = None;
            self.cancelled = None;
            self.bytes = self.refusal.take();
            if let Some(refuse) = self.on_refusal.take() {
                refuse("withheld", "plugin delivery is no longer available");
            }
        } else if self.cancelled.as_ref().is_some_and(|check| check()) {
            self.gate = None;
            self.cancelled = None;
            self.bytes = None;
            if let Some(refuse) = self.on_refusal.take() {
                refuse("cancelled", "cancelled before transport handoff");
            }
        }
    }

    pub fn websocket(mut self) -> Option<String> {
        self.recheck();
        self.bytes
            .map(|bytes| String::from_utf8(bytes).expect("serialized JSON is UTF-8"))
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
                    abandoned: false,
                    _parent: parent,
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
        let _ = self.tx.send(Frame {
            message: frame,
            end: false,
            gate,
            cancelled,
        });
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
