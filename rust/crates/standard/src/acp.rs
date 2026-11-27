//! The standard configuration behind the SDK's project-aware ACP Interface.
use crate::{Standard, builder, default_model};
use anyhow::{Result, anyhow, bail, ensure};
use modular_agent::{AcpComposition, Agent, History, async_trait};
use modular_agent_mcp::{Mcp, Server};
use serde_json::{Value, json};
use std::path::Path;

pub struct Factory {
    pub standard: Standard,
    pub settings: Value,
    pub mcp: Mcp,
}
impl Factory {
    /// Use the saved model and the ordinary project composition. Release the
    /// writer when recovery finishes so a later client can open it normally.
    pub async fn resume_open(
        &self,
        project: &Path,
        local: &modular_agent::AcpOptions,
    ) -> Result<()> {
        let project = project.canonicalize()?;
        if local
            .projects
            .as_ref()
            .is_some_and(|p| !p.contains(&project))
            || local.actor.as_ref().is_some_and(|a| !a.rights.has("watch"))
        {
            return Ok(());
        }
        for info in self.history()?.sessions(Some(&project))? {
            if !info.unfinished_turn
                || !local
                    .tenants
                    .as_ref()
                    .map_or(info.tenant.is_none(), |allowed| {
                        allowed.contains(&info.tenant)
                    })
            {
                continue;
            }
            let id = info.id.escape_default();
            let agent = self.compose(&project, Some(&info.id)).await?;
            let result = agent.open_interrupted_session(&info.id, local).await;
            let closed = agent.close().await;
            match result {
                Ok(Some(_)) => eprintln!("resume-open: resumed {id}"),
                Ok(None) => eprintln!("resume-open: skipped {id} (turn already ended)"),
                Err(error) => eprintln!("resume-open: skipped {id} ({})", error.code().as_str()),
            }
            closed?;
        }
        Ok(())
    }
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
impl AcpComposition for Factory {
    async fn compose(
        &self,
        project: &Path,
        reopening: Option<&str>,
    ) -> modular_agent::Result<Agent> {
        let mut standard = self.standard.clone();
        let configured = standard.configuration().settings(project)?;
        let recorded = match reopening {
            Some(id) => Some(standard.history()?.session_info(id)?),
            None => None,
        };
        let fallback = if standard.scripted.is_none() && !standard.conformance {
            default_model(&standard).await
        } else {
            None
        };
        let saved_model = recorded.and_then(|session| session.model.map(|model| model.to_string()));
        let chosen = saved_model
            .as_deref()
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
    fn project_settings(&self, _project: &Path) -> modular_agent::Result<Value> {
        let mut settings = self.settings.clone();
        if self.standard.scripted.is_some() {
            settings["model"] = json!(modular_agent::testing::SCRIPTED_MODEL);
        } else if self.standard.conformance && settings["model"].is_null() {
            settings["model"] = json!("conformance/echo");
        }
        Ok(settings)
    }
    async fn project_mcp(
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
