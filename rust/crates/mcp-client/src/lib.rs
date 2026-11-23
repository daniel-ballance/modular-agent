//! The transport and tool catalog shared by the Rust MCP adapters.
use anyhow::{Result, ensure};
use opentelemetry::{Context, trace::TraceContextExt};
use rmcp::model::CallToolRequestParams;
pub use rmcp::model::{CallToolResult, Tool};
use rmcp::{
    ClientHandler, RoleClient, ServiceExt,
    service::{NotificationContext, RunningService},
    transport::{StreamableHttpClientTransport, TokioChildProcess},
};
use serde::{Deserialize, Serialize};
use serde_json::Map;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, RwLock},
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
    pub fn name(&self) -> &str {
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
pub struct Connection {
    name: String,
    client: Client,
    service: RunningService<RoleClient, Client>,
}

impl Connection {
    pub async fn open(server: Server, project: &Path) -> Result<Self> {
        let name = server.name().to_string();
        tool_name(&name, "probe")?;
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
                    #[cfg(target_os = "linux")]
                    let parent = std::process::id();
                    #[cfg(target_os = "linux")]
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
                        ensure!(
                            !matches!(
                                name.as_str(),
                                "host" | "content-type" | "accept" | "content-length"
                            ) && !name.as_str().starts_with("mcp-"),
                            "reserved MCP HTTP header"
                        );
                        custom.insert(name, reqwest::header::HeaderValue::from_str(&value)?);
                    }
                    let config = rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig::with_uri(url).custom_headers(custom);
                    let http = reqwest::Client::builder()
                        .redirect(reqwest::redirect::Policy::none())
                        .build()?;
                    Ok(client
                        .clone()
                        .serve(StreamableHttpClientTransport::with_client(http, config))
                        .await?)
                }
            }
        };
        let service = tokio::time::timeout(Duration::from_secs(15), connect).await??;

        let connection = Self {
            name,
            client,
            service,
        };
        if let Err(error) = connection.refresh().await {
            connection.close().await;
            return Err(error);
        }
        Ok(connection)
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub async fn refresh(&self) -> Result<()> {
        let tools =
            tokio::time::timeout(Duration::from_secs(15), self.service.list_all_tools()).await??;
        validate(&self.name, &tools)?;
        *self.client.tools.write().unwrap() = tools;
        Ok(())
    }

    pub fn tools(&self) -> Vec<Tool> {
        let tools = self.client.tools.read().unwrap();
        if validate(&self.name, &tools).is_err() {
            return Vec::new();
        }
        tools.clone()
    }

    pub async fn call(
        &self,
        name: String,
        arguments: Map<String, Value>,
    ) -> Result<Option<CallToolResult>> {
        let mut request = CallToolRequestParams::new(name).with_arguments(arguments);
        request.meta = trace_metadata();
        match tokio::time::timeout(Duration::from_secs(60), self.service.call_tool(request)).await {
            Ok(result) => Ok(Some(result?)),
            Err(_) => Ok(None),
        }
    }

    pub async fn close(self) {
        let _ = self.service.cancel().await;
    }
}

fn trace_metadata() -> Option<rmcp::model::RequestMetaObject> {
    let cx = Context::current();
    let span = cx.span();
    let sc = span.span_context();
    sc.is_valid().then(|| {
        let parent = format!(
            "00-{}-{}-{:02x}",
            sc.trace_id(),
            sc.span_id(),
            sc.trace_flags().to_u8()
        );
        rmcp::model::RequestMetaObject::from(Map::from_iter([(
            "traceparent".into(),
            Value::String(parent),
        )]))
    })
}

fn validate(server: &str, tools: &[Tool]) -> Result<()> {
    let mut names = std::collections::BTreeSet::new();
    for tool in tools {
        let name = tool_name(server, &tool.name)?;
        ensure!(names.insert(name.clone()), "duplicate MCP tool {name}");
    }
    Ok(())
}

pub fn tool_name(server: &str, tool: &str) -> Result<String> {
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
