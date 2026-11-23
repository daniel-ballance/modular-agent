//! A remote plugin is an ordinary collection of local capability adapters.
use crate::{rpc::*, wire};
use agent_api::*;
use agent_harness::Harness;
use base64::{Engine, prelude::BASE64_STANDARD};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak, atomic::Ordering},
    time::Duration,
};
use tokio::process::Command;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Launch {
    pub command: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub config: Value,
}
impl Launch {
    fn spawn(&self, project: &Path) -> Result<tokio::process::Child> {
        let (program, args) = self
            .command
            .split_first()
            .ok_or_else(|| anyhow!("empty plugin command"))?;
        Ok(Command::new(program)
            .args(args)
            .env_clear()
            .env(
                "PATH",
                std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into()),
            )
            .envs(&self.env)
            .current_dir(project)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .kill_on_drop(true)
            .spawn()?)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceLaunch {
    pub url: String,
    pub token_file: PathBuf,
    #[serde(default)]
    pub config: Value,
}

impl ServiceLaunch {
    pub fn new(url: impl Into<String>, token_file: impl Into<PathBuf>) -> Self {
        Self {
            url: url.into(),
            token_file: token_file.into(),
            config: json!({}),
        }
    }

    pub fn config(mut self, config: Value) -> Self {
        self.config = config;
        self
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum ExternalLaunch {
    Process(Launch),
    Service(ServiceLaunch),
}

#[derive(Default)]
pub struct LoadOptions {
    pub readiness: Option<ProviderReadiness>,
    pub omit_trace_offer: bool,
}

impl ExternalLaunch {
    pub async fn load(
        self,
        harness: &Arc<Harness>,
        project: &Path,
        home: &Path,
        index: usize,
    ) -> Result<Arc<Remote>> {
        self.load_with_options(harness, project, home, index, LoadOptions::default())
            .await
    }

    pub async fn load_with_options(
        self,
        harness: &Arc<Harness>,
        project: &Path,
        home: &Path,
        index: usize,
        options: LoadOptions,
    ) -> Result<Arc<Remote>> {
        match self {
            Self::Process(launch) => {
                ensure!(!launch.command.is_empty(), "empty plugin command");
                let config = launch.config.clone();
                load_transport(
                    harness,
                    Transport::Process(launch),
                    config,
                    project,
                    home,
                    index,
                    options,
                )
                .await
            }
            Self::Service(launch) => {
                ensure!(
                    launch.token_file.is_absolute(),
                    "plugin service token file must be absolute"
                );
                ensure!(
                    launch.config.is_null() || launch.config.is_object(),
                    "plugin service config must be an object"
                );
                load_transport(
                    harness,
                    Transport::Service(launch.url, launch.token_file),
                    launch.config,
                    project,
                    home,
                    index,
                    LoadOptions::default(),
                )
                .await
            }
        }
    }
}

/// The hang guard and fallback message for a dedicated Provider program.
#[derive(Clone, Copy, Debug)]
pub struct ProviderReadiness {
    pub id: &'static str,
    pub guard: Duration,
    pub fallback: &'static str,
}

impl ProviderReadiness {
    fn validate(&self, registration: &Value) -> Result<()> {
        ensure!(
            registration["providers"]
                .as_array()
                .is_some_and(|providers| providers.len() == 1 && providers[0]["id"] == self.id),
            "process program did not register the expected {} Provider",
            self.id
        );
        Ok(())
    }

    /// Ask a fresh process for readiness without composing an agent or sending model work.
    pub async fn probe(self, launch: &Launch, state: &Path) -> Result<Option<String>> {
        let state = state.canonicalize()?;
        let mut child = launch.spawn(&state)?;
        let peer = Peer::start(
            child.stdout.take().unwrap(),
            child.stdin.take().unwrap(),
            Arc::new(ProbeCallbacks),
        );
        let _close_on_drop = peer.closed.clone().drop_guard();
        let result = async {
            let registration =
                initialize(&peer, &state, &state, launch.config.clone(), true).await?;
            validate_binding(&registration)?;
            wire::string(&registration, "name")?;
            self.validate(&registration)?;
            provider_availability(&peer, self.id, Some(self), CancellationToken::new()).await
        }
        .await;
        if !peer.closed.is_cancelled() && result.is_ok() {
            let _ = control(&peer, "plugin/shutdown", json!({"reason":"stop"})).await;
        }
        peer.close();
        if result.is_err() || tokio::time::timeout(CONTROL, child.wait()).await.is_err() {
            let _ = child.kill().await;
        }
        result
    }
}

struct ProbeCallbacks;

#[async_trait]
impl Endpoint for ProbeCallbacks {
    async fn request(
        &self,
        _: Arc<Peer>,
        _: Value,
        _: &str,
        _: Value,
        _: CancellationToken,
    ) -> Reply {
        Err(Fault::new(
            "invalid_request",
            "readiness probes do not allow host callbacks",
        ))
    }
}

pub(crate) struct Shared {
    readiness: Option<ProviderReadiness>,
    pub(crate) api: Weak<dyn AgentApi>,
    pub(crate) registration: Mutex<Value>,
    pub(crate) sessions: Mutex<BTreeMap<String, Scope>>,
    pub(crate) job_lock: tokio::sync::Mutex<()>,
    pub(crate) running_jobs: std::sync::Mutex<BTreeSet<String>>,
    project: PathBuf,
    provider_points: BTreeMap<String, HookPoint>,
    sources: Mutex<Vec<Weak<Source>>>,
    identity: String,
    /// This plugin's hold on its Providers' credentials, made at install.
    credentials: Mutex<Option<CredentialClaim>>,
}
pub struct Remote {
    name: String,
    peer: Arc<Peer>,
    shared: Arc<Shared>,
    reaped: CancellationToken,
    sources: Vec<Arc<Source>>,
    runtime: Option<Arc<crate::runtime_host::RemoteRuntime>>,
}
pub async fn load(
    harness: &Arc<Harness>,
    launch: Launch,
    project: &Path,
    home: &Path,
    index: usize,
) -> Result<Arc<Remote>> {
    ExternalLaunch::Process(launch)
        .load(harness, project, home, index)
        .await
}

/// Load a plugin through connected streams, with the same host and registration checks.
pub async fn load_pipe(
    harness: &Arc<Harness>,
    pipe: tokio::io::DuplexStream,
    config: Value,
    project: &Path,
    home: &Path,
    index: usize,
) -> Result<Arc<Remote>> {
    load_transport(
        harness,
        Transport::Pipe(pipe),
        config,
        project,
        home,
        index,
        LoadOptions::default(),
    )
    .await
}

enum Transport {
    Process(Launch),
    Pipe(tokio::io::DuplexStream),
    Service(String, PathBuf),
}

async fn load_transport(
    harness: &Arc<Harness>,
    transport: Transport,
    config: Value,
    project: &Path,
    home: &Path,
    index: usize,
    options: LoadOptions,
) -> Result<Arc<Remote>> {
    tokio::fs::create_dir_all(home).await?;
    let project = project.canonicalize()?;
    let home = home.canonicalize()?;
    let api: Api = harness.clone();
    let shared = Arc::new(Shared {
        readiness: options.readiness,
        api: Arc::downgrade(&api),
        registration: Mutex::new(Value::Null),
        sessions: Mutex::default(),
        project: project.clone(),
        provider_points: harness.provider_points(),
        sources: Mutex::default(),
        identity: format!("external.{index}"),
        credentials: Mutex::default(),
        job_lock: Default::default(),
        running_jobs: Default::default(),
    });
    let callbacks = Arc::new(Callbacks(shared.clone()));
    let reaped = CancellationToken::new();
    let peer = match transport {
        Transport::Service(url, token_file) => {
            let interval = match std::env::var("MODULAR_AGENT_PLUGIN_IDLE_MS") {
                Ok(value) => value
                    .parse::<u64>()
                    .ok()
                    .filter(|&n| n > 0)
                    .map(Duration::from_millis)
                    .ok_or_else(|| {
                        anyhow!("MODULAR_AGENT_PLUGIN_IDLE_MS must be a positive integer")
                    })?,
                Err(std::env::VarError::NotPresent) => Duration::from_secs(30),
                Err(e) => return Err(e.into()),
            };
            let socket =
                transport_websocket::connect(&url, &token_file, transport_websocket::PLUGIN)
                    .await?;
            let (tx, rx) = tokio::sync::oneshot::channel();
            let done = reaped.clone();
            tokio::spawn(async move {
                transport_websocket::run(socket, CancellationToken::new(), |conn| async move {
                    let peer = Peer::websocket(conn, callbacks, false);
                    peer.monitor_liveness(interval, CONTROL);
                    if tx.send(peer.clone()).is_err() {
                        peer.close();
                    }
                    peer.finished.cancelled().await;
                })
                .await;
                done.cancel();
            });
            rx.await?
        }
        Transport::Pipe(pipe) => {
            let (read, write) = tokio::io::split(pipe);
            let peer = Peer::start(read, write, callbacks);
            let p = peer.clone();
            let done = reaped.clone();
            tokio::spawn(async move {
                p.finished.cancelled().await;
                done.cancel();
            });
            peer
        }
        Transport::Process(launch) => {
            let mut child = launch.spawn(&project)?;
            let peer = Peer::start(
                child.stdout.take().unwrap(),
                child.stdin.take().unwrap(),
                callbacks,
            );
            let p = peer.clone();
            let done = reaped.clone();
            tokio::spawn(async move {
                tokio::select! { _=p.closed.cancelled()=>(), _=child.wait()=>{p.close();} }
                if tokio::time::timeout(std::time::Duration::from_secs(5), child.wait())
                    .await
                    .is_err()
                {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                }
                p.finished.cancelled().await;
                done.cancel();
            });
            peer
        }
    };
    let registration =
        match initialize(&peer, &project, &home, config, !options.omit_trace_offer).await {
            Ok(r) => r,
            Err(e) => {
                peer.close();
                reaped.cancelled().await;
                return Err(e.into());
            }
        };
    let result: Result<Arc<Remote>> = async {
        validate_binding(&registration)?;
        let name = format!("external.{index}.{}", wire::string(&registration, "name")?);
        for field in ["providers", "toolSources", "hooks", "commands", "replaces"] {
            if let Some(value) = wire::optional(&registration, field) {
                ensure!(value.is_array(), "registration {field} must be an array");
            }
        }
        if let Some(readiness) = shared.readiness {
            readiness.validate(&registration)?;
        }
        if let Some(environment) = registration
            .get("workingEnvironment")
            .filter(|v| !v.is_null())
        {
            ensure!(
                environment.is_object(),
                "workingEnvironment must be an object"
            );
            ensure!(
                ["strong", "processGroup", "none"]
                    .contains(&wire::string(environment, "containment")?),
                "invalid containment"
            );
            ensure!(
                environment.get("platforms").is_none_or(|value| value
                    .as_array()
                    .is_some_and(|a| a.iter().all(Value::is_string))),
                "environment platforms must be a list of identifiers"
            );
        }
        for hook in registration["hooks"].as_array().into_iter().flatten() {
            ensure!(
                hook_name(wire::string(hook, "hook")?).is_some(),
                "not_supported: unknown hook {}",
                hook["hook"]
            );
            ensure!(hook["handlerId"].is_number(), "handlerId must be a number");
        }
        *shared.registration.lock().unwrap() = registration.clone();
        let mut sources = vec![];
        for source in registration["toolSources"].as_array().into_iter().flatten() {
            let tools = source["tools"]
                .as_array()
                .into_iter()
                .flatten()
                .map(wire::parse_definition)
                .collect::<Result<Vec<_>>>()?;
            sources.push(Arc::new(Source {
                id: wire::string(source, "id")?.into(),
                capability: format!("tools.{name}.{}", wire::string(source, "id")?),
                peer: peer.clone(),
                shared: shared.clone(),
                initial: tools,
                per_session: source["perSession"] == true,
                cache: Mutex::default(),
                refresh_lock: tokio::sync::Mutex::default(),
            }));
        }
        *shared.sources.lock().unwrap() = sources.iter().map(Arc::downgrade).collect();
        let runtime = registration
            .get("runtime")
            .filter(|v| !v.is_null())
            .map(|runtime| {
                wire::string(runtime, "id")?;
                ensure!(runtime["supports"].is_object(), "missing runtime supports");
                ensure!(
                    runtime["supports"]
                        .get("interfaceTools")
                        .is_none_or(Value::is_boolean),
                    "interfaceTools Runtime support must be a boolean"
                );
                let points = harness.runtime_points();
                ensure!(
                    !points.is_empty(),
                    "load the native Runtime hook points before external plugins"
                );
                Ok::<_, anyhow::Error>(Arc::new(crate::runtime_host::RemoteRuntime {
                    execution: crate::runtime_host::Execution::Remote(peer.clone()),
                    points,
                    registration: runtime.clone(),
                    ui_runtime: capability(harness.as_ref(), "runtime.transient").ok(),
                }))
            })
            .transpose()?;
        let plugin = Arc::new(Remote {
            name,
            peer: peer.clone(),
            shared: shared.clone(),
            reaped: reaped.clone(),
            sources,
            runtime,
        });
        let mut replaces: Vec<String> = serde_json::from_value(
            registration
                .get("replaces")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(json!([])),
        )?;
        if plugin.runtime.is_some() && !replaces.iter().any(|r| r == "runtime") {
            replaces.push("runtime".into());
        }
        // A replacement must actually provide the item it names.
        let mut seen = BTreeSet::new();
        for item in &replaces {
            ensure!(seen.insert(item), "duplicate replacement {item}");
            let matches = if item == "runtime" {
                plugin.runtime.is_some()
            } else if item == "working-environment" {
                registration["workingEnvironment"].is_object()
            } else if let Some(id) = item.strip_prefix("provider:") {
                registration["providers"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|p| p["id"] == id)
            } else if let Some(name) = item.strip_prefix("tool:") {
                plugin
                    .sources
                    .iter()
                    .any(|s| s.initial.iter().any(|t| t.name == name))
            } else if let Some(name) = item.strip_prefix("command:") {
                registration["commands"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|c| c["name"] == name)
            } else {
                false
            };
            ensure!(matches, "replacement {item} is not provided");
        }
        ensure!(
            !peer.closed.is_cancelled(),
            "plugin exited before registration"
        );
        harness.load_replacing(plugin.clone(), &replaces).await?;
        Ok(plugin)
    }
    .await;
    if let Err(error) = &result {
        let _ = control(
            &peer,
            "plugin/shutdown",
            json!({"reason":"refused","detail":error.to_string()}),
        )
        .await;
        peer.close();
        reaped.cancelled().await;
    }
    result
}
const CONTROL: Duration = Duration::from_secs(5);

async fn initialize(peer: &Peer, project: &Path, home: &Path, config: Value, offer: bool) -> Reply {
    let config = if config.is_null() { json!({}) } else { config };
    let mut params = json!({
        "binding":"modular-agent-plugin/1","data":"modular-agent-data/1",
        "host":{"name":"modular-agent-rs","version":env!("CARGO_PKG_VERSION")},
        "project":project,"home":home,"config":config
    });
    if offer {
        params["traceContext"] = json!(1);
    }
    let registration = control(peer, "plugin/initialize", params).await?;
    if let Some(name) = registration["name"].as_str() {
        peer.configure_trace(name, offer && registration["traceContext"] == 1, false);
    }
    Ok(registration)
}

fn validate_binding(registration: &Value) -> Result<()> {
    ensure!(
        registration["binding"] == "modular-agent-plugin/1",
        "not_supported: plugin binding"
    );
    Ok(())
}

async fn control(peer: &Peer, method: &str, params: Value) -> Reply {
    tokio::time::timeout(
        CONTROL,
        peer.call(method, params, None, CancellationToken::new()),
    )
    .await
    .unwrap_or_else(|_| Err(Fault::new("lost", "plugin control deadline expired")))
}

impl Remote {
    pub async fn shutdown(&self) -> Result<()> {
        if !self.peer.closed.is_cancelled() {
            let _ = control(&self.peer, "plugin/shutdown", json!({"reason":"stop"})).await;
            self.peer.close();
        }
        self.reaped.cancelled().await;
        Ok(())
    }
}
impl Plugin for Remote {
    fn name(&self) -> &str {
        &self.name
    }
    fn registered_name(&self) -> &str {
        self.name
            .splitn(3, '.')
            .nth(2)
            .expect("external plugin name")
    }
    fn stop(&self) -> Result<()> {
        self.peer.close();
        Ok(())
    }
    fn shutdown(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + '_>> {
        Box::pin(self.shutdown())
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        let registration = self.shared.registration.lock().unwrap().clone();
        let jobs = Arc::new(crate::jobs::RemoteJobs {
            peer: self.peer.clone(),
            shared: self.shared.clone(),
        });
        r.provide::<dyn ExternalJobs>(
            &format!(
                "external.jobs.{}.{}",
                self.shared.identity,
                wire::string(&registration, "name")?
            ),
            jobs.clone(),
        )?;
        r.on(
            "session.end",
            Order::First,
            handler(move |api, scope, _| {
                let jobs = jobs.clone();
                Box::pin(async move {
                    jobs.close_session(api, &scope.session).await?;
                    Ok(HookResult::default())
                })
            }),
        );
        // The plugin holds its own Providers' credentials and no others.
        let ids: Vec<&str> = registration["providers"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|provider| provider["id"].as_str())
            .collect();
        if !ids.is_empty() {
            *self.shared.credentials.lock().unwrap() = Some(r.claim_credentials(&ids)?);
        }
        for provider in registration["providers"].as_array().into_iter().flatten() {
            let id = wire::string(provider, "id")?.to_string();
            let models = provider["models"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|m| {
                    ensure!(
                        m["provider"] == id,
                        "model has a different Provider identity"
                    );
                    wire::model(m, &provider["supports"])
                })
                .collect::<Result<Vec<_>>>()?;
            let p = Arc::new(RemoteProvider {
                id: id.clone(),
                peer: self.peer.clone(),
                shared: self.shared.clone(),
                models: Arc::new(Mutex::new(models)),
                supports: provider["supports"].clone(),
                keeps_state: provider["supports"]["keepsState"] == true,
                dirty: Arc::default(),
            });
            r.provide::<dyn Provider>(&format!("provider.{id}"), p)?;
        }
        for source in &self.sources {
            r.provide::<dyn ToolSource>(
                &format!("tools.{}.{}", self.name, source.id),
                source.clone(),
            )?;
        }
        if let Some(runtime) = &self.runtime {
            for name in ["runtime", "runtime.transient", "runtime.durable"] {
                r.provide::<dyn Runtime>(name, runtime.clone())?;
            }
        }
        if registration["workingEnvironment"].is_object() {
            r.provide::<dyn WorkingEnvironment>(
                "environment",
                Arc::new(Environment {
                    peer: self.peer.clone(),
                    shared: self.shared.clone(),
                    declaration: registration["workingEnvironment"].clone(),
                    work: None,
                }),
            )?;
        }
        for h in registration["hooks"].as_array().into_iter().flatten() {
            let hook = wire::string(h, "hook")?.to_string();
            let order = match h["order"].as_str().unwrap_or("normal") {
                "first" => Order::First,
                "normal" => Order::Normal,
                "last" => Order::Last,
                _ => bail!("invalid hook order"),
            };
            r.on(
                hook_name(&hook).unwrap(),
                order,
                Arc::new(RemoteHandler {
                    peer: self.peer.clone(),
                    shared: self.shared.clone(),
                    hook,
                    handler_id: h["handlerId"].clone(),
                }),
            );
        }
        for c in registration["commands"].as_array().into_iter().flatten() {
            let name = wire::string(c, "name")?.to_string();
            let peer = self.peer.clone();
            let n = name.clone();
            r.command(&name,handler(move |api,scope,v| {let peer=peer.clone();let name=n.clone();Box::pin(async move {
                let cancel=api.cancellation(&scope.session)?;
                let out=peer.call("command/run",json!({"name":name,"args":v["args"],"sessionId":scope.session,"actorId":scope.actor}),Some(Work::new(&api,&scope,"command/run",cancel.clone())),cancel).await?;
                Ok(answer(out))
            })}))?;
        }
        let shared = self.shared.clone();
        let sources = self.sources.clone();
        r.on(
            "session.prepare",
            Order::First,
            handler(move |api, scope, _| {
                let shared = shared.clone();
                let sources = sources.clone();
                Box::pin(async move {
                    shared
                        .sessions
                        .lock()
                        .unwrap()
                        .insert(scope.session.clone(), scope.clone());
                    for source in sources {
                        if source.per_session {
                            source.refresh(&api, &scope).await?;
                        }
                    }
                    Ok(HookResult::default())
                })
            }),
        );
        let shared = self.shared.clone();
        r.on(
            "session.end",
            Order::Last,
            handler(move |_api, scope, _| {
                let shared = shared.clone();
                Box::pin(async move {
                    shared.sessions.lock().unwrap().remove(&scope.session);
                    Ok(HookResult::default())
                })
            }),
        );
        let mut declaration = json!({"external_plugins":{self.name.clone():registration}});
        if registration["hooks"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|h| h["hook"] == "output")
        {
            declaration["holds_output"] = json!(true);
            declaration["remote_output"] = json!(true);
        }
        r.declare(declaration);
        Ok(())
    }
}
struct Source {
    id: String,
    peer: Arc<Peer>,
    shared: Arc<Shared>,
    initial: Vec<ToolDefinition>,
    capability: String,
    per_session: bool,
    cache: Mutex<Views>,
    refresh_lock: tokio::sync::Mutex<()>,
}
#[derive(Default)]
struct Views {
    epoch: u64,
    global: u64,
    invalidated: BTreeMap<String, u64>,
    good: BTreeMap<String, (u64, Vec<ToolDefinition>)>,
}
impl Views {
    fn generation(&self, key: &str) -> u64 {
        self.global
            .max(self.invalidated.get(key).copied().unwrap_or(0))
    }
}
impl Source {
    fn key<'a>(&self, session: &'a str) -> &'a str {
        if self.per_session { session } else { "" }
    }
    fn invalidate(&self, session: Option<&str>) {
        let mut views = self.cache.lock().unwrap();
        views.epoch += 1;
        let epoch = views.epoch;
        match session.filter(|_| self.per_session) {
            Some(session) => {
                views.invalidated.insert(session.into(), epoch);
            }
            None => views.global = epoch,
        }
    }
    async fn refresh(&self, api: &Api, scope: &Scope) -> Result<()> {
        // Catalog invalidation survives turn cancellation. Bound the whole
        // barrier, including contention and refreshes superseded in flight.
        tokio::time::timeout(Duration::from_secs(5), async {
            let _refresh = self.refresh_lock.lock().await;
            let key = self.key(&scope.session);
            loop {
                let generation = {
                    let views = self.cache.lock().unwrap();
                    let generation = views.generation(key);
                    if views.good.get(key).is_some_and(|(v, _)| *v == generation)
                        || (!self.per_session && generation == 0)
                    {
                        return Ok(());
                    }
                    generation
                };
                let tools = self.fetch(api, scope).await?;
                let mut views = self.cache.lock().unwrap();
                if views.generation(key) == generation {
                    views.good.insert(key.to_owned(), (generation, tools));
                    return Ok(());
                }
            }
        })
        .await
        .map_err(|_| anyhow!("tools/list refresh timed out"))?
    }
    async fn fetch(&self, api: &Api, scope: &Scope) -> Result<Vec<ToolDefinition>> {
        let cancel = CancellationToken::new();
        let mut params = json!({"toolSource":self.id});
        if self.per_session {
            params["sessionId"] = json!(scope.session);
        }
        let list = self
            .peer
            .call(
                "tools/list",
                params,
                Some(Work::new(api, scope, "tools/list", cancel.clone())),
                cancel,
            )
            .await?;
        let tools = list["tools"]
            .as_array()
            .ok_or_else(|| anyhow!("tools/list needs tools"))?
            .iter()
            .map(wire::parse_definition)
            .collect::<Result<Vec<_>>>()?;
        let session = api.snapshot(&scope.session)?;
        let mut names = BTreeSet::new();
        for tool in &tools {
            ensure!(
                names.insert(tool.name.clone()),
                "duplicate changed tool {}",
                tool.name
            );
        }
        for key in api.capability_names("tools.") {
            if key == self.capability {
                continue;
            }
            for tool in capability::<dyn ToolSource>(api.as_ref(), &key)?.tools(&session) {
                ensure!(
                    names.insert(tool.name.clone()),
                    "duplicate changed tool {}",
                    tool.name
                );
            }
        }
        Ok(tools)
    }
}
#[async_trait]
impl ToolSource for Source {
    fn tools(&self, session: &SessionData) -> Vec<ToolDefinition> {
        let views = self.cache.lock().unwrap();
        let key = self.key(&session.id);
        let generation = views.generation(key);
        if let Some((version, tools)) = views.good.get(key) {
            if *version == generation {
                return tools.clone();
            }
        } else if generation == 0 {
            return self.initial.clone();
        }
        vec![]
    }
    async fn refresh_for_use(&self, api: &Api, scope: &Scope) {
        if let Err(error) = self.refresh(api, scope).await {
            let _ = api
                .emit(Event::new(
                    scope,
                    "tools.refresh_failed",
                    json!({"toolSource":self.id,"reason":error.to_string()}),
                ))
                .await;
        }
    }
    async fn run(
        &self,
        api: Api,
        scope: Scope,
        call: ToolCall,
        cancel: CancellationToken,
    ) -> ToolResult {
        let result:Result<ToolResult>=async {
            let definition=self.tools(&api.snapshot(&scope.session)?).into_iter().find(|d|d.name==call.name).ok_or_else(||anyhow!("tool is not registered"))?;
            let caller=match call.started_by.as_str() {"model"|"provider"=>"model","plugin"|"tool"=>"plugin",_=>"ui"};
            if !definition.allows(caller) {return Ok(ToolResult::new(&call,ToolStatus::Refused,"tool does not allow this caller"))}
            let project=api.snapshot(&scope.session)?.project;
            let work=Work::new(&api,&scope,"tools/call",cancel.clone());
            let stream=work.stream.clone();
            let reply=self.peer.call("tools/call",json!({"toolSource":self.id,"sessionId":scope.session,"project":project,"call":wire::call(&call,&scope)}),Some(work.clone()),cancel).await;
            let mut end=Event::new(&scope,"tool.stream.end",Value::Null);end.stream=Some(stream);end.end=true;api.emit(end).await?;
            refresh_changed(&self.shared, &api, &scope, &work).await;
            match reply {
                Ok(v)=>wire::parse_result(v,&call.id),
                Err(e)=>Ok(ToolResult::new(&call,if e.code=="lost" {ToolStatus::Unknown}else if e.code=="cancelled" {ToolStatus::Cancelled}else {ToolStatus::Failed},e.to_string())),
            }
        }.await;
        result.unwrap_or_else(|e| {
            ToolResult::new(
                &call,
                if e.downcast_ref::<Fault>().is_some_and(|e| e.code == "lost") {
                    ToolStatus::Unknown
                } else {
                    ToolStatus::Failed
                },
                e.to_string(),
            )
        })
    }
}
async fn refresh_changed(shared: &Shared, api: &Api, scope: &Scope, work: &Work) {
    let changed = std::mem::take(&mut *work.changed_tools.lock().unwrap());
    let sources = shared
        .sources
        .lock()
        .unwrap()
        .iter()
        .filter_map(Weak::upgrade)
        .collect::<Vec<_>>();
    for source in sources {
        if changed.contains(&source.id) {
            source.refresh_for_use(api, scope).await;
        }
    }
}
struct RemoteProvider {
    id: String,
    peer: Arc<Peer>,
    shared: Arc<Shared>,
    models: Arc<Mutex<Vec<ModelInfo>>>,
    supports: Value,
    keeps_state: bool,
    dirty: Arc<Mutex<BTreeSet<String>>>,
}
#[async_trait]
impl Provider for RemoteProvider {
    fn catalog(&self) -> Vec<ModelInfo> {
        self.models.lock().unwrap().clone()
    }
    fn bind(&self, name: &str) -> Result<Arc<dyn ModelAccess>> {
        let info = self
            .models
            .lock()
            .unwrap()
            .iter()
            .find(|m| m.name == name)
            .ok_or_else(|| anyhow!("unknown external model"))?
            .clone();
        Ok(Arc::new(RemoteModel {
            id: self.id.clone(),
            peer: self.peer.clone(),
            shared: self.shared.clone(),
            info,
            models: self.models.clone(),
            supports: self.supports.clone(),
            dirty: self.dirty.clone(),
        }))
    }
    fn invalidate(&self, session: &str) {
        self.dirty.lock().unwrap().insert(session.into());
    }
    async fn erase_binding_copies(
        &self,
        _api: Api,
        targets: &BTreeMap<String, Vec<String>>,
    ) -> Result<ProviderErasure> {
        let mut report = ProviderErasure::default();
        if !self.keeps_state {
            return Ok(report);
        }
        for (session, entry_ids) in targets {
            let answer = self
                .peer
                .call(
                    "provider/discard",
                    json!({"provider":self.id,"sessionId":session,"erase":true,"entryIds":entry_ids}),
                    None,
                    CancellationToken::new(),
                )
                .await?;
            report.out_of_reach.extend(
                answer["outOfReach"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_owned),
            );
            report.pending.extend(
                answer["pending"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .filter(|id| entry_ids.iter().any(|entry| entry == *id))
                    .map(str::to_owned),
            );
        }
        Ok(report)
    }
}
pub(crate) struct ProviderWork {
    payload: Value,
    info: ModelInfo,
    attempt: ModelAttempt,
    // Only the request callback can transition this phase to committed.
    phase: std::sync::atomic::AtomicU8,
    failure: Mutex<Option<Fault>>,
    response: Mutex<Option<Value>>,
}

struct RemoteModel {
    id: String,
    peer: Arc<Peer>,
    shared: Arc<Shared>,
    info: ModelInfo,
    models: Arc<Mutex<Vec<ModelInfo>>>,
    supports: Value,
    dirty: Arc<Mutex<BTreeSet<String>>>,
}
impl RemoteModel {
    async fn check_availability(
        &self,
        readiness: Option<ProviderReadiness>,
        cancel: CancellationToken,
    ) -> Result<()> {
        if let Some(reason) = provider_availability(&self.peer, &self.id, readiness, cancel).await?
        {
            bail!("{reason}");
        }
        Ok(())
    }
}

async fn provider_availability(
    peer: &Peer,
    id: &str,
    readiness: Option<ProviderReadiness>,
    cancel: CancellationToken,
) -> Result<Option<String>> {
    let call = peer.call("provider/available", json!({"provider":id}), None, cancel);
    let value = if let Some(readiness) = readiness {
        match tokio::time::timeout(readiness.guard, call).await {
            Ok(result) => result?,
            Err(_) => {
                peer.close();
                bail!(
                    "the {id} program did not answer provider/available within {:?}",
                    readiness.guard
                );
            }
        }
    } else {
        call.await?
    };
    match value["available"].as_bool() {
        Some(true) => Ok(None),
        Some(false) => Ok(Some(
            value["reason"]
                .as_str()
                .filter(|reason| !reason.is_empty())
                .unwrap_or_else(|| {
                    readiness.map_or("external Provider is unavailable", |check| check.fallback)
                })
                .to_owned(),
        )),
        None => bail!("invalid provider/available reply: expected a boolean available field"),
    }
}

#[async_trait]
impl ModelAccess for RemoteModel {
    fn safe_to_repeat(&self) -> bool {
        !self.info.keeps_state
            && !self.info.runs_tools
            && self.shared.registration.lock().unwrap()["providers"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|p| p["id"] == self.id && p["supports"]["safeToRepeat"] == true)
    }
    fn info(&self) -> ModelInfo {
        self.info.clone()
    }
    async fn discard(&self, session: &str) -> Result<()> {
        self.peer
            .call(
                "provider/discard",
                json!({"provider":self.id,"sessionId":session}),
                None,
                CancellationToken::new(),
            )
            .await?;
        Ok(())
    }
    async fn refresh(&self, api: &Api, scope: &Scope, cancel: CancellationToken) -> Result<()> {
        let readiness = self.shared.readiness.filter(|check| check.id == self.id);
        if let Some(check) = readiness {
            // The readiness probe can discover models. Read the catalog after it finishes.
            self.check_availability(Some(check), cancel.clone()).await?;
        }
        let method = "provider/models";
        let value = self
            .peer
            .call(
                method,
                json!({"provider":self.id}),
                Some(Work::new(api, scope, method, cancel.clone())),
                cancel.clone(),
            )
            .await?;
        let catalog = value["models"]
            .as_array()
            .ok_or_else(|| anyhow!("missing Provider catalog"))?;
        let mut ids = BTreeSet::new();
        let models = catalog
            .iter()
            .map(|model| {
                ensure!(
                    model["provider"] == self.id && ids.insert(wire::string(model, "id")?),
                    "invalid Provider catalog"
                );
                wire::model(model, &self.supports)
            })
            .collect::<Result<Vec<_>>>()?;
        *self.models.lock().unwrap() = models;
        ensure!(
            ids.contains(self.info.name.split_once('/').unwrap().1),
            "selected model is unavailable"
        );
        if readiness.is_none() {
            self.check_availability(None, cancel).await?;
        }
        Ok(())
    }
    async fn generate_attempt(
        &self,
        api: Api,
        scope: Scope,
        request: ModelRequest,
        cancel: CancellationToken,
        mut attempt: ModelAttempt,
    ) -> Result<ModelResponse> {
        if self.dirty.lock().unwrap().remove(&scope.session) {
            self.discard(&scope.session).await?;
        }
        self.refresh(&api, &scope, cancel.clone()).await?;
        attempt.safe_to_repeat &= self.safe_to_repeat();
        ensure!(
            attempt.replay.is_none() || attempt.safe_to_repeat,
            "Provider no longer permits exact repeat"
        );
        let data = api.snapshot(&scope.session)?;
        self.shared
            .sessions
            .lock()
            .unwrap()
            .insert(scope.session.clone(), scope.clone());
        let payload = json!({"provider":self.id,"model":wire::model_request_record(&self.info)["model"],
            "request":attempt.replay.clone().unwrap_or_else(|| wire::request_for_provider(&request,Some(&data),&self.id)),"sessionId":scope.session});
        let mut work = Work::new(&api, &scope, "provider/request", cancel.clone());
        Arc::get_mut(&mut work).unwrap().provider = Some(ProviderWork {
            payload: payload.clone(),
            info: self.info(),
            attempt,
            phase: 0.into(),
            failure: Mutex::default(),
            response: Mutex::default(),
        });
        let result = telemetry::inference(
            &scope,
            &self.info,
            telemetry::SpanKind::Client,
            true,
            |error: &anyhow::Error| {
                (!error.is::<ModelAttemptLimit>()).then_some("provider_request_failed")
            },
            async {
                let answer = self
                    .peer
                    .call("provider/request", payload, Some(work.clone()), cancel)
                    .await;
                let provider = work.provider.as_ref().unwrap();
                if let Some(fault) = provider.failure.lock().unwrap().take() {
                    return Err(fault.into());
                }
                let answer = answer?;
                ensure!(
                    provider.phase.load(Ordering::Acquire) == 2,
                    "Provider answered without an authorized request callback"
                );
                ensure!(
                    provider
                        .response
                        .lock()
                        .unwrap()
                        .as_ref()
                        .is_some_and(|message| same_json(message, &answer)),
                    "Provider answer differs from its response callback"
                );
                wire::parse_response(answer)
            },
        )
        .await;
        let mut end = Event::new(&scope, "model.end", Value::Null);
        end.stream = Some(work.stream.clone());
        end.end = true;
        api.emit(end).await?;
        refresh_changed(&self.shared, &api, &scope, &work).await;
        result
    }
    async fn generate(
        &self,
        _: Api,
        _: Scope,
        _: ModelRequest,
        _: CancellationToken,
    ) -> std::result::Result<ModelResponse, ModelFailure> {
        Err(ModelFailure {
            kind: FailureKind::Other,
            message: "Remote Provider needs an attempt checkpoint".into(),
        })
    }
}
struct Environment {
    peer: Arc<Peer>,
    shared: Arc<Shared>,
    declaration: Value,
    work: Option<Arc<Work>>,
}
impl Environment {
    fn context(&self, project: &Path) -> Result<(Api, Scope, CancellationToken)> {
        if let Some(work) = &self.work {
            return Ok((
                work.api.upgrade().ok_or_else(|| anyhow!("host closed"))?,
                work.scope.clone(),
                work.cancel.clone(),
            ));
        }
        let api = self
            .shared
            .api
            .upgrade()
            .ok_or_else(|| anyhow!("host closed"))?;
        let sessions = self.shared.sessions.lock().unwrap().clone();
        let matches = sessions
            .values()
            .filter(|s| {
                api.snapshot(&s.session)
                    .is_ok_and(|d| project.starts_with(&d.project))
            })
            .cloned()
            .collect::<Vec<_>>();
        ensure!(
            matches.len() == 1,
            "environment operation needs one unambiguous session"
        );
        let cancel = api.cancellation(&matches[0].session)?;
        Ok((api, matches[0].clone(), cancel))
    }
    async fn request(
        &self,
        method: &str,
        p: Value,
        api: Api,
        scope: Scope,
        cancel: CancellationToken,
    ) -> Reply {
        let project = api.snapshot(&scope.session)?.project;
        if project != self.shared.project {
            return Err(Fault::new(
                "invalid_request",
                "environment serves another project",
            ));
        }
        let cwd: PathBuf = serde_json::from_value(p["cwd"].clone())
            .map_err(|e| Fault::new("invalid_request", e))?;
        if !cwd.is_absolute()
            || !cwd
                .canonicalize()
                .is_ok_and(|path| path.starts_with(&project))
        {
            return Err(Fault::new(
                "invalid_request",
                "cwd is outside the environment project",
            ));
        }
        let work = Work::new(&api, &scope, method, cancel.clone());
        let reply = self
            .peer
            .call(
                method,
                {
                    let mut p = p;
                    p["sessionId"] = json!(scope.session);
                    p
                },
                Some(work.clone()),
                cancel,
            )
            .await;
        if method == "env/exec" {
            let mut end = Event::new(&scope, "tool.stream.end", Value::Null);
            end.stream = Some(work.stream.clone());
            end.end = true;
            api.emit(end).await?;
        }
        reply
    }
}
#[async_trait]
impl WorkingEnvironment for Environment {
    async fn session_ended(&self, session: &str) -> Result<()> {
        self.peer
            .call(
                "env/sessionEnded",
                json!({"sessionId":session}),
                None,
                CancellationToken::new(),
            )
            .await?;
        Ok(())
    }

    fn scoped(
        &self,
        api: Api,
        scope: Scope,
        cancel: CancellationToken,
    ) -> Option<Arc<dyn WorkingEnvironment>> {
        Some(Arc::new(Self {
            peer: self.peer.clone(),
            shared: self.shared.clone(),
            declaration: self.declaration.clone(),
            work: Some(Work::new(&api, &scope, "environment", cancel)),
        }))
    }
    fn declaration(&self) -> Value {
        let platform = match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            os => os,
        };
        let containment = self.declaration["platforms"]
            .as_array()
            .filter(|platforms| platforms.iter().any(|p| p == platform))
            .and_then(|_| self.declaration["containment"].as_str())
            .unwrap_or("none");
        json!({"containment":containment,"platforms":self.declaration["platforms"],"local":false,"rewinding":self.declaration["points"]==true,"confines_files":self.declaration["confinesFiles"]==true,"stops_commands_after_sigkill":containment=="strong","normal_cleanup":true})
    }
    async fn save_point(&self, session: &str, project: &Path) -> Result<String> {
        let api = self
            .shared
            .api
            .upgrade()
            .ok_or_else(|| anyhow!("host closed"))?;
        let result = self
            .request(
                "env/save",
                json!({"cwd":project}),
                api,
                Scope::session(session),
                CancellationToken::new(),
            )
            .await?;
        Ok(wire::string(&result, "point")?.to_owned())
    }
    async fn check_point(&self, session: &str, project: &Path, point: &str) -> Result<bool> {
        let api = self
            .shared
            .api
            .upgrade()
            .ok_or_else(|| anyhow!("host closed"))?;
        let result = self
            .request(
                "env/checkPoint",
                json!({"cwd":project,"point":point}),
                api,
                Scope::session(session),
                CancellationToken::new(),
            )
            .await?;
        result["exists"]
            .as_bool()
            .ok_or_else(|| anyhow!("invalid env/checkPoint reply"))
    }
    async fn restore_point(&self, session: &str, project: &Path, point: &str) -> Result<()> {
        let api = self
            .shared
            .api
            .upgrade()
            .ok_or_else(|| anyhow!("host closed"))?;
        self.request(
            "env/restore",
            json!({"cwd":project,"point":point}),
            api,
            Scope::session(session),
            CancellationToken::new(),
        )
        .await?;
        Ok(())
    }
    async fn read(&self, project: &Path, path: &str) -> Result<String> {
        Ok(String::from_utf8(self.read_bytes(project, path).await?)?)
    }
    async fn read_bytes(&self, project: &Path, path: &str) -> Result<Vec<u8>> {
        let (api, scope, cancel) = self.context(project)?;
        let v = self
            .request(
                "env/read",
                json!({"cwd":project,"path":path}),
                api,
                scope,
                cancel,
            )
            .await
            .map_err(|fault| {
                if fault.code == "not_found" {
                    // Normalize the wire code to the local environment's typed error.
                    anyhow::Error::from(std::io::Error::new(std::io::ErrorKind::NotFound, fault))
                } else if matches!(fault.code.as_str(), "not_supported" | "method_not_found") {
                    std::io::Error::new(std::io::ErrorKind::Unsupported, fault).into()
                } else {
                    fault.into()
                }
            })?;
        Ok(BASE64_STANDARD.decode(wire::string(&v, "data")?)?)
    }
    async fn write(&self, project: &Path, path: &str, text: &str) -> Result<()> {
        self.write_bytes(project, path, text.as_bytes()).await
    }
    async fn write_bytes(&self, project: &Path, path: &str, bytes: &[u8]) -> Result<()> {
        let (api, scope, cancel) = self.context(project)?;
        self.request(
            "env/write",
            json!({"cwd":project,"path":path,"data":BASE64_STANDARD.encode(bytes)}),
            api,
            scope,
            cancel,
        )
        .await?;
        Ok(())
    }
    async fn exists(&self, project: &Path, path: &str) -> Result<bool> {
        let (api, scope, cancel) = self.context(project)?;
        Ok(self
            .request(
                "env/exists",
                json!({"cwd":project,"path":path}),
                api,
                scope,
                cancel,
            )
            .await?["exists"]
            == true)
    }
    async fn list_dir(&self, project: &Path, path: &str) -> Result<Vec<String>> {
        let (api, scope, cancel) = self.context(project)?;
        let v = self
            .request(
                "env/list",
                json!({"cwd":project,"path":path}),
                api,
                scope,
                cancel,
            )
            .await
            .map_err(|fault| {
                if fault.code == "not_found" {
                    anyhow::Error::from(std::io::Error::new(std::io::ErrorKind::NotFound, fault))
                } else if matches!(fault.code.as_str(), "not_supported" | "method_not_found") {
                    // An edition 3 environment: the caller falls back to a command.
                    std::io::Error::new(std::io::ErrorKind::Unsupported, fault).into()
                } else {
                    fault.into()
                }
            })?;
        wire::dir_names(&v["entries"])
    }
    async fn edit(&self, project: &Path, path: &str, old: &str, new: &str) -> Result<()> {
        let text = self.read(project, path).await?;
        ensure!(
            !old.is_empty() && text.matches(old).count() == 1,
            "edit must match exactly once"
        );
        self.write(project, path, &text.replacen(old, new, 1)).await
    }
    async fn bash(
        &self,
        api: Api,
        scope: Scope,
        project: PathBuf,
        command: &str,
        cancel: CancellationToken,
    ) -> Result<ToolResult> {
        self.exec(api, scope, project, command, None, cancel).await
    }
    /// The deadline goes to the environment, which is where the command runs.
    async fn exec(
        &self,
        api: Api,
        scope: Scope,
        project: PathBuf,
        command: &str,
        timeout: Option<Duration>,
        cancel: CancellationToken,
    ) -> Result<ToolResult> {
        let mut params = json!({"cwd":project,"command":command});
        if let Some(limit) = timeout.filter(|limit| !limit.is_zero()) {
            params["timeoutMs"] = json!((limit.as_millis() as u64).max(1));
        }
        let v = self
            .request("env/exec", params, api, scope.clone(), cancel.clone())
            .await;
        let v = match v {
            Ok(v) => v,
            Err(e) if e.code == "lost" => {
                return Err(LostPart(format!("environment {}: {e}", self.shared.identity)).into());
            }
            Err(e) if e.code == "cancelled" => {
                return Ok(ToolResult {
                    call: scope.call.unwrap_or_default(),
                    status: ToolStatus::Cancelled,
                    text: e.to_string(),
                    value: None,
                });
            }
            Err(e) => return Err(e.into()),
        };
        Ok(ToolResult {
            call: scope.call.unwrap_or_default(),
            status: if cancel.is_cancelled() {
                ToolStatus::Cancelled
            } else if v["exitCode"] == 0 && v["timedOut"] != true {
                ToolStatus::Completed
            } else {
                ToolStatus::Failed
            },
            text: v["output"].as_str().unwrap_or("").into(),
            value: Some(if v["timedOut"] == true {
                json!({"exit_code":v["exitCode"],"timed_out":true})
            } else {
                json!({"exit_code":v["exitCode"]})
            }),
        })
    }
}
pub fn hook_name(name: &str) -> Option<&'static str> {
    Some(match name {
        "plugin.load" => "plugin.load",
        "output" => "output.stream",
        "session.start" => "session.start",
        "session.end" => "session.end",
        "input" => "input",
        "turn.before" => "before.turn",
        "turn.start" => "runtime.turn.start",
        "step.before" => "runtime.before.step",
        "step.after" => "runtime.after.step",
        "tool.before" => "runtime.before.tool",
        "tool.after" => "runtime.after.tool",
        "model.failed" => "runtime.model.failed",
        "turn.result" => "runtime.result.ready",
        "turn.end" => "runtime.turn.end",
        "provider.request" => "provider.request",
        "provider.response" => "provider.response",
        _ => return None,
    })
}
struct RemoteHandler {
    peer: Arc<Peer>,
    shared: Arc<Shared>,
    hook: String,
    handler_id: Value,
}
#[async_trait]
impl Handler for RemoteHandler {
    async fn handle(&self, api: Api, scope: Scope, value: Value) -> Result<HookResult> {
        let payload = hook_payload(&self.hook, &scope, &value, &api)?;
        let cancel = if self.hook == "output" {
            CancellationToken::new()
        } else {
            api.cancellation(&scope.session).unwrap_or_default()
        };
        let work = Work::new(
            &api,
            &scope,
            if self.hook == "output" {
                "hook/output"
            } else {
                "hook/handle"
            },
            cancel.clone(),
        );
        let result = self
            .peer
            .call(
                "hook/handle",
                json!({"handlerId":self.handler_id,"hook":self.hook,"payload":payload}),
                Some(work.clone()),
                cancel,
            )
            .await;
        if self.hook != "output" && !scope.session.is_empty() {
            refresh_changed(&self.shared, &api, &scope, &work).await;
        }
        let reply = match result {
            Ok(reply) => reply,
            Err(e) if self.hook == "output" => {
                eprintln!("plugin output gate blocked delivery: {e}");
                return Ok(HookResult {
                    stopped: true,
                    ..answer(Value::Null)
                });
            }
            Err(e)
                if [
                    "session.start",
                    "session.end",
                    "turn.start",
                    "turn.end",
                    "provider.response",
                ]
                .contains(&self.hook.as_str()) =>
            {
                eprintln!("plugin observer {} failed: {e}", self.hook);
                return Ok(HookResult::default());
            }
            Err(e) => return Err(e.into()),
        };
        ensure!(
            self.hook != "step.before" || reply["value"].get("providerTools").is_none(),
            "a served step.before handler cannot change Provider tools"
        );
        hook_result(&self.hook, &scope, value, reply)
    }
}
pub fn hook_payload(hook: &str, s: &Scope, v: &Value, api: &Api) -> Result<Value> {
    if hook == "output" {
        return Ok(v.clone());
    }
    let mut p = json!({"sessionId":s.session,"actorId":s.actor,"turnId":s.turn,"stepId":s.step});
    match hook {
        "plugin.load" => {
            p["name"] = v["plugin"].clone();
            p["origin"] = v.get("origin").cloned().unwrap_or(json!("global"));
            p["project"] = v["project"].clone();
        }
        "input" => {
            p["content"] = v
                .get("content")
                .cloned()
                .unwrap_or_else(|| json!([{"type":"text","text":v["text"]}]));
            p["when"] = v["timing"].clone();
        }
        "turn.before" => {
            p["input"] = v
                .get("content")
                .cloned()
                .unwrap_or_else(|| json!([{"type":"text","text":v["input"]}]));
        }
        "step.before" => {
            let request: ModelRequest = serde_json::from_value(v["request"].clone())?;
            p["request"] = wire::request(&request, Some(&api.snapshot(&s.session)?));
            p["model"] = wire::model_value(&serde_json::from_value(v["limits"].clone())?);
        }
        "step.after" => {
            p["response"] = wire::response(&serde_json::from_value(v["response"].clone())?)
        }
        "tool.before" => {
            p["call"] = wire::call(&serde_json::from_value(v["call"].clone())?, s);
            p["definition"] = wire::definition(&serde_json::from_value(v["definition"].clone())?);
        }
        "tool.after" => {
            let result: ToolResult = serde_json::from_value(v.clone())?;
            p["result"] = wire::result(&result);
            p["call"] = api
                .snapshot(&s.session)?
                .entries
                .iter()
                .rev()
                .find(|e| e.kind == "tool.call" && e.scope.call == s.call)
                .and_then(|e| e.content.as_ref())
                .and_then(|v| serde_json::from_value::<ToolCall>(v.clone()).ok())
                .map(|c| wire::call(&c, s))
                .unwrap_or(Value::Null);
        }
        "model.failed" => {
            p["error"] = v["failure"].clone();
            p["error"]["kind"] = json!(match v["failure"]["kind"].as_str() {
                Some("context_too_large") => "contextTooLarge",
                Some(s) => s,
                None => "other",
            });
            p["request"] = wire::request(&serde_json::from_value(v["request"].clone())?, None);
        }
        "turn.result" => {
            p["result"] = json!({"text":v["text"]});
            if let Some(value) = v.get("value") {
                p["result"]["value"] = value.clone();
            }
            p["shape"] = v["shape"].clone();
        }
        "turn.end" => merge(
            &mut p,
            wire::turn_outcome(&serde_json::from_value(v.clone())?),
        ),
        "provider.request" | "provider.response" => {
            let mut v = v.clone();
            if v["model"]["context_window"].is_number() {
                v["model"] = wire::model_value(&serde_json::from_value(v["model"].clone())?);
            }
            if hook == "provider.request" && v["request"]["system"].is_string() {
                v["request"] = wire::request(
                    &serde_json::from_value(v["request"].clone())?,
                    Some(&api.snapshot(&s.session)?),
                );
            }
            if hook == "provider.response" && v["message"]["parts"].is_array() {
                v["message"] = wire::response(&serde_json::from_value(v["message"].clone())?);
            }
            return Ok(v);
        }
        "session.start" => p["resumed"] = json!(v["resumed"] == true),
        _ => (),
    }
    Ok(p)
}
pub fn hook_result(hook: &str, s: &Scope, mut original: Value, reply: Value) -> Result<HookResult> {
    if reply.is_null() {
        return Ok(HookResult::default());
    }
    if let Some(reason) = reply["refuse"].as_str() {
        return Ok(HookResult {
            refused: Some(reason.into()),
            ..HookResult::default()
        });
    }
    if reply["pending"].is_string() {
        return Ok(HookResult {
            suspended: true,
            ..HookResult::default()
        });
    }
    match hook {
        "output" => {
            if reply["block"] == true || !reply["events"].is_array() {
                Ok(HookResult {
                    stopped: true,
                    ..answer(Value::Null)
                })
            } else {
                original["events"] = reply["events"].clone();
                Ok(answer(original))
            }
        }
        "turn.before" => Ok(answer(reply)),
        "turn.result" => {
            // A refusal at this point is feedback; an absent answer accepts.
            ensure!(reply["accept"] == true, "invalid turn.result answer");
            Ok(HookResult::default())
        }
        "step.before" => {
            let v = &reply["value"];
            let mut request = wire::parse_request(&v["request"], &s.session)?;
            let prior: ModelRequest = serde_json::from_value(original["request"].clone())?;
            request.provider_tools = prior.provider_tools;
            if let Some(tools) = v.get("providerTools") {
                // Only the local SDK adapter adds this field to its hook envelope.
                let offered = request
                    .provider_tools
                    .iter()
                    .map(wire::definition)
                    .collect::<Vec<_>>();
                let tools = tools
                    .as_array()
                    .ok_or_else(|| anyhow!("invalid Provider-tool allowance"))?;
                let mut names = std::collections::BTreeSet::new();
                ensure!(
                    tools.iter().all(|tool| {
                        tool["name"].as_str().is_some_and(|name| names.insert(name))
                            && offered.iter().any(|old| wire::json_eq(old, tool))
                    }),
                    "step.before cannot widen the Provider-tool allowance"
                );
                request.provider_tools = tools
                    .iter()
                    .map(wire::parse_definition)
                    .collect::<Result<_>>()?;
            }
            original["request"] = json!(request);
            Ok(answer(original))
        }
        "tool.before" => {
            if !reply["change"].is_null() {
                original["call"] = json!(wire::parse_call(&reply["change"]["call"])?);
                Ok(answer(original))
            } else {
                Ok(HookResult::default())
            }
        }
        "tool.after" => Ok(answer(json!(wire::parse_result(
            reply["value"]["result"].clone(),
            s.call.as_deref().unwrap_or("")
        )?))),
        "input" => {
            let content = &reply["value"]["content"];
            wire::parts(content)?;
            original["text"] = json!(wire::text(content));
            original["content"] = content.clone();
            Ok(HookResult {
                stopped: reply["stop"] == true,
                ..answer(original)
            })
        }
        "provider.request" => {
            let mut value = reply["value"].clone();
            if original["request"]["system"].is_string() {
                let prior: ModelRequest = serde_json::from_value(original["request"].clone())?;
                let mut request = wire::parse_request(&value["request"], &s.session)?;
                request.provider_tools = prior.provider_tools;
                value["request"] = json!(request);
                value["model"] = original["model"].clone();
            }
            Ok(HookResult {
                stopped: reply["stop"] == true,
                ..answer(value)
            })
        }
        "model.failed" => {
            let mut reply = reply;
            if reply["request"].is_object() {
                reply["request"] = json!(wire::parse_request(&reply["request"], &s.session)?);
            }
            Ok(answer(reply))
        }
        _ => Ok(HookResult::default()),
    }
}
struct Callbacks(Arc<Shared>);
impl Callbacks {
    fn scope(&self, peer: &Peer, p: &Value) -> Result<(Api, Scope, Option<Arc<Work>>)> {
        let context = self.capture_scope(peer, p)?;
        context.0.snapshot(&context.1.session)?;
        Ok(context)
    }

    fn capture_scope(&self, peer: &Peer, p: &Value) -> Result<(Api, Scope, Option<Arc<Work>>)> {
        let work = if !p["parentRequestId"].is_null() {
            Some(
                peer.parent(&p["parentRequestId"])
                    .ok_or_else(|| anyhow!("unknown parent request"))?,
            )
        } else {
            None
        };
        let scope = if let Some(w) = &work {
            if let Some(session) = p["sessionId"].as_str() {
                ensure!(session == w.scope.session, "session does not match parent");
            }
            w.scope.clone()
        } else {
            let session = wire::string(p, "sessionId")?;
            self.0
                .sessions
                .lock()
                .unwrap()
                .get(session)
                .cloned()
                .ok_or_else(|| anyhow!("plugin has no access to session"))?
        };
        let api = work
            .as_ref()
            .and_then(|w| w.api.upgrade())
            .or_else(|| self.0.api.upgrade())
            .ok_or_else(|| anyhow!("host closed"))?;
        Ok((api, scope, work))
    }

    async fn serve_request(
        &self,
        peer: Arc<Peer>,
        id: Value,
        method: &str,
        p: Value,
        cancel: CancellationToken,
    ) -> Reply {
        if cancel.is_cancelled() {
            return Err(Fault::new("cancelled", "host request cancelled"));
        }
        let known = matches!(
            method,
            "host/credentials/read"
                | "host/declaration"
                | "host/ask"
                | "host/hook"
                | "host/history"
                | "host/session"
                | "host/env/read"
                | "host/env/write"
                | "host/env/exists"
                | "host/env/exec"
                | "host/env/list"
                | "host/tools/list"
                | "host/tools/call"
                | "host/jobs/start"
                | "host/jobs/end"
                | "host/jobs/unfinished"
                | "host/jobs/resume"
                | "host/runtime/newId"
                | "host/runtime/prepareStep"
                | "host/runtime/model"
                | "host/runtime/hook"
                | "host/runtime/definition"
                | "host/runtime/runToolCall"
                | "host/runtime/record"
                | "host/runtime/takeSteering"
                | "host/runtime/hasSteering"
        );
        if !known {
            return Err(Fault::unknown(method));
        }
        let result:Result<Value>=async {
            if method=="host/credentials/read" {
                ensure!(p["sessionId"].is_null() && p["parentRequestId"].is_null(), "credentials name neither a session nor a parent");
                let provider=wire::string(&p,"provider")?;
                ensure!(self.0.registration.lock().unwrap()["providers"].as_array().into_iter().flatten().any(|v|v["id"]==provider),"provider not registered by this plugin");
                let api=self.0.api.upgrade().ok_or_else(||anyhow!("host closed"))?;
                let claim=self.0.credentials.lock().unwrap().clone().ok_or_else(||anyhow!("no credential registered"))?;
                let credential=capability::<dyn CredentialStore>(api.as_ref(),"credentials")?.provider(&claim,provider).ok().map(|key|json!({"type":"apiKey","key":key}));
                return Ok(json!({"credential":credential}))
            }
            if method=="host/declaration"&&p["sessionId"].is_null()&&p["parentRequestId"].is_null() {
                let api=self.0.api.upgrade().ok_or_else(||anyhow!("host closed"))?;
                return interface_acp::declaration(api.as_ref(),None)
            }
            if ["host/history","host/session"].contains(&method) || method.starts_with("host/env/") {
                wire::string(&p, "sessionId")?;
            }
            if method.starts_with("host/jobs/") {
                return crate::jobs::RemoteJobs { peer: peer.clone(), shared: self.0.clone() }.request(method, &p).await;
            }
            let (api,scope,work)=self.scope(&peer,&p)?;
            let runtime = work.as_ref().and_then(|w|w.runtime.clone());
            if method.starts_with("host/runtime/") { ensure!(runtime.is_some(),"Runtime callback requires a turn parent"); }
            if let Some(rt) = &runtime {
                rt.active()?;
                ensure!(method.starts_with("host/runtime/") || ["host/history","host/session","host/declaration"].contains(&method), "a Runtime may not bypass its host port");
            }
            let parent_cancel=work.as_ref().map(|w|w.cancel.clone()).unwrap_or_default();
            // Signal cooperative work on parent cancellation without preventing the
            // Runtime from making cleanup callbacks, such as recording turnEnd.
            let token=cancel.child_token();
            if parent_cancel.is_cancelled() && !matches!(method,
                "host/history" | "host/session" | "host/declaration" | "host/env/read" | "host/env/exists"
                | "host/env/list" | "host/tools/list" | "host/runtime/record") && !(method == "host/runtime/hook" && p["hook"] == "turn.end") {
                return Err(Fault::new("cancelled", "parent is cancelled").into());
            }
            let run=async {
                match method {
                    m if m.starts_with("host/runtime/")=> runtime.unwrap().callback(&api,work.as_ref().unwrap(),crate::runtime_host::Callback{peer:Some(peer.clone()),id,method:m,params:&p},token.clone()).await,
                    m if m.starts_with("host/env/")=>{
                        ensure!(work.is_some(),"environment calls require parentRequestId");
                        require(api.as_ref(),&scope,"tools")?;
                        let cwd=Path::new(wire::string(&p,"cwd")?);
                        let project=api.snapshot(&scope.session)?.project;
                        ensure!(cwd.is_absolute()&&cwd.starts_with(&project)&&!cwd.components().any(|c|c==std::path::Component::ParentDir),"cwd outside session project");
                        if let Ok(real)=cwd.canonicalize(){ensure!(real.starts_with(&project),"cwd outside session project");}
                        let env:Arc<dyn WorkingEnvironment>=capability(api.as_ref(),"environment")?;
                        let env=env.scoped(api.clone(),scope.clone(),token.clone()).unwrap_or(env);
                        let method=m.trim_start_matches("host/");
                        match method {
                            "env/read"=>Ok(json!({"data":BASE64_STANDARD.encode(env.read_bytes(cwd,wire::string(&p,"path")?).await?)})),
                            "env/write"=>{env.write_bytes(cwd,wire::string(&p,"path")?,&BASE64_STANDARD.decode(wire::string(&p,"data")?)?).await?;Ok(json!({}))}
                            "env/exists"=>Ok(json!({"exists":env.exists(cwd,wire::string(&p,"path")?).await?})),
                            "env/list"=>match env.list_dir(cwd,wire::string(&p,"path")?).await {
                                Ok(names)=>Ok(json!({"entries":wire::dir_entries(&names)})),
                                Err(error) if error.downcast_ref::<std::io::Error>().is_some_and(|e|e.kind()==std::io::ErrorKind::Unsupported)=>Err(Fault::new("not_supported","the environment does not list directories").into()),
                                Err(error) if error.downcast_ref::<std::io::Error>().is_some_and(|e|e.kind()==std::io::ErrorKind::NotADirectory)=>Err(Fault::new("invalid_request","not a directory").into()),
                                Err(error)=>Err(error),
                            },
                            "env/exec"=>{
                                let relay:Api=Arc::new(crate::relay::Relay{inner:api.clone(),peer:peer.clone(),id,route:crate::relay::Route::Environment});
                                // Zero is no limit, including when routing to a local environment.
                                let limit=p["timeoutMs"].as_u64().filter(|ms| *ms > 0).map(Duration::from_millis);
                                let r=env.exec(relay,scope.clone(),cwd.to_path_buf(),wire::string(&p,"command")?,limit,token.clone()).await?;
                                let timed_out=r.value.as_ref().is_some_and(|v|v["timed_out"]==true);
                                if token.is_cancelled(){bail!("cancelled");}
                                Ok(json!({"exitCode":r.value.map(|v|v["exit_code"].clone()).unwrap_or(Value::Null),"output":r.text,"timedOut":timed_out}))
                            }
                            _=>bail!("unknown host environment method"),
                        }
                    }
                    "host/tools/list" | "host/tools/call"=>{
                        // Nested calls: only under the tool source's own live, dispatched call.
                        let work=work.ok_or_else(||Fault::new("invalid_request","nested calls require parentRequestId"))?;
                        if work.method!="tools/call" || scope.call.is_none() {
                            return Err(Fault::new("invalid_request","nested calls belong under a tools/call").into());
                        }
                        let data=api.snapshot(&scope.session)?;
                        let runtime=session_runtime(api.as_ref(),&data)?;
                        if runtime.declaration()["nested_tools"]!=true {
                            return Err(Fault::new("not_supported","this host does not run nested calls").into());
                        }
                        if method=="host/tools/list" {
                            let tools:Vec<Value>=nested_tool_definitions(api.as_ref(),&data)?.iter().map(wire::definition).collect();
                            return Ok(json!({"tools":tools}));
                        }
                        let name=p["name"].as_str().filter(|n|!n.is_empty()).ok_or_else(||Fault::new("invalid_request","name must be a tool name"))?;
                        if !p["input"].is_object() {
                            return Err(Fault::new("invalid_request","input must be an object").into());
                        }
                        let nested=ToolCall::new(name,p["input"].clone());
                        let result=runtime.nested_tool(api.clone(),scope.clone(),nested,token.clone()).await?;
                        Ok(wire::result(&result))
                    }
                    "host/hook"=>{
                        let work=work.ok_or_else(||anyhow!("hook requires parent"))?;
                        ensure!(work.method=="provider/request","plugin does not own these hook points");
                        let hook=wire::string(&p,"hook")?;
                        ensure!(["provider.request","provider.response"].contains(&hook),"plugin does not own this hook");
                        let provider = work.provider.as_ref().ok_or_else(|| anyhow!("missing Provider attempt"))?;
                        let payload = &p["payload"];
                        for key in ["provider", "model", "sessionId"] {
                            ensure!(same_json(&payload[key], &provider.payload[key]), "Provider hook changed {key}");
                        }
                        if hook == "provider.request" {
                            ensure!(same_json(payload, &provider.payload), "request differs from the original");
                            ensure!(provider.phase.compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire).is_ok(),
                                "repeated Provider request callback");
                            let checkpoint: Result<Value> = async {
                                let mut value = provider.payload.clone();
                                if provider.attempt.replay.is_none() {
                                    let transformed = api.invoke(&self.0.provider_points[hook], &scope, value.clone()).await
                                        .map_err(|e| Fault::new("internal", e))?;
                                    for key in ["provider", "model", "sessionId"] {
                                        ensure!(same_json(&transformed.value[key], &value[key]), "Provider transform changed {key}");
                                    }
                                    value["request"] = transformed.value["request"].clone();
                                }
                                let request = wire::parse_request(&value["request"], &scope.session)?;
                                let mut attempt = provider.attempt.clone();
                                // Preserve transformed wire fields in the recorded intent as sent.
                                attempt.authorized_wire = Some(value["request"].clone());
                                attempt.authorize(api.as_ref(), &scope, &provider.info, &request, &token)?;
                                Ok(value)
                            }.await;
                            match checkpoint {
                                Ok(value) => {
                                    provider.phase.store(2, Ordering::Release);
                                    Ok(value)
                                }
                                Err(e) => {
                                    let fault = if let Some(limit) = e.downcast_ref::<ModelAttemptLimit>() {
                                        Fault { limit: Some(limit.0.into()), ..Fault::new("turn_limit", limit) }
                                    } else if let Some(fault) = e.downcast_ref::<Fault>() {
                                        fault.clone()
                                    } else if token.is_cancelled() {
                                        Fault::new("cancelled", e)
                                    } else if e.downcast_ref::<LostPart>().is_some() {
                                        Fault::new("lost", e)
                                    } else {
                                        Fault::new("invalid_request", e)
                                    };
                                    *provider.failure.lock().unwrap() = Some(fault.clone());
                                    Err(fault.into())
                                }
                            }
                        } else {
                            ensure!(provider.phase.load(Ordering::Acquire) == 2, "Provider attempt not committed");
                            ensure!(payload.is_object() && payload.get("sessionId").is_some()
                                && payload["message"]["role"] == "assistant", "missing Provider response fields");
                            wire::parse_response(payload["message"].clone())?;
                            let projected = json!({"sessionId":payload["sessionId"],"provider":payload["provider"],
                                "model":payload["model"],"message":payload["message"]});
                            {
                                let mut response = provider.response.lock().unwrap();
                                ensure!(response.is_none(), "repeated Provider response callback");
                                *response = Some(payload["message"].clone());
                            }
                            api.invoke(&self.0.provider_points[hook], &scope, projected).await?;
                            Ok(Value::Null)
                        }
                    }
                    "host/ask"=>{
                        let work=work.ok_or_else(||anyhow!("ask requires parent"))?;
                        let draft=&p["request"];
                        let kind=match wire::string(draft,"kind")? {"approval"=>RequestKind::Approval,"choice"=>RequestKind::Choice,"text"|"link"=>RequestKind::Text,"secret"=>RequestKind::Secret,_=>bail!("unknown question kind")};
                        let mut q=Question::new(scope.clone(),kind,wire::string(draft,"question")?);
                        q.extra=draft.clone();
                        if let Some(fields)=q.extra.as_object_mut() {
                            for field in ["details","options","timeLimitMs","key","whenTimeLimit","credential"] {
                                if fields.get(field).is_some_and(Value::is_null) {
                                    fields.remove(field);
                                }
                            }
                        }
                        if q.kind == RequestKind::Approval {
                            // The caller cannot substitute a different call for the actor to approve.
                            q.extra.as_object_mut().unwrap().remove("approvalCall");
                            if work.method == "tools/call" && scope.call.is_some()
                                && let Some(call) = api.snapshot(&scope.session)?.entries.iter().rev()
                                    .find(|e| e.kind == "tool.call" && e.scope.call == scope.call)
                                    .and_then(|e| serde_json::from_value::<ToolCall>(e.content.clone()?).ok())
                            {
                                q.extra["approvalCall"] = wire::call(&call, &scope);
                            }
                        }
                        q.options=serde_json::from_value(wire::optional(draft,"options").cloned().unwrap_or(json!([])))?;
                        q.credential=draft["credential"].as_str().map(str::to_string);
                        q.timeout_ms=draft["timeLimitMs"].as_u64();
                        if draft["whenTimeLimit"] == "leaveOpen" {
                            if api.declaration()?["questions_outlast_turn"] != true {
                                return Err(Fault::new("not_supported", "this agent does not leave questions open").into());
                            }
                            ensure!(q.kind != RequestKind::Approval && q.timeout_ms.is_some_and(|ms| ms <= 9_007_199_254_740_991), "leaveOpen needs a representable wait and a non-approval question");
                        }
                        let n = work.asks.fetch_add(1,Ordering::Relaxed) + 1;
                        q.key = draft["key"].as_str().map(str::to_owned)
                            .or_else(||scope.call.as_ref().map(|call|format!("call:{call}:{n}")));
                        let question_key=q.key.clone();
                        let service=requests(api.as_ref())?;
                        let reply=service.ask(api.clone(),q,token.clone()).await?;
                        let request_id=questions(&api.snapshot(&scope.session)?)?.into_iter().rev().find(|q|q.key==question_key).map(|q|q.id).unwrap_or_default();
                        let reply=match reply {
                            RequestReply::Answer(a)=>json!({"requestId":a.request,"actorId":a.actor,"value":if a.value.get("credential").is_some(){Value::Null}else{a.value.clone()},"declined":a.declined,"stored":a.value.get("credential")}),
                            RequestReply::Declined=>json!({"requestId":request_id,"actorId":scope.actor,"declined":true}),
                            RequestReply::Waiting=>json!({"requestId":request_id,"actorId":scope.actor,"pending":true}),
                        };
                        Ok(reply)
                    }
                    "host/history"=>{
                        require(api.as_ref(),&scope,"watch")?;
                        let data=api.snapshot(&scope.session)?;
                        let mut entries=if p["all"]==true {data.entries.clone()}else{data.branch()};
                        entries.retain(|e|e.writer!="rust.derived");
                        let start=if wire::optional(&p,"after").is_some() {
                            let after = wire::string(&p, "after")?;
                            entries.iter().position(|e|e.id==after).ok_or_else(||anyhow!("unknown history cursor"))?+1
                        } else {0};
                        let limit=match wire::optional(&p,"limit") {
                            None => 500,
                            Some(v) => v.as_u64().filter(|n| (1..=500).contains(n)).ok_or_else(||anyhow!("limit must be an integer from 1 to 500"))? as usize,
                        };
                        ensure!(wire::optional(&p,"all").is_none_or(Value::is_boolean), "all must be a boolean");
                        let mut page=vec![];
                        let mut size=b"{\"entries\":[]}".len();
                        for (i,e) in entries.iter().enumerate().skip(start).take(limit) {
                            let mut v=wire::entry(e,&data)?;
                            portable::omit_trace_metadata(&mut v);
                            let n=serde_json::to_vec(&v)?.len();
                            let cursor_size=if i+1<entries.len() {b",\"next\":".len()+serde_json::to_vec(&e.id)?.len()}else{0};
                            let total=size+n+usize::from(!page.is_empty());
                            if total+cursor_size>4*1024*1024 {
                                if !page.is_empty() { break; }
                                if total>4*1024*1024 { return Err(Fault::new("result_too_large","history entry exceeds 4 MiB").into()); }
                            }
                            size=total;
                            page.push(v);
                        }
                        let next=if start+page.len()<entries.len(){page.last().map(|v|v["id"].clone())}else{None};
                        let mut result=json!({"entries":page});if let Some(next)=next {result["next"]=next;}Ok(result)
                    }
                    "host/session"=>{require(api.as_ref(),&scope,"watch")?;let d=api.snapshot(&scope.session)?;Ok(json!({"id":d.id,"project":d.project,"settings":d.settings,"busy":api.is_running(&d.id),"actors":d.entries.iter().filter(|e|e.kind=="actor.grant").filter_map(|e|e.content.as_ref()).filter_map(|v|v["actor"].as_str()).chain(std::iter::once("user")).collect::<BTreeSet<_>>().into_iter().map(|actor|json!({"id":actor,"rights":api.authority(&d.id,actor).ok()})).collect::<Vec<_>>()}))}
                    "host/declaration"=>{require(api.as_ref(),&scope,"watch")?;interface_acp::declaration(api.as_ref(),Some(&scope.session))}
                    _=>bail!("unknown host request {method}"),
                }
            };
            tokio::pin!(run);
            tokio::select! {
                biased;
                _=parent_cancel.cancelled()=>{token.cancel();run.await}
                result=&mut run=>result,
            }
        }.await;
        result.map_err(|e| {
            if let Some(fault) = e.downcast_ref::<Fault>() {
                return fault.clone();
            }
            if is_file_not_found(&e)
                || matches!(
                    e.downcast_ref::<OperationError>(),
                    Some(OperationError::Busy(_))
                )
                || e.downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::Unsupported)
            {
                return Fault::from(e);
            }
            if e.downcast_ref::<LostPart>().is_some() {
                return Fault::new("lost", e);
            }
            Fault::new(
                if e.to_string() == "cancelled" {
                    "cancelled"
                } else {
                    "invalid_request"
                },
                e,
            )
        })
    }
}
#[async_trait]
impl Endpoint for Callbacks {
    async fn request(
        &self,
        peer: Arc<Peer>,
        id: Value,
        method: &str,
        p: Value,
        cancel: CancellationToken,
    ) -> Reply {
        let request = self.serve_request(peer, id, method, p, cancel.clone());
        tokio::pin!(request);
        let cancelled = || Fault::new("cancelled", "host request cancelled");
        let reply = tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                match method {
                    // Let cooperative work settle and committed records finish publishing,
                    // but leave room in the caller's five-second cancellation wait.
                    "host/ask" | "host/env/exec" | "host/tools/call" | "host/runtime/model"
                    | "host/runtime/runToolCall" | "host/runtime/record" => {
                        tokio::time::timeout(Duration::from_secs(4), &mut request)
                            .await
                            .map_err(|_| cancelled())?
                    }
                    _ => return Err(cancelled()),
                }
            }
            result = &mut request => result,
        };
        reply.map_err(|e| {
            if cancel.is_cancelled() {
                cancelled()
            } else {
                e
            }
        })
    }
    fn request_barrier(&self, method: &str, params: &Value) -> Option<NotificationKey> {
        match method {
            "host/jobs/end" | "host/jobs/resume" => job_progress_key(params),
            "host/hook" if params["hook"] == "provider.response" => Some(NotificationKey::Stream(
                params.get("parentRequestId")?.to_string(),
            )),
            _ => None,
        }
    }

    fn admit_notification(
        self: Arc<Self>,
        peer: &Arc<Peer>,
        method: &str,
        p: Value,
    ) -> Option<Notification> {
        if method == "tools/changed" {
            // Invalidate at receipt and let the triggering caller refresh after
            // its reply. Never ask tools/list from the reader.
            let source = p["toolSource"].as_str()?;
            let parent = peer.parent(&p["parentRequestId"]);
            if !p["parentRequestId"].is_null()
                && parent.as_ref().is_none_or(|w| w.method == "tools/list")
            {
                return None;
            }
            let view = self
                .0
                .sources
                .lock()
                .unwrap()
                .iter()
                .filter_map(Weak::upgrade)
                .find(|s| s.id == source)?;
            view.invalidate(
                parent
                    .as_ref()
                    .map(|w| w.scope.session.as_str())
                    .filter(|s| !s.is_empty()),
            );
            if let Some(work) = parent {
                work.changed_tools.lock().unwrap().insert(source.into());
            }
            return None;
        }
        if method == "host/jobs/progress" {
            let jobs = crate::jobs::RemoteJobs {
                peer: peer.clone(),
                shared: self.0.clone(),
            };
            return Some(Notification {
                barrier: Some(job_progress_key(&p)?),
                run: Box::pin(async move {
                    let _ = jobs.progress(&p).await;
                }),
            });
        }
        if method == "host/problem" {
            return Some(Notification {
                barrier: None,
                run: Box::pin(async move {
                    eprintln!("plugin problem at {}: {}", p["where"], p["message"]);
                }),
            });
        }
        if method == "host/emit" && peer.handling_output() {
            return None;
        }
        let (api, scope, work) = self.capture_scope(peer, &p).ok()?;
        let barrier = || Some(NotificationKey::Stream(p["parentRequestId"].to_string()));
        if method == "host/runtime/report" {
            let work = work.as_ref()?.clone();
            let runtime = work.runtime.clone()?;
            return Some(Notification {
                barrier: barrier(),
                run: Box::pin(async move {
                    let _ = runtime.report(&api, &work, &p).await;
                }),
            });
        }
        let mut emitter = None;
        let mut event = match method {
            "provider/event"
                if work.as_ref().is_some_and(|work| {
                    work.provider.as_ref().is_some_and(|p| {
                        p.phase.load(Ordering::Acquire) == 2 && p.response.lock().unwrap().is_none()
                    }) && !work.cancel.is_cancelled()
                }) =>
            {
                Event::new(
                    &scope,
                    if p["event"]["type"] == "reasoning" {
                        "model.thought"
                    } else if p["event"]["type"] == "toolInput" {
                        "model.tool_input"
                    } else {
                        "model.delta"
                    },
                    p["event"]["delta"].clone(),
                )
            }
            "tools/progress" if work.as_ref()?.method == "tools/call" => {
                Event::new(&scope, "tool.progress", p["content"].clone())
            }
            "env/output" if work.as_ref()?.method == "env/exec" => {
                Event::new(&scope, "tool.progress", p["chunk"].clone())
            }
            "host/emit" if !work.as_ref().is_some_and(|w| w.cancel.is_cancelled()) => {
                let kind = p["type"].as_str().filter(|kind| kind.contains('.'))?;
                let registration = self.0.registration.lock().unwrap();
                let plugin = registration["name"].as_str()?;
                emitter = Some(plugin.to_owned());
                Event::new(
                    &scope,
                    &format!("plugin.{plugin}.{kind}"),
                    p["data"].clone(),
                )
            }
            _ => return None,
        };
        let barrier = if method == "host/emit" {
            None
        } else {
            event.stream = Some(work?.stream.clone());
            barrier()
        };
        Some(Notification {
            barrier,
            run: Box::pin(async move {
                if api.snapshot(&scope.session).is_ok() {
                    if let Some(name) = emitter {
                        let _ = EMITTER.scope(name, api.emit(event)).await;
                    } else {
                        let _ = api.emit(event).await;
                    }
                }
            }),
        })
    }
}

fn job_progress_key(p: &Value) -> Option<NotificationKey> {
    Some(NotificationKey::Job(p["jobId"].as_str()?.to_owned()))
}
