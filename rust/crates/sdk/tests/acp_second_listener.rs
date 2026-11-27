use modular_agent::{
    AcpActor, AcpServiceOptions, Actor, Agent, Rights, WebSocketServer, testing::scripted_provider,
};
use serde_json::{Value, json};
use std::{io::Write, path::Path, time::Duration};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use transport_websocket::{ACP, Connection, connect, run};

async fn request(conn: &mut Connection, id: u64, method: &str, params: Value) -> Value {
    let message = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
    conn.outgoing.send(message.to_string()).await.unwrap();
    loop {
        let frame = conn.incoming.recv().await.expect("ACP connection closed");
        let reply: Value = serde_json::from_str(&frame).unwrap();
        if reply["id"] == id {
            return reply;
        }
    }
}

async fn initialize(conn: &mut Connection) {
    let reply = request(conn, 1, "initialize", json!({"protocolVersion": 1})).await;
    assert_eq!(reply["result"]["protocolVersion"], 1, "{reply}");
}

async fn reopen(service: &WebSocketServer, token: &Path, params: Value) -> Value {
    let socket = connect(&service.url, token, ACP).await.unwrap();
    let mut reply = None;
    run(socket, CancellationToken::new(), |mut conn| {
        let reply = &mut reply;
        async move {
            initialize(&mut conn).await;
            *reply = Some(request(&mut conn, 2, "session/resume", params).await);
        }
    })
    .await;
    reply.expect("session/resume reply")
}

async fn prompt(conn: &mut Connection, id: u64, session: &str, text: &str) {
    let reply = request(
        conn,
        id,
        "session/prompt",
        json!({"sessionId": session, "prompt": [{"type": "text", "text": text}]}),
    )
    .await;
    assert_eq!(reply["result"]["stopReason"], "end_turn", "{reply}");
    assert_eq!(
        reply["result"]["_meta"]["modular-agent"]["outcome"]["kind"], "completed",
        "{reply}"
    );
}

#[tokio::test]
async fn second_listener_checks_scope_before_refusing_an_open_session() -> modular_agent::Result<()>
{
    let dir = tempfile::tempdir()?;
    let project = dir.path().join("project");
    std::fs::create_dir(&project)?;
    let mut allowed = tempfile::NamedTempFile::new_in(dir.path())?;
    let mut denied = tempfile::NamedTempFile::new_in(dir.path())?;
    writeln!(allowed, "efd168f0119d47929a1f22e37628dd8b")?;
    writeln!(denied, "da545bb70d5042dbbe63dd575df1ed01")?;
    let principal = |token: &Path, tenant: Option<String>| AcpActor {
        join_on_open: false,
        token_file: token.to_owned(),
        actor: Actor {
            id: "editor".into(),
            kind: "user".into(),
            rights: Rights::only(&["input", "watch"]),
        },
        tenants: Some(vec![tenant]),
        projects: Some(vec![project.clone()]),
        represents: vec![],
        trust_trace_context: false,
    };
    let agent = Agent::builder()
        .project(&project)
        .plugin_host(true)
        .provider(scripted_provider(json!([
            {"text": "first reply"},
            {"text": "second reply"}
        ])))
        .build()
        .await?;
    let listen = |actors| AcpServiceOptions {
        listen: "127.0.0.1:0".into(),
        actors,
        tls: None,
    };
    let first = agent
        .serve_acp_websocket(
            Default::default(),
            listen(vec![principal(allowed.path(), None)]),
        )
        .await?;
    let second = agent
        .serve_acp_websocket(
            Default::default(),
            listen(vec![
                principal(allowed.path(), None),
                principal(denied.path(), Some("another-tenant".into())),
            ]),
        )
        .await?;
    assert_ne!(first.url, second.url);

    timeout(Duration::from_secs(30), async {
        let socket = connect(&first.url, allowed.path(), ACP).await.unwrap();
        let (second, allowed, denied) = (&second, allowed.path(), denied.path());
        run(socket, CancellationToken::new(), |mut writer| async move {
            initialize(&mut writer).await;
            let opened = request(
                &mut writer,
                2,
                "session/new",
                json!({"cwd": project, "mcpServers": []}),
            )
            .await;
            let session = opened["result"]["sessionId"]
                .as_str()
                .unwrap_or_else(|| panic!("session/new failed: {opened}"));
            prompt(&mut writer, 3, session, "materialize this session").await;
            let params = json!({"sessionId": session, "cwd": project, "mcpServers": []});
            let hidden = reopen(second, denied, params.clone()).await;
            assert_eq!(hidden["error"]["data"]["code"], "forbidden", "{hidden}");
            let busy = reopen(second, allowed, params).await;
            assert_eq!(busy["error"]["data"]["code"], "busy", "{busy}");
            prompt(&mut writer, 4, session, "continue").await;
        })
        .await;
    })
    .await
    .expect("ACP listener test timed out");
    second.close().await;
    first.close().await;
    agent.close().await
}
