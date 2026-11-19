//! The standard configuration behind the SDK's project-aware ACP Interface.
use crate::{Standard, builder, default_model};
use anyhow::{Result, anyhow, bail, ensure};
use modular_agent::{AcpHost, Agent, History, async_trait};
use modular_agent_mcp::{Mcp, Server};
use serde_json::{Value, json};
use std::path::Path;

pub struct Factory {
    pub standard: Standard,
    pub settings: Value,
    pub mcp: Mcp,
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

#[async_trait]
impl AcpHost for Factory {
    async fn agent(&self, project: &Path, reopening: Option<&str>) -> modular_agent::Result<Agent> {
        let mut standard = self.standard.clone();
        let configured = standard.configuration().settings(project)?;
        let recorded = match reopening {
            Some(id) => Some(standard.history()?.session(id)?),
            None => None,
        };
        let fallback = if standard.scripted.is_none() && !standard.conformance {
            default_model(&standard)
        } else {
            None
        };
        let chosen = recorded
            .as_ref()
            .and_then(|session| session.settings["model"].as_str())
            .or(self.settings["model"].as_str())
            .or(configured["model"].as_str())
            .or(fallback);
        standard.claude = !standard.conformance
            && standard.scripted.is_none()
            && chosen.is_some_and(|m| m.starts_with("claude/"));
        let mut b = builder(&standard, project, &self.mcp, vec![])?;
        if let Some(fallback) = fallback {
            b = b.setting("model", json!(fallback));
        }
        b.build().await
    }
    fn history(&self) -> modular_agent::Result<History> {
        Ok(self.standard.history()?)
    }
    fn trust(&self, project: &Path) -> modular_agent::Result<()> {
        self.standard.configuration().trust(project)
    }
    fn initial_settings(&self) -> Value {
        let mut settings = self.settings.clone();
        if self.standard.scripted.is_some() {
            settings["model"] = json!(modular_agent::testing::SCRIPTED_MODEL);
        } else if self.standard.conformance && settings["model"].is_null() {
            settings["model"] = json!("conformance/echo");
        }
        settings
    }
    async fn attach_mcp(
        &self,
        session: &str,
        project: &Path,
        servers: Value,
    ) -> modular_agent::Result<()> {
        for server in convert_servers(servers)? {
            if let Err(error) = self.mcp.attach(session, project, server.clone()).await {
                eprintln!(
                    "MCP: server {} is not available: {}",
                    server.name(),
                    error.message()
                );
            }
        }
        Ok(())
    }
}

fn convert_servers(servers: Value) -> Result<Vec<Server>> {
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
            Some("http") => Server::Http {
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
                Server::Stdio {
                    name,
                    command: command.into(),
                    args: serde_json::from_value(server.get("args").cloned().unwrap_or(json!([])))?,
                    env: pairs(server, "env")?,
                }
            }
            _ => bail!("only stdio and Streamable HTTP MCP are supported"),
        });
    }

    Ok(converted)
}
