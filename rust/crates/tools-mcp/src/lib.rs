//! MCP is adapted here, not in the Runtime. Official SDK owns both transports.
//! Sources: https://modelcontextprotocol.io/specification/2026-07-28/server/tools
//! https://modelcontextprotocol.io/specification/2026-07-28/basic/transports
#[cfg(test)]
mod tests;
use agent_api::*;
pub use mcp_client::Server;
use mcp_client::{Connection, Tool, tool_name};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub struct Mcp {
    connections: Mutex<BTreeMap<String, Vec<Arc<Connection>>>>,
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
                    !opened.iter().any(|c: &Arc<Connection>| c.name() == name)
                        && !self
                            .connections
                            .lock()
                            .unwrap()
                            .get(session)
                            .is_some_and(|cs| cs.iter().any(|c| c.name() == name)),
                    "duplicate MCP server {name}"
                );
                opened.push(Arc::new(Connection::open(server, project).await?));
            }
            Ok(())
        }
        .await;
        if let Err(e) = result {
            for connection in opened {
                if let Ok(connection) = Arc::try_unwrap(connection) {
                    connection.close().await;
                }
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
            .cloned()
            .unwrap_or_default();
        for connection in targets {
            connection.refresh().await?;
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
            if let Ok(connection) = Arc::try_unwrap(connection) {
                connection.close().await;
            }
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
                c.tools()
                    .iter()
                    .filter_map(|t| definition(c.name(), t).ok())
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
                c.tools()
                    .iter()
                    .find(|t| tool_name(c.name(), &t.name).ok().as_deref() == Some(&call.name))
                    .map(|t| (c.clone(), t.name.to_string()))
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
            response = peer.call(name, arguments) => response,
        };
        match response {
            Ok(Some(value)) => {
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
            Err(e) => ToolResult::new(
                &call,
                ToolStatus::Failed,
                format!("MCP error: {e}; outside outcome may be unknown"),
            ),
            Ok(None) => ToolResult::new(
                &call,
                ToolStatus::Unknown,
                "MCP request timed out; check outside state",
            ),
        }
    }
}
