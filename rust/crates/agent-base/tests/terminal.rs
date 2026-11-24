use agent_api::*;
use std::{path::Path, process::Stdio, sync::Arc};
use tempfile::TempDir;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};
fn command(root: &Path, project: &Path, script: &Path) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_modular-agent"));
    c.args([
        "--data-dir",
        root.to_str().unwrap(),
        "--project",
        project.to_str().unwrap(),
        "--global-config",
        root.join("missing-config").to_str().unwrap(),
        "--fake-script",
        script.to_str().unwrap(),
    ]);
    c.kill_on_drop(true);
    c
}
fn setup() -> (TempDir, TempDir, std::path::PathBuf) {
    let root = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();
    let script = root.path().join("script.json");
    std::fs::write(&script, r#"["offline answer","continued answer"]"#).unwrap();
    (root, project, script)
}
#[tokio::test]
async fn print_and_json_modes_run_in_new_processes_and_continue_history() {
    let (root, project, script) = setup();
    let first = command(root.path(), project.path(), &script)
        .args(["-p", "first question"])
        .output()
        .await
        .unwrap();
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&first.stdout).trim(),
        "offline answer"
    );
    let stderr = String::from_utf8(first.stderr).unwrap();
    let id = stderr.trim().strip_prefix("Session: ").unwrap();
    let second = command(root.path(), project.path(), &script)
        .args(["--session", id, "--json", "--prompt", "continue"])
        .output()
        .await
        .unwrap();
    assert!(second.status.success());
    let events: Vec<Event> = String::from_utf8(second.stdout)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert!(events.iter().any(|e| e.kind == "turn.result"));
    let store = history_fs::FileHistory::new(&root.path().join("sessions")).unwrap();
    let data = store.load(id).unwrap();
    assert_eq!(data.entries.iter().filter(|e| e.kind == "input").count(), 2);
}
#[tokio::test]
async fn line_mode_accepts_lines_and_slash_commands_without_inference() {
    let (root, project, script) = setup();
    let mut child = command(root.path(), project.path(), &script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"/thinking high\nhello\n")
        .await
        .unwrap();
    let result = child.wait_with_output().await.unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("offline answer"));
    assert!(String::from_utf8_lossy(&result.stdout).contains("high"));
}
#[tokio::test]
async fn inspecting_settings_in_a_fresh_session_leaves_no_session_file() {
    let (root, project, script) = setup();
    let result = command(root.path(), project.path(), &script)
        .args(["-p", "/settings"])
        .output()
        .await
        .unwrap();
    assert!(result.status.success());
    assert!(String::from_utf8_lossy(&result.stdout).contains("fake"));
    let store = history_fs::FileHistory::new(&root.path().join("sessions")).unwrap();
    assert!(store.list(None).unwrap().is_empty());
}
#[tokio::test]
async fn another_process_cannot_write_an_open_session() {
    let (root, project, script) = setup();
    let result = command(root.path(), project.path(), &script)
        .args(["-p", "hello"])
        .output()
        .await
        .unwrap();
    let stderr = String::from_utf8(result.stderr).unwrap();
    let id = stderr.trim().strip_prefix("Session: ").unwrap();
    let mut holder = command(root.path(), project.path(), &script)
        .args(["--session", id, "--json"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut reader = BufReader::new(holder.stdout.take().unwrap()).lines();
    let opened = tokio::time::timeout(std::time::Duration::from_secs(5), reader.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Event>(&opened).unwrap().kind,
        "session.open"
    );
    let refused = command(root.path(), project.path(), &script)
        .args(["--session", id, "-p", "clash"])
        .output()
        .await
        .unwrap();
    assert!(!refused.status.success());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("already held"));
    // Close by PID-owned handle and wait. No pattern-based process killing.
    holder.kill().await.unwrap();
    holder.wait().await.unwrap();
    let reopened = command(root.path(), project.path(), &script)
        .args(["--session", id, "-p", "after holder exit"])
        .output()
        .await
        .unwrap();
    assert!(reopened.status.success());
}
#[test]
fn openai_adapter_preserves_opaque_reasoning_tool_ids_and_unknown_content_offline() {
    let response = json!({"status":"completed","output":[
        {"type":"reasoning","id":"r1","encrypted_content":"opaque-test-value"},
        {"type":"function_call","id":"fc1","call_id":"call1","name":"read","arguments":"{\"path\":\"fact.txt\"}"},
        {"type":"future_item","data":{"keep":17}}
    ],"usage":{"input_tokens":12,"output_tokens":7,"input_tokens_details":{"cached_tokens":4}}});
    let normalized = provider_openai::normalize(&response).unwrap();
    assert_eq!(normalized.tool_calls()[0].id, "call1");
    assert_eq!(normalized.usage.input_tokens, 12);
    let request = ModelRequest {
        thinking: "low".into(),
        output_limit: 512,
        messages: vec![
            Message {
                role: "assistant".into(),
                parts: normalized.parts,
                opaque: normalized.opaque,
                call: None,
            },
            Message {
                call: Some("call1".into()),
                ..Message::text("tool", "fact=417")
            },
        ],
        ..ModelRequest::default()
    };
    let body = provider_openai::request_body(&request).unwrap();
    assert_eq!(body["model"], "gpt-6-luna");
    assert_eq!(body["store"], false);
    assert_eq!(body["input"][0]["encrypted_content"], "opaque-test-value");
    assert_eq!(body["input"][2]["data"]["keep"], 17);
    assert_eq!(body["input"][3]["type"], "function_call_output");
    assert_eq!(body["input"][3]["call_id"], "call1");
}
#[tokio::test]
async fn credentials_are_read_on_demand_from_the_credential_store() {
    use agent_harness::Harness;
    let root = TempDir::new().unwrap();
    let file = root.path().join("key");
    let h = Harness::new();
    h.load(Arc::new(credentials_file::FileCredentials {
        openai_key: file.clone(),
    }))
    .await
    .unwrap();
    // Only the plugin that claimed the name can read a Provider's credential.
    struct Claims(Arc<std::sync::Mutex<Option<CredentialClaim>>>);
    impl Plugin for Claims {
        fn name(&self) -> &str {
            "provider.openai"
        }
        fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
            *self.0.lock().unwrap() = Some(r.claim_credentials(&["openai"])?);
            Ok(())
        }
    }
    let slot = Arc::new(std::sync::Mutex::new(None));
    h.load(Arc::new(Claims(slot.clone()))).await.unwrap();
    let claim = slot.lock().unwrap().clone().unwrap();
    let store: Arc<dyn CredentialStore> = capability(h.as_ref(), "credentials").unwrap();
    assert!(store.provider(&claim, "openai").is_err());
    std::fs::write(&file, "TEST-ONLY-NOT-A-KEY\n").unwrap();
    assert_eq!(
        store.provider(&claim, "openai").unwrap(),
        "TEST-ONLY-NOT-A-KEY"
    );
    std::fs::write(&file, "CHANGED-TEST-VALUE").unwrap();
    assert_eq!(
        store.provider(&claim, "openai").unwrap(),
        "CHANGED-TEST-VALUE"
    );
    assert!(store.get("openai").is_err());
    let answers = root.path().join("answers");
    std::fs::create_dir(&answers).unwrap();
    std::fs::write(answers.join("example"), "unused-fixture").unwrap();
    assert!(store.get("example").is_err());
    store.put("example", "answer-from-journal").unwrap();
    assert_eq!(store.get("example").unwrap(), "answer-from-journal");
    let journal = answers.join("credentials.json");
    let invalid = br#"{"example":"not-a-journal"}"#;
    std::fs::write(&journal, invalid).unwrap();
    assert!(store.get("example").is_err());
    assert!(
        store
            .put("example", "cannot-replace-an-unrecognized-journal")
            .is_err()
    );
    assert_eq!(std::fs::read(journal).unwrap(), invalid);
}
