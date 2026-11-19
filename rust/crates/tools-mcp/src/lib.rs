//! MCP is adapted here, not in the Runtime. Official SDK owns both transports.
//! Sources: https://modelcontextprotocol.io/specification/2026-07-28/server/tools
//! https://modelcontextprotocol.io/specification/2026-07-28/basic/transports
#[cfg(test)]
mod tests;
use agent_api::*;
use rmcp::{
    ClientHandler, RoleClient, ServiceExt,
    model::*,
    service::{NotificationContext, RunningService},
    transport::{StreamableHttpClientTransport, TokioChildProcess},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "transport", rename_all = "snake_case", deny_unknown_fields)]
pub enum Server {
    Stdio {
        name: String,
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
    },
    Http {
        name: String,
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
}
impl Server {
    fn name(&self) -> &str {
        match self {
            Self::Stdio { name, .. } | Self::Http { name, .. } => name,
        }
    }
}
#[derive(Clone)]
struct Client {
    tools: Arc<RwLock<Vec<Tool>>>,
    failed: Arc<RwLock<Option<String>>>,
}
impl ClientHandler for Client {
    async fn on_tool_list_changed(&self, context: NotificationContext<RoleClient>) {
        // Refresh before returning from the notification, so the next step sees it.
        match context.peer.list_all_tools().await {
            Ok(tools) => {
                *self.tools.write().unwrap() = tools;
                *self.failed.write().unwrap() = None;
            }
            Err(e) => {
                self.tools.write().unwrap().clear();
                *self.failed.write().unwrap() = Some(e.to_string());
            }
        }
    }
}
struct Connection {
    name: String,
    client: Client,
    service: RunningService<RoleClient, Client>,
}
#[derive(Default)]
pub struct Mcp {
    connections: Mutex<BTreeMap<String, Vec<Connection>>>,
    /// Who may start these tools. `None` leaves every caller allowed.
    pub callers: Option<Vec<String>>,
}
#[derive(Default)]
pub struct McpPlugin {
    pub servers: Vec<Server>,
    pub service: Arc<Mcp>,
}
impl Plugin for McpPlugin {
    fn name(&self) -> &str {
        "tools.mcp"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.provide::<dyn ToolSource>("tools.mcp", self.service.clone())?;
        r.provide::<Mcp>("mcp.control", self.service.clone())?;
        let service = self.service.clone();
        let servers = self.servers.clone();
        r.on(
            "session.prepare",
            Order::Normal,
            handler(move |api, scope, _| {
                let service = service.clone();
                let servers = servers.clone();
                Box::pin(async move {
                    service
                        .attach(
                            &scope.session,
                            &api.snapshot(&scope.session)?.project,
                            servers,
                        )
                        .await?;
                    Ok(HookResult::default())
                })
            }),
        );
        let service = self.service.clone();
        r.on(
            "before.turn",
            Order::First,
            handler(move |_, scope, _| {
                let service = service.clone();
                Box::pin(async move {
                    service.refresh(&scope.session).await?;
                    Ok(HookResult::default())
                })
            }),
        );
        let service = self.service.clone();
        r.on(
            "session.end",
            Order::Last,
            handler(move |_, scope, _| {
                let service = service.clone();
                Box::pin(async move {
                    service.close(&scope.session).await;
                    Ok(HookResult::default())
                })
            }),
        );
        r.declare(json!({"mcp":{"stdio":true,"streamable_http":true,"session_scoped":true,"sampling":false,"elicitation":false}}));
        Ok(())
    }
}
fn tool_name(server: &str, tool: &str) -> Result<String> {
    ensure!(
        !server.is_empty()
            && server
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-'),
        "MCP server names must contain only letters, digits and hyphens"
    );
    let name = format!("mcp_{server}__{tool}");
    ensure!(
        name.len() <= 64
            && tool
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            && !tool.is_empty(),
        "MCP tool name cannot be exposed safely: {name}"
    );
    Ok(name)
}
fn definition(server: &str, tool: &Tool) -> Result<ToolDefinition> {
    let annotations = tool.annotations.clone().unwrap_or_default();
    let read_only = annotations.read_only_hint.unwrap_or(false);
    Ok(ToolDefinition {
        name: tool_name(server, &tool.name)?,
        description: tool.description.as_deref().unwrap_or("").into(),
        input: json!(tool.input_schema),
        read_only,
        safe_to_repeat: read_only || annotations.idempotent_hint.unwrap_or(false),
        parallel: false,
        hints: json!({"destructive":annotations.destructive_hint.unwrap_or(true),"outside":annotations.open_world_hint.unwrap_or(true),"mcp":tool}),
    })
}
impl Mcp {
    pub fn for_callers(callers: &[&str]) -> Self {
        Self {
            callers: Some(callers.iter().map(|c| c.to_string()).collect()),
            ..Self::default()
        }
    }
    pub async fn attach(&self, session: &str, project: &Path, servers: Vec<Server>) -> Result<()> {
        let mut opened = Vec::new();
        let result: Result<()> = async {
            for server in servers {
                let name = server.name().to_string();
                tool_name(&name, "probe")?;
                ensure!(
                    !opened.iter().any(|c: &Connection| c.name == name)
                        && !self
                            .connections
                            .lock()
                            .unwrap()
                            .get(session)
                            .is_some_and(|cs| cs.iter().any(|c| c.name == name)),
                    "duplicate MCP server {name}"
                );
                let client = Client {
                    tools: Arc::default(),
                    failed: Arc::default(),
                };
                let connect = async {
                    match server {
                        Server::Stdio {
                            command, args, env, ..
                        } => {
                            let mut cmd = tokio::process::Command::new(command);
                            cmd.args(args)
                                .envs(env)
                                .current_dir(project)
                                .kill_on_drop(true);
                            // The direct server also dies on agent SIGKILL, without a shell wrapper.
                            let parent = std::process::id();
                            unsafe {
                                cmd.pre_exec(move || {
                                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                                        return Err(std::io::Error::last_os_error());
                                    }
                                    if libc::getppid() != parent as i32 {
                                        return Err(std::io::Error::other("agent exited"));
                                    }
                                    Ok(())
                                });
                            }
                            Ok(client.clone().serve(TokioChildProcess::new(cmd)?).await?)
                        }
                        Server::Http { url, headers, .. } => {
                            ensure!(
                                url.starts_with("http://") || url.starts_with("https://"),
                                "MCP URL must be HTTP(S)"
                            );
                            let mut custom = std::collections::HashMap::new();
                            for (name, value) in headers {
                                let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())?;
                                ensure!(!matches!(name.as_str(), "host" | "content-type" | "accept" | "content-length") && !name.as_str().starts_with("mcp-"), "reserved MCP HTTP header");
                                custom.insert(name, reqwest::header::HeaderValue::from_str(&value)?);
                            }
                            let config = rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig::with_uri(url).custom_headers(custom);
                            let http = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build()?;
                            Ok(client.clone().serve(StreamableHttpClientTransport::with_client(http, config)).await?)
                        }
                    }
                };
                let service = tokio::time::timeout(Duration::from_secs(15), connect).await??;
                opened.push(Connection {
                    name: name.clone(),
                    client,
                    service,
                });
                let connection = opened.last().unwrap();
                let tools = tokio::time::timeout(
                    Duration::from_secs(15),
                    connection.service.list_all_tools(),
                )
                .await??;
                for tool in &tools {
                    definition(&name, tool)?;
                }
                *connection.client.tools.write().unwrap() = tools;
            }
            Ok(())
        }
        .await;
        if let Err(e) = result {
            for connection in opened {
                let _ = connection.service.cancel().await;
            }
            return Err(e);
        }
        self.connections
            .lock()
            .unwrap()
            .entry(session.into())
            .or_default()
            .extend(opened);
        Ok(())
    }
    pub async fn refresh(&self, session: &str) -> Result<()> {
        let targets = self
            .connections
            .lock()
            .unwrap()
            .get(session)
            .into_iter()
            .flatten()
            .map(|c| {
                (
                    c.name.clone(),
                    c.service.peer().clone(),
                    c.client.tools.clone(),
                )
            })
            .collect::<Vec<_>>();
        for (name, peer, cache) in targets {
            let tools =
                tokio::time::timeout(Duration::from_secs(15), peer.list_all_tools()).await??;
            for tool in &tools {
                definition(&name, tool)?;
            }
            *cache.write().unwrap() = tools;
        }
        Ok(())
    }
    pub async fn close(&self, session: &str) {
        let connections = self
            .connections
            .lock()
            .unwrap()
            .remove(session)
            .unwrap_or_default();
        for connection in connections {
            let _ = connection.service.cancel().await;
        }
    }
}
#[async_trait]
impl ToolSource for Mcp {
    fn tools(&self, session: &SessionData) -> Vec<ToolDefinition> {
        self.connections
            .lock()
            .unwrap()
            .get(&session.id)
            .into_iter()
            .flatten()
            .flat_map(|c| {
                c.client
                    .tools
                    .read()
                    .unwrap()
                    .iter()
                    .filter_map(|t| definition(&c.name, t).ok())
                    .collect::<Vec<_>>()
            })
            .map(|tool| match &self.callers {
                Some(callers) => {
                    tool.for_callers(&callers.iter().map(String::as_str).collect::<Vec<_>>())
                }
                None => tool,
            })
            .collect()
    }
    async fn run(
        &self,
        _api: Api,
        scope: Scope,
        call: ToolCall,
        cancel: CancellationToken,
    ) -> ToolResult {
        let target = {
            let all = self.connections.lock().unwrap();
            all.get(&scope.session).into_iter().flatten().find_map(|c| {
                c.client
                    .tools
                    .read()
                    .unwrap()
                    .iter()
                    .find(|t| tool_name(&c.name, &t.name).ok().as_deref() == Some(&call.name))
                    .map(|t| (c.service.peer().clone(), t.name.to_string()))
            })
        };
        let Some((peer, name)) = target else {
            return ToolResult::new(&call, ToolStatus::Failed, "MCP tool unavailable");
        };
        let Some(arguments) = call.input.as_object().cloned() else {
            return ToolResult::new(&call, ToolStatus::Failed, "MCP arguments must be an object");
        };
        let response = tokio::select! {
            _ = cancel.cancelled() => return ToolResult::new(&call, ToolStatus::Cancelled, "MCP call cancelled; outside outcome may be unknown"),
            response = tokio::time::timeout(Duration::from_secs(60), peer.call_tool(CallToolRequestParams::new(name).with_arguments(arguments))) => response,
        };
        match response {
            Ok(Ok(value)) => {
                let text = value
                    .content
                    .iter()
                    .filter_map(|c| c.as_text().map(|t| t.text.clone()))
                    .collect::<Vec<_>>()
                    .join("\n");
                let mut result = ToolResult::new(
                    &call,
                    if value.is_error.unwrap_or(false) {
                        ToolStatus::Failed
                    } else {
                        ToolStatus::Completed
                    },
                    &text,
                );
                result.value = Some(json!(value));
                result
            }
            Ok(Err(e)) => ToolResult::new(
                &call,
                ToolStatus::Failed,
                format!("MCP error: {e}; outside outcome may be unknown"),
            ),
            Err(_) => ToolResult::new(
                &call,
                ToolStatus::Unknown,
                "MCP request timed out; check outside state",
            ),
        }
    }
}
