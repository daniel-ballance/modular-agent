use serde_json::{Value, json};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

struct Wire {
    child: Child,
    tx: ChildStdin,
    rx: tokio::io::Lines<BufReader<ChildStdout>>,
}

impl Wire {
    async fn launch(project: &std::path::Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_sdk-acp-test-agent"))
            .arg(project.join("state"))
            .current_dir(project)
            .env_remove("MODULAR_AGENT_PLUGINS")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let tx = child.stdin.take().unwrap();
        let rx = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut wire = Self { child, tx, rx };
        wire.call(
            1,
            "initialize",
            json!({"protocolVersion":1,"clientCapabilities":{}}),
        )
        .await;
        wire
    }

    async fn send(&mut self, id: u32, method: &str, params: Value) {
        self.tx
            .write_all(
                format!(
                    "{}\n",
                    json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    }

    async fn next(&mut self) -> Value {
        serde_json::from_str(
            &self
                .rx
                .next_line()
                .await
                .unwrap()
                .expect("ACP disconnected"),
        )
        .unwrap()
    }

    async fn call(&mut self, id: u32, method: &str, params: Value) -> Value {
        self.send(id, method, params).await;
        loop {
            let message = self.next().await;
            if message["id"] == id {
                assert!(message["error"].is_null(), "{method}: {message}");
                return message["result"].clone();
            }
        }
    }
}

#[tokio::test]
async fn acp_reopen_does_not_wait_for_an_interrupted_turn() {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let project = tempfile::tempdir().unwrap();
        let cwd = project.path().canonicalize().unwrap();
        let mut first = Wire::launch(&cwd).await;
        let session = first
            .call(2, "session/new", json!({"cwd":cwd,"mcpServers":[]}))
            .await;
        let sid = &session["sessionId"];
        first
            .send(
                3,
                "session/prompt",
                json!({"sessionId":sid,"prompt":[{"type":"text","text":"first"}]}),
            )
            .await;
        loop {
            if first.next().await["params"]["update"]["content"]["text"] == "attempt is live" {
                break;
            }
        }
        let queued = first
            .call(
                4,
                "_modular-agent/input",
                json!({"sessionId":sid,"content":"old queued input","when":"after"}),
            )
            .await;
        first.child.kill().await.unwrap();

        let mut reopened = Wire::launch(&cwd).await;
        let reply = reopened
            .call(
                2,
                "session/resume",
                json!({"sessionId":sid,"cwd":cwd,"mcpServers":[]}),
            )
            .await;
        assert_eq!(
            reply["_meta"]["modular-agent"]["handedBack"],
            json!([
                {"inputId":queued["inputId"],"content":[{"type":"text","text":"old queued input"}]}
            ])
        );
        let history = reopened
            .call(3, "_modular-agent/history", json!({"sessionId":sid}))
            .await;
        assert!(
            !history["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["kind"] == "turnEnd")
        );
        let fresh = reopened
            .call(
                4,
                "_modular-agent/input",
                json!({"sessionId":sid,"content":"fresh input","when":"now"}),
            )
            .await;
        assert_eq!(fresh["taken"], "after");
        reopened
            .send(5, "session/cancel", json!({"sessionId":sid}))
            .await;
        reopened
            .call(6, "session/close", json!({"sessionId":sid}))
            .await;
        drop(reopened.tx);
        assert!(reopened.child.wait().await.unwrap().success());
    })
    .await
    .expect("ACP waited for the held attempt or failed to cancel it");
}

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
