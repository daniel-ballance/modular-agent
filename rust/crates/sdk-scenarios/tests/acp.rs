use serde_json::{Value, json};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

#[tokio::test]
async fn sdk_agent_answers_an_acp_prompt_and_reuses_its_composition() {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let project = tempfile::tempdir().unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_sdk-acp-test-agent"))
            .current_dir(project.path()).env_remove("MODULAR_AGENT_PLUGINS")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).kill_on_drop(true)
            .spawn().unwrap();
        let mut tx = child.stdin.take().unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut id = 0;
        let mut text = String::new();
        macro_rules! call {
            ($method:literal,$params:expr) => {{
                id += 1;
                tx.write_all(format!("{}\n", json!({"jsonrpc":"2.0","id":id,"method":$method,"params":$params})).as_bytes()).await.unwrap();
                loop {
                    let line = lines.next_line().await.unwrap().expect("ACP disconnected");
                    let message:Value = serde_json::from_str(&line).unwrap();
                    if message["id"] == id {
                        assert!(message["error"].is_null(), "{message}");
                        break message["result"].clone();
                    }
                    if message["method"] == "session/update"
                        && message["params"]["update"]["sessionUpdate"] == "agent_message_chunk" {
                        text.push_str(message["params"]["update"]["content"]["text"].as_str().unwrap());
                    }
                }
            }}
        }
        let initialize = call!("initialize", json!({"protocolVersion":1,"clientCapabilities":{}}));
        assert_eq!(initialize["_meta"]["modular-agent"]["declaration"]["portableSessions"],false);
        for _ in 0..2 {
            let cwd = project.path().canonicalize().unwrap();
            let session = call!("session/new",json!({"cwd":cwd,"mcpServers":[]}));
            let id = &session["sessionId"];
            let reply = call!("session/prompt",json!({"sessionId":id,"prompt":[{"type":"text","text":"hello"}]}));
            assert_eq!(reply["stopReason"],"end_turn");
            let _ = call!("session/close",json!({"sessionId":id}));
        }
        assert_eq!(text,"Hello over ACP.Hello over ACP.");
        drop(tx);
        assert!(child.wait().await.unwrap().success());
    }).await.expect("ACP timed out");
}
