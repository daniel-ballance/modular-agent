use modular_agent::{
    AcpActor, AcpServiceOptions, Actor, Agent, Code, Plugin, Rights, ServeOptions, ServicePlugin,
    Tool, ToolContext, ToolStatus, serve_websocket, testing::test_agent,
};
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
            kind: "program".into(),
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
    assert_eq!(b["kind"], "program");
    server.close().await;
    agent.close().await.unwrap();
}

#[tokio::test]
async fn service_registration_and_pending_tool_loss() -> modular_agent::Result<()> {
    use std::{sync::Arc, time::Duration};
    use tokio::{sync::Notify, time::timeout};
    let dir = tempfile::tempdir()?;
    let bearer = token(dir.path(), "plugin", "af712a1174815937db47ebb99cc64e83");
    let entered = Arc::new(Notify::new());
    let start = entered.clone();
    let tool = Tool::new("hold", "Wait for cancellation.").run(move |_: Value, cx: ToolContext| {
        let start = start.clone();
        async move {
            start.notify_one();
            cx.cancelled().cancelled().await;
            Ok("held")
        }
    });
    let service = serve_websocket(
        Plugin::new("remote-hold").tool(tool),
        ServeOptions {
            listen: "127.0.0.1:0".into(),
            token_file: bearer.clone(),
            tls: None,
        },
    )
    .await?;
    let registration = ServicePlugin::new(service.url.clone(), bearer);
    let refused = Agent::builder()
        .plugin(Plugin::new("remote-hold"))
        .service_plugin(registration.clone())
        .build()
        .await;
    assert_eq!(
        refused.err().expect("duplicate registration").code(),
        Code::InvalidComposition
    );
    let agent = test_agent()
        .service_plugin(registration.clone())
        .build()
        .await?;
    let session = agent.session().await?;
    let work = tokio::spawn(async move { session.call_tool("hold", json!({})).await });
    timeout(Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    service.close().await;
    let result = timeout(Duration::from_secs(5), work)
        .await
        .unwrap()
        .unwrap()?;
    assert_eq!(result.status, ToolStatus::OutcomeUnknown);
    agent.close().await?;
    let unreachable = Agent::builder().service_plugin(registration).build().await;
    assert_eq!(
        unreachable.err().expect("unreachable service").code(),
        Code::InvalidComposition
    );
    Ok(())
}
