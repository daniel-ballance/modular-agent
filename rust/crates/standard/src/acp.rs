//! The standard configuration behind the ACP Interface, so an editor or a
//! host such as T3 Code can drive it.
use crate::Standard;
use agent_api::*;
use std::{path::Path, sync::Arc};

struct Quiet;
impl EventSink for Quiet {
    fn send(&self, _: Event) {}
}
pub struct Factory {
    pub standard: Standard,
    pub settings: Value,
}
fn pairs(server: &Value, field: &str) -> Result<std::collections::BTreeMap<String, String>> {
    server[field]
        .as_array()
        .into_iter()
        .flatten()
        .map(|v| {
            Ok((
                v["name"]
                    .as_str()
                    .ok_or_else(|| anyhow!("MCP option name missing"))?
                    .into(),
                v["value"]
                    .as_str()
                    .ok_or_else(|| anyhow!("MCP option value missing"))?
                    .into(),
            ))
        })
        .collect()
}
#[async_trait::async_trait]
impl interface_acp::Factory for Factory {
    async fn declaration(&self) -> Result<Value> {
        let api = self
            .build(&std::env::current_dir()?, Arc::new(Quiet))
            .await?;
        let declaration = interface_acp::declaration(api.as_ref(), None);
        api.shutdown().await?;
        declaration
    }
    async fn build(&self, project: &Path, sink: Arc<dyn EventSink>) -> Result<Api> {
        Ok(crate::compose(
            &self.standard,
            Arc::new(interface_acp::AcpPlugin { sink }),
            project,
        )
        .await?)
    }
    fn list(&self, project: Option<&Path>) -> Result<Vec<SessionData>> {
        self.standard.list(project)
    }
    fn trust(&self, project: &Path) -> Result<()> {
        self.standard.configuration().trust(project)
    }
    fn initial_settings(&self) -> Value {
        self.settings.clone()
    }
    async fn attach(&self, api: Api, session: &str, project: &Path, servers: Value) -> Result<()> {
        let mut converted = Vec::new();
        for server in servers
            .as_array()
            .ok_or_else(|| anyhow!("mcpServers must be an array"))?
        {
            let name = server["name"]
                .as_str()
                .ok_or_else(|| anyhow!("MCP name missing"))?
                .to_string();
            converted.push(match server["type"].as_str() {
                Some("http") => tools_mcp::Server::Http {
                    name,
                    url: server["url"]
                        .as_str()
                        .ok_or_else(|| anyhow!("MCP URL missing"))?
                        .into(),
                    headers: pairs(server, "headers")?,
                },
                None | Some("stdio") => {
                    let command = server["command"]
                        .as_str()
                        .ok_or_else(|| anyhow!("MCP command missing"))?;
                    ensure!(
                        Path::new(command).is_absolute(),
                        "ACP MCP executable paths must be absolute"
                    );
                    tools_mcp::Server::Stdio {
                        name,
                        command: command.into(),
                        args: serde_json::from_value(
                            server.get("args").cloned().unwrap_or(json!([])),
                        )?,
                        env: pairs(server, "env")?,
                    }
                }
                _ => bail!("only stdio and Streamable HTTP MCP are supported"),
            });
        }
        capability::<tools_mcp::Mcp>(api.as_ref(), "mcp.control")?
            .attach(session, project, converted)
            .await
    }
    async fn detach(&self, api: Api, session: &str) {
        if let Ok(mcp) = capability::<tools_mcp::Mcp>(api.as_ref(), "mcp.control") {
            mcp.close(session).await;
        }
    }
}
