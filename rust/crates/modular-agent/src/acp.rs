//! Composition adapter for the ACP Interface, not an agent loop.
use agent_api::*;
use std::{path::Path, sync::Arc};
struct Quiet;
impl EventSink for Quiet {
    fn send(&self, _: Event) {}
}
pub struct Factory {
    pub options: crate::Options,
    pub provider: Arc<dyn Plugin>,
    pub runtime: Arc<dyn Plugin>,
    pub settings: Value,
}
#[async_trait::async_trait]
impl interface_acp::Factory for Factory {
    async fn declaration(&self) -> Result<Value> {
        // Describe the launch composition without creating a session. New/load
        // report their own project's composition and selected Provider separately.
        let api = self
            .build(&std::env::current_dir()?, Arc::new(Quiet))
            .await?;
        let declaration = interface_acp::declaration(api.as_ref(), None);
        api.shutdown().await?;
        declaration
    }
    async fn build(&self, project: &Path, sink: Arc<dyn EventSink>) -> Result<Api> {
        Ok(crate::compose_project(
            self.options.clone(),
            self.provider.clone(),
            Arc::new(interface_acp::AcpPlugin { sink }),
            self.runtime.clone(),
            project,
        )
        .await?)
    }
    fn list(&self, project: Option<&Path>) -> Result<Vec<SessionData>> {
        match history_http::HttpHistory::from_env()? {
            Some(http) => http.list(project),
            None => history_fs::FileHistory::new(&self.options.history)?.list(project),
        }
    }
    fn trust(&self, project: &Path) -> Result<()> {
        config_files::FilesConfiguration::new(self.options.global_config.clone())
        .trust(project)
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
            let pairs = |field: &str| -> Result<std::collections::BTreeMap<String, String>> {
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
            };
            converted.push(match server["type"].as_str() {
                Some("http") => tools_mcp::Server::Http {
                    name,
                    url: server["url"]
                        .as_str()
                        .ok_or_else(|| anyhow!("MCP URL missing"))?
                        .into(),
                    headers: pairs("headers")?,
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
                        env: pairs("env")?,
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
