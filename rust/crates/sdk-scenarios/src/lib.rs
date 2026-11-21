//! A runner for the shared SDK scenarios (docs/sdk/testing.md#the-shared-scenarios).
use modular_agent::{
    Agent, Answer, Approval, Code, Durability, Error, HistoryServer, ProcessPlugin,
    ServeHistoryOptions, ServicePlugin, Session, SessionOptions, Timing, file_history,
    http_history, listen_history,
    testing::{Answers, answers, fixtures, test_agent},
};
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::{fs::OpenOptionsExt, process::CommandExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

/// Where the fixture plugins run.
#[derive(Clone, Debug)]
pub enum Placement {
    InProcess,
    /// Served by an SDK's fixture program, by the command that starts it with a fixture name.
    Process {
        sdk: String,
        command: Vec<String>,
    },
    Service {
        sdk: String,
        command: Vec<String>,
    },
}

impl Placement {
    pub fn name(&self) -> String {
        match self {
            Placement::InProcess => "inProcess".into(),
            Placement::Process { sdk, .. } => format!("process:{sdk}"),
            Placement::Service { sdk, .. } => format!("service:{sdk}"),
        }
    }
    /// As command-line arguments, for the crash helper.
    pub fn to_args(&self) -> Vec<String> {
        match self {
            Placement::InProcess => vec!["inProcess".into()],
            Placement::Process { command, .. } | Placement::Service { command, .. } => {
                [vec![self.name()], command.clone()].concat()
            }
        }
    }
    pub fn from_args(args: &[String]) -> Self {
        match args[0].as_str() {
            "inProcess" => Placement::InProcess,
            name if name.starts_with("service:") => Placement::Service {
                sdk: name["service:".len()..].into(),
                command: args[1..].to_vec(),
            },
            name => Placement::Process {
                sdk: name.strip_prefix("process:").unwrap_or(name).into(),
                command: args[1..].to_vec(),
            },
        }
    }
}

/// Where one run of one scenario keeps its files. It survives a crash.
pub struct Run {
    pub dir: PathBuf,
    pub placement: Placement,
}

impl Run {
    pub fn data_dir(&self) -> PathBuf {
        self.dir.join("data")
    }
    pub fn counter(&self) -> PathBuf {
        self.dir.join("count")
    }
    pub fn project(&self) -> PathBuf {
        self.dir.join("project")
    }
    fn history_dir(&self) -> PathBuf {
        self.dir.join("history")
    }
    fn history_token(&self) -> PathBuf {
        self.dir.join("history-token")
    }
    fn history_url(&self) -> PathBuf {
        self.dir.join("history-url")
    }
    fn service_config(&self) -> PathBuf {
        self.dir.join("services.json")
    }
    fn token(&self) -> PathBuf {
        self.dir.join("service-token")
    }
}

/// The repository root.
pub fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap()
}

/// Every SDK's fixture program, from `conformance/sdk/fixtures/*.json`, with `{repo}`
/// replaced. Returns each SDK's placement, or why it is not available: a program whose
/// paths do not exist has not been built.
pub fn fixture_programs() -> Vec<(String, Result<Placement, String>)> {
    let repo = repo();
    let root = repo.to_string_lossy().to_string();
    let mut files: Vec<_> = std::fs::read_dir(repo.join("conformance/sdk/fixtures"))
        .expect("fixture program folder")
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    files.sort();
    files
        .into_iter()
        .map(|file| {
            let v = load(&file);
            let sdk = v["sdk"].as_str().unwrap_or("?").to_string();
            let command: Vec<String> = v["command"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|a| a.as_str().unwrap_or_default().replace("{repo}", &root))
                .collect();
            let missing: Vec<_> = v["command"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|a| a.as_str())
                .filter(|a| a.starts_with("{repo}"))
                .map(|a| a.replace("{repo}", &root))
                .filter(|a| !Path::new(a).exists())
                .collect();
            let placement = if missing.is_empty() {
                Ok(Placement::Process {
                    sdk: sdk.clone(),
                    command,
                })
            } else {
                Err(format!(
                    "not built ({}); build with: {}",
                    missing.join(", "),
                    v["build"].as_str().unwrap_or("?")
                ))
            };
            (sdk, placement)
        })
        .collect()
}

/// The scenarios, in name order.
pub fn scenarios() -> Vec<PathBuf> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../conformance/sdk/scenarios");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .expect("scenario folder")
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    files.sort();
    files
}

pub fn load(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// Start the history fixture independently of plugin placement.
async fn start_history(
    scenario: &Value,
    run: &Run,
) -> modular_agent::Result<Option<HistoryServer>> {
    match scenario["agent"]["history"].as_str() {
        None => Ok(None),
        Some("file") => {
            file_history(run.history_dir())?;
            Ok(None)
        }
        Some("service") => {
            let token = run.history_token();
            let output = Command::new("openssl")
                .args(["rand", "-hex", "32"])
                .output()?;
            if !output.status.success() {
                return Err(Error::new(
                    Code::Internal,
                    "could not generate fixture token",
                ));
            }
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&token)?
                .write_all(&output.stdout)?;
            let server = listen_history(
                file_history(run.history_dir())?,
                ServeHistoryOptions::new("127.0.0.1:0".parse().unwrap(), token),
            )
            .await?;
            std::fs::write(run.history_url(), &server.url)?;
            http_history(&server.url, run.history_token())?;
            Ok(Some(server))
        }
        Some(kind) => Err(Error::new(
            Code::InvalidParams,
            format!("unknown history fixture {kind}"),
        )),
    }
}

/// Build the scenario's agent over this run's files.
pub async fn agent(scenario: &Value, run: &Run) -> modular_agent::Result<(Agent, Option<Answers>)> {
    let spec = &scenario["agent"];
    std::fs::create_dir_all(run.project())?;
    let mut builder = test_agent()
        .script(scenario["model"].clone())
        .several_actors(spec["severalActors"] == true)
        .project(run.project())
        .data_dir(run.data_dir())
        .durability(match spec["durability"].as_str() {
            Some("kept") => Durability::Kept,
            Some("durable") => Durability::Durable,
            _ => Durability::Ephemeral,
        });
    match spec["history"].as_str() {
        Some("file") => builder = builder.history(file_history(run.history_dir())?),
        Some("service") => {
            let url = std::fs::read_to_string(run.history_url())?;
            builder = builder.history(http_history(&url, run.history_token())?);
        }
        _ => (),
    }
    if let Some(settings) = spec["settings"].as_object() {
        for (key, value) in settings {
            builder = builder.setting(key, value.clone());
        }
    }
    let config = serde_json::json!({"path": run.counter()});
    if matches!(run.placement, Placement::Service { .. }) {
        let urls: Vec<String> = serde_json::from_slice(&std::fs::read(run.service_config())?)
            .map_err(|e| Error::new(Code::InvalidComposition, e.to_string()))?;
        for url in urls {
            builder = builder.service_plugin(ServicePlugin {
                url,
                token_file: run.token(),
                config: config.clone(),
            });
        }
    }
    for name in spec["plugins"].as_array().into_iter().flatten() {
        let name = name.as_str().unwrap();
        builder = match &run.placement {
            Placement::InProcess => builder.plugin(
                fixtures::fixture(name)
                    .unwrap_or_else(|| panic!("no fixture named {name}"))
                    .config(config.clone()),
            ),
            Placement::Process { command, .. } => builder.process_plugin(
                ProcessPlugin::new(command.iter().cloned().chain([name.to_string()]))
                    .config(config.clone()),
            ),
            Placement::Service { .. } => builder,
        };
    }
    if let Some(policy) = spec["approval"].as_str() {
        builder = builder.approval(match policy {
            "off" => Approval::Off,
            "ask" => Approval::Ask,
            "all" => Approval::All,
            _ => Approval::Never,
        });
    }
    let queue = spec["answers"]
        .as_array()
        .map(|list| {
            list.iter()
                .map(scenario_answer)
                .collect::<modular_agent::Result<Vec<_>>>()
                .map(answers)
        })
        .transpose()?;
    if let Some(queue) = &queue {
        builder = builder.answers(queue.clone());
    }
    Ok((builder.build().await?, queue))
}

fn scenario_answer(value: &Value) -> modular_agent::Result<Answer> {
    if value == "allow" {
        Ok(Answer::Allow)
    } else if value == "decline" {
        Ok(Answer::Declined { reason: None })
    } else if let Some(value) = value["value"].as_str() {
        Ok(Answer::Value(value.into()))
    } else {
        Err(Error::new(Code::InvalidParams, "invalid scenario answer"))
    }
}

pub async fn new_session(agent: &Agent, scenario: &Value) -> modular_agent::Result<Session> {
    let actors = scenario["agent"]
        .get("actors")
        .cloned()
        .map(serde_json::from_value)
        .transpose()?
        .unwrap_or_default();
    agent
        .session_with(SessionOptions {
            actors,
            ..Default::default()
        })
        .await
}

async fn perform(
    session: &Session,
    step: &Value,
) -> modular_agent::Result<Option<modular_agent::PromptResult>> {
    let session = match step["as"].as_str() {
        Some(actor) => session.r#as(actor)?,
        None => session.clone(),
    };
    if let Some(prompt) = step["prompt"].as_str() {
        return session.prompt(prompt).await.map(Some);
    }
    if let Some(input) = step["send"].as_str() {
        let timing = step
            .get("timing")
            .cloned()
            .map(serde_json::from_value)
            .transpose()?
            .unwrap_or(Timing::Now);
        session.send(input, timing).await?;
    } else if let Some(answer) = step.get("answer") {
        let answer = scenario_answer(answer)?;
        let question = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let mut open = session.questions()?;
                if open.len() == 1 {
                    return Ok::<_, Error>(open.remove(0));
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .map_err(|_| {
            Error::new(
                Code::Busy,
                "expected exactly one open question within 10 seconds",
            )
        })??;
        session.answer(&question.id, answer).await?;
    } else if step["wait"] == true {
        session.wait_idle().await?;
        return session.last_turn();
    } else {
        return Err(Error::new(Code::InvalidParams, "unknown scenario step"));
    }
    Ok(None)
}

/// Whether a scenario applies to a placement.
pub fn applies(scenario: &Value, placement: &Placement) -> bool {
    match scenario["placements"].as_array() {
        None => true,
        Some(list) => list.iter().any(|p| {
            p == "inProcess" && matches!(placement, Placement::InProcess)
                || p.as_str() == Some(&placement.name())
                || p == "process" && matches!(placement, Placement::Process { .. })
                || p == "service" && matches!(placement, Placement::Service { .. })
        }),
    }
}

/// Run a scenario. Returns every failed expectation, or none.
/// `crash_agent` is the `scenario-agent` binary, for steps that crash.
pub async fn run(path: &Path, placement: &Placement, crash_agent: &Path) -> Vec<String> {
    let scenario = load(path);
    let name = scenario["scenario"].as_str().unwrap_or("?").to_string();
    let tmp = tempfile::Builder::new()
        .prefix("sdk-scenario-")
        .tempdir()
        .unwrap();
    let run = Run {
        dir: tmp.path().to_path_buf(),
        placement: placement.clone(),
    };
    let label = placement.name();
    let mut failures = vec![];
    let mut fail =
        |step: usize, what: String| failures.push(format!("{name} ({label}) step {step}: {what}"));

    let _history = match start_history(&scenario, &run).await {
        Ok(history) => history,
        Err(e) => {
            fail(0, format!("start history fixture: {e}"));
            return failures;
        }
    };
    if let Some(want) = scenario.get("expectCreateError") {
        let mut services = match start_services(&scenario, &run) {
            Ok(children) => children,
            Err(e) => {
                fail(0, format!("start fixture services: {e}"));
                return failures;
            }
        };
        match agent(&scenario, &run).await {
            Ok((a, _)) => {
                let _ = a.close().await;
                fail(0, format!("createAgent: expected {want}, got success"));
            }
            Err(e)
                if want["code"] == e.code().as_str()
                    && want["messageContains"]
                        .as_str()
                        .is_some_and(|s| e.message().contains(s)) => {}
            Err(e) => fail(
                0,
                format!(
                    "createAgent: expected {want}, got {}: {}",
                    e.code().as_str(),
                    e.message()
                ),
            ),
        }
        if let Err(e) = stop_groups(&mut services) {
            fail(0, e);
        }
        return failures;
    }

    let mut current: Option<(Agent, modular_agent::Session, Option<Answers>)> = None;
    let mut session_id = None;
    let mut services = Vec::new();
    for (index, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
        let expect = &step["expect"];
        let result;
        if step["reopen"] != true {
            if let Some(crash) = step.get("crashWhen") {
                match crash_run(crash_agent, path, &scenario, &run, index, crash) {
                    Ok(id) => session_id = Some(id),
                    Err(e) => fail(index, e),
                }
                continue;
            }
            if current.is_none() {
                match start_services(&scenario, &run) {
                    Ok(children) => services = children,
                    Err(e) => {
                        fail(index, e);
                        break;
                    }
                }
                match agent(&scenario, &run).await {
                    Ok((a, queue)) => match new_session(&a, &scenario).await {
                        Ok(s) => {
                            session_id = Some(s.id().to_string());
                            current = Some((a, s, queue));
                        }
                        Err(e) => {
                            fail(index, format!("session: {e}"));
                            break;
                        }
                    },
                    Err(e) => {
                        fail(index, format!("compose agent: {e}"));
                        break;
                    }
                }
            }
            let (_, session, _) = current.as_ref().unwrap();
            match perform(session, step).await {
                Ok(r) => result = r,
                Err(e) => {
                    check_error(expect, &e, &mut |w| fail(index, w));
                    continue;
                }
            }
        } else {
            if let Some((a, _, queue)) = current.take() {
                let _ = a.close().await;
                if let Some(Err(e)) = queue.map(|q| q.assert_done()) {
                    fail(index, e.to_string());
                }
            }
            let Some(id) = session_id.clone() else {
                fail(index, "no session to reopen".into());
                break;
            };
            if let Err(e) = stop_groups(&mut services) {
                fail(index, e);
                break;
            }
            match start_services(&scenario, &run) {
                Ok(children) => services = children,
                Err(e) => {
                    fail(index, e);
                    break;
                }
            }
            let (a, queue) = match agent(&scenario, &run).await {
                Ok(composition) => composition,
                Err(e) => {
                    fail(index, format!("compose for reopen: {e}"));
                    break;
                }
            };
            match a.open_session(&id).await {
                Ok(s) => {
                    result = match s.wait_idle().await.and_then(|_| s.last_turn()) {
                        Ok(last) => last,
                        Err(e) => {
                            fail(index, format!("read the last turn after reopen: {e}"));
                            None
                        }
                    };
                    current = Some((a, s, queue));
                }
                Err(e) => {
                    check_error(expect, &e, &mut |w| fail(index, w));
                    let _ = a.close().await;
                    continue;
                }
            }
        }
        if expect.is_null() {
            continue;
        }
        if let Some(code) = expect["error"].as_str() {
            fail(
                index,
                format!("expected error {code}, but the step succeeded"),
            );
        }
        let Some(r) = result else {
            fail(index, "no turn to check".into());
            continue;
        };
        if let Some(want) = expect["outcome"].as_str() {
            let got = r.outcome.as_ref().map(|o| o.kind()).unwrap_or("none");
            if got != want {
                fail(
                    index,
                    format!("outcome: want {want}, got {got} ({:?})", r.outcome),
                );
            }
        }
        if let Some(want) = expect["text"].as_str()
            && r.text != want
        {
            fail(index, format!("text: want {want:?}, got {:?}", r.text));
        }
        if let Some(want) = expect["toolResults"].as_array() {
            let got = r.tool_results();
            if got.len() != want.len() {
                fail(
                    index,
                    format!(
                        "toolResults: want {} results, got {}: {:?}",
                        want.len(),
                        got.len(),
                        got
                    ),
                );
            }
            for (w, g) in want.iter().zip(got) {
                if w["name"] != g.name.as_str() || w["status"] != g.status.as_str() {
                    fail(
                        index,
                        format!(
                            "toolResult: want {} {}, got {} {}",
                            w["name"],
                            w["status"],
                            g.name,
                            g.status.as_str()
                        ),
                    );
                }
                let actual = g.text();
                if let Some(text) = w["text"].as_str()
                    && actual != text
                {
                    fail(
                        index,
                        format!("toolResult text: want {text:?}, got {actual:?}"),
                    );
                }
                if let Some(part) = w["contains"].as_str()
                    && !actual.contains(part)
                {
                    fail(
                        index,
                        format!("toolResult text: want substring {part:?}, got {actual:?}"),
                    );
                }
            }
        }
        if let Some(want) = expect["records"].as_array() {
            let (_, session, _) = current.as_ref().unwrap();
            let kinds: Vec<String> = session
                .history()
                .await
                .unwrap_or_default()
                .iter()
                .map(|e| e["kind"].as_str().unwrap_or_default().to_string())
                .collect();
            let mut at = 0;
            for w in want {
                let w = w.as_str().unwrap();
                match kinds[at..].iter().position(|k| k == w) {
                    Some(i) => at += i + 1,
                    None => {
                        fail(
                            index,
                            format!("records: no {w} after position {at} in {kinds:?}"),
                        );
                        break;
                    }
                }
            }
        }
        if let Some(want) = expect["count"].as_u64() {
            let got = fixtures::count(&run.counter());
            if got != want {
                fail(index, format!("count: want {want}, got {got}"));
            }
        }
    }
    if let Some((a, _, queue)) = current {
        let _ = a.close().await;
        if let Some(Err(e)) = queue.map(|q| q.assert_done()) {
            fail(
                scenario["steps"]
                    .as_array()
                    .unwrap()
                    .len()
                    .saturating_sub(1),
                e.to_string(),
            );
        }
    }
    if let Err(e) = stop_groups(&mut services) {
        fail(scenario["steps"].as_array().unwrap().len(), e);
    }
    failures
}

fn check_error(expect: &Value, e: &modular_agent::Error, fail: &mut dyn FnMut(String)) {
    match expect["error"].as_str() {
        Some(code) if code == e.code().as_str() => (),
        Some(code) => fail(format!("error: want {code}, got {e}")),
        None => fail(format!("unexpected error: {e}")),
    }
}

/// Run a prompt step in a separate process group and kill the whole group when the
/// crash condition holds. Returns the session id.
fn crash_run(
    bin: &Path,
    path: &Path,
    scenario: &Value,
    run: &Run,
    step: usize,
    crash: &Value,
) -> Result<String, String> {
    let mut groups = start_services(scenario, run)?;
    let child = Command::new(bin)
        .arg(path)
        .arg(&run.dir)
        .arg(step.to_string())
        .args(run.placement.to_args())
        .stdout(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("spawn: {e}"))?;
    groups.push(ChildGroup(Some(child)));
    let child = groups.last_mut().unwrap().0.as_mut().unwrap();
    let result = (|| {
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .map_err(|e| e.to_string())?;
        let id = line
            .trim()
            .strip_prefix("SESSION ")
            .ok_or(format!("no session id: {line:?}"))?
            .to_string();
        let reached: Box<dyn Fn() -> bool> =
            match (crash["count"].as_u64(), crash["record"].as_str()) {
                (Some(count), None) => Box::new(move || fixtures::count(&run.counter()) >= count),
                (None, Some(kind)) => {
                    // FileHistory publishes an atomic snapshot only after committing the entry.
                    let snapshot = run.data_dir().join("sessions").join(format!("{id}.json"));
                    Box::new(move || {
                        std::fs::read(&snapshot)
                            .ok()
                            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                            .and_then(|v| {
                                v["entries"]
                                    .as_array()
                                    .map(|entries| entries.iter().any(|e| e["kind"] == kind))
                            })
                            .unwrap_or(false)
                    })
                }
                _ => return Err("crashWhen needs exactly one count or record".into()),
            };
        let deadline = Instant::now() + Duration::from_secs(30);
        while !reached() {
            if Instant::now() > deadline {
                return Err("the crash condition never held".into());
            }
            // Do not reap here: keep the child's group id until we have signalled it.
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(id)
    })();
    stop_groups(&mut groups)?;
    result
}

/// A service has its own group, distinct from the agent and all other services.
/// The parent owns these guards even when the crash agent is unconditionally killed.
struct ChildGroup(Option<Child>);
impl ChildGroup {
    fn signal(&self) -> std::io::Result<()> {
        let Some(child) = &self.0 else {
            return Ok(());
        };
        if unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) } != 0 {
            let e = std::io::Error::last_os_error();
            if e.raw_os_error() != Some(libc::ESRCH) {
                return Err(e);
            }
        }
        Ok(())
    }
    fn reap(&mut self) -> std::io::Result<()> {
        let Some(mut child) = self.0.take() else {
            return Ok(());
        };
        let pid = child.id() as i32;
        child.wait()?;
        let deadline = Instant::now() + Duration::from_secs(5);
        while group_can_run(pid)? {
            if Instant::now() > deadline {
                return Err(std::io::Error::other(
                    "some of the process group did not exit",
                ));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(())
    }
}
impl Drop for ChildGroup {
    fn drop(&mut self) {
        let _ = self.signal();
        let _ = self.reap();
    }
}

fn stop_groups(groups: &mut Vec<ChildGroup>) -> Result<(), String> {
    // Signal all groups before waiting for any one of them.
    let mut errors = vec![];
    for group in groups.iter() {
        if let Err(e) = group.signal() {
            errors.push(format!("kill process group: {e}"));
        }
    }
    for mut group in groups.drain(..) {
        if let Err(e) = group.reap() {
            errors.push(format!("reap process group: {e}"));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn start_services(scenario: &Value, run: &Run) -> Result<Vec<ChildGroup>, String> {
    let Placement::Service { command, .. } = &run.placement else {
        return Ok(vec![]);
    };
    let prepare = || -> std::io::Result<()> {
        std::fs::create_dir_all(run.project())?;
        let path = run.token();
        if !path.exists() {
            let mut file = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(path)?;
            writeln!(
                file,
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            )?;
        }
        Ok(())
    };
    prepare().map_err(|e| format!("prepare services: {e}"))?;
    let mut groups = Vec::new();
    let mut urls = Vec::new();
    for name in scenario["agent"]["plugins"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let name = name.as_str().unwrap();
        let child = Command::new(&command[0])
            .args(&command[1..])
            .arg(name)
            .args(["--listen", "127.0.0.1:0", "--token-file"])
            .arg(run.token())
            .env_clear()
            .env(
                "PATH",
                std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into()),
            )
            .current_dir(run.project())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .process_group(0)
            .spawn()
            .map_err(|e| format!("start {name} service: {e}"))?;
        groups.push(ChildGroup(Some(child)));
        let mut line = String::new();
        let child = groups.last_mut().unwrap().0.as_mut().unwrap();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .map_err(|e| format!("read {name} service URL: {e}"))?;
        let url = line.trim();
        if !url.starts_with("ws://") {
            return Err(format!("{name} service did not publish a WebSocket URL"));
        }
        urls.push(url.to_owned());
    }
    std::fs::write(run.service_config(), serde_json::to_vec(&urls).unwrap())
        .map_err(|e| format!("write service configuration: {e}"))?;
    Ok(groups)
}

#[cfg(target_os = "linux")]
fn group_can_run(pgid: i32) -> std::io::Result<bool> {
    for entry in std::fs::read_dir("/proc")? {
        let entry = entry?;
        if entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<u32>().ok())
            .is_none()
        {
            continue;
        }
        let stat = match std::fs::read_to_string(entry.path().join("stat")) {
            Ok(stat) => stat,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        // The command in parentheses may itself contain spaces and parens.
        if let Some((_, fields)) = stat.rsplit_once(')') {
            let mut fields = fields.split_whitespace();
            if !matches!(fields.next(), Some("Z" | "X" | "x"))
                && fields.nth(1).and_then(|group| group.parse().ok()) == Some(pgid)
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

#[cfg(not(target_os = "linux"))]
fn group_can_run(pgid: i32) -> std::io::Result<bool> {
    let status = Command::new("ps")
        .args(["-ax", "-o", "pgid=,stat="])
        .output()?;
    if !status.status.success() {
        return Err(std::io::Error::other("ps failed"));
    }
    Ok(String::from_utf8_lossy(&status.stdout).lines().any(|line| {
        let mut fields = line.split_whitespace();
        fields.next().and_then(|group| group.parse().ok()) == Some(pgid)
            && fields.next().is_some_and(|state| !state.starts_with('Z'))
    }))
}
