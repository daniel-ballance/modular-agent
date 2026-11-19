use serde_json::{Value, json};
use std::{fs, process::Command};

#[test]
fn data_dir_is_authoritative_and_json_uses_sdk_event_ids() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    let data = root.path().join("data");
    let script = root.path().join("script.json");
    fs::create_dir(&project).unwrap();
    fs::create_dir(&data).unwrap();
    fs::write(&script, r#"[{"text":"hello"}]"#).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_ma"))
        .current_dir(&project)
        .env("MODULAR_AGENT_DATA_DIR", &data)
        .env("XDG_STATE_HOME", root.path().join("unused"))
        .env("MODULAR_AGENT_SCRIPT", &script)
        .env_remove("MODULAR_AGENT_HISTORY_URL")
        .env_remove("MODULAR_AGENT_CONFORMANCE")
        .args(["--trust-project", "--json", "-p", "hello"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        data.join("state/sessions")
            .read_dir()
            .unwrap()
            .next()
            .is_some()
    );
    assert!(!data.join("sessions").exists());
    assert!(!root.path().join("unused").exists());
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(data.join("trusted-projects.json")).unwrap())
            .unwrap(),
        json!({project.canonicalize().unwrap().to_str().unwrap(): true})
    );

    let events = String::from_utf8(output.stdout).unwrap();
    let events: Vec<Value> = events
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let find = |kind| events.iter().find(|event| event["type"] == kind).unwrap();
    let started = find("sessionStarted");
    let text = find("text");
    let ended = find("turnEnded");
    assert_eq!(text["data"]["delta"], "hello");
    assert_eq!(text["sessionId"], started["sessionId"]);
    assert_eq!(text["turnId"], ended["turnId"]);
    assert!(text["stepId"].is_string());
    assert!(
        events
            .iter()
            .all(|e| e["time"].is_u64() && e.get("data").is_some() && e.get("scope").is_none())
    );
}
