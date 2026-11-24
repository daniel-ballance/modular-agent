//! Disposable ACP waiting-approval writer. Only the ACP connections can decide or dispatch.
mod store;
use agent_api::{self as base, HistoryStore, Value, json};
use anyhow::{Context, Result, bail, ensure};
use modular_agent::{self as sdk, AcpActor, AcpOptions, AcpServiceOptions, Agent, Plugin, Rights};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt},
    sync::Notify,
};

struct Fixture {
    dir: PathBuf,
    clock: PathBuf,
    store: history_fs::FileHistory,
    host: OnceLock<base::Api>,
    journal: Mutex<()>,
    // Empty sets on every launch: only commit batches and the clock survive a kill.
    holds: Mutex<BTreeSet<String>>,
    reached: Mutex<BTreeSet<String>>,
    gate: Mutex<(String, String)>,
    fence: base::CancellationToken,
    changed: Notify,
}
fn read(path: &Path) -> Result<Value> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}
fn string<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    base::wire::string(v, k)
}
fn rights(role: &str) -> Rights {
    match role {
        "worker" => {
            let mut r = Rights::full();
            r.0.remove("answer");
            r.0.remove("approve");
            r
        }
        "approver" | "other" => Rights::only(&["watch", "approve", "answer"]),
        "user" => {
            let mut r = Rights::full();
            r.0.remove("approve");
            r
        }
        _ => Rights::only(&["watch", "answer"]),
    }
}
impl Fixture {
    fn host(&self) -> &base::Api {
        self.host.get().expect("host installed before serving")
    }
    fn tick(&self) -> Result<()> {
        base::set_clock_for_test(read(&self.clock)?.as_u64().context("fixture clock")?);
        Ok(())
    }
    fn inspect(&self, id: &str) -> Result<Value> {
        let _lock = self.journal.lock().unwrap();
        let d = self.store.load(id)?;
        let path = self.dir.join(format!("{id}.commits"));
        let mut batches = Vec::new();
        for line in fs::read_to_string(path)?.lines() {
            let ids: Vec<String> = serde_json::from_str(line)?;
            batches.push(
                ids.iter()
                    .map(|id| {
                        let entry = d
                            .entries
                            .iter()
                            .find(|e| &e.id == id)
                            .context("missing committed entry")?;
                        base::portable::entry(entry, &d)
                    })
                    .collect::<Result<Vec<_>>>()?,
            );
        }
        Ok(json!({"batches":batches}))
    }
    async fn until(&self, mut done: impl FnMut() -> bool) {
        loop {
            let wake = self.changed.notified();
            tokio::pin!(wake);
            wake.as_mut().enable();
            if done() {
                return;
            }
            wake.await;
        }
    }
    async fn barrier(&self, at: &str) {
        if !self.holds.lock().unwrap().contains(at) {
            return;
        }
        self.reached.lock().unwrap().insert(at.into());
        self.changed.notify_waiters();
        self.until(|| !self.holds.lock().unwrap().contains(at))
            .await;
    }
    fn plugins(self: &Arc<Self>) -> Plugin {
        let (prepare, end, start, before, after, output) = (
            self.clone(),
            self.clone(),
            self.clone(),
            self.clone(),
            self.clone(),
            self.clone(),
        );
        Plugin::new("fixture.waiting")
            .on_session_start(move |scope| {
                let k = prepare.clone();
                async move {
                    let host = k.host();
                    if !scope.resumed {
                        // The SDK's implicit local person is not a third offline approver.
                        for role in ["user", "approver", "other", "answerOnly", "representative"] {
                            host.append(
                                &base::Scope::session(&scope.session_id),
                                "fixture.waiting",
                                base::Draft::new(
                                    "actor.grant",
                                    false,
                                    json!({"actor":role,"kind":"user",
                            "authority":rights(role),"operatorAdmission":true}),
                                ),
                            )?;
                        }
                    }
                    Ok(())
                }
            })
            .on_turn_end(move |turn| {
                let k = end.clone();
                async move {
                    if !turn.result.open_tool_calls.is_empty() {
                        k.barrier("requestPending").await;
                    }
                    Ok(())
                }
            })
            .on_turn_before(move |_| {
                let k = start.clone();
                async move {
                    k.barrier("answerCommit").await;
                    Ok(Default::default())
                }
            })
            .on_tool_before(move |call| {
                let k = before.clone();
                async move {
                    if k.host()
                        .snapshot(&call.session_id)?
                        .entries
                        .iter()
                        .any(|e| {
                            e.kind == "tool.pending" && e.scope.call == call.context.tool_call_id
                        })
                    {
                        k.barrier("continuationStart").await;
                        k.barrier("beforeHandoff").await;
                    }
                    Ok(sdk::Gate::Allow)
                }
            })
            .on_tool_after(move |_| {
                let k = after.clone();
                async move {
                    k.barrier("afterEffect").await;
                    Ok(Default::default())
                }
            })
            .on_output(move |out| {
                let k = output.clone();
                async move {
                    let mut v = out.value;
                    let (role, mode) = k.gate.lock().unwrap().clone();
                    if v["method"] == "_modular-agent/requests" && out.context.actor_id == role {
                        if mode == "block" {
                            return Ok(sdk::OutputDecision::Block);
                        }
                        if mode == "redact" {
                            for q in v["result"]["requests"].as_array_mut().into_iter().flatten() {
                                q["call"]["input"]["command"] = json!("withheld");
                                q["question"] = json!("withheld");
                            }
                            return Ok(sdk::OutputDecision::Redact(v));
                        }
                    }
                    Ok(sdk::OutputDecision::Allow)
                }
            })
    }
    async fn control(&self, agent: &Agent, v: Value) -> Result<Value> {
        let id = string(&v, "sessionId")?;
        ensure!(
            id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'),
            "invalid session ID"
        );
        let scope = base::Scope::session(id);
        match string(&v, "operation")? {
            "inspect" => return self.inspect(id),
            "tick" => self.tick()?,
            "pause" => {
                self.holds.lock().unwrap().insert(string(&v, "at")?.into());
            }
            "release" => {
                let mut holds = self.holds.lock().unwrap();
                if let Some(at) = v["at"].as_str() {
                    holds.remove(at);
                } else {
                    holds.clear();
                }
                self.changed.notify_waiters();
            }
            "reached" => {
                let at = string(&v, "at")?;
                self.until(|| self.reached.lock().unwrap().contains(at))
                    .await;
            }
            "gate" => {
                *self.gate.lock().unwrap() =
                    (string(&v, "role")?.into(), string(&v, "mode")?.into())
            }
            "revoke" => {
                let role = string(&v, "role")?;
                let mut r = rights(role);
                r.0.remove(string(&v, "right")?);
                self.host().grant(&scope, role, r)?;
            }
            "cut" => match string(&v, "kind")? {
                "worker-ceiling" => {
                    let mut r = Rights::full();
                    r.0.remove("tools");
                    self.host().append(
                        &scope,
                        "fixture.waiting",
                        base::Draft::new("limit", false, json!({"rights":r})),
                    )?;
                }
                "approver-rights" => {
                    self.host()
                        .grant(&scope, "approver", rights("answerOnly"))?;
                }
                "route-authorization" => {
                    let d = self.store.load(id)?;
                    let proof = d
                        .entries
                        .iter()
                        .rev()
                        .find_map(|e| e.content.as_ref()?.get("approvalView"))
                        .context("no committed route")?;
                    sdk::testing::revoke_fixture_route(
                        agent,
                        string(proof, "routeId")?.into(),
                        string(proof, "submittedBy")?.into(),
                    );
                }
                "stale-writer" => self.fence.cancel(),
                other => bail!("unsupported authority cut: {other}"),
            },
            "idle" => {
                self.until(|| {
                    if self.fence.is_cancelled() {
                        return true;
                    }
                    let Ok(d) = self.store.load(id) else {
                        return false;
                    };
                    let branch = d.branch();
                    let running = branch.iter().any(|start| {
                        start.kind == "turn.start"
                            && !branch
                                .iter()
                                .any(|e| e.kind == "turn.end" && e.scope.turn == start.scope.turn)
                    });
                    let owed = branch.iter().any(|q| {
                        q.kind == "request.open"
                            && q.content.as_ref().is_some_and(|body| {
                                body["extra"]["approvalWait"] == "untilDeadline"
                            })
                            && branch.iter().any(|e| {
                                matches!(e.kind.as_str(), "request.answer" | "request.closed")
                                    && e.scope.call == q.scope.call
                            })
                            && (!branch
                                .iter()
                                .any(|e| e.kind == "tool.result" && e.scope.call == q.scope.call)
                                || (d.settings["approvalWait"] == "untilDeadline"
                                    && !branch.iter().any(|e| {
                                        e.kind == "turn.start"
                                            && e.content.as_ref().is_some_and(|v| {
                                                v["continuesTurnId"].as_str()
                                                    == q.scope.turn.as_deref()
                                            })
                                    })))
                    });
                    !running && !owed
                })
                .await;
            }
            other => bail!("unsupported control: {other}"),
        }
        Ok(json!({}))
    }
}

pub async fn serve() -> Result<()> {
    ensure!(
        std::env::var("MODULAR_AGENT_CONFORMANCE").as_deref() == Ok("1"),
        "waiting fixture requires conformance mode"
    );
    let dir =
        PathBuf::from(std::env::var_os("MODULAR_AGENT_DATA_DIR").context("fixture directory")?);
    let cfg = read(Path::new(
        &std::env::var_os("MA_ACP_WAIT_FIXTURE").context("fixture configuration")?,
    ))?;
    let project = PathBuf::from(string(&cfg, "project")?);
    let store = history_fs::FileHistory::new(&dir.join("ledger"))?;
    if cfg["reopen"] == "missing-proof" {
        for mut session in store.list(None)? {
            let _writer = store.acquire(&session.id)?;
            for e in &mut session.entries {
                if e.kind == "request.answer"
                    && let Some(fields) = e.content.as_mut().and_then(Value::as_object_mut)
                {
                    fields.remove("approvalView");
                }
            }
            store.save(&session)?;
        }
    }
    let k = Arc::new(Fixture {
        clock: string(&cfg, "clock")?.into(),
        dir: dir.clone(),
        store,
        host: Default::default(),
        journal: Default::default(),
        holds: Default::default(),
        reached: Default::default(),
        gate: Default::default(),
        fence: Default::default(),
        changed: Default::default(),
    });
    k.tick()?;
    let mut limits = sdk::ResourceLimits::default();
    if cfg["name"] == "capacity" {
        limits.session.calls = 1;
    }
    let mut b = sdk::testing::acp_conformance(Agent::builder())
        .plugin_host(true)
        .several_actors(true)
        .durability(sdk::Durability::Durable)
        .project(&project)
        .data_dir(&dir)
        .history(sdk::History::from_store(store::Store(k.clone()), true))
        .tenants(json!({"elsewhere":{"rights":Rights::full()}}))
        .session_limits(true)
        .resource_limits(limits)
        .model("conformance/echo")
        .plugin(k.plugins());
    if cfg["reopen"] != "unsupported" {
        b = b.max_approval_wait_ms(cfg["maxApprovalWaitMs"].as_u64().context("maximum wait")?);
    }
    let agent = b.build().await?;
    let _ = k.host.set(sdk::testing::fixture_host(&agent));
    let token = |role| -> Result<PathBuf> { Ok(string(&cfg["tokenFiles"], role)?.into()) };
    let mut endpoints = Vec::new();
    for role in [
        "approver",
        "other",
        "answerOnly",
        "representative",
        "tenant",
    ] {
        let mut p = AcpActor::local(token(role)?);
        p.actor.id = role.into();
        p.actor.kind = "user".into();
        p.actor.rights = rights(role);
        if role == "representative" {
            p.represents.push("approver".into());
        }
        if role == "tenant" {
            p.tenants = Some(vec![Some("elsewhere".into())]);
        }
        endpoints.push(p);
    }
    // Put stdio on the same listener as the other principals, using a separate
    // worker token. Every request, including its output, goes through ACP.
    let worker_file = dir.join(format!("worker-{}.token", base::id()));
    writeln!(
        fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&worker_file)?,
        "{}",
        uuid::Uuid::new_v4()
    )?;
    let mut worker = AcpActor::local(worker_file.clone());
    worker.actor.rights = rights("worker");
    endpoints.push(worker);
    let server = agent
        .serve_acp_websocket(
            AcpOptions::default(),
            AcpServiceOptions {
                listen: "127.0.0.1:0".into(),
                actors: endpoints,
                tls: None,
            },
        )
        .await?;
    let controller = agent.clone();
    let control = transport_websocket::http::serve(
        "127.0.0.1:0",
        None,
        None,
        vec![(token("control")?, ())],
        move |principal, req, _| {
            let k = k.clone();
            let agent = controller.clone();
            async move {
                use axum::{
                    body::Body,
                    http::{Method, Response},
                };
                let ans = async {
                    ensure!(
                        principal.is_some()
                            && req.method() == Method::POST
                            && req.uri().path() == "/fixture",
                        "invalid control request"
                    );
                    k.control(
                        &agent,
                        serde_json::from_slice(
                            &axum::body::to_bytes(req.into_body(), 4096).await?,
                        )?,
                    )
                    .await
                }
                .await;
                match ans {
                    Ok(v) => Response::new(Body::from(v.to_string())),
                    Err(e) => {
                        eprintln!("fixture control: {e}");
                        Response::builder().status(400).body(Body::empty()).unwrap()
                    }
                }
            }
        },
    )
    .await?;
    let wire =
        transport_websocket::connect(&server.url, &worker_file, transport_websocket::ACP).await?;
    fs::write(
        string(&cfg, "ready")?,
        json!({"acp":server.url,"control":format!("{}/fixture",control.url)}).to_string(),
    )?;
    transport_websocket::run(wire,base::CancellationToken::new(),|mut conn|async move{
        let mut lines=tokio::io::BufReader::new(tokio::io::stdin()).lines();
        let mut out=tokio::io::stdout();
        loop {tokio::select! {
            line=lines.next_line()=>match line {Ok(Some(line))=>if conn.outgoing.send(line).await.is_err(){break},_=>break},
            msg=conn.incoming.recv()=>match msg {Some(msg)=>{if out.write_all(format!("{msg}\n").as_bytes()).await.is_err() || out.flush().await.is_err(){break}},None=>break}
        }}
    }).await;
    control.close().await;
    server.close().await;
    agent.close().await?;
    Ok(())
}
