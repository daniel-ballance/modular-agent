//! MCP servers from configuration, in the `mcpServers` form Pi and most
//! clients share. Each server is started on its own: one that fails is
//! reported and skipped, and the session opens with the rest.
use agent_api::*;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};
use tools_mcp::{Mcp, Server};

/// `${NAME}` in a configured value is the environment variable's value, so
/// that a secret can stay out of the file.
fn expand(text: &str) -> Result<String> {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        let Some(length) = rest[start..].find('}') else {
            break;
        };
        let name = &rest[start + 2..start + length];
        out.push_str(&rest[..start]);
        out.push_str(
            &std::env::var(name).map_err(|_| anyhow!("environment variable {name} is not set"))?,
        );
        rest = &rest[start + length + 1..];
    }
    out.push_str(rest);
    Ok(out)
}
fn strings(value: &Value, what: &str) -> Result<BTreeMap<String, String>> {
    match value {
        Value::Null => Ok(BTreeMap::new()),
        Value::Object(map) => map
            .iter()
            .map(|(k, v)| {
                let text = v
                    .as_str()
                    .ok_or_else(|| anyhow!("{what} values must be strings"))?;
                Ok((k.clone(), expand(text)?))
            })
            .collect(),
        _ => bail!("{what} must be an object"),
    }
}
fn server(name: &str, spec: &Value) -> Result<Option<Server>> {
    if spec["disabled"] == true || spec["enabled"] == false {
        return Ok(None);
    }
    let kind = spec["type"].as_str().unwrap_or(if spec.get("url").is_some() {
        "http"
    } else {
        "stdio"
    });
    Ok(Some(match kind {
        "stdio" => Server::Stdio {
            name: name.into(),
            command: spec["command"]
                .as_str()
                .ok_or_else(|| anyhow!("command is missing"))?
                .into(),
            args: spec["args"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|v| {
                    v.as_str()
                        .ok_or_else(|| anyhow!("args must be strings"))
                        .and_then(expand)
                })
                .collect::<Result<_>>()?,
            env: strings(&spec["env"], "env")?,
        },
        "http" | "streamable-http" | "streamableHttp" => Server::Http {
            name: name.into(),
            url: expand(spec["url"].as_str().ok_or_else(|| anyhow!("url is missing"))?)?,
            headers: strings(&spec["headers"], "headers")?,
        },
        other => bail!("transport {other} is not supported; use stdio or http"),
    }))
}

/// The servers in one file, with a problem for each entry that cannot be used.
pub fn read(path: &Path) -> (Vec<Server>, Vec<String>) {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (vec![], vec![]),
        Err(e) => return (vec![], vec![format!("{}: {e}", path.display())]),
    };
    let value: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(e) => return (vec![], vec![format!("{}: {e}", path.display())]),
    };
    let (mut servers, mut problems) = (vec![], vec![]);
    for (name, spec) in value["mcpServers"].as_object().into_iter().flatten() {
        match server(name, spec) {
            Ok(Some(server)) => servers.push(server),
            Ok(None) => (),
            Err(error) => problems.push(format!("{}: server {name}: {error}", path.display())),
        }
    }
    (servers, problems)
}

fn name(server: &Server) -> &str {
    match server {
        Server::Stdio { name, .. } | Server::Http { name, .. } => name,
    }
}

pub struct McpConfig {
    pub service: Arc<Mcp>,
    /// The person's servers, for every project.
    pub global: PathBuf,
    /// Whether the project's own `.mcp.json` may start programs. The operator
    /// grants this outside the project.
    pub project_trusted: bool,
}
impl McpConfig {
    pub fn servers(&self, project: &Path) -> (Vec<Server>, Vec<String>) {
        let (mut servers, mut problems) = read(&self.global);
        let file = project.join(".mcp.json");
        if self.project_trusted {
            let (more, issues) = read(&file);
            problems.extend(issues);
            for server in more {
                servers.retain(|s| name(s) != name(&server));
                servers.push(server);
            }
        } else if file.is_file() {
            problems.push(format!(
                "{}: not used, because this project is not trusted (start once with --trust-project)",
                file.display()
            ));
        }
        (servers, problems)
    }
}
impl Plugin for McpConfig {
    fn name(&self) -> &str {
        "tools.mcp.config"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        let this = Arc::new(Self {
            service: self.service.clone(),
            global: self.global.clone(),
            project_trusted: self.project_trusted,
        });
        r.on(
            "session.prepare",
            Order::Normal,
            handler(move |api, scope, _| {
                let this = this.clone();
                Box::pin(async move {
                    let project = api.snapshot(&scope.session)?.project;
                    let (servers, problems) = this.servers(&project);
                    for problem in problems {
                        eprintln!("MCP: {problem}");
                    }
                    let starts = servers.into_iter().map(|server| {
                        let (this, project, session) =
                            (this.clone(), project.clone(), scope.session.clone());
                        async move {
                            let label = name(&server).to_owned();
                            if let Err(error) =
                                this.service.attach(&session, &project, vec![server]).await
                            {
                                eprintln!("MCP: server {label} is not available: {error:#}");
                            }
                        }
                    });
                    futures_util::future::join_all(starts).await;
                    Ok(HookResult::default())
                })
            }),
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn servers_are_read_in_the_shared_form() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("mcp.json");
        // SAFETY: this test alone reads and writes this variable.
        unsafe { std::env::set_var("MA_TEST_MCP_TOKEN", "t0k") };
        std::fs::write(
            &file,
            r#"{"mcpServers":{
                "files":{"command":"npx","args":["-y","server"],"env":{"A":"b"}},
                "docs":{"type":"http","url":"https://example.test/mcp","headers":{"Authorization":"Bearer ${MA_TEST_MCP_TOKEN}"}},
                "off":{"command":"x","disabled":true},
                "odd":{"type":"sse","url":"https://example.test/sse"},
                "unset":{"command":"x","env":{"K":"${MA_TEST_NOT_SET}"}}
            }}"#,
        )
        .unwrap();
        let (servers, problems) = read(&file);
        assert_eq!(servers.len(), 2);
        assert!(servers.iter().any(|s| matches!(s, Server::Http { headers, .. } if headers["Authorization"] == "Bearer t0k")));
        assert!(servers.iter().any(|s| matches!(s, Server::Stdio { command, args, .. } if command == "npx" && args.len() == 2)));
        assert_eq!(problems.len(), 2);
        assert!(problems.iter().all(|p| !p.contains("t0k")));
        assert_eq!(read(&dir.path().join("none.json")).0.len(), 0);

        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        std::fs::write(project.join(".mcp.json"), r#"{"mcpServers":{"files":{"command":"other"}}}"#).unwrap();
        let config = |trusted| McpConfig {
            service: Arc::default(),
            global: file.clone(),
            project_trusted: trusted,
        };
        let (servers, problems) = config(false).servers(&project);
        assert!(servers.iter().any(|s| matches!(s, Server::Stdio { command, .. } if command == "npx")));
        assert!(problems.iter().any(|p| p.contains("not trusted")));
        let (servers, _) = config(true).servers(&project);
        assert_eq!(servers.len(), 2);
        assert!(servers.iter().any(|s| matches!(s, Server::Stdio { command, .. } if command == "other")));
    }
}
