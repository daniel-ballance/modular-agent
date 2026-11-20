use serde_json::{Value, json};
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

#[tokio::test]
async fn drive_one_acp_prompt() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let project = tempfile::tempdir().unwrap();
        let cwd = project.path().canonicalize().unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_sdk-acp-test-agent"))
            .current_dir(&cwd)
            .env_remove("MODULAR_AGENT_PLUGINS")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut text = String::new();

        // Send one ACP request and read updates until its reply arrives.
        macro_rules! call {
            ($id:literal, $method:literal, $params:expr) => {{
                let request = json!({
                    "jsonrpc": "2.0", "id": $id, "method": $method, "params": $params
                });
                input.write_all(format!("{request}\n").as_bytes()).await.unwrap();
                loop {
                    let line = lines.next_line().await.unwrap().expect("ACP disconnected");
                    let frame: Value = serde_json::from_str(&line).unwrap();
                    if frame["id"] == $id {
                        assert!(frame["error"].is_null(), "{frame}");
                        break frame["result"].clone();
                    }
                    let update = &frame["params"]["update"];
                    if frame["method"] == "session/update"
                        && update["sessionUpdate"] == "agent_message_chunk"
                    {
                        text.push_str(update["content"]["text"].as_str().unwrap());
                    }
                }
            }};
        }

        call!(1, "initialize", json!({"protocolVersion": 1}));
        let session = call!(2, "session/new", json!({"cwd": cwd, "mcpServers": []}));
        let reply = call!(
            3,
            "session/prompt",
            json!({
                "sessionId": session["sessionId"],
                "prompt": [{"type": "text", "text": "Say hello."}]
            })
        );
        assert_eq!(reply["stopReason"], "end_turn");
        assert_eq!(text, "Hello over ACP.");
        drop(input);
        assert!(child.wait().await.unwrap().success());
    })
    .await
    .expect("ACP timed out");
}
