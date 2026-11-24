//! One disposable writer for the conditional ADR 0034 scenarios. The driver
//! owns the clock and the kill boundary. This worker uses normal SDK handles.
use super::*;
use agent_api::{HistoryStore, Lease, SessionData};
use modular_agent::{
    Gate, History, OutputDecision, Plugin, Tool, ToolSource, testing::TestAgentBuilder,
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    fs,
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;

type R<T> = agent_api::Result<T>;
struct Journal {
    store: history_fs::FileHistory,
    log: PathBuf,
}
impl HistoryStore for Journal {
    fn acquire(&self, id: &str) -> R<Box<dyn Lease>> {
        self.store.acquire(id)
    }
    fn list(&self, p: Option<&Path>) -> R<Vec<SessionData>> {
        self.store.list(p)
    }
    fn load(&self, id: &str) -> R<SessionData> {
        self.store.load(id)
    }
    fn erase(&self, e: Vec<String>, h: &[String]) -> R<Vec<SessionData>> {
        self.store.erase(e, h)
    }
    fn save(&self, data: &SessionData) -> R<()> {
        let n = self.store.load(&data.id).map_or(0, |d| d.entries.len());
        self.store.save(data)?;
        let batch = data.entries[n..]
            .iter()
            .map(|e| agent_api::portable::entry(e, data))
            .collect::<R<Vec<_>>>()?;
        if !batch.is_empty() {
            writeln!(
                fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&self.log)?,
                "{}",
                json!(batch)
            )?;
        }
        Ok(())
    }
}
#[derive(Default)]
struct Controls {
    arm: Mutex<String>,
    reached: Notify,
    release: Notify,
    input: Mutex<Option<Value>>,
    redact: Mutex<String>,
    registration: Mutex<String>,
}
impl Controls {
    async fn hit(&self, key: &str) {
        if self.arm.lock().unwrap().as_str() == key {
            self.reached.notify_one();
            self.release.notified().await;
        }
    }
    fn plugin(self: &Arc<Self>) -> Plugin {
        let first = self.clone();
        let before = self.clone();
        let view = self.clone();
        Plugin::new("fixture.wait-checks")
            .on_turn_before(move |_| {
                let s = first.clone();
                async move {
                    s.hit("afterAnswer").await;
                    Ok(Default::default())
                }
            })
            .on_turn_start(move |_| {
                let s = before.clone();
                async move {
                    s.hit("beforeGates").await;
                    Ok(())
                }
            })
            .on_tool_before({
                let s = self.clone();
                move |_| {
                    let s = s.clone();
                    async move {
                        s.hit("beforeHandoff").await;
                        Ok(s.input
                            .lock()
                            .unwrap()
                            .clone()
                            .map_or(Gate::Allow, Gate::Change))
                    }
                }
            })
            .on_output(move |o| {
                let s = view.clone();
                async move {
                    Ok(
                        if o.value["question"].is_object()
                            && o.recipient == *s.redact.lock().unwrap()
                        {
                            OutputDecision::Block
                        } else {
                            OutputDecision::Allow
                        },
                    )
                }
            })
    }
}
fn place(mut b: TestAgentBuilder, spec: &Value, run: &Run) -> R<TestAgentBuilder> {
    let config = json!({"path":run.counter()});
    for name in spec["plugins"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        b = match &run.placement {
            Placement::InProcess => {
                b.plugin(fixtures::fixture(name).unwrap().config(config.clone()))
            }
            Placement::Process { command, .. } => b.process_plugin(
                ProcessPlugin::new(command.iter().cloned().chain([name.to_string()]))
                    .config(config.clone()),
            ),
            Placement::Service { .. } => b,
        };
    }
    if matches!(run.placement, Placement::Service { .. }) {
        let urls: Vec<String> = serde_json::from_slice(&fs::read(run.service_config())?)?;
        for url in urls {
            b = b.service_plugin(ServicePlugin {
                url,
                token_file: run.token(),
                config: config.clone(),
            });
        }
    }
    Ok(b)
}
/// The refresh fixture has two real registered sources. Both forward the
/// same operation to the counter in the selected tool placement.
struct Catalog {
    controls: Arc<Controls>,
    peer: Session,
    replacement: bool,
}
impl ToolSource for Catalog {
    fn tools(&self, _: &str) -> Vec<Tool> {
        let change = self.controls.registration.lock().unwrap();
        if self.replacement != (change.as_str() == "source") {
            return vec![];
        }
        let peer = self.peer.clone();
        vec![
            Tool::new(
                "bump",
                if change.as_str() == "definition" {
                    "Increment the counter file"
                } else {
                    "Add one to the counter"
                },
            )
            .run(move |v: Value, _| {
                let s = peer.clone();
                async move { Ok(s.call_tool("bump", v).await?.text().to_owned()) }
            }),
        ]
    }
}
async fn build(s: &Value, run: &Run, controls: &Arc<Controls>, probe: bool) -> R<Agent> {
    let spec = &s["agent"];
    let mut b = test_agent()
        .project(run.project())
        .data_dir(run.data_dir())
        .script(s["model"].clone())
        .several_actors(spec["severalActors"] == true)
        .plugin(controls.plugin());
    let d = if probe {
        Durability::Kept
    } else {
        match spec["durability"].as_str() {
            Some("kept") => Durability::Kept,
            Some("durable") => Durability::Durable,
            _ => Durability::Ephemeral,
        }
    };
    b = b.durability(d);
    if d != Durability::Ephemeral {
        b = b.history(History::from_store(
            Journal {
                store: history_fs::FileHistory::new(&run.history_dir())?,
                log: run.dir.join("batches"),
            },
            true,
        ));
    }
    if probe || spec["maxApprovalWaitMs"].is_number() {
        b = b.max_approval_wait_ms(if probe {
            100
        } else {
            spec["maxApprovalWaitMs"].as_u64().unwrap_or(0)
        });
    }
    if let Some(policy) = spec["approval"].as_str() {
        b = b.approval(match policy {
            "off" => Approval::Off,
            "ask" => Approval::Ask,
            "never" => Approval::Never,
            _ => Approval::All,
        });
    } else if probe {
        b = b.approval(Approval::All);
    }
    if let Some(ms) = s.pointer("/fixture/requestedApprovalMs") {
        b = b.setting("approval_timeout_ms", ms.clone());
    }
    if !probe
        && s["steps"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|v| v.pointer("/change/registration").is_some())
    {
        let peer = place(test_agent().project(run.project()), spec, run)?
            .build()
            .await?
            .session()
            .await?;
        for replacement in [false, true] {
            let source = if replacement {
                "other-source"
            } else {
                "initial-source"
            };
            b = b.plugin(Plugin::new(source).tool_source(
                source,
                Catalog {
                    peer: peer.clone(),
                    controls: controls.clone(),
                    replacement,
                },
            ));
        }
    } else {
        b = place(b, spec, run)?;
    }
    if !probe && let Some(request) = telemetry::Request::from_env() {
        b = request.configure(b);
    }
    Ok(b.build().await?)
}

/// Line-delimited JSON commands; never exposed on a listener.
pub async fn worker(args: &[String]) -> R<()> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let s = load(Path::new(&args[0]));
    let run = Run {
        dir: args[1].clone().into(),
        placement: Placement::from_args(&args[2..]),
    };
    fs::create_dir_all(run.project())?;
    let controls = Arc::new(Controls::default());
    let mut agent = None;
    let mut export = None;
    let mut handles = BTreeMap::<String, Session>::new();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        let p: Value = serde_json::from_str(&line)?;
        let op = p["op"].as_str().unwrap();
        let response: R<Value> = async {
            if op == "init" || op == "probe" {
                agent_api::set_clock_for_test(p["clock"].as_u64().unwrap());
                if op == "init" {
                    export =
                        telemetry::install(telemetry::Request::from_env().is_some_and(|r| r.sdk));
                }
                let a = build(&s, &run, &controls, op == "probe").await?;
                let session = if op == "probe" {
                    a.session().await?
                } else if let Some(id) = p["open"].as_str() {
                    a.open_session(id).await?
                } else {
                    a.session_with(SessionOptions {
                        settings: s["agent"]["settings"]
                            .as_object()
                            .cloned()
                            .unwrap_or_default(),
                        actors: serde_json::from_value(
                            s["agent"].get("actors").cloned().unwrap_or(json!([])),
                        )?,
                        ..Default::default()
                    })
                    .await?
                };
                let out = json!({"id":session.id(),"declaration":session.declaration()?});
                handles.insert("user".into(), session);
                agent = Some(a);
                return Ok(out);
            }
            if op == "close" {
                if let Some(a) = agent.take() {
                    a.close().await?
                }
                return Ok(Value::Null);
            }
            let id = p["as"].as_str().unwrap_or("user");
            if !handles.contains_key(id) {
                let s = handles["user"].r#as(id)?;
                handles.insert(id.into(), s);
            }
            let session = &handles[id];
            let null = Value::Null;
            Ok(match op {
                "parked" => {
                    let active = telemetry::active_work(session.id());
                    if let Some(provider) = export.clone()
                        && p["flush"] == true
                    {
                        tokio::task::spawn_blocking(move || provider.force_flush()).await??;
                    }
                    json!(active)
                }
                "flush" => {
                    telemetry::flush(export.take()).await;
                    null
                }
                "prompt" => json!(session.prompt(p["text"].as_str().unwrap()).await?),
                "wait" => {
                    session.wait_idle().await?;
                    json!(session.last_turn().await?)
                }
                "poll" => json!(if p["present"] == true {
                    session.questions_present().await?
                } else {
                    session.questions()?
                }),
                "decide" => match session
                    .answer(
                        p["id"].as_str().unwrap(),
                        if let Some(reason) = p["reason"].as_str() {
                            Answer::Declined {
                                reason: Some(reason.into()),
                            }
                        } else {
                            scenario_answer(&p["answer"])?
                        },
                    )
                    .await
                {
                    Ok(()) => json!(true),
                    Err(e)
                        if matches!(
                            e.code(),
                            Code::Conflict | Code::NotFound | Code::Forbidden
                        ) =>
                    {
                        json!(false)
                    }
                    Err(e) => return Err(e.into()),
                },
                "clock" => {
                    agent_api::set_clock_for_test(p["at"].as_u64().unwrap());
                    null
                }
                "barrier" => {
                    let v = &p["barrier"];
                    if let Some(k) = v["arm"].as_str() {
                        *controls.arm.lock().unwrap() = k.into()
                    } else if v["reached"].is_string() {
                        controls.reached.notified().await
                    } else {
                        controls.arm.lock().unwrap().clear();
                        controls.release.notify_one();
                    }
                    null
                }
                "change" => {
                    let v = &p["change"];
                    if let Some(m) = v["setting"].as_object() {
                        for (k, v) in m {
                            session.set_setting(k, v.clone())?;
                        }
                    } else if let Some(k) = v["registration"].as_str() {
                        *controls.registration.lock().unwrap() = k.into();
                    } else if let Some(input) = v.get("gateInput") {
                        *controls.input.lock().unwrap() = Some(input.clone());
                    } else if let Some(who) = v["gateView"]["actor"].as_str() {
                        *controls.redact.lock().unwrap() = who.into();
                    } else {
                        let who = v["removeRight"]["actor"].as_str().unwrap();
                        let mut a: modular_agent::Actor = serde_json::from_value(
                            s["agent"]["actors"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .find(|v| v["id"] == who)
                                .unwrap()
                                .clone(),
                        )?;
                        a.rights
                            .0
                            .remove(v["removeRight"]["right"].as_str().unwrap());
                        session.join(a).await?;
                    }
                    null
                }
                _ => agent_api::bail!("unknown waiting fixture operation"),
            })
        }
        .await;
        let out = match response {
            Ok(v) => json!({"value":v}),
            Err(e) => {
                json!({"error":e.downcast_ref::<Error>().map(|e|e.code().as_str()).unwrap_or("internal"),"message":e.to_string()})
            }
        };
        println!("{out}");
        std::io::stdout().flush()?;
    }
    Ok(())
}
