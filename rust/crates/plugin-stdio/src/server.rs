//! A reusable Endpoint runner, with the conformance plugin as one endpoint.
use crate::rpc::*;
use agent_api::*;
use base64::{Engine, prelude::BASE64_STANDARD};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
pub async fn serve(endpoint: Arc<dyn Endpoint>) {
    let peer = Peer::start(tokio::io::stdin(), tokio::io::stdout(), endpoint);
    peer.finished.cancelled().await;
}
pub async fn serve_websocket(
    listen: &str,
    token_file: PathBuf,
    tls: Option<transport_websocket::TlsOptions>,
    endpoint: impl Fn() -> Arc<dyn Endpoint> + Send + Sync + 'static,
) -> Result<transport_websocket::Server> {
    transport_websocket::serve(
        listen,
        tls,
        transport_websocket::PLUGIN,
        vec![(token_file, ())],
        move |(), conn| {
            let endpoint = endpoint();
            async move {
                Peer::websocket(conn, endpoint, true)
                    .finished
                    .cancelled()
                    .await;
            }
        },
    )
    .await
}

#[derive(Default)]
pub struct Conformance {
    initializing: tokio::sync::Mutex<()>,
    state: Mutex<Option<(Api, Value)>>,
    parts: BTreeSet<String>,
    service_scope: Option<(PathBuf, PathBuf)>,
}
impl Conformance {
    pub fn from_env() -> Result<Self> {
        let parts: BTreeSet<_> = std::env::var("MODULAR_AGENT_PLUGIN_PARTS")
            .unwrap_or("provider,tools,environment,hooks".into())
            .split(',')
            .map(|s| s.trim().to_string())
            .collect();
        ensure!(
            parts.iter().all(|s| [
                "provider",
                "tools",
                "environment",
                "hooks",
                "runtime",
                "durable-runtime"
            ]
            .contains(&s.as_str())),
            "invalid MODULAR_AGENT_PLUGIN_PARTS"
        );
        ensure!(
            !(parts.contains("runtime") && parts.contains("durable-runtime")),
            "choose only one Runtime"
        );
        let project = std::env::var_os("MODULAR_AGENT_PLUGIN_PROJECT");
        let state_dir = std::env::var_os("MODULAR_AGENT_PLUGIN_STATE_DIR");
        let service_scope = match (project, state_dir) {
            (None, None) => None,
            (Some(project), Some(state_dir)) => {
                let (project, state_dir) = (PathBuf::from(project), PathBuf::from(state_dir));
                ensure!(
                    project.is_absolute() && project.is_dir() && state_dir.is_absolute(),
                    "use an absolute project directory and absolute state path"
                );
                std::fs::create_dir_all(&state_dir)?;
                Some((project.canonicalize()?, state_dir))
            }
            _ => bail!("set both MODULAR_AGENT_PLUGIN_PROJECT and MODULAR_AGENT_PLUGIN_STATE_DIR"),
        };
        Ok(Self {
            parts,
            service_scope,
            ..Self::default()
        })
    }
    pub fn new_instance(&self) -> Self {
        Self {
            parts: self.parts.clone(),
            service_scope: self.service_scope.clone(),
            ..Self::default()
        }
    }
    fn has(&self, part: &str) -> bool {
        self.parts.contains(part)
    }
    fn state(&self) -> Result<Api> {
        Ok(self
            .state
            .lock()
            .unwrap()
            .as_ref()
            .ok_or_else(|| anyhow!("initialize first"))?
            .0
            .clone())
    }
    fn registration(&self) -> Value {
        let mut r =
            json!({"binding":"modular-agent-plugin/1","name":"rust-conformance","replaces":[]});
        if self.parts
            != ["environment", "hooks", "provider", "tools"]
                .into_iter()
                .map(str::to_owned)
                .collect()
        {
            r["name"] = json!(format!(
                "rust-conformance.{}",
                self.parts.iter().cloned().collect::<Vec<_>>().join("+")
            ));
        }
        let mut replaces = vec![];
        if self.has("provider") {
            r["providers"] = json!([{"id":"conformance","supports":{"keepsState":false,"runsTools":false},"models":[echo_info()]}]);
            replaces.push("provider:conformance");
        }
        if self.has("tools") {
            r["toolSources"] =
                json!([{"id":"conformance-tools","tools":tools(),"perSession":false}]);
            replaces.extend(["tool:bash", "tool:read", "tool:nest"]);
        }
        if self.has("environment") {
            r["workingEnvironment"] = if cfg!(target_os = "macos") {
                json!({"containment":"processGroup","platforms":["darwin"],"points":true})
            } else {
                json!({"containment":"strong","platforms":["linux"],"points":true})
            };
            replaces.push("working-environment");
        }
        if self.has("hooks") {
            r["hooks"] = json!([{"hook":"tool.before","handlerId":1,"order":"normal"},{"hook":"turn.before","handlerId":2,"order":"normal"},{"hook":"output","handlerId":3,"order":"normal"}]);
        }
        if self.has("runtime") || self.has("durable-runtime") {
            r["runtime"] = runtime_engine::binding::registration(self.has("durable-runtime"));
            replaces.push("runtime");
        }
        r["replaces"] = json!(replaces);
        r
    }
}
pub fn echo_info() -> Value {
    json!({"provider":"conformance","id":"echo","name":"Conformance echo","contextWindow":128000,"maxOutput":8192,"input":["text"],"reasoning":true,"thinking":["off","low"]})
}
fn tools() -> Value {
    json!([
        {"name":"bash","description":"Run bash in the host working environment.","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"],"additionalProperties":false},"hints":{"readOnly":false,"safeToRepeat":false},"parallel":false,"callers":["model","ui","plugin"]},
        {"name":"read","description":"Read a UTF-8 file from the host working environment.","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false},"hints":{"readOnly":true,"safeToRepeat":true},"parallel":true,"callers":["model","ui","plugin"]},
        {"name":"nest","description":"Start one nested call and return its result.","parameters":{"type":"object","properties":{"name":{"type":"string"},"input":{"type":"object"}},"required":["name","input"],"additionalProperties":false},"hints":{"readOnly":false,"safeToRepeat":false},"parallel":false}
    ])
}
fn text_of(content: &Value) -> String {
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| v["type"] == "text")
        .filter_map(|v| v["text"].as_str())
        .collect()
}
struct Sink(Arc<Peer>);

/// Run a native environment behind the same public bridge used by the binding kit.
/// The isolated Harness only relays environment output; it is not the host Agent.
pub struct EnvironmentServer {
    api: Api,
    project: PathBuf,
}
impl EnvironmentServer {
    pub async fn new(peer: Arc<Peer>, params: &Value) -> std::result::Result<Self, Fault> {
        let project = environment_cwd(params, "project")?;
        let harness = agent_harness::Harness::new();
        harness.load(Arc::new(Sink(peer))).await?;
        Ok(Self {
            api: harness,
            project,
        })
    }
    pub async fn request(
        &self,
        env: Arc<dyn WorkingEnvironment>,
        id: &Value,
        method: &str,
        params: &Value,
        cancel: CancellationToken,
    ) -> Reply {
        environment(
            env,
            self.api.clone(),
            &self.project,
            id,
            method,
            params,
            cancel,
        )
        .await
    }
}
impl EventSink for Sink {
    fn send(&self, event: Event) {
        if event.kind == "tool.progress" {
            let parent: Value = serde_json::from_str(event.scope.call.as_deref().unwrap_or("null"))
                .unwrap_or(Value::Null);
            self.0.notify(
                "env/output",
                json!({"parentRequestId":parent,"chunk":event.content.as_str().unwrap_or("")}),
            );
        }
    }
}
impl Plugin for Sink {
    fn name(&self) -> &str {
        "server.events"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.provide::<dyn EventSink>("interface.server", Arc::new(Self(self.0.clone())))
    }
}
#[async_trait]
impl Endpoint for Conformance {
    async fn disconnected(&self) {
        let state = self.state.lock().unwrap().take();
        if let Some((api, _)) = state {
            let _ = api.shutdown().await;
        }
    }
    async fn request(
        &self,
        peer: Arc<Peer>,
        id: Value,
        method: &str,
        p: Value,
        cancel: CancellationToken,
    ) -> Reply {
        if method == "plugin/initialize" {
            let _guard = self.initializing.lock().await;
            if p["binding"] != "modular-agent-plugin/1" || p["data"] != "modular-agent-data/1" {
                return Err(Fault::new("not_supported", "unsupported binding"));
            }
            if self.state.lock().unwrap().is_some() {
                return Err(Fault::new("invalid_request", "already initialized"));
            }
            let mut p = p;
            if let Some((project, state_dir)) = &self.service_scope {
                if p["project"].as_str().map(Path::new) != Some(project.as_path()) {
                    return Err(Fault::new(
                        "invalid_request",
                        "project is outside the service scope",
                    ));
                }
                p["home"] = json!(state_dir);
            }
            if self.has("environment") {
                p["project"] = json!(environment_cwd(&p, "project")?);
            }
            let h = agent_harness::Harness::new();
            // Reuse this build's environment, including its ptrace containment.
            if self.has("environment") {
                h.load(Arc::new(environment_local::ServedEnvironment {
                    state: PathBuf::from(
                        p["home"]
                            .as_str()
                            .ok_or_else(|| Fault::new("invalid_request", "home required"))?,
                    )
                    .join("commands"),
                }))
                .await?;
            }
            h.load(Arc::new(Sink(peer))).await?;
            *self.state.lock().unwrap() = Some((h, p));
            return Ok(self.registration());
        }
        let api = self.state().map_err(|e| Fault::new("invalid_request", e))?;
        if let Some((project, _)) = &self.service_scope
            && matches!(method, "env/read" | "env/write" | "env/exists" | "env/list")
        {
            let cwd = environment_cwd(&p, "cwd")?;
            let path = cwd.join(p["path"].as_str().unwrap_or(""));
            if !service_path_in_project(project, &path) {
                return Err(Fault::new(
                    "invalid_request",
                    "path is outside the service project",
                ));
            }
        }
        let missing = |part| {
            Err(Fault::new(
                "not_supported",
                format!("{part} is not registered"),
            ))
        };
        match method {
            "plugin/shutdown" => {
                let state = self.state.lock().unwrap().take();
                if let Some((api, _)) = state {
                    api.shutdown().await?;
                }
                Ok(json!({}))
            }
            "runtime/runTurn" | "runtime/resumeTurn" | "runtime/continueOpenCalls" => {
                if !self.has("runtime") && !self.has("durable-runtime") {
                    return missing("runtime");
                }
                let host = crate::runtime_server::Host::new(peer, id, cancel);
                Ok(
                    runtime_engine::binding::run(&host, method, p, self.has("durable-runtime"))
                        .await
                        .map_err(|e| {
                            if e.is::<runtime_engine::binding::InvalidResume>() {
                                Fault::new("invalid_request", e)
                            } else {
                                Fault::new("internal", e)
                            }
                        })?,
                )
            }
            "tools/list" => {
                if !self.has("tools") {
                    return missing("tools");
                }
                if p["toolSource"] != "conformance-tools" {
                    return Err(Fault::new("invalid_request", "unknown tool source"));
                }
                Ok(json!({"tools":tools()}))
            }
            "tools/call" => {
                if !self.has("tools") {
                    return missing("tools");
                }
                if p["toolSource"] != "conformance-tools" {
                    return Err(Fault::new("invalid_request", "unknown tool source"));
                }
                let call = &p["call"];
                let name = call["name"].as_str().unwrap_or("");
                let scope = Scope {
                    call: Some(id.to_string()),
                    session: p["sessionId"].as_str().unwrap_or("").into(),
                    ..Scope::default()
                };
                let work = Work::new(&api, &scope, "tools/call", cancel.clone());
                let mut params =
                    json!({"parentRequestId":id,"cwd":p["project"],"sessionId":p["sessionId"]});
                if name == "nest" {
                    let asked = peer
                        .call(
                            "host/tools/call",
                            json!({"parentRequestId":id,"name":call["input"]["name"],"input":call["input"]["input"]}),
                            Some(work),
                            cancel.clone(),
                        )
                        .await;
                    if cancel.is_cancelled() {
                        return Err(Fault::new("cancelled", "tool cancelled"));
                    }
                    return Ok(match asked {
                        Ok(nested) => {
                            json!({"status":nested["status"],"content":nested["content"]})
                        }
                        Err(e) => {
                            json!({"status":"failed","content":[{"type":"text","text":e.code}]})
                        }
                    });
                }
                let method = match name {
                    "read" => {
                        params["path"] = call["input"]["path"].clone();
                        "host/env/read"
                    }
                    "bash" => {
                        params["command"] = call["input"]["command"].clone();
                        "host/env/exec"
                    }
                    _ => return Err(Fault::new("invalid_request", "unknown tool")),
                };
                let r = peer.call(method, params, Some(work), cancel.clone()).await;
                if cancel.is_cancelled() {
                    return Err(Fault::new("cancelled", "tool cancelled"));
                }
                match r {
                    Ok(r) => {
                        let (text, status) = if name == "read" {
                            let bytes = BASE64_STANDARD
                                .decode(r["data"].as_str().unwrap_or(""))
                                .map_err(|e| Fault::new("internal", e))?;
                            (
                                String::from_utf8(bytes).map_err(|e| Fault::new("internal", e))?,
                                "completed",
                            )
                        } else {
                            (
                                format!(
                                    "{}\n[exit code {}]",
                                    r["output"].as_str().unwrap_or("").trim_end_matches('\n'),
                                    r["exitCode"]
                                ),
                                if r["exitCode"] == 0 && r["timedOut"] != true {
                                    "completed"
                                } else {
                                    "failed"
                                },
                            )
                        };
                        Ok(
                            json!({"status":status,"content":[{"type":"text","text":text}],"value":r}),
                        )
                    }
                    Err(e) => Ok(
                        json!({"status":if e.code=="lost" {"outcomeUnknown"} else {"failed"},"content":[{"type":"text","text":e.to_string()}]}),
                    ),
                }
            }
            "provider/models" | "provider/available" | "provider/discard" => {
                if !self.has("provider") {
                    return missing("provider");
                }
                if p["provider"] != "conformance" {
                    return Err(Fault::new("invalid_request", "unknown provider"));
                }
                Ok(match method {
                    "provider/models" => json!({"models":[echo_info()]}),
                    "provider/available" => json!({"available":true}),
                    _ => json!({}),
                })
            }
            "provider/request" => {
                if !self.has("provider") {
                    return missing("provider");
                }
                if p["provider"] != "conformance" || p["model"]["id"] != "echo" {
                    return Err(Fault::new("invalid_request", "unknown model"));
                }
                let payload = json!({"sessionId":p["sessionId"],"provider":p["provider"],"model":p["model"],"request":p["request"]});
                let payload = peer
                    .call(
                        "host/hook",
                        json!({"parentRequestId":id,"hook":"provider.request","payload":payload}),
                        None,
                        cancel.clone(),
                    )
                    .await?;
                let request = &payload["request"];
                let messages = request["messages"]
                    .as_array()
                    .ok_or_else(|| Fault::new("invalid_request", "messages required"))?;
                let user_index = messages.iter().rposition(|m| m["role"] == "user");
                let user = user_index
                    .map(|i| text_of(&messages[i]["content"]))
                    .unwrap_or_default();
                let result: Result<Value> = (|| {
                    if let Some(reason) = user.strip_prefix("fail:") {
                        bail!("{reason}");
                    }
                    let content = if let Some(tool) = user.strip_prefix("tool:") {
                        if let Some(done) = messages
                            .iter()
                            .skip(user_index.unwrap_or(0) + 1)
                            .find(|m| m["role"] == "toolResult")
                        {
                            json!([{"type":"text","text":format!("done: {}",text_of(&done["content"]).chars().take(200).collect::<String>())}])
                        } else {
                            let (name, args) = tool
                                .split_once(' ')
                                .ok_or_else(|| anyhow!("Invalid tool directive"))?;
                            let arguments: Value = serde_json::from_str(args)
                                .map_err(|_| anyhow!("Invalid tool directive"))?;
                            ensure!(
                                arguments.is_object()
                                    && !name.is_empty()
                                    && request["tools"].as_array().is_some_and(|tools| tools
                                        .iter()
                                        .any(|d| d["name"] == name)),
                                "Invalid tool directive"
                            );
                            json!([{"type":"toolCall","id":agent_api::id(),"name":name,"arguments":arguments}])
                        }
                    } else {
                        json!([{"type":"text","text":format!("echo: {user}")}])
                    };
                    let stop = if content[0]["type"] == "toolCall" {
                        "toolUse"
                    } else {
                        "finished"
                    };
                    Ok(
                        json!({"role":"assistant","content":content,"stop":stop,"model":p["model"],"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0}}),
                    )
                })();
                let message = result.unwrap_or_else(|e|json!({"role":"assistant","content":[],"stop":"failed","error":{"kind":"other","message":e.to_string()},"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0}}));
                for part in message["content"].as_array().into_iter().flatten() {
                    if part["type"] == "text" {
                        peer.notify("provider/event",json!({"parentRequestId":id,"event":{"type":"text","delta":part["text"]}}));
                    }
                }
                peer.call("host/hook",json!({"parentRequestId":id,"hook":"provider.response","payload":{"sessionId":p["sessionId"],"provider":p["provider"],"model":p["model"],"message":message}}),None,cancel).await?;
                Ok(message)
            }
            "hook/handle" => {
                if !self.has("hooks") {
                    return missing("hooks");
                }
                match (p["handlerId"].as_u64(), p["hook"].as_str()) {
                    (Some(1), Some("tool.before")) => Ok(
                        if p["payload"]["call"]["input"]
                            .to_string()
                            .contains("conformance-forbidden")
                        {
                            json!({"refuse":"refused by the conformance plugin"})
                        } else {
                            Value::Null
                        },
                    ),
                    (Some(3), Some("output")) => Ok(crate::output::redact(&p["payload"]["events"])),
                    (Some(2), Some("turn.before")) => {
                        Ok(json!({"system":"The conformance plugin is loaded."}))
                    }
                    _ => Err(Fault::new("unknown_handler", "unknown handler")),
                }
            }
            m if m.starts_with("env/") => {
                if !self.has("environment") {
                    return missing("environment");
                }
                let env: Arc<dyn WorkingEnvironment> = capability(api.as_ref(), "environment")?;
                let project = self.state.lock().unwrap().as_ref().unwrap().1["project"]
                    .as_str()
                    .map(PathBuf::from)
                    .unwrap();
                environment(env, api, &project, &id, method, &p, cancel).await
            }
            _ => Err(Fault::unknown(method)),
        }
    }
    fn admit_notification(
        self: Arc<Self>,
        peer: &Arc<Peer>,
        method: &str,
        p: Value,
    ) -> Option<Notification> {
        let id = p.get("parentRequestId")?;
        let barrier = Some(NotificationKey::Stream(id.to_string()));
        let run: futures_util::future::BoxFuture<'static, ()> = match method {
            "host/runtime/modelEvent" => {
                let handler = peer.event_handler(id, "host/runtime/model")?;
                Box::pin(async move { handler(p["event"].clone()) })
            }
            "host/env/output" if peer.pending_method(id, "host/env/exec") => {
                let work = peer.parent(id)?;
                let parent: Value = serde_json::from_str(work.scope.call.as_deref()?).ok()?;
                let peer = peer.clone();
                Box::pin(async move {
                    peer.notify(
                        "tools/progress",
                        json!({"parentRequestId":parent,"content":[{"type":"text","text":p["chunk"]}]}),
                    );
                })
            }
            _ => return None,
        };
        Some(Notification { barrier, run })
    }
}
fn wire_session(p: &Value) -> std::result::Result<&str, Fault> {
    p["sessionId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Fault::new("invalid_request", "sessionId required"))
}
fn environment_cwd(p: &Value, key: &str) -> std::result::Result<PathBuf, Fault> {
    let cwd = Path::new(wire::string(p, key).map_err(|e| Fault::new("invalid_request", e))?);
    if !cwd.is_absolute() {
        return Err(Fault::new(
            "invalid_request",
            "expected an absolute directory",
        ));
    }
    match cwd.canonicalize() {
        Ok(path) if path.is_dir() => Ok(path),
        _ => Err(Fault::new(
            "invalid_request",
            "invalid environment directory",
        )),
    }
}

// Check the nearest existing ancestor, including for a file that will be created.
fn service_path_in_project(project: &Path, path: &Path) -> bool {
    use std::{fs, io::ErrorKind, path::Component};
    path.starts_with(project)
        && !path.components().any(|part| part == Component::ParentDir)
        && path
            .ancestors()
            .find(|p| !matches!(fs::symlink_metadata(p), Err(e) if e.kind() == ErrorKind::NotFound))
            .is_some_and(|p| p.canonicalize().is_ok_and(|p| p.starts_with(project)))
}

pub(crate) async fn environment(
    env: Arc<dyn WorkingEnvironment>,
    api: Api,
    project: &Path,
    id: &Value,
    method: &str,
    p: &Value,
    cancel: CancellationToken,
) -> Reply {
    let session = wire_session(p)?;
    if method == "env/sessionEnded" {
        env.session_ended(session).await?;
        return Ok(json!({}));
    }
    let cwd = environment_cwd(p, "cwd")?;
    if !cwd.starts_with(project) {
        return Err(Fault::new(
            "invalid_request",
            "cwd is outside the environment project",
        ));
    }
    if matches!(method, "env/save" | "env/checkPoint" | "env/restore")
        && env.declaration()["rewinding"] != true
    {
        return Err(Fault::new(
            "not_supported",
            "saved points are not supported",
        ));
    }
    let name = p["path"].as_str().unwrap_or("");
    match method {
        "env/read" => Ok(json!({"data":BASE64_STANDARD.encode(env.read_bytes(&cwd,name).await?)})),
        "env/write" => {
            let bytes = BASE64_STANDARD
                .decode(p["data"].as_str().unwrap_or(""))
                .map_err(|e| Fault::new("invalid_request", e))?;
            env.write_bytes(&cwd, name, &bytes).await?;
            Ok(json!({}))
        }
        "env/exists" => Ok(json!({"exists":env.exists(&cwd,name).await?})),
        "env/list" => match env.list_dir(&cwd, name).await {
            Ok(names) => Ok(json!({"entries":wire::dir_entries(&names)})),
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotADirectory) =>
            {
                Err(Fault::new("invalid_request", "not a directory"))
            }
            Err(error) => Err(error.into()),
        },
        "env/save" => Ok(json!({"point":env.save_point(session,project).await?})),
        "env/checkPoint" => {
            let point = wire::string(p, "point").map_err(|e| Fault::new("invalid_request", e))?;
            let exists = env
                .check_point(session, project, point)
                .await
                .map_err(|e| Fault::new("internal", e))?;
            Ok(json!({"exists":exists}))
        }
        "env/restore" => {
            env.restore_point(
                session,
                project,
                wire::string(p, "point").map_err(|e| Fault::new("invalid_request", e))?,
            )
            .await?;
            Ok(json!({}))
        }
        "env/exec" => {
            let command = p["command"]
                .as_str()
                .ok_or_else(|| Fault::new("invalid_request", "command required"))?;
            // The binding accepts legacy zero as no limit, just like null or omission.
            let timeout = p["timeoutMs"].as_u64().filter(|ms| *ms > 0);
            let token = cancel.child_token();
            let timer_token = token.clone();
            let timer = tokio::spawn(async move {
                if let Some(ms) = timeout {
                    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                    timer_token.cancel();
                } else {
                    std::future::pending::<()>().await;
                }
            });
            let scope = Scope {
                session: session.into(),
                call: Some(id.to_string()),
                ..Scope::default()
            };
            let result = env.bash(api, scope, cwd, command, token.clone()).await;
            let timed_out = token.is_cancelled() && !cancel.is_cancelled();
            timer.abort();
            let _ = timer.await;
            let result = result?;
            if cancel.is_cancelled() {
                return Err(Fault::new("cancelled", "command cancelled"));
            }
            Ok(
                json!({"exitCode":result.value.as_ref().map(|v|v["exit_code"].clone()).unwrap_or(Value::Null),"output":result.text,"timedOut":timed_out}),
            )
        }
        _ => Err(Fault::unknown(method)),
    }
}
