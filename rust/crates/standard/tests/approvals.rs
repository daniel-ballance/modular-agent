//! Run the shipped program against a scripted model in an empty configuration.
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Command, Stdio},
};

fn ma(dir: &Path) -> Command {
    let project = dir.join("project");
    fs::create_dir_all(&project).unwrap();
    let script = dir.join("script");
    fs::write(&script, json!([{"toolCalls":[{"name":"codemode","input":{"code":"tools.write(path='effect', content='approved')"}}]}, {"text":"done"}]).to_string()).unwrap();
    let mut ma = Command::new(env!("CARGO_BIN_EXE_ma"));
    ma.env("MODULAR_AGENT_SCRIPT", script)
        .env("MODULAR_AGENT_DATA_DIR", dir)
        .env_remove("MODULAR_AGENT_CONFORMANCE")
        .env_remove("MODULAR_AGENT_HISTORY_URL")
        .arg("--project")
        .arg(project);
    ma
}
fn declaration(dir: &Path, flags: &[&str]) -> Value {
    let out = ma(dir).args(flags).arg("--declaration").output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}
#[test]
fn only_the_operator_configures_approval_and_its_maximum() {
    let dir = tempfile::tempdir().unwrap();
    let dir = dir.path();
    let _ = ma(dir);
    fs::write(
        dir.join("project/.modular-agent.json"),
        r#"{"approval":"off","approval_wait":"untilDeadline","approvalWait":"untilDeadline"}"#,
    )
    .unwrap();
    fs::write(dir.join("policy.json"), r#"{"approvalWaitMaxMs":60000}"#).unwrap();
    let d = declaration(dir, &[]);
    assert!(d.get("approvalCoversNested").is_none() && d.get("approvalsOutlastTurns").is_none());
    fs::write(
        dir.join("settings.json"),
        r#"{"approval":"ask","approval_wait":"untilDeadline"}"#,
    )
    .unwrap();
    let d = declaration(dir, &[]);
    assert_eq!(d["approvalCoversNested"], true);
    assert_eq!(d["approvalsOutlastTurns"], true);
    let out = ma(dir).args(["-p", "Run"]).output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!dir.join("project/effect").exists());
    let store = modular_agent::file_history(dir.join("state/sessions")).unwrap();
    let history = store.sessions(None).unwrap();
    let info = store.session_info(&history[0].id).unwrap();
    assert_eq!(info.settings["approvalWait"], "untilDeadline");
    let out = ma(dir)
        .args(["--approval", "off", "-p", "Run"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        fs::read_to_string(dir.join("project/effect")).unwrap(),
        "approved"
    );
    for max in ["0", "null", "1.5", "9007199254740992"] {
        fs::write(
            dir.join("policy.json"),
            format!("{{\"approvalWaitMaxMs\":{max}}}"),
        )
        .unwrap();
        let out = ma(dir).arg("--declaration").output().unwrap();
        assert!(!out.status.success());
        let message = String::from_utf8_lossy(&out.stderr);
        assert!(
            message.contains("policy.json") && message.contains("approvalWaitMaxMs"),
            "{message}"
        );
    }
}
#[test]
fn an_unrecognized_saved_policy_refuses_without_asking_on_reopen() {
    let scratch = tempfile::tempdir().unwrap();
    let dir = scratch.path();
    let script = dir.join("reopen-script");
    fs::write(
        &script,
        json!([
            {"text":"ready"},
            {"toolCalls":[{"name":"codemode","input":{"code":"tools.write(path='effect', content='unexpected')"}}]},
            {"text":"done"}
        ])
        .to_string(),
    )
    .unwrap();
    let started = ma(dir)
        .env("MODULAR_AGENT_SCRIPT", &script)
        .args(["-p", "Start"])
        .output()
        .unwrap();
    assert!(started.status.success(), "{:?}", started);

    let sessions = dir.join("state/sessions");
    let store = modular_agent::file_history(&sessions).unwrap();
    let id = &store.sessions(None).unwrap()[0].id;
    let path = sessions.join(format!("{id}.json"));
    let mut saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    saved["defaults"]["approval"] = json!("future-policy");
    fs::write(path, serde_json::to_vec(&saved).unwrap()).unwrap();

    let reopened = ma(dir)
        .env("MODULAR_AGENT_SCRIPT", script)
        .args(["--approval", "off", "-c", "-p", "Resume"])
        .output()
        .unwrap();
    assert!(reopened.status.success(), "{:?}", reopened);
    let history = ma(dir).args(["-c", "--history"]).output().unwrap();
    assert!(history.status.success(), "{:?}", history);
    let entries: Vec<Value> = serde_json::from_slice(&history.stdout).unwrap();
    assert!(
        entries.iter().all(|entry| entry["kind"] != "inputRequest"),
        "the unknown policy must refuse without asking"
    );
    assert!(
        entries
            .iter()
            .any(|entry| entry["kind"] == "toolResult" && entry["data"]["status"] == "refused")
    );
    assert!(!dir.join("project/effect").exists());
}

#[test]
fn the_terminal_displays_the_script_and_reads_one_decision() {
    for (answer, exists) in [("y", true), ("n", false)] {
        let dir = tempfile::tempdir().unwrap();
        let mut child = ma(dir.path())
            .args(["--approval", "ask"])
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take();
        writeln!(stdin.as_mut().unwrap(), "Run").unwrap();
        let mut prompts = 0;
        let mut script = false;
        for line in BufReader::new(child.stderr.take().unwrap()).lines() {
            let line = line.unwrap();
            if line.contains("covers")
                && line.contains("nested")
                && line.contains("tools.write(path='effect', content='approved')")
            {
                script = true;
            }
            if line.contains("(y/n)") {
                prompts += 1;
                // EOF drains the turn; it does not supply consent.
                writeln!(stdin.take().unwrap(), "{answer}").unwrap();
            }
        }
        drop(stdin);
        assert!(child.wait().unwrap().success());
        assert!(script);
        assert_eq!(prompts, 1);
        assert_eq!(dir.path().join("project/effect").exists(), exists);
    }
}

#[test]
fn printing_history_records_no_approval_policy() {
    let dir = tempfile::tempdir().unwrap();
    let dir = dir.path();
    let script = dir.join("hello");
    fs::write(&script, json!([{"text":"hello"}]).to_string()).unwrap();
    let started = ma(dir)
        .env("MODULAR_AGENT_SCRIPT", &script)
        .args(["-p", "Hello"])
        .output()
        .unwrap();
    assert!(started.status.success(), "{:?}", started);
    for _ in 0..2 {
        let history = ma(dir)
            .env("MODULAR_AGENT_SCRIPT", &script)
            .args(["-c", "--history"])
            .output()
            .unwrap();
        assert!(history.status.success(), "{:?}", history);
        let entries: Vec<Value> = serde_json::from_slice(&history.stdout).unwrap();
        let settings: Vec<&Value> = entries.iter().filter(|e| e["kind"] == "setting").collect();
        assert!(
            settings
                .iter()
                .all(|e| !e.to_string().contains("\"approval\"")),
            "printing history recorded an approval policy: {settings:?}"
        );
    }
}
