//! The receipt index is local to this deployment, not part of portable history.
//! Its filename commits to the exchange identity. The same opaque ID on the
//! accepted entry proves admission, even if the process died inside the operation.
use super::*;
use agent_harness::receipt::{BIND_ENTRY, EntryBinding, ReceiptOperation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{ErrorKind, Read},
    os::unix::fs::{DirBuilderExt, FileExt, OpenOptionsExt},
};

pub(super) fn identity(thread: &str, a: &AguiActor, run: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(json!(["agui:receipt:1", thread, a.id(), a.client_id, run]).to_string())
    )
}
#[derive(Clone)]
pub(crate) struct ReceiptFiles(PathBuf);
#[derive(Default, Serialize, Deserialize)]
pub(super) struct Proof {
    pub questions: Vec<String>,
    pub calls: Vec<(String, Option<String>)>,
    pub error: Option<String>,
    pub withheld: bool,
    pub sources: Vec<String>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Terminal {
    Unknown = 0,
    Success,
    Interrupt,
    Cancelled,
    Error,
}
impl Terminal {
    fn name(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Success => "success",
            Self::Interrupt => "interrupt",
            Self::Cancelled => "cancelled",
            Self::Error => "error",
        }
    }
    fn decode(b: u8) -> R<Self> {
        [
            Self::Unknown,
            Self::Success,
            Self::Interrupt,
            Self::Cancelled,
            Self::Error,
        ]
        .get(b as usize)
        .copied()
        .ok_or(Fail::Lost)
    }
}
pub(super) struct Slot {
    pub id: String,
    file: File,
}
impl Slot {
    pub(super) async fn bind<T>(
        &self,
        session: &str,
        actor: &str,
        operation: ReceiptOperation,
        f: impl Future<Output = T>,
    ) -> T {
        BIND_ENTRY
            .scope(
                EntryBinding {
                    session: session.into(),
                    actor: actor.into(),
                    entry_id: self.id.clone(),
                    operation,
                },
                f,
            )
            .await
    }
    // Store only references, never event bodies. A torn preparation is harmless:
    // the separately reserved class byte is still zero and readers ignore it.
    pub(super) fn prepare(&self, proof: &Proof) -> R<()> {
        let bytes = serde_json::to_vec(proof).map_err(|_| Fail::Lost)?;
        self.file
            .write_all_at(&bytes, 1)
            .and_then(|()| self.file.set_len(bytes.len() as u64 + 1))
            .and_then(|()| self.file.sync_data())
            .map_err(|_| Fail::Lost)
    }
    pub(super) fn released(&self, terminal: Terminal, session: &str) {
        log::debug!(target:"modular_agent::agui::terminal_released","{session} {}",self.id);
        if self
            .file
            .write_all_at(&[terminal as u8], 0)
            .and_then(|()| self.file.sync_data())
            .is_ok()
        {
            log::debug!(target:"modular_agent::agui::terminal_recorded","{session} {}",self.id);
        } else {
            log::error!("could not record the released AG-UI terminal class");
        }
    }
}
fn read_file(path: &Path) -> R<(Terminal, Proof)> {
    let mut f = File::open(path).map_err(|e| {
        if e.kind() == ErrorKind::NotFound {
            Fail::Missing
        } else {
            Fail::Lost
        }
    })?;
    let mut b = [0];
    f.read_exact(&mut b).map_err(|_| Fail::Lost)?;
    let class = Terminal::decode(b[0])?;
    Ok((
        class,
        if class == Terminal::Unknown {
            Proof::default()
        } else {
            serde_json::from_reader(f).map_err(|_| Fail::Lost)?
        },
    ))
}
impl ReceiptFiles {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self(root)
    }
    pub(super) fn reserve(&self, session: &str, id: String) -> R<Slot> {
        let dir = self.0.join(session);
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)
            .map_err(|_| Fail::Lost)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(dir.join(&id))
            .map_err(|_| Fail::Lost)?;
        file.try_lock().map_err(|_| Fail::Conflict)?;
        // Space for the class and directory entry is durable before acceptance.
        // Opening an unused slot from a refused or killed POST does not claim it.
        if file.metadata().map_err(|_| Fail::Lost)?.len() == 0 {
            file.write_all_at(&[0], 0).map_err(|_| Fail::Lost)?;
        } else {
            let mut marker = [0];
            file.read_exact_at(&mut marker, 0).map_err(|_| Fail::Lost)?;
            if marker != [0] {
                return Err(Fail::Conflict);
            }
        }
        file.sync_all()
            .and_then(|()| File::open(&dir)?.sync_all())
            .and_then(|()| File::open(&self.0)?.sync_all())
            .and_then(|()| File::open(self.0.parent().unwrap())?.sync_all())
            .map_err(|_| Fail::Lost)?;
        Ok(Slot { id, file })
    }
    pub(crate) fn erase(&self, d: &SessionData) -> anyhow::Result<()> {
        let dir = self.0.join(&d.id);
        let files = match fs::read_dir(&dir) {
            Ok(v) => v,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        let erased = d
            .entries
            .iter()
            .filter(|e| e.content.is_none())
            .collect::<Vec<_>>();
        if erased.is_empty() {
            return Ok(());
        }
        let mut removed = false;
        for file in files {
            let path = file?.path();
            let Some(id) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            let Some(source) = d.entries.iter().find(|e| e.id == id) else {
                continue;
            };
            let taken = d.entries.iter().find(|e| {
                e.kind == "input"
                    && (e.content.as_ref().is_some_and(|v| v["inputId"] == id)
                        || e.copies.contains(&source.id))
            });
            let origin = source.scope.turn.as_ref();
            let late = origin.is_some()
                && d.entries
                    .iter()
                    .take_while(|e| e.id != id)
                    .any(|e| e.kind == "turn.end" && e.scope.turn.as_ref() == origin);
            let turn = if late {
                d.entries
                    .iter()
                    .find(|e| {
                        e.kind == "turn.start"
                            && e.content.as_ref().is_some_and(|v| {
                                v["continuesTurnId"].as_str() == origin.map(String::as_str)
                            })
                    })
                    .and_then(|e| e.scope.turn.as_ref())
            } else {
                origin.or_else(|| taken?.scope.turn.as_ref())
            };
            let (_, proof) =
                read_file(&path).map_err(|_| anyhow::anyhow!("cannot check receipt sources"))?;
            if source.content.is_none()
                || taken.is_some_and(|e| e.content.is_none())
                || erased.iter().any(|e| {
                    proof.sources.contains(&e.id)
                        || source.copies.contains(&e.id)
                        || (turn.is_some()
                            && e.scope.turn.as_ref() == turn
                            && matches!(e.kind.as_str(), "turn.start" | "turn.end"))
                })
            {
                match fs::remove_file(path) {
                    Ok(()) => (),
                    Err(e) if e.kind() == ErrorKind::NotFound => continue,
                    Err(e) => return Err(e.into()),
                }
                removed = true;
            }
        }
        if removed {
            File::open(dir)?.sync_all()?;
        }
        Ok(())
    }
}
impl Service {
    fn receipt_view(&self, a: &AguiActor, id: &str) -> R<SessionData> {
        if !self.agent.inner.persistent
            || !a.principal.actor.rights.has("watch")
            || id.is_empty()
            || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err(Fail::Missing);
        }
        let history = &self.agent.inner.history.0;
        let classify = |e: anyhow::Error| {
            if e.is::<base::PendingErasure>() || Error::from(e).code() == Code::NotFound {
                Fail::Missing
            } else {
                Fail::Lost
            }
        };
        let d = history.inspect(id).map_err(classify)?;
        if !self.scope_ok(a, &d)
            || !base::actors(&d).contains_key(a.id())
            || !self
                .h()
                .discovery_rights(&d, a.id(), &a.principal.actor.rights, false)?
                .has("watch")
        {
            return Err(Fail::Missing);
        }
        history.check_erasure(&d).map_err(classify)?;
        Ok(d)
    }
    async fn exact_read(&self, a: &AguiActor, d: &SessionData, value: Value) -> R<()> {
        if self.read_gate(a, &d.id, value.clone()).await? != value {
            return Err(Fail::Withheld);
        }
        Ok(())
    }
    async fn receipt_facts(
        &self,
        a: &AguiActor,
        d: &SessionData,
        id: &str,
        run: &str,
        class: Terminal,
        proof: &Proof,
    ) -> R<Value> {
        let branch = d.branch();
        let index = branch
            .iter()
            .position(|e| e.id == id && e.content.is_some())
            .ok_or(Fail::Missing)?;
        let source = &branch[index];
        self.read_entry(a, d, source).await?;
        let mut work = "unsettled";
        let turn = match source.kind.as_str() {
            "command" => {
                work = "handled";
                None
            }
            "input.accepted" => {
                if let Some(r) = branch.iter().find(|e| {
                    matches!(e.kind.as_str(), "input.returned" | "input.withdrawn")
                        && e.content.as_ref().is_some_and(|v| {
                            v["input"] == id
                                || v["inputIds"]
                                    .as_array()
                                    .is_some_and(|l| l.iter().any(|s| s == id))
                        })
                }) {
                    self.read_entry(a, d, r).await?;
                    work = "handedBack";
                    None
                } else {
                    branch
                        .iter()
                        .find(|e| {
                            e.content.as_ref().is_some_and(|v| {
                                e.kind == "input"
                                    && (v["inputId"] == id || e.copies.iter().any(|s| s == id))
                                    || e.kind == "turn.start" && v["startedBy"]["id"] == id
                            })
                        })
                        .and_then(|e| e.scope.turn.as_deref())
                }
            }
            "request.answer" | "tool.result" => {
                let origin = source.scope.turn.as_deref().ok_or(Fail::Missing)?;
                if source.kind == "request.answer" {
                    let q = &source.content.as_ref().unwrap()["request"];
                    let open = branch
                        .iter()
                        .find(|e| {
                            e.kind == "request.open"
                                && e.content.as_ref().is_some_and(|v| v["id"] == *q)
                        })
                        .ok_or(Fail::Missing)?;
                    self.read_entry(a, d, open).await?;
                } else {
                    let handoff = branch[..index]
                        .iter()
                        .find(|e| base::interface_handoff(e) && e.scope.call == source.scope.call)
                        .ok_or(Fail::Missing)?;
                    let h = handoff.content.as_ref().ok_or(Fail::Missing)?;
                    if h["routeId"] != a.client_id || h["executorActorId"] != a.id() {
                        return Err(Fail::Missing);
                    }
                    let start = branch
                        .iter()
                        .find(|e| h["toolStartedId"] == e.id)
                        .ok_or(Fail::Missing)?;
                    self.read_entry(a, d, start).await?;
                }
                if branch[..index]
                    .iter()
                    .any(|e| e.kind == "turn.end" && e.scope.turn.as_deref() == Some(origin))
                {
                    branch
                        .iter()
                        .find(|e| {
                            e.kind == "turn.start"
                                && e.content
                                    .as_ref()
                                    .is_some_and(|v| v["continuesTurnId"] == origin)
                        })
                        .and_then(|e| e.scope.turn.as_deref())
                } else {
                    Some(origin)
                }
            }
            _ => return Err(Fail::Missing),
        };
        if let Some(turn) = turn {
            let start = branch
                .iter()
                .find(|e| e.kind == "turn.start" && e.scope.turn.as_deref() == Some(turn))
                .ok_or(Fail::Missing)?;
            self.read_entry(a, d, start).await?;
            if let Some(end) = branch
                .iter()
                .find(|e| e.kind == "turn.end" && e.scope.turn.as_deref() == Some(turn))
            {
                let row = self.read_entry(a, d, end).await?;
                let mut settlement = row["data"].clone();
                settlement["turnId"] = json!(turn);
                let view = self
                    .read_gate(a, &d.id, json!({"type":"turnEnded","data":settlement}))
                    .await?;
                work = match view["data"]["outcome"]["kind"].as_str() {
                    Some("completed") => "completed",
                    Some("cancelled") => "cancelled",
                    Some("failed") => "failed",
                    Some("limit") => "limit",
                    _ => return Err(Fail::Missing),
                };
            }
        }
        if proof.withheld {
            return Err(Fail::Missing);
        }
        if class != Terminal::Unknown {
            let mut outcome = json!({"type":class.name()});
            let mut interrupts = vec![];
            for qid in &proof.questions {
                let open = branch
                    .iter()
                    .find(|e| {
                        e.kind == "request.open"
                            && e.content.as_ref().is_some_and(|v| v["id"] == *qid)
                    })
                    .ok_or(Fail::Missing)?;
                let row = self.read_entry(a, d, open).await?;
                let q: base::Question = serde_json::from_value(open.content.clone().unwrap())
                    .map_err(|_| Fail::Missing)?;
                let v = &row["data"]["request"];
                if q.kind == base::RequestKind::Approval
                    && *v != interface_acp::shared_question(q.clone())
                {
                    return Err(Fail::Missing);
                }
                interrupts.push(super::view::interrupt(&q, v, open.at).ok_or(Fail::Missing)?);
            }
            if class == Terminal::Interrupt {
                outcome["interrupts"] = json!(interrupts);
            }
            for (call, parent) in &proof.calls {
                let start = branch
                    .iter()
                    .find(|e| e.kind == "tool.started" && e.scope.call.as_ref() == Some(call))
                    .ok_or(Fail::Missing)?;
                let row = self.read_entry(a, d, start).await?;
                let handoff = branch
                    .iter()
                    .find(|e| base::interface_handoff(e) && e.scope.call.as_ref() == Some(call))
                    .and_then(|e| e.content.as_ref())
                    .ok_or(Fail::Missing)?;
                if handoff["executorActorId"] != a.id()
                    || handoff["routeId"] != a.client_id
                    || !self
                        .h()
                        .discovery_rights(d, a.id(), &a.principal.actor.rights, false)?
                        .has("tools")
                {
                    return Err(Fail::Missing);
                }
                let def = &row["data"]["call"];
                let original = base::portable::public_entry(start, d)?;
                if original["data"]["call"] != *def {
                    return Err(Fail::Missing);
                }
                let exact = self
                    .h()
                    .output(
                        &scope(&d.id, a.id()),
                        base::Output {
                            recipient: a.id().into(),
                            value: def.clone(),
                            stream: None,
                            end: true,
                        },
                    )
                    .await?;
                if exact.as_ref() != Some(def) {
                    return Err(Fail::Missing);
                }
                let mut head =
                    json!({"type":"TOOL_CALL_START","toolCallId":call,"toolCallName":def["name"]});
                if let Some(p) = parent {
                    head["parentMessageId"] = json!(p)
                }
                for v in [
                    head,
                    json!({"type":"TOOL_CALL_ARGS","toolCallId":call,"delta":def["input"].to_string()}),
                    json!({"type":"TOOL_CALL_END","toolCallId":call}),
                ] {
                    self.exact_read(a, d, v).await?;
                }
            }
            if !proof.calls.is_empty() && class == Terminal::Success {
                outcome["pendingToolCallIds"] =
                    json!(proof.calls.iter().map(|(id, _)| id).collect::<Vec<_>>());
            }
            let frame = if class == Terminal::Error {
                json!({"type":"RUN_ERROR","code":proof.error,"message":"The run could not be delivered."})
            } else {
                json!({"type":"RUN_FINISHED","threadId":d.id,"runId":run,"outcome":outcome})
            };
            self.exact_read(a, d, frame).await?;
        }
        Ok(json!({"terminal":class.name(),"work":work}))
    }
    pub(super) async fn run_receipt(
        &self,
        a: &AguiActor,
        thread: &str,
        query: Option<&str>,
    ) -> R<Response> {
        let d = self.receipt_view(a, thread)?;
        let run = super::reads::parameter(query, "runId")?;
        if run.is_empty() {
            return Err(Fail::Invalid);
        }
        let id = identity(thread, a, &run);
        let path = self.agent.inner.receipts.0.join(thread).join(&id);
        let cut = || self.receipt_view(a, thread);
        let (class, proof) = read_file(&path)?;
        // The class is write-once. Take the ledger cut after observing it, and
        // verify it did not change while taking that cut.
        let d = if class == Terminal::Unknown {
            let d = cut()?;
            if read_file(&path)?.0 != class {
                return Err(Fail::Lost);
            }
            d
        } else {
            drop(d);
            cut()?
        };
        // A receipt index left by another process on this deployment is subject
        // to the same tombstones, even when no writer has reopened this thread.
        if d.entries.iter().any(|e| e.content.is_none()) {
            self.agent.inner.receipts.erase(&d)?;
            if !path.exists() {
                return Err(Fail::Missing);
            }
        }
        let value = self
            .receipt_facts(a, &d, &id, &run, class, &proof)
            .await
            .map_err(|e| {
                if e == Fail::Withheld {
                    Fail::Missing
                } else {
                    e
                }
            })?;
        let event = json!({"method":"agui.runReceipt","result":value});
        let allowed = self.read_gate(a, thread, event.clone()).await;
        if self.h().gates_output()
            && self
                .receipt_facts(a, &d, &id, &run, class, &proof)
                .await
                .map_err(|e| {
                    if e == Fail::Withheld {
                        Fail::Missing
                    } else {
                        e
                    }
                })?
                != value
        {
            return Err(Fail::Missing);
        }
        let fresh = cut()?;
        if view::epoch(&d) != view::epoch(&fresh) || !path.exists() {
            return Err(Fail::Missing);
        }
        if allowed? != event {
            return Err(Fail::Withheld);
        }
        Ok(reply(200, "application/json", Body::from(encode(&value)?)))
    }
}
