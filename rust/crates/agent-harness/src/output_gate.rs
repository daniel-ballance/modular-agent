use super::{Harness, bytes, capacity, output};
use agent_api::*;
use std::{collections::BTreeMap, sync::Arc};

const GATE_SEGMENT: u64 = 4 << 20;
const MAX_HELD: u64 = 64 << 20;
#[derive(Default)]
pub(super) struct HeldPieces {
    bytes: u64,
    pieces: Vec<(Event, Value, capacity::Buffer)>,
}
// None marks a blocked stream. Ignore later pieces until its end.
pub(super) type HeldOutput = BTreeMap<(String, String, String), Option<HeldPieces>>;

#[derive(Debug)]
struct OutputOverflow;

impl std::fmt::Display for OutputOverflow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("output exceeds the gate or buffer limit")
    }
}
impl std::error::Error for OutputOverflow {}

impl Harness {
    // Do not reconcile here: this check guards a view that was built from the
    // old state. Reconciliation must never make that view eligible again.
    fn output_epoch(&self, session: &str) -> Result<Option<String>> {
        let sessions = self.sessions.lock().unwrap();
        let Some(open) = sessions.get(session) else {
            return Ok(None);
        };
        if !open.provisional
            && let Some(store) = self.store()
        {
            store.check_erasure(&open.data)?;
        }
        Ok(open
            .data
            .entries
            .iter()
            .rev()
            .find(|e| e.kind == "erasure")
            .map(|e| e.id.clone()))
    }

    async fn local_output(&self, scope: &Scope, output: Output) -> Result<Option<Value>> {
        let result = match self
            .invoke(&self.points["output"], scope, json!(output))
            .await
        {
            Ok(result) => result,
            Err(e) => {
                eprintln!("output gate refused delivery: {e}");
                return Ok(None);
            }
        };
        if result.stopped && result.value.is_null() {
            return Ok(None);
        }
        let output: Output = serde_json::from_value(result.value)?;
        Ok(Some(output.value))
    }
    async fn remote_output(
        &self,
        scope: &Scope,
        recipient: &str,
        events: Vec<Value>,
    ) -> Result<Vec<Value>> {
        let registry = self.registry.read().unwrap().clone();
        let recipient = if recipient == "interface.acp" {
            registry.declaration()["acp"]["actor"]["id"]
                .as_str()
                .unwrap_or(ACP_HOST_ACTOR)
                .to_owned()
        } else {
            recipient.to_owned()
        };
        let mut accepted = Vec::new();
        let mut charges = Vec::new();
        let mut total = bytes::size(&events);
        if total > MAX_HELD {
            return Err(OutputOverflow.into());
        }
        let mut remaining = events.into_iter().peekable();
        while remaining.peek().is_some() {
            let mut segment = Vec::new();
            let mut charged = 2;
            while let Some(item) = remaining.peek() {
                let n = bytes::size(item);
                if n + 2 > GATE_SEGMENT {
                    return Err(OutputOverflow.into());
                }
                let next = charged + n + u64::from(!segment.is_empty());
                if next > GATE_SEGMENT {
                    break;
                }
                charged = next;
                segment.push(remaining.next().unwrap());
            }
            let result = registry.invoke_checked(self.api(), &self.points["output.stream"], scope,
                json!({"sessionId":scope.session,"recipient":recipient,"events":segment,"final":true}),
                |before,after| {
                    let size = bytes::size(&after["events"]);
                    if size > GATE_SEGMENT {return Err(OutputOverflow.into());}
                    ensure!(after["events"].is_array() && output::apply_redactions(&mut before["events"].clone(), &after["events"]), "invalid output redaction");
                    if size>charged {total+=size-charged; if total>MAX_HELD{return Err(OutputOverflow.into())}}
                        if size > charged && !scope.session.is_empty() {
                        charges.push(self.reserve_output(&scope.session,size-charged).map_err(|_|OutputOverflow)?);
                        charged=size;
                    }
                    Ok(())
                }).await?;
            let Some(after) = result.value["events"].as_array() else {
                return Ok(vec![]);
            };
            for (mut before, after) in segment.into_iter().zip(after) {
                if !output::apply_redactions(&mut before, after) {
                    return Ok(vec![]);
                }
                accepted.push(before);
            }
        }
        Ok(accepted)
    }
    pub fn gates_output(&self) -> bool {
        self.registry.read().unwrap().gates_output()
    }
    fn holds_remote_output(&self) -> bool {
        self.registry.read().unwrap().declaration()["remote_output"] == true
    }

    pub async fn history_view(&self, session: &str) -> Result<Value> {
        self.reconcile_pending_erasure(session).await?;
        Ok(self
            .output(
                &Scope::session(session),
                Output {
                    recipient: "interface".into(),
                    value: json!(self.snapshot(session)?),
                    stream: None,
                    end: true,
                },
            )
            .await?
            .unwrap_or(Value::Null))
    }

    pub(super) fn reserve_output_buffer(&self, session: &str, bytes: u64) -> Result<Box<dyn Send>> {
        let sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get(session)
            .ok_or_else(|| anyhow!("session not open"))?;
        Ok(Box::new(self.reservations().buffer(&open.data, bytes)?))
    }

    pub(super) async fn gate_output(&self, scope: &Scope, output: Output) -> Result<Option<Value>> {
        let epoch = self.output_epoch(&scope.session)?;
        let recipient = output.recipient.clone();
        let Some(value) = self.local_output(scope, output).await? else {
            return Ok(None);
        };
        if !self.holds_remote_output() {
            return Ok((self.output_epoch(&scope.session)? == epoch).then_some(value));
        }
        let kind = if value["method"].is_string() && value.get("params").is_some() {
            "request"
        } else if value["method"].is_string() && value.get("result").is_some() {
            "reply"
        } else if value["entry"]["id"].is_string() {
            "entry"
        } else {
            "rust.result"
        };
        let recipient = if recipient == "interface.acp" {
            scope.actor.as_str()
        } else {
            &recipient
        };
        let shared = matches!(
            value["type"].as_str(),
            Some("modular-agent.waitClosed" | "turnEnded" | "toolResult")
        ) && value["data"].is_object();
        let event = if shared {
            value
        } else {
            json!({"type":kind,"data":value})
        };
        let gated = self
            .remote_output(scope, recipient, vec![event])
            .await
            .unwrap_or_default();
        if self.output_epoch(&scope.session)? != epoch {
            return Ok(None);
        }
        Ok(gated
            .into_iter()
            .next()
            .map(|event| if shared { event } else { event["data"].clone() }))
    }

    pub(super) async fn deliver_event(&self, event: Event) -> Result<()> {
        let mut events =
            if event.kind == "session.interrupted" || (event.stream.is_some() && !event.end) {
                vec![]
            } else {
                std::mem::take(&mut *self.pending_events.lock().unwrap())
            };
        events.push(event);
        for event in events {
            let Ok(epoch) = self.output_epoch(&event.scope.session) else {
                continue;
            };
            let observe = match event.kind.as_str() {
                "actor.joined" => Some("session.join"),
                "actor.left" => Some("session.leave"),
                "model.delta" | "model.thought" | "model.tool_input" | "model.audio" => {
                    Some("provider.piece")
                }
                _ => None,
            };
            if let Some(point) = observe {
                self.invoke(&self.points[point], &event.scope, json!(event))
                    .await?;
            }
            for name in self.capability_names("interface.") {
                let sink: Arc<dyn EventSink> = capability(self, &name)?;
                let view = self
                    .local_output(
                        &event.scope,
                        Output {
                            recipient: name.clone(),
                            value: json!(event),
                            stream: event.stream.clone(),
                            end: event.end,
                        },
                    )
                    .await?;
                if !self.holds_remote_output() {
                    if let Some(view) = view
                        && self
                            .output_epoch(&event.scope.session)
                            .is_ok_and(|current| current == epoch)
                    {
                        sink.send(serde_json::from_value(view)?);
                    }
                    continue;
                }
                let view = view.map(serde_json::from_value::<Event>).transpose()?;
                let item = view
                    .filter(|e| !(e.end && e.content.is_null()))
                    .and_then(|e| output::encode(&e, self).ok().map(|item| (e, item)));
                let batch = if let Some(stream) = &event.stream {
                    let key = (event.scope.session.clone(), name.clone(), stream.clone());
                    let item = item.map(|(event, item)| -> Result<_> {
                        let n = bytes::size(&item) + 2;
                        ensure!(n <= GATE_SEGMENT, OutputOverflow);
                        let data = self.snapshot(&event.scope.session)?;
                        let permit = self.reservations().buffer(&data, n)?;
                        Ok((n, (event, item, permit)))
                    });
                    let mut held = self.held_output.lock().unwrap();
                    let stream = held
                        .entry(key.clone())
                        .or_insert_with(|| Some(HeldPieces::default()));
                    match item {
                        Some(Err(_)) => *stream = None,
                        Some(Ok((n, item))) => {
                            if let Some(held) = stream {
                                if held.bytes + n > MAX_HELD {
                                    *stream = None;
                                } else {
                                    held.bytes += n;
                                    held.pieces.push(item);
                                }
                            }
                        }
                        None => {}
                    }
                    if !event.end {
                        continue;
                    }
                    let batch = held.remove(&key).flatten();
                    drop(held);
                    let Some(batch) = batch else {
                        sink.send(Event::new(&event.scope, "output.overflow", Value::Null));
                        continue;
                    };
                    batch.pieces
                } else {
                    item.and_then(|(event, item)| {
                        let data = self.snapshot(&event.scope.session).ok()?;
                        let permit = self.reservations().buffer(&data, bytes::size(&item)).ok()?;
                        Some((event, item, permit))
                    })
                    .into_iter()
                    .collect()
                };
                let gated = match self
                    .remote_output(
                        &event.scope,
                        &name,
                        batch.iter().map(|(_, item, _)| item.clone()).collect(),
                    )
                    .await
                {
                    Ok(gated) => gated,
                    Err(error) => {
                        if error.is::<OutputOverflow>() && event.stream.is_some() {
                            sink.send(Event::new(&event.scope, "output.overflow", Value::Null));
                        }
                        continue;
                    }
                };
                let decoded = batch
                    .into_iter()
                    .zip(gated)
                    .map(|((original, before, _permit), after)| {
                        output::decode(original, &before, &after)
                    })
                    .collect::<Result<Vec<_>>>();
                if let Ok(decoded) = decoded
                    && self
                        .output_epoch(&event.scope.session)
                        .is_ok_and(|current| current == epoch)
                {
                    for event in decoded {
                        sink.send(event);
                    }
                }
            }
        }
        Ok(())
    }
}
