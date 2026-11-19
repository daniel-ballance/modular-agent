//! A runner for the shared SDK scenarios (docs/sdk/testing.md#the-shared-scenarios).
//! In-process placement only, for now.
use modular_agent::{
    Agent, Answer, Approval, Durability,
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

/// Where one run of one scenario keeps its files. It survives a crash.
pub struct Run {
    pub dir: PathBuf,
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
    for name in spec["plugins"].as_array().into_iter().flatten() {
        let name = name.as_str().unwrap();
        builder = match fixtures::fixture(name, &run.counter()) {
            Some(fixtures::Fixture::Tool(tool)) => builder.tool(tool),
            Some(fixtures::Fixture::Base(plugin)) => builder.base_plugin(plugin),
            None => panic!("no fixture named {name}"),
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

/// Run a scenario. Returns every failed expectation, or none.
/// `crash_agent` is the `scenario-agent` binary, for steps that crash.
pub async fn run(path: &Path, crash_agent: &Path) -> Vec<String> {
    let scenario = load(path);
    let name = scenario["scenario"].as_str().unwrap_or("?").to_string();
    let tmp = tempfile::Builder::new()
        .prefix("sdk-scenario-")
        .tempdir()
        .unwrap();
    let run = Run {
        dir: tmp.path().to_path_buf(),
    };
    let mut failures = vec![];
    let mut fail = |step: usize, what: String| {
        failures.push(format!("{name} (inProcess) step {step}: {what}"))
    };

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
