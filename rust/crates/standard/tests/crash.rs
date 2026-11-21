#![cfg(target_os = "linux")] // Needs Linux child subreaper and strong containment.
//! A kill in the middle of a code run, through the real binary. The durable
//! Runtime carries the turn on when the session is reopened. Neither the code
//! run nor the command it had started runs again.
use std::{
    io::{BufRead, BufReader},
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn ma(data: &Path, project: &Path, script: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_ma"));
    command
        .env("MODULAR_AGENT_DATA_DIR", data)
        .env("MODULAR_AGENT_SCRIPT", script)
        .env_remove("MODULAR_AGENT_HISTORY_URL")
        .args(["--project", project.to_str().unwrap()]);
    command
}
fn call(code: &str) -> serde_json::Value {
    serde_json::json!({"toolCalls":[{"name":"codemode","input":{"code":code}}]})
}

#[test]
fn a_killed_code_run_is_settled_as_unknown_and_never_repeated() {
    // Reap the killed agent's descendants here instead of leaving them to PID 1.
    unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) };
    let root = tempfile::tempdir().unwrap();
    let (data, project) = (root.path().join("data"), root.path().join("project"));
    std::fs::create_dir_all(&project).unwrap();
    let first = root.path().join("first.json");
    std::fs::write(
        &first,
        serde_json::json!([call(
            "tools.write('before.txt', 'x')\ntools.exec('echo run >> runs.txt; sleep 30')\ntools.write('after.txt', 'x')"
        )])
        .to_string(),
    )
    .unwrap();
    let mut child = ma(&data, &project, &first)
        .args(["-p", "go", "--json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let session = loop {
        let line = lines.next().expect("agent exited early").unwrap();
        let event: serde_json::Value = serde_json::from_str(&line).unwrap();
        if event["type"] == "sessionStarted" {
            break event["sessionId"].as_str().unwrap().to_owned();
        }
    };
    let deadline = Instant::now() + Duration::from_secs(20);
    while !project.join("runs.txt").exists() {
        assert!(Instant::now() < deadline, "the command never started");
        std::thread::sleep(Duration::from_millis(20));
    }
    child.kill().unwrap();
    child.wait().unwrap();

    let second = root.path().join("second.json");
    std::fs::write(
        &second,
        serde_json::json!([{}, {"text":"It was interrupted."}]).to_string(),
    )
    .unwrap();
    let reopened = ma(&data, &project, &second)
        .args(["--session", &session, "--json"])
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert!(
        reopened.status.success(),
        "{}",
        String::from_utf8_lossy(&reopened.stderr)
    );
    let events: Vec<serde_json::Value> = String::from_utf8_lossy(&reopened.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    let turn = events
        .iter()
        .find(|e| e["type"] == "turnEnded")
        .expect("no turn result");
    assert_eq!(turn["data"]["result"]["text"], "It was interrupted.");

    // One run of the command, and nothing after the kill point was done.
    assert_eq!(
        std::fs::read_to_string(project.join("runs.txt")).unwrap(),
        "run\n"
    );
    assert!(project.join("before.txt").exists());
    assert!(!project.join("after.txt").exists());

    let history = ma(&data, &project, &second)
        .args(["--session", &session, "--history"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&history.stdout);
    let unknown = text.matches("outcomeUnknown").count() + text.matches("\"unknown\"").count();
    assert!(
        unknown >= 2,
        "the code run and its command should both be unknown:\n{text}"
    );
}
