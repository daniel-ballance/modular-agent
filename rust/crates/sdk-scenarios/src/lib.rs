//! A runner for the shared SDK scenarios (docs/sdk/testing.md#the-shared-scenarios).
use modular_agent::{
    Agent, Answer, Approval, Durability, ProcessPlugin,
    testing::{fixtures, test_agent},
};
use serde_json::Value;
use std::{
    io::{BufRead, BufReader},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
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
}

impl Placement {
    pub fn name(&self) -> String {
        match self {
            Placement::InProcess => "inProcess".into(),
            Placement::Process { sdk, .. } => format!("process:{sdk}"),
        }
    }
    /// As command-line arguments, for the crash helper.
    pub fn to_args(&self) -> Vec<String> {
        match self {
            Placement::InProcess => vec!["inProcess".into()],
            Placement::Process { sdk, command } => [vec![sdk.clone()], command.clone()].concat(),
        }
    }
    pub fn from_args(args: &[String]) -> Self {
        match args[0].as_str() {
            "inProcess" => Placement::InProcess,
            sdk => Placement::Process {
                sdk: sdk.into(),
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

/// Build the scenario's agent over this run's files.
pub async fn agent(scenario: &Value, run: &Run) -> modular_agent::Result<Agent> {
    let spec = &scenario["agent"];
    std::fs::create_dir_all(run.project())?;
    let mut builder = test_agent()
        .script(scenario["model"].clone())
        .project(run.project())
        .data_dir(run.data_dir())
        .durability(match spec["durability"].as_str() {
            Some("kept") => Durability::Kept,
            Some("durable") => Durability::Durable,
            _ => Durability::Ephemeral,
        });
    let config = serde_json::json!({"path": run.counter()});
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
    if let Some(answers) = spec["answers"].as_array() {
        builder = builder.answers(
            answers
                .iter()
                .map(|a| match a {
                    Value::String(s) if s == "allow" => Answer::Allow,
                    Value::String(_) => Answer::Declined { reason: None },
                    other => Answer::Value(other["value"].as_str().unwrap_or_default().into()),
                })
                .collect(),
        );
    }
    builder.build().await
}

/// Whether a scenario applies to a placement.
pub fn applies(scenario: &Value, placement: &Placement) -> bool {
    match scenario["placements"].as_array() {
        None => true,
        Some(list) => list.iter().any(|p| {
            p == "inProcess" && matches!(placement, Placement::InProcess)
                || p.as_str() == Some(&placement.name())
                || p == "process" && matches!(placement, Placement::Process { .. })
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

    let mut current: Option<(Agent, modular_agent::Session)> = None;
    let mut session_id = None;
    for (index, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
        let expect = &step["expect"];
        let mut result = None;
        if let Some(prompt) = step["prompt"].as_str() {
            if let Some(crash) = step.get("crashWhen") {
                match crash_run(crash_agent, path, &run, index, crash) {
                    Ok(id) => session_id = Some(id),
                    Err(e) => fail(index, e),
                }
                continue;
            }
            if current.is_none() {
                match agent(&scenario, &run).await {
                    Ok(a) => match a.session().await {
                        Ok(s) => {
                            session_id = Some(s.id().to_string());
                            current = Some((a, s));
                        }
                        Err(e) => {
                            fail(index, format!("session: {e}"));
                            break;
                        }
                    },
                    Err(e) => {
                        check_error(expect, &e, &mut |w| fail(index, w));
                        break;
                    }
                }
            }
            let (_, session) = current.as_ref().unwrap();
            match session.prompt(prompt).await {
                Ok(r) => result = Some(r),
                Err(e) => {
                    check_error(expect, &e, &mut |w| fail(index, w));
                    continue;
                }
            }
        } else if step["reopen"] == true {
            if let Some((a, _)) = current.take() {
                let _ = a.close().await;
            }
            let Some(id) = session_id.clone() else {
                fail(index, "no session to reopen".into());
                break;
            };
            let opened = match agent(&scenario, &run).await {
                Ok(a) => a.open_session(&id).await.map(|s| (a, s)),
                Err(e) => Err(e),
            };
            match opened {
                Ok((a, s)) => {
                    result = s.last_turn().ok().flatten();
                    current = Some((a, s));
                }
                Err(e) => {
                    fail(index, format!("reopen: {e}"));
                    break;
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
                if let Some(text) = w["text"].as_str()
                    && g.text() != text
                {
                    fail(
                        index,
                        format!("toolResult text: want {text:?}, got {:?}", g.text()),
                    );
                }
            }
        }
        if let Some(want) = expect["records"].as_array() {
            let (_, session) = current.as_ref().unwrap();
            let kinds: Vec<String> = session
                .history()
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
    if let Some((a, _)) = current {
        let _ = a.close().await;
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
    run: &Run,
    step: usize,
    crash: &Value,
) -> Result<String, String> {
    let mut child = Command::new(bin)
        .arg(path)
        .arg(&run.dir)
        .arg(step.to_string())
        .args(run.placement.to_args())
        .stdout(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("spawn: {e}"))?;
    let pid = child.id() as i32;
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    let id = line
        .trim()
        .strip_prefix("SESSION ")
        .ok_or(format!("no session id: {line:?}"))?
        .to_string();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let reached = match crash.get("count").and_then(Value::as_u64) {
            Some(n) => fixtures::count(&run.counter()) >= n,
            None => return Err("only crashWhen.count is supported yet".into()),
        };
        if reached {
            break;
        }
        if Instant::now() > deadline {
            unsafe { libc::kill(-pid, libc::SIGKILL) };
            let _ = child.wait();
            return Err("the crash condition never held".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    unsafe { libc::kill(-pid, libc::SIGKILL) };
    let _ = child.wait();
    Ok(id)
}
