//! Disposable fixture for conformance/agui. Not a mode of ma.
mod hooks;
mod store;
use agent_api::{self as base, Value, json};
use anyhow::{Context, Result, ensure};
use base::HistoryStore;
use modular_agent::{self as sdk, Agent, AguiActor, AguiOptions, Plugin, Rights};
use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};
use std::{
    collections::BTreeSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};
use tokio::sync::Notify;
fn read(path: impl AsRef<Path>) -> Result<Value> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}
fn lines(path: impl AsRef<Path>) -> Result<Vec<Value>> {
    match fs::read_to_string(path) {
        Ok(s) => Ok(s
            .lines()
            .map(serde_json::from_str)
            .collect::<Result<_, _>>()?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e.into()),
    }
}
struct Kit {
    name: String,
    dir: PathBuf,
    restarted: bool,
    redacted_client: Mutex<String>,
    wait_gate: Mutex<(String, String)>,
    receipt_gate: Mutex<String>,
    api: OnceLock<base::Api>,
    changed: Notify,
    latches: Mutex<BTreeSet<(String, String)>>,
    erasure: Mutex<Value>,
    exporter: InMemorySpanExporter,
    provider: SdkTracerProvider,
    writes: Mutex<()>,
}
impl Kit {
    fn api(&self) -> Result<&base::Api> {
        self.api.get().context("Runtime has not started")
    }
    fn file(&self, id: &str) -> Result<base::SessionData> {
        history_fs::FileHistory::new(&self.dir.join("ledger"))?.load(id)
    }
    fn append(&self, name: &str, v: Value) -> Result<()> {
        let _lock = self.writes.lock().unwrap();
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join(name))?;
        writeln!(file, "{v}")?;
        Ok(())
    }
    fn latch(&self, id: &str, name: &str) {
        self.latches
            .lock()
            .unwrap()
            .insert((id.into(), name.into()));
        self.changed.notify_waiters();
    }
    async fn until(&self, mut ready: impl FnMut() -> bool) {
        loop {
            let w = self.changed.notified();
            tokio::pin!(w);
            w.as_mut().enable();
            if ready() {
                return;
            }
            w.await;
        }
    }
    async fn barrier(&self, id: &str, name: &str) {
        self.until(|| {
            self.latches
                .lock()
                .unwrap()
                .contains(&(id.into(), name.into()))
        })
        .await;
    }
    fn held(&self, id: &str, name: &str) -> bool {
        self.latches
            .lock()
            .unwrap()
            .contains(&(id.into(), format!("hold:{name}")))
    }
    async fn pause(&self, id: &str, name: &str) {
        if self.held(id, name) {
            self.latch(id, name);
            self.barrier(id, "released").await;
        }
    }
    fn inspect(&self, id: &str) -> Result<Value> {
        let d = self.file(id)?;
        let journal = lines(self.dir.join(format!("{id}.batches")))?;
        let batches = journal
            .iter()
            .map(|b| {
                b.as_array()
                    .context("batch")?
                    .iter()
                    .filter_map(|v| d.entries.iter().find(|e| v == &e.id))
                    .map(|e| base::portable::entry(e, &d))
                    .collect::<Result<Vec<_>>>()
            })
            .collect::<Result<Vec<_>>>()?;
        self.provider.force_flush()?;
        let spans=self.exporter.get_finished_spans()?.iter().map(|s|{let attrs:serde_json::Map<_,_>=s.attributes.iter().map(|kv|(kv.key.to_string(),match &kv.value{opentelemetry::Value::Bool(v)=>json!(v),opentelemetry::Value::I64(v)=>json!(v),v=>json!(v.to_string())})).collect();json!({"name":s.name,"traceId":s.span_context.trace_id().to_string(),"spanId":s.span_context.span_id().to_string(),"parentSpanId":s.parent_span_id.to_string(),"attributes":attrs,"links":s.links.iter().map(|l|json!({"traceId":l.span_context.trace_id().to_string(),"spanId":l.span_context.span_id().to_string()})).collect::<Vec<_>>()})}).collect::<Vec<_>>();
        let dispatches = lines(self.dir.join("dispatches"))?
            .into_iter()
            .filter(|v| v[0] == id)
            .map(|v| v[1].clone())
            .collect::<Vec<_>>();
        Ok(
            json!({"batches":batches,"dispatches":dispatches,"counter":sdk::testing::fixtures::count(&self.dir.join("count")),"project":d.project,"spans":spans,"model":lines(std::env::var("MODULAR_AGENT_SCRIPT_LOG")?)?,"erasure":*self.erasure.lock().unwrap(),"warnings":lines(self.dir.join("warnings"))?}),
        )
    }
    async fn control(&self, v: Value) -> Result<Value> {
        let id = v["threadId"].as_str().unwrap_or("");
        ensure!(
            id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'),
            "invalid thread"
        );
        let scope = base::Scope::session(id);
        match v["operation"].as_str() {
            Some("inspect") => return self.inspect(id),
            Some("storedEntries") => {
                let data = self.file(id)?;
                let entries = data
                    .entries
                    .iter()
                    .map(|e| base::portable::entry(e, &data))
                    .collect::<Result<Vec<_>>>()?;
                return Ok(json!({"entries":entries}));
            }
            Some("markPending") => {
                let entries: Vec<String> = serde_json::from_value(v["entryIds"].clone())?;
                let store = history_fs::FileHistory::new(&self.dir.join("ledger"))?;
                store.mark_erasure(id, &entries)?;
                return Ok(json!({}));
            }
            Some("openWait") if v["kind"] == "leaveOpen" => {
                let api = self.api()?.clone();
                api.submit(
                    id,
                    "kit-owner",
                    "Ask inside the pending call.",
                    base::Timing::Now,
                    None,
                )
                .await?;
                let thread = id.to_owned();
                tokio::spawn(async move { api.next_turn(&thread).await });
                let question = |d: base::SessionData| {
                    base::questions(&d)
                        .ok()?
                        .into_iter()
                        .find(|q| q.extra["whenTimeLimit"] == "leaveOpen")
                };
                self.until(|| self.file(id).ok().and_then(question).is_some())
                    .await;
                return Ok(
                    json!({"requestId":question(self.file(id)?).context("leaveOpen question")?.id}),
                );
            }
            Some("openWait") => {
                let kind = v["kind"].as_str().context("kind")?;
                let mut scope = scope;
                scope.actor = "kit-owner".into();
                let mut q = base::Question::new(
                    scope,
                    if kind == "approval" {
                        base::RequestKind::Approval
                    } else {
                        base::RequestKind::Choice
                    },
                    "Choose a label.",
                );
                q.options = vec!["yes".into(), "no".into()];
                if kind == "revocable" {
                    q.extra = json!({"answerers":["kit-owner"]});
                }
                if matches!(kind, "deadline" | "leaveOpen") {
                    q.timeout_ms = Some(5000);
                    q.extra =
                        json!({"whenTimeLimit":if kind=="deadline"{"decline"}else{"leaveOpen"}});
                }
                let request = q.id.clone();
                let api = self.api()?.clone();
                let service = base::requests(api.as_ref())?;
                tokio::spawn(
                    async move { service.ask(api, q, base::CancellationToken::new()).await },
                );
                self.until(|| {
                    self.file(id).is_ok_and(|s| {
                        s.entries.iter().any(|e| {
                            e.kind == "request.open"
                                && e.content.as_ref().is_some_and(|v| v["id"] == request)
                        })
                    })
                })
                .await;
                return Ok(json!({"requestId":request}));
            }
            Some("hold") => {
                self.latch(id, &format!("hold:{}", v["name"].as_str().context("name")?))
            }
            Some("waitGate") => {
                *self.wait_gate.lock().unwrap() = (
                    v["requestId"].as_str().context("request")?.into(),
                    v["mode"].as_str().context("mode")?.into(),
                )
            }
            Some("revokeRight") => {
                let right = v["right"].as_str().context("right")?;
                let rights = Rights::full()
                    .0
                    .into_iter()
                    .filter(|r| r != right)
                    .collect();
                self.api()?.grant(&scope, "kit-owner", Rights(rights))?;
            }
            Some("expireWaitCursor") => base::advance_clock_for_test(300_001),
            Some("receiptGate") => {
                *self.receipt_gate.lock().unwrap() = v["mode"].as_str().context("gate mode")?.into()
            }
            Some("barrier") if v["name"] == "terminalRecorded" => {
                use sha2::{Digest, Sha256};
                let key = format!(
                    "{:x}",
                    Sha256::digest(
                        json!(["agui:receipt:1", id, "kit-owner", "kit-primary", v["runId"]])
                            .to_string()
                    )
                );
                self.barrier(id, &format!("terminal:{key}")).await;
            }
            Some("barrier") if v["name"] == "recoveryEnded" => {
                self.until(|| {
                    self.file(id).is_ok_and(|d| {
                        d.entries.iter().filter(|e| e.kind == "turn.end").count() >= 2
                    })
                })
                .await
            }
            Some("tls") => return read(self.dir.join("tls-client.json")),
            Some("approvalGate") if v["mode"] == "redact" => {
                *self.redacted_client.lock().unwrap() =
                    v["client"].as_str().context("client")?.into();
            }
            Some("barrier") if self.name == "closure-presence" && v["name"] == "presenceLost" => {
                self.barrier(id, "presenceLost").await;
                self.until(|| {
                    self.file(id)
                        .is_ok_and(|d| d.entries.iter().any(|e| e.kind == "request.closed"))
                })
                .await;
            }
            Some("barrier")
                if (self.name.starts_with("waiting-") || self.name.starts_with("closure-"))
                    && v["name"] == "presenceLost" =>
            {
                self.barrier(id, "presenceLost").await
            }
            Some("barrier") if v["name"] == "presenceLost" => {
                self.until(|| {
                    self.file(id)
                        .is_ok_and(|s| s.entries.iter().any(|e| e.kind == "turn.end"))
                })
                .await
            }
            Some("barrier") => {
                self.barrier(id, v["name"].as_str().context("barrier name")?)
                    .await
            }
            Some("release") => self.latch(id, "released"),
            Some("revoke") => {
                self.api()?.grant(
                    &scope,
                    "kit-owner",
                    Rights::only(&["watch", "input", "approve", "answer"]),
                )?;
            }
            Some("move") => {
                self.api()?.move_position(&scope, None)?;
            }
            Some("erase") => {
                let input = self
                    .file(id)?
                    .entries
                    .into_iter()
                    .find(|e| e.kind == "input.accepted")
                    .context("admission")?;
                let report = self.api()?.erase(&scope, vec![input.id]).await?;
                *self.erasure.lock().unwrap() = json!({"outOfReach":report.out_of_reach});
            }
            Some("advance") => {
                let ms = v["milliseconds"].as_u64().context("time")?;
                base::advance_clock_for_test(ms);
                if self.name.starts_with("closure-") {
                    self.until(|| {
                        self.file(id).is_ok_and(|d| {
                            d.entries.iter().any(|e| {
                                if self.name == "closure-left-open" {
                                    e.kind == "tool.pending"
                                } else {
                                    e.kind == "request.closed"
                                        && e.content
                                            .as_ref()
                                            .is_some_and(|v| v["reason"] == "timeLimit")
                                }
                            })
                        })
                    })
                    .await;
                }
                if self.name.starts_with("waiting-") {
                    fs::write(self.dir.join("clock"), base::now().to_string())?;
                }
                let ends = if self.name == "report-cutoffs" || self.name == "waiting-expiry" {
                    2
                } else {
                    1
                };
                self.until(|| {
                    self.file(id).is_ok_and(|s| {
                        s.entries.iter().filter(|e| e.kind == "turn.end").count() >= ends
                    })
                })
                .await;
            }
            _ => anyhow::bail!("unknown fixture operation"),
        };
        Ok(json!({}))
    }
}
struct FixtureProvider<P>(P, bool);
#[sdk::async_trait]
impl<P: sdk::Provider> sdk::Provider for FixtureProvider<P> {
    fn id(&self) -> &str {
        self.0.id()
    }
    fn models(&self) -> Vec<sdk::ModelInfo> {
        self.0.models()
    }
    fn supports(&self) -> sdk::ProviderSupport {
        self.0.supports()
    }
    async fn request(
        &self,
        model: sdk::ModelRef,
        req: sdk::ModelRequest,
        cx: sdk::ProviderContext,
    ) -> sdk::Result<sdk::AssistantMessage> {
        let mut msg = self.0.request(model, req, cx).await?;
        if self.1 {
            msg["providerData"] = json!({"private":"provider-only-sentinel"});
        }
        Ok(msg)
    }
}
struct Logger(Arc<Kit>);
impl log::Log for Logger {
    fn enabled(&self, m: &log::Metadata<'_>) -> bool {
        m.target().starts_with("modular_agent::agui::")
    }
    fn log(&self, r: &log::Record<'_>) {
        match r.target() {
            "modular_agent::agui::terminal_recorded" => {
                if let Some((id, key)) = r.args().to_string().split_once(' ') {
                    self.0.latch(id, &format!("terminal:{key}"));
                }
            }
            "modular_agent::agui::report_committed" if self.0.name == "receipt-result" => {
                let id = r.args().to_string();
                if self.0.held(&id, "afterResult") {
                    tokio::task::block_in_place(|| {
                        self.0.latch(&id, "afterResult");
                        loop {
                            std::thread::park();
                        }
                    });
                }
            }
            "modular_agent::agui::warning" => {
                let _ = self.0.append("warnings", json!(r.args().to_string()));
            }
            "modular_agent::agui::wait_following" => {
                self.0.latch(&r.args().to_string(), "waitFollowing")
            }
            "modular_agent::agui::presence_lost" => {
                self.0.latch(&r.args().to_string(), "presenceLost")
            }
            "modular_agent::agui::handoff" => {
                if let Some((s, id)) = r.args().to_string().split_once(' ') {
                    let _ = self.0.append("dispatches", json!([s, id]));
                }
            }
            _ => (),
        }
    }
    fn flush(&self) {}
}
fn main() -> Result<()> {
    let config = read(std::env::var("MA_AGUI_FIXTURE")?)?;
    let mut rt = if matches!(
        config["name"].as_str(),
        Some("approval-expired" | "questions" | "report-cutoffs")
    ) {
        tokio::runtime::Builder::new_current_thread()
    } else {
        let mut b = tokio::runtime::Builder::new_multi_thread();
        b.worker_threads(4);
        b
    };
    rt.enable_all().build()?.block_on(serve(config))
}
async fn serve(config: Value) -> Result<()> {
    // Other scenarios, including restart, use the production wall clock.
    if matches!(
        config["name"].as_str(),
        Some("approval-expired" | "questions" | "report-cutoffs")
    ) {
        base::advance_clock_for_test(0);
    }
    let dir = PathBuf::from(std::env::var("MODULAR_AGENT_DATA_DIR")?);
    if config["name"]
        .as_str()
        .is_some_and(|s| s.starts_with("waiting-") || s.starts_with("closure-"))
    {
        let clock = dir.join("clock");
        let at = if clock.exists() {
            fs::read_to_string(&clock)?.parse()?
        } else {
            1_800_000_000_000u64
        };
        fs::write(clock, at.to_string())?;
        base::set_clock_for_test(at);
    }
    let project = PathBuf::from(config["project"].as_str().context("project")?);
    let listen = std::env::var("MA_AGUI_LISTEN")?;
    ensure!(
        listen == "127.0.0.1:0",
        "fixture requires disposable loopback"
    );
    let restarted = dir.join("started").exists();
    fs::write(dir.join("started"), [])?;
    let exporter = InMemorySpanExporter::default();
    let provider = SdkTracerProvider::builder()
        .with_sampler(opentelemetry_sdk::trace::Sampler::AlwaysOn)
        .with_simple_exporter(exporter.clone())
        .build();
    opentelemetry::global::set_tracer_provider(provider.clone());
    let k = Arc::new(Kit {
        name: config["name"].as_str().context("name")?.into(),
        dir: dir.clone(),
        restarted,
        redacted_client: Default::default(),
        wait_gate: Default::default(),
        receipt_gate: Default::default(),
        api: Default::default(),
        changed: Default::default(),
        latches: Default::default(),
        erasure: Mutex::new(json!({"outOfReach":[]})),
        exporter,
        provider,
        writes: Mutex::new(()),
    });
    log::set_boxed_logger(Box::new(Logger(k.clone())))?;
    log::set_max_level(log::LevelFilter::Debug);
    let mut def = config["offer"].clone();
    def["callers"] = json!(["model"]);
    if k.name.starts_with("waiting-mixed-") {
        def["hints"]["readOnly"] = json!(true);
    }
    let store = store::Journal {
        inner: history_fs::FileHistory::new(&dir.join("ledger"))?,
        state: k.clone(),
    };
    let mut steps = read(std::env::var("MODULAR_AGENT_SCRIPT")?)?;
    if k.name == "closure-left-open" {
        steps
            .as_array_mut()
            .context("fixture script")?
            .insert(1, json!({"toolCalls":[{"name":"kit_choose","input":{}}]}));
    }
    let script = standard::script::Script::new(
        steps,
        Some(std::env::var("MODULAR_AGENT_SCRIPT_LOG")?.into()),
    );
    let durable = !matches!(
        k.name.as_str(),
        "crash-before-handoff" | "receipt-after-admission"
    );
    let mut builder = Agent::builder()
        .project(&project)
        .plugin_host(true)
        .several_actors(true)
        .session_limits(true)
        .tenants(json!({"kit":{"rights":Rights::full()}}))
        .data_dir(&dir)
        .durability(if durable {
            sdk::Durability::Durable
        } else {
            sdk::Durability::Kept
        })
        .history(sdk::History::from_store(store, true))
        .provider(FixtureProvider(
            script.provider(),
            k.name == "state-and-gate",
        ))
        .model("scripted/script")
        .approval_covers_nested(
            k.name.starts_with("approval")
                || k.name.starts_with("waiting-")
                || k.name == "erasure-retry",
        )
        .approval(
            if k.name.starts_with("approval")
                || matches!(k.name.as_str(), "closure-presence" | "closure-routes")
            {
                sdk::Approval::All
            } else {
                sdk::Approval::Off
            },
        )
        .setting("approval_timeout_ms", json!(5000))
        .interface_tools([sdk::InterfaceToolSource {
            source_id: "kit.palette".into(),
            actor_id: "kit-owner".into(),
            route_id: "kit-primary".into(),
            result_timeout_ms: 60_000,
            tools: vec![def],
        }]);
    if k.name.starts_with("waiting-") {
        builder = builder
            .max_approval_wait_ms(5000)
            .setting(
                "approvalWait",
                json!(if k.name == "waiting-live" {
                    "live"
                } else {
                    "untilDeadline"
                }),
            )
            .approval(if k.name.starts_with("waiting-mixed-") {
                sdk::Approval::Ask
            } else {
                sdk::Approval::All
            });
        let counter = dir.join("count");
        if k.name == "waiting-restart" {
            builder = builder
                .setting("modelTools", json!(["bump"]))
                .tool(sdk::Tool::new("bump", "Increment the counter").run(
                    |_: Value, cx| async move {
                        let result = cx.tools().call("increment", json!({})).await?;
                        Ok(result.text().to_owned())
                    },
                ))
                .tool(
                    sdk::Tool::new("increment", "Write the count").run(move |_: Value, _| {
                        let path = counter.clone();
                        async move {
                            let next = sdk::testing::fixtures::count(&path) + 1;
                            fs::write(path, next.to_string())?;
                            Ok(next.to_string())
                        }
                    }),
                );
        } else {
            builder = builder.tool(sdk::testing::fixtures::counter(counter));
        }
    }
    if k.name == "closure-left-open" {
        builder = builder.tool(sdk::Tool::new("kit_choose", "Choose a label").run(
            |_: Value, cx| async move {
                cx.ask_with(
                    sdk::Ask::choice("Choose a label.", &["yes", "no"]),
                    sdk::AskWait {
                        wait: std::time::Duration::from_secs(5),
                    },
                )
                .await?;
                Ok("Answered.".to_owned())
            },
        ));
    }
    builder = hooks::install(builder, &k);
    let agent = builder.build().await?;
    let _ = k.api.set(sdk::testing::fixture_host(&agent));
    let mut actors = vec![];
    let outside = dir.join("outside-project");
    fs::create_dir_all(&outside)?;
    for (role, path) in config["tokenFiles"].as_object().context("token files")? {
        let mut p = sdk::AcpActor::local(path.as_str().context("token file")?.into());
        p.actor.id = match role.as_str() {
            "foreign" => "kit-other",
            "default-join" => base::ACP_HOST_ACTOR,
            "departed" => "kit-departed",
            "outside" => "kit-outside",
            "no-watch" => "kit-no-watch",
            _ => "kit-owner",
        }
        .into();
        p.actor.kind = if role == "default-join" {
            "host"
        } else {
            "user"
        }
        .into();
        p.actor.rights = match role.as_str() {
            "foreign" => Rights::only(&["watch", "input", "tools", "answer", "approve"]),
            "watch" => Rights::only(&["watch"]),
            "no-watch" => Rights::only(&["input"]),
            _ => Rights::full(),
        };
        p.tenants = Some(vec![Some(
            if role == "tenant" { "other" } else { "kit" }.into(),
        )]);
        p.projects = Some(vec![if matches!(role.as_str(), "project" | "outside") {
            outside.clone()
        } else {
            project.clone()
        }]);
        let primary = matches!(role.as_str(), "owner" | "rotated");
        let mut a = AguiActor::new(if primary { "kit-primary" } else { role }, p);
        a.join_on_open = matches!(
            role.as_str(),
            "foreign" | "departed" | "outside" | "no-watch"
        );
        a.trust_trace_context = primary;
        a.trace_state_keys = vec!["kit".into()];
        actors.push(a);
    }
    let tls = (k.name == "tls").then(|| sdk::TlsOptions {
        cert_file: dir.join("server.pem"),
        key_file: dir.join("server.key"),
    });
    let client_ca_file = tls.as_ref().map(|_| dir.join("ca.pem"));
    let mut options = AguiOptions {
        listen,
        actors,
        acp: true,
        tenant: Some("kit".into()),
        tls,
        client_ca_file,
        ..Default::default()
    };
    if k.name == "state-and-gate" {
        options.state = Some(sdk::AguiState {
            plugin: "kit.state".into(),
            snapshot: Arc::new(|_| Some(("0".into(), json!({"counter":0})))),
        });
        options
            .raw_events
            .insert(("kit.state".into(), "kit.raw".into()), "kit".into());
    }
    let server = agent.serve_agui(options).await?;
    let control = transport_websocket::http::serve(
        "127.0.0.1:0",
        None,
        None,
        vec![(
            config["controlTokenFile"]
                .as_str()
                .context("control token file")?
                .into(),
            (),
        )],
        move |actor, req, _| {
            let k = k.clone();
            async move {
                use axum::{
                    body::Body,
                    http::{Method, Response},
                };
                let result = async {
                    ensure!(
                        actor.is_some()
                            && req.method() == Method::POST
                            && req.uri().path() == "/fixture",
                        "invalid control request"
                    );
                    let bytes = axum::body::to_bytes(req.into_body(), 4096).await?;
                    k.control(serde_json::from_slice(&bytes)?).await
                }
                .await;
                match result {
                    Ok(v) => Response::builder()
                        .header("Content-Type", "application/json")
                        .body(Body::from(v.to_string()))
                        .unwrap(),
                    Err(e) => {
                        eprintln!("fixture control: {e:#}");
                        Response::builder().status(400).body(Body::empty()).unwrap()
                    }
                }
            }
        },
    )
    .await?;
    println!(
        "{}",
        json!({"url":server.url,"control":format!("{}/fixture",control.url)})
    );
    tokio::signal::ctrl_c().await?;
    control.close().await;
    server.close().await;
    agent.close().await?;
    Ok(())
}
