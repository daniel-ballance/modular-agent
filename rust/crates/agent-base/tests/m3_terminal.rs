use agent_api::*;
use std::process::Stdio;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};
#[tokio::test]
async fn terminal_secret_answers_bypass_ordinary_history_and_event_input() {
    let root = tempfile::TempDir::new().unwrap();
    let project = root.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let script = root.path().join("script.json");
    std::fs::write(
        &script,
        serde_json::to_vec(&json!([
            ModelResponse::calls(vec![ToolCall::new(
                "ask_user",
                json!({"kind":"secret","question":"Token?","credential":"terminal_token"})
            )]),
            ModelResponse::text("Stored terminal_token")
        ]))
        .unwrap(),
    )
    .unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_modular-agent"))
        .arg("--json")
        .arg("--data-dir")
        .arg(root.path())
        .arg("--project")
        .arg(&project)
        .arg("--global-config")
        .arg(root.path().join("no-settings"))
        .arg("--credential-file")
        .arg(root.path().join("NO-KEY"))
        .arg("--fake-script")
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    input.write_all(b"start\n").await.unwrap();
    let mut events = vec![];
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while let Some(line) = lines.next_line().await.unwrap() {
            let event: Event = serde_json::from_str(&line).unwrap();
            if event.kind == "request.opened" {
                let command = format!(
                    "/answer {} TERMINAL-PRIVATE-547\n",
                    event.content["id"].as_str().unwrap()
                );
                input.write_all(command.as_bytes()).await.unwrap();
            }
            let done = event.kind == "turn.result";
            events.push(event);
            if done {
                break;
            }
        }
    })
    .await
    .unwrap();
    input.write_all(b"/quit\n").await.unwrap();
    drop(input);
    while let Some(line) = lines.next_line().await.unwrap() {
        events.push(serde_json::from_str::<Event>(&line).unwrap());
    }
    assert!(child.wait_with_output().await.unwrap().status.success());
    assert!(
        !serde_json::to_string(&events)
            .unwrap()
            .contains("TERMINAL-PRIVATE-547")
    );
    assert_eq!(
        credentials_file::SecretFile(root.path().join("answers/credentials.json"))
            .read("terminal_token")
            .unwrap(),
        "TERMINAL-PRIVATE-547"
    );
    let entries: Vec<_> = std::fs::read_dir(root.path().join("sessions"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    assert_eq!(entries.len(), 1);
    let data = std::fs::read_to_string(&entries[0]).unwrap();
    assert!(!data.contains("TERMINAL-PRIVATE-547"));
    let store = history_fs::FileHistory::new(&root.path().join("sessions")).unwrap();
    let data = store.list(None).unwrap().pop().unwrap();
    assert_eq!(
        data.entries
            .iter()
            .filter(|e| e.kind == "input.accepted")
            .count(),
        1
    );
    assert_eq!(
        data.entries
            .iter()
            .filter(|e| e.kind == "request.answer")
            .count(),
        1
    );
}
#[tokio::test]
async fn terminal_eof_cancels_unanswerable_questions_without_hanging() {
    let root = tempfile::TempDir::new().unwrap();
    let project = root.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let script = root.path().join("script.json");
    std::fs::write(
        &script,
        serde_json::to_vec(&json!([ModelResponse::calls(vec![ToolCall::new(
            "ask_user",
            json!({"question":"Nobody can answer after EOF?"})
        )])]))
        .unwrap(),
    )
    .unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_modular-agent"))
        .arg("--json")
        .arg("--data-dir")
        .arg(root.path())
        .arg("--project")
        .arg(&project)
        .arg("--global-config")
        .arg(root.path().join("no-settings"))
        .arg("--fake-script")
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"start\n")
        .await
        .unwrap();
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert!(result.status.success());
    let output = String::from_utf8(result.stdout).unwrap();
    assert!(
        output
            .lines()
            .map(|l| serde_json::from_str::<Event>(l).unwrap())
            .any(|e| e.kind == "turn.end" && e.content["outcome"] == "cancelled")
    );
}
