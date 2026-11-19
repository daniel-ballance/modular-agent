mod support;
use agent_api::*;
use std::{collections::BTreeMap, sync::Arc};
use support::*;
use tools_mcp::{Mcp, McpPlugin, Server};
struct Replacement(McpPlugin);
impl Plugin for Replacement {
    fn name(&self) -> &str {
        "tools.mcp"
    }
    fn replaces(&self) -> Option<&str> {
        Some("tools.mcp")
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        self.0.install(r)
    }
}
fn server(name: &str, pid: &std::path::Path) -> Server {
    Server::Stdio {
        name: name.into(),
        command: "python3".into(),
        args: vec![
            format!(
                "{}/../../scripts/mcp-fixture.py",
                env!("CARGO_MANIFEST_DIR")
            ),
            pid.display().to_string(),
        ],
        env: BTreeMap::from([("MCP_PREFIX".into(), "fixture:".into())]),
    }
}
async fn gone(pid: &std::path::Path) {
    let pid: i32 = std::fs::read_to_string(pid).unwrap().parse().unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while unsafe { libc::kill(pid, 0) } == 0 {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("MCP server left behind");
}
#[tokio::test]
async fn stdio_tools_hints_settings_scope_host_scope_and_close() -> Result<()> {
    let pids = tempfile::tempdir()?;
    let service = Arc::new(Mcp::default());
    let r = Rig::with(
        vec![
            calls(vec![ToolCall::new(
                "mcp_global__echo",
                json!({"text":"ok"}),
            )]),
            text("done"),
        ],
        vec![Arc::new(Replacement(McpPlugin {
            servers: vec![server("global", &pids.path().join("global"))],
            service: service.clone(),
        }))],
        vec![],
        json!({}),
    )
    .await;
    let tools = service.tools(&r.data());
    let echo = tools.iter().find(|t| t.name == "mcp_global__echo").unwrap();
    assert!(echo.read_only && echo.safe_to_repeat && !echo.parallel);
    assert_eq!(echo.hints["outside"], false);
    let mutate = tools
        .iter()
        .find(|t| t.name == "mcp_global__mutate")
        .unwrap();
    assert!(!mutate.read_only && mutate.safe_to_repeat);
    assert_eq!(mutate.hints["destructive"], true);
    let result = r.run("use MCP").await;
    assert_eq!(result.text, "done");
    assert_eq!(r.results()[0].text, "fixture:ok");
    assert_eq!(
        r.results()[0].value.as_ref().unwrap()["content"][1]["type"],
        "resource_link"
    );
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !service
            .tools(&r.data())
            .iter()
            .any(|t| t.name == "mcp_global__added")
        {
            tokio::task::yield_now().await;
        }
    })
    .await?;
    let second =
        r.h.create(r.project.path(), json!({"model":"fake"}))
            .await?;
    service
        .attach(
            &r.id,
            r.project.path(),
            vec![server("host", &pids.path().join("host"))],
        )
        .await?;
    assert!(
        service
            .tools(&r.data())
            .iter()
            .any(|t| t.name == "mcp_host__echo")
    );
    assert!(
        service
            .tools(&r.h.snapshot(&second)?)
            .iter()
            .any(|t| t.name == "mcp_global__echo")
    );
    assert!(
        !service
            .tools(&r.h.snapshot(&second)?)
            .iter()
            .any(|t| t.name == "mcp_host__echo")
    );
    let closed = r.data();
    r.h.close(&r.id).await?;
    gone(&pids.path().join("host")).await;
    assert!(service.tools(&closed).is_empty());
    r.h.close(&second).await?;
    gone(&pids.path().join("global")).await;
    Ok(())
}
#[tokio::test]
async fn mcp_failures_refusals_and_cancellation_get_one_result() -> Result<()> {
    let pids = tempfile::tempdir()?;
    let service = Arc::new(Mcp::default());
    let r = Rig::with(
        vec![],
        vec![Arc::new(Replacement(McpPlugin {
            servers: vec![server("test", &pids.path().join("pid"))],
            service: service.clone(),
        }))],
        vec![],
        json!({"approval":"ask_unless_read_only"}),
    )
    .await;
    let runtime: Arc<dyn Runtime> = capability(r.h.as_ref(), "runtime")?;
    let result = runtime
        .tool(
            r.h.clone(),
            Scope::session(&r.id),
            ToolCall::new("mcp_test__mutate", json!({})),
        )
        .await?;
    assert_eq!(result.status, ToolStatus::Refused);
    let result = runtime
        .tool(
            r.h.clone(),
            Scope::session(&r.id),
            ToolCall::new("mcp_test__fail", json!({})),
        )
        .await?;
    assert_eq!(result.status, ToolStatus::Failed);
    let token = CancellationToken::new();
    token.cancel();
    let result = service
        .run(
            r.h.clone(),
            Scope::session(&r.id),
            ToolCall::new("mcp_test__slow", json!({})),
            token,
        )
        .await;
    assert_eq!(result.status, ToolStatus::Cancelled);
    assert_eq!(r.results().len(), 2);
    r.h.close(&r.id).await?;
    gone(&pids.path().join("pid")).await;
    Ok(())
}
#[tokio::test]
async fn failed_attach_rolls_back_started_servers() -> Result<()> {
    let root = tempfile::tempdir()?;
    let mcp = Mcp::default();
    let mut bad = server("bad", &root.path().join("bad"));
    if let Server::Stdio { command, .. } = &mut bad {
        *command = "/no/such/mcp-program".into();
    }
    assert!(
        mcp.attach(
            "s",
            root.path(),
            vec![server("good", &root.path().join("good")), bad]
        )
        .await
        .is_err()
    );
    gone(&root.path().join("good")).await;
    Ok(())
}
#[derive(Clone)]
struct HttpFixture;
impl rmcp::ServerHandler for HttpFixture {
    fn get_info(&self) -> rmcp::model::ServerConfig {
        rmcp::model::ServerConfig::new(
            rmcp::model::ServerCapabilities::builder()
                .enable_tools()
                .build(),
        )
    }
    async fn list_tools(
        &self,
        _: Option<rmcp::model::PaginatedRequestParams>,
        _: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> std::result::Result<rmcp::model::ListToolsResult, rmcp::ErrorData> {
        Ok(rmcp::model::ListToolsResult::with_all_items(vec![serde_json::from_value(json!({"name":"echo","description":"HTTP fixture","inputSchema":{"type":"object","properties":{}},"annotations":{"readOnlyHint":true}})).unwrap()]))
    }
    async fn call_tool(
        &self,
        _: rmcp::model::CallToolRequestParams,
        _: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> std::result::Result<rmcp::model::CallToolResponse, rmcp::ErrorData> {
        Ok(
            rmcp::model::CallToolResult::success(vec![rmcp::model::ContentBlock::text("http-ok")])
                .into(),
        )
    }
}
#[tokio::test]
async fn streamable_http_official_server_json_and_sse() -> Result<()> {
    use rmcp::transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    };
    for json_response in [true, false] {
        let stop = CancellationToken::new();
        let service: StreamableHttpService<HttpFixture, LocalSessionManager> =
            StreamableHttpService::new(
                || Ok(HttpFixture),
                Default::default(),
                StreamableHttpServerConfig::default()
                    .with_json_response(json_response)
                    .with_cancellation_token(stop.clone()),
            );
        let router = axum::Router::new().nest_service("/mcp", service);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}/mcp", listener.local_addr()?);
        let shutdown = stop.clone();
        let server_task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(shutdown.cancelled_owned())
                .await
        });
        let mcp = Arc::new(Mcp::default());
        let r = Rig::with(
            vec![
                calls(vec![ToolCall::new("mcp_http__echo", json!({}))]),
                text("done"),
            ],
            vec![Arc::new(Replacement(McpPlugin {
                servers: vec![Server::Http {
                    name: "http".into(),
                    url,
                    headers: BTreeMap::new(),
                }],
                service: mcp,
            }))],
            vec![],
            json!({}),
        )
        .await;
        assert_eq!(r.run("HTTP").await.text, "done");
        assert_eq!(r.results()[0].text, "http-ok");
        r.h.close(&r.id).await?;
        stop.cancel();
        server_task.await??;
    }
    Ok(())
}
