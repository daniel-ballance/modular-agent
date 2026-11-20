use modular_agent::{AcpActor, AcpServiceOptions, Actor, Agent, Rights};
use serde_json::{Value, json};
use std::{
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};
use tokio_util::sync::CancellationToken;

fn token(dir: &Path, name: &str, value: &str) -> PathBuf {
    let path = dir.join(name);
    writeln!(
        std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&path)
            .unwrap(),
        "{value}"
    )
    .unwrap();
    path
}

async fn inspect(url: &str, token: &Path, project: &Path, allowed: bool) -> Value {
    let socket = transport_websocket::connect(url, token, transport_websocket::ACP)
        .await
        .unwrap();
    let mut actor = Value::Null;
    transport_websocket::run(socket, CancellationToken::new(), |mut conn| {
        let actor = &mut actor;
        async move {
            conn.outgoing.send(json!({"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":1,"clientCapabilities":{}}}).to_string()).await.unwrap();
            let v: Value = serde_json::from_str(&conn.incoming.recv().await.unwrap()).unwrap();
            *actor = v["result"]["_meta"]["modular-agent"]["actor"].clone();
            conn.outgoing.send(json!({"jsonrpc":"2.0","method":"session/new","id":2,"params":{"cwd":project,"mcpServers":[]}}).to_string()).await.unwrap();
            let v: Value = serde_json::from_str(&conn.incoming.recv().await.unwrap()).unwrap();
            if allowed { assert!(v["result"]["sessionId"].is_string(), "{v}"); }
            else { assert_eq!(v["error"]["data"]["code"], "forbidden", "{v}"); }
        }
    }).await;
    actor
}

#[tokio::test]
async fn acp_tokens_bind_independent_principals_and_scopes() {
    let project = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let editor = token(dir.path(), "editor", "8a04297e8ac45721d5cf37001ad0e8a5");
    let observer = token(dir.path(), "observer", "91c2644d20ae02b331b70e8a3f4a519f");
    let agent = Agent::builder()
        .project(project.path())
        .plugin_host(true)
        .build()
        .await
        .unwrap();
    let allowed = AcpActor {
        token_file: editor.clone(),
        actor: Actor {
            id: "editor".into(),
            kind: "user".into(),
            rights: Rights::only(&["input", "watch"]),
        },
        tenants: Some(vec![None]),
        projects: Some(vec![project.path().into()]),
    };
    let denied = AcpActor {
        token_file: observer.clone(),
        actor: Actor {
            id: "observer".into(),
            kind: "agent".into(),
            rights: Rights::full(),
        },
        tenants: None,
        projects: Some(vec![elsewhere.path().into()]),
    };
    let server = agent
        .serve_acp_websocket(
            Default::default(),
            AcpServiceOptions {
                listen: "127.0.0.1:0".into(),
                actors: vec![allowed, denied],
                tls: None,
            },
        )
        .await
        .unwrap();
    let (a, b) = tokio::join!(
        inspect(&server.url, &editor, project.path(), true),
        inspect(&server.url, &observer, project.path(), false)
    );
    assert_eq!(
        a,
        json!({"id":"editor","kind":"user","rights":["input","watch"]})
    );
    assert_eq!(b["id"], "observer");
    assert_eq!(b["kind"], "agent");
    server.close().await;
    agent.close().await.unwrap();
}
