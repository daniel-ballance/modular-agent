//! MCP tools over stdio and Streamable HTTP, scoped to the session that owns them.
pub use mcp_client::Server;
use mcp_client::{Connection, tool_name};
use modular_agent::{
    Code, Error, Order, Plugin, Result, Tool, ToolOutput, ToolSource, ToolStatus, TurnAddition,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex},
};

#[derive(Clone, Default)]
pub struct Mcp(Arc<Mutex<BTreeMap<String, Vec<Arc<Connection>>>>>);

impl Mcp {
    pub fn plugin(&self, servers: Vec<Server>) -> Plugin {
        let (open, refresh, close) = (self.clone(), self.clone(), self.clone());
        Plugin::new("mcp")
            .tool_source("mcp", self.clone())
            .on_session_prepare(move |cx| {
                let (mcp, servers) = (open.clone(), servers.clone());
                async move {
                    let starts = servers.into_iter().map(|server| {
                        let (mcp, project, session) =
                            (mcp.clone(), cx.project.clone(), cx.session_id.clone());
                        async move {
                            let name = server.name().to_owned();
                            if let Err(error) = mcp.attach(&session, &project, server).await {
                                eprintln!(
                                    "MCP: server {name} is not available: {}",
                                    error.message()
                                );
                            }
                        }
                    });
                    futures_util::future::join_all(starts).await;
                    Ok(())
                }
            })
            .on_turn_before_with(Order::First, move |cx| {
                let mcp = refresh.clone();
                async move {
                    let targets = mcp.connections(&cx.session_id);
                    for connection in targets {
                        if let Err(error) = connection.refresh().await {
                            eprintln!(
                                "MCP: server {} is not available: {error:#}",
                                connection.name()
                            );
                            mcp.remove(&cx.session_id, connection.name());
                        }
                    }
                    Ok(TurnAddition::default())
                }
            })
            .on_session_end_with(Order::Last, move |cx| {
                let mcp = close.clone();
                async move {
                    mcp.close(&cx.session_id).await;
                    Ok(())
                }
            })
    }

    pub async fn attach(&self, session: &str, project: &Path, server: Server) -> Result<()> {
        let name = server.name().to_owned();
        if self.connections(session).iter().any(|c| c.name() == name) {
            return Err(Error::new(
                Code::InvalidRequest,
                format!("duplicate MCP server {name}"),
            ));
        }
        let opened = Connection::open(server, project).await?;
        {
            let mut all = self.0.lock().unwrap();
            let entries = all.entry(session.into()).or_default();
            if !entries.iter().any(|c| c.name() == name) {
                entries.push(Arc::new(opened));
                return Ok(());
            }
        }
        opened.close().await;
        Err(Error::new(
            Code::InvalidRequest,
            format!("duplicate MCP server {name}"),
        ))
    }

    pub async fn close(&self, session: &str) {
        let connections = self.0.lock().unwrap().remove(session).unwrap_or_default();
        for connection in connections {
            if let Ok(connection) = Arc::try_unwrap(connection) {
                connection.close().await;
            }
        }
    }

    fn remove(&self, session: &str, name: &str) {
        if let Some(connections) = self.0.lock().unwrap().get_mut(session) {
            connections.retain(|c| c.name() != name);
        }
    }

    fn connections(&self, session: &str) -> Vec<Arc<Connection>> {
        self.0
            .lock()
            .unwrap()
            .get(session)
            .cloned()
            .unwrap_or_default()
    }
}

impl ToolSource for Mcp {
    fn tools(&self, session: &str) -> Vec<Tool> {
        self.connections(session)
            .into_iter()
            .flat_map(|c| {
                c.tools().into_iter().filter_map(move |tool| {
                    let name = tool_name(c.name(), &tool.name).ok()?;
                    let hints = tool.annotations.unwrap_or_default();
                    let mut builder = Tool::new(name, tool.description.unwrap_or_default())
                        .input_schema(json!(tool.input_schema))
                        .destructive(hints.destructive_hint.unwrap_or(true))
                        .open_world(hints.open_world_hint.unwrap_or(true));
                    if hints.read_only_hint.unwrap_or(false) {
                        builder = builder.read_only().safe_to_repeat();
                    } else if hints.idempotent_hint.unwrap_or(false) {
                        builder = builder.safe_to_repeat();
                    }
                    let connection = c.clone();
                    let remote = tool.name.to_string();
                    Some(builder.run(move |input: Value, _| {
                        let (connection, remote) = (connection.clone(), remote.clone());
                        async move {
                            let arguments = input.as_object().cloned().ok_or_else(|| {
                                Error::new(Code::InvalidRequest, "MCP arguments must be an object")
                            })?;
                            let (status, text, value) =
                                match connection.call(remote, arguments).await {
                                    Ok(Some(value)) => {
                                        let text = value
                                            .content
                                            .iter()
                                            .filter_map(|c| c.as_text().map(|t| t.text.as_str()))
                                            .collect::<Vec<_>>()
                                            .join("\n");
                                        let status = if value.is_error.unwrap_or(false) {
                                            ToolStatus::Failed
                                        } else {
                                            ToolStatus::Completed
                                        };
                                        (status, text, Some(json!(value)))
                                    }
                                    Ok(None) => (
                                        ToolStatus::OutcomeUnknown,
                                        "MCP request timed out; check outside state".into(),
                                        None,
                                    ),
                                    Err(e) => (
                                        ToolStatus::Failed,
                                        format!("MCP error: {e}; outside outcome may be unknown"),
                                        None,
                                    ),
                                };
                            Ok(ToolOutput {
                                status,
                                text,
                                value,
                                content: None,
                            })
                        }
                    }))
                })
            })
            .collect()
    }
}
