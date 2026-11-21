use serde_json::{Value, json};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{ChildStdin, ChildStdout, Command},
};

async fn rpc(
    input: &mut ChildStdin,
    output: &mut Lines<BufReader<ChildStdout>>,
    id: u64,
    method: &str,
    params: Value,
) -> Value {
    let request = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
    input
        .write_all(format!("{request}\n").as_bytes())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let line = output.next_line().await.unwrap().expect("ma closed ACP");
            let reply: Value = serde_json::from_str(&line).unwrap();
            if reply["id"] == id {
                assert!(reply.get("error").is_none(), "{method}: {reply}");
                break reply["result"].clone();
            }
        }
    })
    .await
    .expect("ma did not reply")
}

#[tokio::test]
async fn ma_acp_new_and_settings_leave_no_history_until_prompt() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    let data = root.path().join("data");
    let script = root.path().join("responses.json");
    std::fs::create_dir(&project).unwrap();
    std::fs::write(&script, r#"[{"text":"done"}]"#).unwrap();
    let mut ma = Command::new(env!("CARGO_BIN_EXE_ma"))
        .arg("--acp")
        .arg("--project")
        .arg(&project)
        .env("MODULAR_AGENT_DATA_DIR", &data)
        .env("MODULAR_AGENT_SCRIPT", &script)
        .env_remove("MODULAR_AGENT_HISTORY_URL")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = ma.stdin.take().unwrap();
    let mut output = BufReader::new(ma.stdout.take().unwrap()).lines();
    rpc(
        &mut input,
        &mut output,
        1,
        "initialize",
        json!({"protocolVersion":1}),
    )
    .await;
    let store = modular_agent::file_history(data.join("state/sessions")).unwrap();
    let new_params = |project: &Path| json!({"cwd":project,"mcpServers":[]});
    for offset in [2, 6] {
        let new = rpc(
            &mut input,
            &mut output,
            offset,
            "session/new",
            new_params(&project),
        )
        .await;
        let session = new["sessionId"].as_str().unwrap();
        assert_eq!(
            store.session_info(session).unwrap_err().code(),
            modular_agent::Code::NotFound
        );
        rpc(
            &mut input,
            &mut output,
            offset + 1,
            "session/set_config_option",
            json!({"sessionId":session,"configId":"approval","value":"off"}),
        )
        .await;
        assert_eq!(
            store.session_info(session).unwrap_err().code(),
            modular_agent::Code::NotFound
        );
        if offset == 6 {
            rpc(
                &mut input,
                &mut output,
                offset + 2,
                "session/prompt",
                json!({"sessionId":session,"prompt":[{"type":"text","text":"hello"}]}),
            )
            .await;
            assert_eq!(
                store.session_info(session).unwrap().settings["approval"],
                "off"
            );
        }
        rpc(
            &mut input,
            &mut output,
            offset + 3,
            "session/close",
            json!({"sessionId":session}),
        )
        .await;
        assert_eq!(
            store.sessions(None).unwrap().len(),
            usize::from(offset == 6)
        );
    }
    drop(input);
    let status = tokio::time::timeout(Duration::from_secs(10), ma.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(status.success(), "{status}");
}
