//! ma's combined listener, not the kit controller. All state is disposable.
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::{fs, os::unix::fs::PermissionsExt, process::Stdio};
use tokio::io::{AsyncBufReadExt, BufReader};

#[tokio::test]
async fn ma_serves_read_only_status_and_shares_the_writer_with_acp() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("token");
    let token = "ma-disposable-host-read-test-token";
    fs::write(&path, token)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    let script = dir.path().join("script");
    fs::write(&script, r#"[{"text":"Finished."}]"#)?;
    let mut ma = tokio::process::Command::new(env!("CARGO_BIN_EXE_ma"))
        .current_dir(dir.path())
        .env_clear()
        .env("HOME", dir.path())
        .env("PATH", std::env::var_os("PATH").unwrap())
        .env("TMPDIR", dir.path())
        .env("MODULAR_AGENT_DATA_DIR", dir.path().join("data"))
        .env("MODULAR_AGENT_SCRIPT", script)
        .args([
            "--trust-project",
            "--acp",
            "--agui",
            "--listen",
            "127.0.0.1:0",
            "--token-file",
        ])
        .arg(&path)
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let origin = BufReader::new(ma.stdout.take().unwrap())
        .lines()
        .next_line()
        .await?
        .context("ma did not start")?;
    let api = format!("{origin}/agui/v1");
    let client = reqwest::Client::new();
    let t: Value = client
        .post(format!("{api}/threads"))
        .bearer_auth(token)
        .json(&json!({}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let id = t["threadId"].as_str().context("thread")?;
    let thread = format!("{api}/threads/{id}");
    let snapshot: Value = client
        .get(&thread)
        .bearer_auth(token)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    assert!(snapshot["declaration"].get("runReceipts").is_none());
    assert!(snapshot["declaration"].get("waitCursor").is_none());
    assert_eq!(snapshot["runReceipts"], 1);
    let after = snapshot["waitCursor"].as_str().context("wait cursor")?;
    let feed = client
        .get(format!("{thread}/wait-closures?after={after}"))
        .bearer_auth(token)
        .send()
        .await?
        .error_for_status()?;
    assert_eq!(feed.headers()["content-type"], "text/event-stream");
    drop(feed);
    let post = json!({"threadId":id,"runId":"original","protocolVersion":"1.0","messages":[{"id":"new","role":"user","content":"Hello"}]});
    let events = client
        .post(format!("{api}/run"))
        .bearer_auth(token)
        .json(&post)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    assert!(events.contains("RUN_FINISHED"));
    let ws = transport_websocket::connect(
        &origin.replacen("http:", "ws:", 1),
        &path,
        transport_websocket::ACP,
    )
    .await?;
    let project = dir.path();
    transport_websocket::run(ws, Default::default(), |mut conn| async move {
        for (n, method, params) in [
            (
                1,
                "initialize",
                json!({"protocolVersion":1,"clientCapabilities":{}}),
            ),
            (
                2,
                "session/resume",
                json!({"sessionId":id,"cwd":project,"mcpServers":[]}),
            ),
        ] {
            conn.outgoing
                .send(json!({"jsonrpc":"2.0","id":n,"method":method,"params":params}).to_string())
                .await
                .unwrap();
            loop {
                let v: Value = serde_json::from_str(&conn.incoming.recv().await.unwrap()).unwrap();
                if v["id"] == n {
                    assert!(v["result"].is_object(), "{method}: {v}");
                    break;
                }
            }
        }
    })
    .await;
    let view: Value = client
        .get(format!("{thread}/run-receipt?runId=original"))
        .bearer_auth(token)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    assert_eq!(view, json!({"terminal":"success","work":"completed"}));
    ma.kill().await?;
    Ok(())
}
