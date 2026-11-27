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

#[path = "fixtures/git_project.rs"]
mod git_project;
use git_project::git_project;

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

#[tokio::test]
async fn named_listener_rejects_invalid_tables_before_creating_a_plugin() {
    use modular_agent::{NamedServeOptions, PluginCaller, serve_websocket_named};
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let file = token(dir.path(), "private", "disposable-named-test-credential");
    let unsafe_file = token(
        dir.path(),
        "readable",
        "another-disposable-named-credential",
    );
    std::fs::set_permissions(&unsafe_file, std::fs::Permissions::from_mode(0o644)).unwrap();
    for callers in [
        vec![],
        vec![PluginCaller::new("", file.clone())],
        vec![PluginCaller::new("other", unsafe_file)],
        vec![PluginCaller::new("missing", dir.path().join("absent"))],
    ] {
        let err = serve_websocket_named(
            |_| panic!("factory ran before authentication"),
            NamedServeOptions {
                listen: "127.0.0.1:0".into(),
                callers,
                ..Default::default()
            },
        )
        .await
        .err()
        .expect("invalid caller table accepted");
        assert_eq!(err.code(), Code::InvalidComposition);
    }
}

async fn inspect(url: &str, token: &Path, project: &Path, allowed: bool) -> Value {
    let socket = transport_websocket::connect(url, token, transport_websocket::ACP)
        .await
        .unwrap();
    let mut actor = Value::Null;
    transport_websocket::run(socket, CancellationToken::new(), |mut conn| {
        let actor = &mut actor;
        async move {
            conn.outgoing.send(json!({"jsonrpc":"2.0","method":"$/ping","id":0,"params":{}}).to_string()).await.unwrap();
            let ping: Value = serde_json::from_str(&conn.incoming.recv().await.unwrap()).unwrap();
            assert_eq!(ping["result"], json!({}));
            conn.outgoing.send(json!({"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":1,"clientCapabilities":{}}}).to_string()).await.unwrap();
            let v: Value = serde_json::from_str(&conn.incoming.recv().await.unwrap()).unwrap();
            let metadata = &v["result"]["_meta"]["modular-agent"];
            *actor = metadata["actor"].clone();
            assert_eq!(metadata["declaration"]["runsToolsAtProvider"], false);
            assert_eq!(metadata["declaration"]["liveSessions"], false);
            conn.outgoing.send(json!({"jsonrpc":"2.0","method":"session/new","id":2,"params":{"cwd":project,"mcpServers":[]}}).to_string()).await.unwrap();
            let v: Value = serde_json::from_str(&conn.incoming.recv().await.unwrap()).unwrap();
            if allowed {
                assert!(v["result"]["sessionId"].is_string(), "{v}");
                let declaration = &v["result"]["_meta"]["modular-agent"]["declaration"];
                assert_eq!(declaration["runsToolsAtProvider"], false);
                assert_eq!(declaration["liveSessions"], false);
            } else {
                assert_eq!(v["error"]["data"]["code"], "forbidden", "{v}");
            }
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
        join_on_open: false,
        token_file: editor.clone(),
        trust_trace_context: false,
        actor: Actor {
            id: "editor".into(),
            kind: "user".into(),
            rights: Rights::only(&["input", "watch"]),
        },
        tenants: Some(vec![None]),
        projects: Some(vec![project.path().into()]),
        represents: vec![],
    };
    let denied = AcpActor {
        join_on_open: false,
        token_file: observer.clone(),
        trust_trace_context: false,
        actor: Actor {
            id: "observer".into(),
            kind: "program".into(),
            rights: Rights::full(),
        },
        tenants: None,
        projects: Some(vec![elsewhere.path().into()]),
        represents: vec![],
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
async fn acp_watch_token_caps_recorded_grants_without_rewriting_them() -> modular_agent::Result<()>
{
    let dir = tempfile::tempdir()?;
    let root = dir.path().canonicalize()?;
    let bearer = token(&root, "scope", "408ea717c85a5a164598ec62edaad510");
    let subproject = root.join("nested");
    std::fs::create_dir_all(&subproject)?;
    let alias = root.join("alias");
    std::os::unix::fs::symlink(&root, &alias)?;
    let agent = Agent::builder()
        .project(&root)
        .data_dir(root.join("data"))
        .durability(modular_agent::Durability::Kept)
        .provider(modular_agent::testing::scripted_provider(
            json!([{"text":"kept"}]),
        ))
        .plugin_host(true)
        .several_actors(true)
        .build()
        .await?;
    let grant = Actor {
        id: "observer".into(),
        kind: "user".into(),
        rights: Rights::full(),
    };
    let saved = agent
        .session_with(modular_agent::SessionOptions {
            actors: vec![grant],
            ..Default::default()
        })
        .await?;
    let id = saved.id().to_owned();
    saved.prompt("materialize").await?;
    saved.close().await?;
    let service = agent
        .serve_acp_websocket(
            Default::default(),
            AcpServiceOptions {
                actors: vec![AcpActor {
                    join_on_open: false,
                    token_file: bearer.clone(),
                    trust_trace_context: false,
                    actor: Actor {
                        id: "observer".into(),
                        kind: "user".into(),
                        rights: Rights::only(&["watch"]),
                    },
                    tenants: None,
                    projects: Some(vec![root.clone()]),
                    represents: vec![],
                }],
                listen: "127.0.0.1:0".into(),
                tls: None,
            },
        )
        .await?;
    let socket = transport_websocket::connect(&service.url, &bearer, transport_websocket::ACP)
        .await
        .unwrap();
    transport_websocket::run(socket, CancellationToken::new(), |mut conn| {
        let (id, alias, subproject) = (&id, &alias, &subproject);
        async move {
            macro_rules! rpc {
                ($id:expr, $method:expr, $params:expr) => {{
                    conn.outgoing.send(json!({"jsonrpc":"2.0","method":$method,"id":$id,"params":$params}).to_string()).await.unwrap();
                    loop {
                        let v: Value = serde_json::from_str(&conn.incoming.recv().await.unwrap()).unwrap();
                        if v["id"] == $id { break v; }
                    }
                }};
            }
            assert!(rpc!(1, "initialize", json!({"protocolVersion":1})).get("result").is_some());
            let list = rpc!(10, "session/list", json!({"cwd":alias}));
            assert_eq!(list["result"]["sessions"][0]["sessionId"], *id);
            assert_eq!(list["result"]["sessions"][0]["_meta"]["modular-agent"]["waiting"],
                json!({"questions":0,"toolCalls":0,"turn":"none"}));
            let hidden = rpc!(8, "session/resume", json!({"sessionId":"unknown","cwd":alias,"mcpServers":[]}));
            let denied = rpc!(9, "session/resume", json!({"sessionId":id,"cwd":subproject,"mcpServers":[]}));
            assert_eq!(hidden["error"], denied["error"]);
            assert_eq!(hidden["error"]["data"]["code"], "forbidden");
            let v = rpc!(2, "session/resume", json!({"sessionId":id,"cwd":alias,"mcpServers":[]}));
            assert!(v.get("result").is_some(), "{v}");
            let v = rpc!(3, "session/prompt", json!({"sessionId":id,"prompt":[{"type":"text","text":"not allowed"}]}));
            assert_eq!(v["error"]["data"]["code"], "forbidden", "{v}");
            assert_eq!(rpc!(4, "$/ping", json!({}))["result"], json!({}));
            let v = rpc!(5, "session/close", json!({"sessionId":id}));
            assert!(v.get("result").is_some(), "{v}");
            let v = rpc!(6, "_modular-agent/history", json!({"sessionId":id}));
            assert_eq!(v["error"]["data"]["code"], "not_open", "{v}");
            let v = rpc!(7, "_modular-agent/history", json!({"sessionId":"unknown"}));
            assert_eq!(v["error"]["data"]["code"], "forbidden", "{v}");
        }
    }).await;
    service.close().await;
    let reopened = agent.open_session(&id).await?;
    let observer = reopened.r#as("observer")?;
    // A connection limit does not modify the actor's grants for other callers.
    observer
        .send("allowed here", modular_agent::Timing::Propose)
        .await?;
    agent.close().await?;
    Ok(())
}

#[tokio::test]
async fn invalid_stdio_scope_fails_before_serving() -> modular_agent::Result<()> {
    let project = tempfile::tempdir()?;
    let agent = Agent::builder()
        .project(project.path())
        .plugin_host(true)
        .build()
        .await?;
    for options in [
        modular_agent::AcpOptions {
            projects: Some(vec![PathBuf::from("relative")]),
            ..Default::default()
        },
        modular_agent::AcpOptions {
            tenants: Some(vec![Some(String::new())]),
            ..Default::default()
        },
        modular_agent::AcpOptions {
            represents: vec!["job:invalid".into()],
            ..Default::default()
        },
    ] {
        assert_eq!(
            agent.serve_acp(options).await.unwrap_err().code(),
            Code::InvalidComposition
        );
    }
    agent.close().await
}

struct ComposedProject {
    project: PathBuf,
    stopped: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

impl modular_agent::Configuration for ComposedProject {
    fn settings(&self, _: &Path) -> modular_agent::Result<Value> {
        Ok(json!({}))
    }
    fn trusted(&self, project: &Path) -> modular_agent::Result<bool> {
        Ok(project == self.project)
    }
}

struct Lifecycle(std::sync::Arc<std::sync::atomic::AtomicUsize>);
#[modular_agent::async_trait]
impl modular_agent::Interface for Lifecycle {
    async fn start(&self, _: Agent) -> modular_agent::Result<()> {
        Ok(())
    }
    async fn stop(&self) -> modular_agent::Result<()> {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
}

#[modular_agent::async_trait]
impl modular_agent::AcpComposition for ComposedProject {
    async fn compose(&self, project: &Path, _: Option<&str>) -> modular_agent::Result<Agent> {
        let stopped = self.stopped.clone();
        Agent::builder()
            .project(project)
            .plugin_host(true)
            .plugin(Plugin::new("lifecycle").setup(move |r| {
                r.interface(Lifecycle(stopped.clone()));
                Ok(())
            }))
            .build()
            .await
    }
    fn history(&self) -> modular_agent::Result<modular_agent::History> {
        Ok(modular_agent::memory_history())
    }
    fn configuration(&self) -> Option<&dyn modular_agent::Configuration> {
        Some(self)
    }
}

#[tokio::test]
async fn acp_composition_keeps_ephemeral_agents_and_checks_project_trust()
-> modular_agent::Result<()> {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let project = tempfile::tempdir()?;
    let denied = tempfile::tempdir()?;
    let dir = tempfile::tempdir()?;
    let bearer = token(
        dir.path(),
        "composition",
        "0b22057fef8484bd731e150d279a3707",
    );
    let agent = Agent::builder().plugin_host(true).build().await?;
    let stopped = Arc::new(AtomicUsize::new(0));
    let server = agent
        .serve_acp_websocket(
            modular_agent::AcpOptions {
                compose: Some(Arc::new(ComposedProject {
                    project: project.path().canonicalize()?,
                    stopped: stopped.clone(),
                })),
                ..Default::default()
            },
            AcpServiceOptions {
                listen: "127.0.0.1:0".into(),
                actors: vec![AcpActor::local(bearer.clone())],
                tls: None,
            },
        )
        .await?;
    inspect(&server.url, &bearer, denied.path(), false).await;
    inspect(&server.url, &bearer, project.path(), true).await;
    server.close().await;
    assert_eq!(stopped.load(Ordering::SeqCst), 1);
    agent.close().await
}

#[tokio::test]
async fn service_factory_creates_and_stops_one_instance_per_connection() -> modular_agent::Result<()>
{
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let dir = tempfile::tempdir()?;
    let bearer = token(dir.path(), "factory", "af712a1174815937db47ebb99cc64e83");
    let created = Arc::new(AtomicUsize::new(0));
    let stopped = Arc::new(AtomicUsize::new(0));
    let service = modular_agent::serve_websocket_factory(
        {
            let (created, stopped) = (created.clone(), stopped.clone());
            move || {
                let id = created.fetch_add(1, Ordering::SeqCst) + 1;
                let stopped = stopped.clone();
                Plugin::new("factory")
                    .setup(move |r| {
                        let suffix = r.config()["suffix"].as_str().unwrap();
                        let reply = format!("{id}/{suffix}");
                        r.tool(Tool::new("instance", "Report the instance.").run(
                            move |_: Value, _| {
                                let reply = reply.clone();
                                async move { Ok(reply) }
                            },
                        ));
                        Ok(())
                    })
                    .stop(move || {
                        stopped.fetch_add(1, Ordering::SeqCst);
                        std::future::ready(Ok(()))
                    })
            }
        },
        ServeOptions {
            listen: "127.0.0.1:0".into(),
            token_file: bearer.clone(),
            tls: None,
            projects: vec![],
        },
    )
    .await?;
    assert_eq!(created.load(Ordering::SeqCst), 0);
    let mut agents = Vec::new();
    let project = git_project();
    for (index, suffix) in [(1, "first"), (2, "second")] {
        let agent = Agent::builder()
            .project(project.path())
            .service_plugins([
                ServicePlugin::new(&service.url, &bearer).config(json!({"suffix": suffix}))
            ])
            .build()
            .await?;
        assert_eq!(
            agent
                .session()
                .await?
                .call_tool("instance", json!({}))
                .await?
                .text(),
            format!("{index}/{suffix}")
        );
        agents.push(agent);
    }
    service.close().await;
    assert_eq!(stopped.load(Ordering::SeqCst), 2);
    for agent in agents {
        agent.close().await?;
    }
    Ok(())
}

#[tokio::test]
async fn served_tool_cancelled_during_its_final_poll_is_not_a_failure() -> modular_agent::Result<()>
{
    // The binding reader can deliver cancellation between the executor checking
    // the token and a callback returning its own cancellation error.
    let plugin =
        Plugin::new("cancel-cutoff").tool(Tool::new("finish", "Finish a cancelled callback").run(
            |_: Value, cx: ToolContext| async move {
                cx.cancelled().cancel();
                Err::<String, _>(modular_agent::Error::new(
                    Code::Cancelled,
                    "callback cancelled",
                ))
            },
        ));
    let agent = test_agent().over_wire(plugin).build().await?;
    let session = agent.session().await?;
    let result = session.call_tool("finish", json!({})).await?;
    assert_eq!(result.status, ToolStatus::Cancelled);
    agent.close().await
}

#[tokio::test]
async fn served_tool_waits_for_its_exec_reply_before_answering_cancel() -> modular_agent::Result<()>
{
    use transport_websocket::{Connection, PLUGIN};

    async fn send(conn: &Connection, frame: Value) {
        conn.outgoing.send(frame.to_string()).await.unwrap();
    }
    async fn receive(conn: &mut Connection) -> Value {
        let frame = conn
            .incoming
            .recv()
            .await
            .expect("plugin connection closed");
        serde_json::from_str(&frame).unwrap()
    }

    let dir = tempfile::tempdir()?;
    let bearer = token(dir.path(), "plugin", "disposable-callback-test-credential");
    let plugin = Plugin::new("cancel-exec").tool(Tool::new("exec", "Call the host.").run(
        |_: Value, cx: ToolContext| async move {
            Ok(cx.environment().exec("echo unused", None).await?.output)
        },
    ));
    let service = serve_websocket(
        plugin,
        ServeOptions {
            listen: "127.0.0.1:0".into(),
            token_file: bearer.clone(),
            tls: None,
            projects: vec![],
        },
    )
    .await?;
    let socket = transport_websocket::connect(&service.url, &bearer, PLUGIN).await?;
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        transport_websocket::run(socket, CancellationToken::new(), |mut conn| async move {
            send(
                &conn,
                json!({"jsonrpc":"2.0","method":"plugin/initialize","id":1,"params":{
                    "binding":"modular-agent-plugin/1","host":{"name":"test","version":"1"},
                    "project":dir.path(),"home":dir.path(),"config":{}
                }}),
            )
            .await;
            let init = receive(&mut conn).await;
            assert!(init["result"].is_object(), "{init}");
            send(
                &conn,
                json!({"jsonrpc":"2.0","method":"tools/call","id":2,"params":{
                    "toolSource":"tools","project":dir.path(),"sessionId":"s1",
                    "call":{"id":"call","name":"exec","startedBy":"model","input":{}}
                }}),
            )
            .await;
            let exec = receive(&mut conn).await;
            assert_eq!(exec["method"], "host/env/exec", "{exec}");
            assert_eq!(exec["params"]["parentRequestId"], 2);
            send(
                &conn,
                json!({"jsonrpc":"2.0","method":"$/cancel","params":{"id":2}}),
            )
            .await;

            // The callback cancel is the barrier: release the reply only after
            // the plugin has acted on the parent cancel. Ping while it is held.
            assert_eq!(
                receive(&mut conn).await,
                json!({"jsonrpc":"2.0","method":"$/cancel","params":{"id":exec["id"]}})
            );
            send(&conn, json!({"jsonrpc":"2.0","method":"$/ping","id":3})).await;
            let before = receive(&mut conn).await;
            send(
                &conn,
                json!({"jsonrpc":"2.0","id":exec["id"],"result":{
                    "exitCode":0,"output":"","timedOut":false
                }}),
            )
            .await;
            send(&conn, json!({"jsonrpc":"2.0","method":"$/ping","id":4})).await;
            // The normal exec answer is not unsolicited. The connection must
            // survive it and reply to both the cancelled parent and the ping.
            let mut after = [receive(&mut conn).await, receive(&mut conn).await];
            after.sort_by_key(|frame| frame["id"].as_u64());
            assert_eq!(before, json!({"jsonrpc":"2.0","id":3,"result":{}}));
            assert_eq!(after[0]["id"], 2);
            assert_eq!(after[0]["error"]["data"]["code"], "cancelled");
            assert_eq!(after[1], json!({"jsonrpc":"2.0","id":4,"result":{}}));
        }),
    )
    .await
    .expect("served tool did not settle");
    service.close().await;
    Ok(())
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
            projects: vec![],
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
