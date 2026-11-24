//! Adapter and independent observations for the shared telemetry check.
use super::{Placement, Run, load};
use agent_api::{Entry, HistoryStore, Lease, SessionData, portable};
use history_fs::FileHistory;
use modular_agent::{
    Agent, History, Plugin, Session,
    testing::{TestAgentBuilder, fixtures},
};
use opentelemetry::global;
use opentelemetry_otlp::{Protocol, SpanExporter, WithExportConfig};
use opentelemetry_sdk::{
    runtime::Tokio,
    trace::{Sampler, SdkTracerProvider, span_processor_with_async_runtime::BatchSpanProcessor},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

const REQUEST: &str = "MODULAR_AGENT_TELEMETRY_RUN";
pub const ENDPOINT: &str = "MODULAR_AGENT_TELEMETRY_OTLP";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    host: String,
    pub scenario: String,
    placement: String,
    pub sdk: bool,
    agent_name: String,
    pub scenario_path: PathBuf,
    pub report_path: PathBuf,
    work_dir: PathBuf,
    fixtures: Vec<Fixture>,
    values: Values,
}

#[derive(Deserialize)]
struct Fixture {
    name: String,
    command: Vec<String>,
    env: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct Values {
    answer: String,
}

impl Request {
    pub fn from_env() -> Option<Self> {
        let path = std::env::var_os(REQUEST)?;
        let request: Self =
            serde_json::from_value(load(Path::new(&path))).expect("telemetry request");
        assert_eq!(request.host, "rust");
        Some(request)
    }

    pub fn run(&self) -> Run {
        Run {
            dir: self.work_dir.clone(),
            placement: Placement::from_args(std::slice::from_ref(&self.placement)),
        }
    }

    pub fn fixture(&self, name: &str) -> Option<Plugin> {
        if self.scenario == "question-answered" && name == "confirm" {
            return Some(
                Plugin::new("confirm")
                    .tool(fixtures::confirm_with_choice(self.values.answer.clone())),
            );
        }
        fixtures::fixture(name)
    }

    pub fn process_plugin(&self, name: &str) -> modular_agent::ProcessPlugin {
        let fixture = self
            .fixtures
            .iter()
            .find(|fixture| fixture.name == name)
            .expect("telemetry process fixture");
        let mut plugin = modular_agent::ProcessPlugin::new(fixture.command.clone());
        plugin.env.clone_from(&fixture.env);
        plugin
    }

    pub fn configure(&self, builder: TestAgentBuilder) -> TestAgentBuilder {
        builder.agent_name(&self.agent_name)
    }
}

/// Only the scenario binaries install exporters. The SDK still uses only the API.
// A test processor observes live work; an exporter only sees ended spans.
type ActiveMap = std::collections::HashMap<opentelemetry::trace::SpanId, (String, String)>;
#[derive(Clone, Default, Debug)]
struct ActiveWork(Arc<Mutex<ActiveMap>>);
static ACTIVE: std::sync::OnceLock<ActiveWork> = std::sync::OnceLock::new();
pub fn active_work(session: &str) -> Vec<String> {
    ACTIVE
        .get()
        .map(|s| {
            s.0.lock()
                .unwrap()
                .values()
                .filter(|(id, _)| id == session)
                .map(|(_, n)| n.clone())
                .collect()
        })
        .unwrap_or_default()
}
impl opentelemetry_sdk::trace::SpanProcessor for ActiveWork {
    fn on_start(&self, span: &mut opentelemetry_sdk::trace::Span, _: &opentelemetry::Context) {
        if let Some(d) = span.exported_data()
            && (d.name.starts_with("invoke_agent")
                || d.name.starts_with("execute_tool")
                || d.name.starts_with("modular_agent.question.")
                || d.name == "modular_agent.step")
            && let Some(attr) = d
                .attributes
                .iter()
                .find(|a| a.key.as_str() == "gen_ai.conversation.id")
        {
            self.0.lock().unwrap().insert(
                d.span_context.span_id(),
                (attr.value.to_string(), d.name.into_owned()),
            );
        }
    }
    fn on_end(&self, span: opentelemetry_sdk::trace::SpanData) {
        self.0.lock().unwrap().remove(&span.span_context.span_id());
    }
    fn force_flush(&self) -> opentelemetry_sdk::error::OTelSdkResult {
        Ok(())
    }
    fn shutdown_with_timeout(
        &self,
        _: std::time::Duration,
    ) -> opentelemetry_sdk::error::OTelSdkResult {
        Ok(())
    }
}

pub fn install(enabled: bool) -> Option<SdkTracerProvider> {
    if !enabled {
        return None;
    }
    let endpoint = std::env::var(ENDPOINT).expect("telemetry receiver endpoint");
    let exporter = SpanExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(endpoint)
        .build()
        .expect("configure OTLP/HTTP exporter");
    let provider = SdkTracerProvider::builder()
        .with_sampler(Sampler::AlwaysOn)
        .with_resource(opentelemetry_sdk::Resource::builder_empty().build())
        .with_span_processor(ACTIVE.get_or_init(Default::default).clone())
        .with_span_processor(BatchSpanProcessor::builder(exporter, Tokio).build())
        .build();
    global::set_tracer_provider(provider.clone());
    Some(provider)
}

pub async fn flush(provider: Option<SdkTracerProvider>) {
    if let Some(provider) = provider {
        // The batch worker needs a Tokio thread for its HTTP request while we wait.
        tokio::task::spawn_blocking(move || {
            provider
                .force_flush()
                .expect("receiver acknowledged traces");
            provider.shutdown().expect("stop trace exporter");
        })
        .await
        .expect("join exporter shutdown");
    }
}

#[derive(Default)]
struct Journal {
    commits: Vec<Value>,
    steps: Vec<Value>,
    after_restart: Vec<Value>,
}

#[derive(Clone, Default)]
pub(crate) struct Evidence(Arc<Mutex<Journal>>);

impl Evidence {
    pub fn attach(
        &self,
        request: &Request,
        run: &Run,
        persistent: bool,
        builder: TestAgentBuilder,
    ) -> modular_agent::Result<TestAgentBuilder> {
        let store = FileHistory::new(&run.data_dir())?;
        let evidence = self.clone();
        let observe_commits = request.sdk && request.scenario == "first-turn";
        let observe_recovery = request.scenario.ends_with("-crash");
        let attempt_file = run.dir.join("attempts.ndjson");
        Ok(builder
            .history(History::from_store(
                ObservedStore {
                    store,
                    evidence: self.clone(),
                    observe_commits,
                    observe_recovery,
                },
                persistent,
            ))
            .observe_scripted_dispatch(move |model, cx| {
                let row = json!({"id": cx.step_id().expect("model step ID"), "model": model.id});
                if observe_recovery {
                    // A separate process records the killed dispatch before returning
                    // from the Provider. The outer runner reads it at the counter barrier.
                    let mut file = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&attempt_file)?;
                    writeln!(file, "{row}")?;
                }
                let mut journal = evidence.0.lock().unwrap();
                if observe_recovery && !journal.after_restart.iter().any(|e| e["kind"] == "effect")
                {
                    journal.after_restart.push(json!({"kind":"effect"}));
                }
                journal.steps.push(row);
                Ok(())
            }))
    }

    pub fn before_crash(run: &Run, session: &str) -> agent_api::Result<Value> {
        let store = FileHistory::new(&run.data_dir())?;
        let data = store.load(session)?;
        let start = data
            .entries
            .iter()
            .find(|e| e.kind == "turn.start")
            .expect("committed turnStart at counter barrier");
        let mut attempts = read_attempts(run)?;
        assert_eq!(
            attempts.len(),
            1,
            "one Provider dispatch before the barrier"
        );
        let mut step = attempts.pop().unwrap();
        step["beforeCrash"] = json!(true);
        Ok(
            json!({"turnStart":portable::entry(start, &data)?, "countBefore":fixtures::count(&run.counter()), "step":step}),
        )
    }

    pub fn report(
        &self,
        request: &Request,
        run: &Run,
        agent: &Agent,
        session: &Session,
        before_crash: Option<Value>,
    ) -> agent_api::Result<Value> {
        let store = FileHistory::new(&run.data_dir())?;
        let data = store.load(session.id())?;
        let entries = &data.entries;
        let end = entries
            .iter()
            .rfind(|e| e.kind == "turn.end")
            .expect("recorded turnEnd");
        let end = portable::entry(end, &data)?;
        let mut report = json!({
            "scenario":request.scenario, "placement":run.placement.name(), "passed":true,
            "sessionId":session.id(), "turnId":end["turnId"], "outcome":end["data"]["outcome"]["kind"],
            "historyKinds":entries.iter().map(|entry| portable::entry(entry, &data).map(|row| row["kind"].clone())).collect::<agent_api::Result<Vec<_>>>()?,
        });
        let journal = self.0.lock().unwrap();
        if request.scenario == "first-turn" {
            report["declarations"] =
                json!({"agent":agent.declaration()?, "session":session.declaration()?});
            if request.sdk {
                report["commits"] = json!(journal.commits);
            }
        }
        if request.sdk {
            let mut steps = journal.steps.clone();
            if let Some(crash) = before_crash {
                steps.insert(0, crash["step"].clone());
                report["crash"] = json!({"signal":"SIGKILL", "turnStart":crash["turnStart"], "countBefore":crash["countBefore"],
                    "countAfter":fixtures::count(&run.counter()), "afterRestart":journal.after_restart});
            }
            report["steps"] = json!(steps);
            report["calls"] = json!(
                entries
                    .iter()
                    .filter(|e| e.kind == "tool.call")
                    .map(|e| observed_call(e, &data))
                    .collect::<agent_api::Result<Vec<_>>>()?
            );
            if request.scenario == "question-answered" {
                let question = entries
                    .iter()
                    .find(|e| e.kind == "request.open")
                    .expect("recorded question");
                let row = portable::entry(question, &data)?;
                report["question"] = json!({"id":row["data"]["request"]["id"], "kind":row["data"]["request"]["kind"]});
            }
        }
        Ok(report)
    }
}

fn read_attempts(run: &Run) -> agent_api::Result<Vec<Value>> {
    std::fs::read_to_string(run.dir.join("attempts.ndjson"))?
        .lines()
        .map(|line| Ok(serde_json::from_str(line)?))
        .collect()
}

fn observed_call(call: &Entry, data: &SessionData) -> agent_api::Result<Value> {
    let result = data
        .entries
        .iter()
        .find(|e| e.kind == "tool.result" && e.scope.call == call.scope.call)
        .expect("recorded tool result");
    let result = portable::entry(result, data)?;
    let content = call.content.as_ref().expect("recorded tool call");
    let mut row = json!({"id":call.scope.call, "stepId":call.scope.step, "name":content["name"], "status":result["data"]["status"]});
    if let Some(value) = content["extra"].get("parentCallId") {
        row["parentCallId"] = value.clone();
    }
    if content["started_by"] == "model"
        && let Some(value) = content["extra"].get("id")
    {
        row["providerCallId"] = value.clone();
    }
    Ok(row)
}

struct ObservedStore {
    store: FileHistory,
    evidence: Evidence,
    observe_commits: bool,
    observe_recovery: bool,
}

impl HistoryStore for ObservedStore {
    fn acquire(&self, session: &str) -> agent_api::Result<Box<dyn Lease>> {
        self.store.acquire(session)
    }
    fn load(&self, session: &str) -> agent_api::Result<SessionData> {
        self.store.load(session)
    }
    fn list(&self, project: Option<&Path>) -> agent_api::Result<Vec<SessionData>> {
        self.store.list(project)
    }
    fn erase(&self, entries: Vec<String>, held: &[String]) -> agent_api::Result<Vec<SessionData>> {
        self.store.erase(entries, held)
    }
    fn save(&self, data: &SessionData) -> agent_api::Result<()> {
        let previous = self
            .store
            .load(&data.id)
            .map_or(0, |data| data.entries.len());
        self.store.save(data)?;
        let batch = &data.entries[previous..];
        let mut journal = self.evidence.0.lock().unwrap();
        if self.observe_commits
            && let Some(entry) = batch.last()
        {
            // The first-turn script has only admission, turn and step writers.
            let scope = &entry.scope;
            let parent = match (&scope.turn, &scope.step) {
                (None, _) => json!({"name":"modular_agent.input.admit"}),
                (Some(turn), None) => json!({"name":"invoke_agent", "turnId":turn}),
                (Some(turn), Some(step)) => {
                    json!({"name":"modular_agent.step", "turnId":turn, "stepId":step})
                }
            };
            let mut commit = json!({"count":batch.len(), "status":"committed", "parent":parent});
            if let Some(turn) = &scope.turn {
                commit["turnId"] = json!(turn);
            }
            if let Some(step) = &scope.step {
                commit["stepId"] = json!(step);
            }
            journal.commits.push(commit);
        }
        if self.observe_recovery {
            for entry in batch
                .iter()
                .filter(|entry| entry.kind == "modular-agent.turnTrace")
            {
                journal.after_restart.push(portable::entry(entry, data)?);
            }
        }
        Ok(())
    }
}
