//! Disposable plugin kit service. Nothing in the handshake selects a scope.
use anyhow::{Context, Result};
use modular_agent::{self as sdk, NamedServeOptions, Plugin, PluginCaller, Tool, ToolOutput};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Caller {
    caller_id: String,
    token_file: PathBuf,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scope {
    caller_id: String,
    project: PathBuf,
    state_dir: PathBuf,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    listen: String,
    token_file: Option<PathBuf>,
    callers: Vec<Caller>,
    scopes: Vec<Scope>,
    audit_file: PathBuf,
}
fn audit(path: &Path, event: &str, id: &str) -> std::io::Result<()> {
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(f, "{}", json!({"event":event,"callerId":id}))
}
#[tokio::main]
async fn main() -> Result<()> {
    let cfg: Config = serde_json::from_slice(&fs::read(
        std::env::var_os("MA_PLUGIN_FIXTURE").context("missing fixture config")?,
    )?)?;
    let scopes: BTreeMap<_, _> = cfg
        .scopes
        .into_iter()
        .map(|s| (s.caller_id.clone(), (s, sdk::testing::memory_environment())))
        .collect();
    let callers = cfg
        .callers
        .into_iter()
        .map(|c| {
            let mut caller = PluginCaller::new(c.caller_id, c.token_file);
            if let Some((s, _)) = scopes.get(&caller.caller_id) {
                caller.projects.push(s.project.clone());
            }
            caller
        })
        .collect();
    let opts = NamedServeOptions {
        listen: cfg.listen,
        callers,
        token_file: cfg.token_file,
        tls: None,
    };
    let server = sdk::serve_websocket_named(
        move |caller| {
            let id = caller.caller_id;
            audit(&cfg.audit_file, "factory", &id).expect("fixture audit");
            let (s, files) = scopes.get(&id).expect("operator scope");
            let (audit_file, files, marker, caller_id) = (
                cfg.audit_file.clone(),
                files.clone(),
                s.state_dir.join("marker"),
                id.clone(),
            );
            Plugin::new("kit.named")
                .setup(move |r| {
                    audit(&audit_file, "setup", &id)?;
                    r.environment(files.clone())
                })
                .tool(Tool::new("caller_probe", "Read this caller's marker").run(
                    move |v: Value, _| {
                        let path = marker.clone();
                        let id = caller_id.clone();
                        async move {
                            let previous = match fs::read_to_string(&path) {
                                Ok(v) => Some(v),
                                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                                Err(e) => return Err(e.into()),
                            };
                            if let Some(write) = v["write"].as_str() {
                                fs::write(path, write)?;
                            }
                            ToolOutput::value(json!({"callerId":id,"previous":previous}))
                        }
                    },
                ))
                .tool(
                    Tool::new("bash", "Run a host command").run(|v: Value, cx| async move {
                        Ok(cx
                            .environment()
                            .exec(v["command"].as_str().unwrap_or_default(), None)
                            .await?
                            .output)
                    }),
                )
        },
        opts,
    )
    .await;
    match server {
        Ok(server) => {
            println!("{}", json!({"url":server.url}));
            tokio::signal::ctrl_c().await?;
            server.close().await;
            Ok(())
        }
        Err(e) if e.code() == sdk::Code::InvalidComposition => {
            println!("{}", json!({"error":"invalid_composition"}));
            Err(e.into())
        }
        Err(e) => Err(e.into()),
    }
}
