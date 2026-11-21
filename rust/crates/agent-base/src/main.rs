mod policy;
use agent_api::*;
use agent_base::{Options, compose_project};
use interface_terminal::{Mode, TerminalOptions, TerminalPlugin, TerminalSink};
use std::{path::PathBuf, sync::Arc};
fn take(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String> {
    args.next().ok_or_else(|| anyhow!("{flag} needs a value"))
}
#[tokio::main]
async fn main() {
    if let Err(error) = start().await {
        eprintln!("Error: {error:#}");
        std::process::exit(1)
    }
}
async fn start() -> Result<()> {
    if std::env::args().nth(1).as_deref() == Some("--serve-plugin") {
        let plugin = plugin_stdio::server::Conformance::from_env()?;
        let args: Vec<_> = std::env::args().skip(2).collect();
        match args.as_slice() {
            [] => plugin_stdio::server::serve(Arc::new(plugin)).await,
            [flag, address, token_flag, token_file]
                if flag == "--listen" && token_flag == "--token-file" =>
            {
                let server = plugin_stdio::server::serve_websocket(
                    address,
                    token_file.into(),
                    None,
                    move || Arc::new(plugin.new_instance()),
                )
                .await?;
                println!("{}", server.url);
                let stopped = tokio::signal::ctrl_c().await;
                server.close().await;
                stopped?;
            }
            [flag, address, policy_flag, path]
                if flag == "--listen" && policy_flag == "--host-policy" =>
            {
                let hosts = policy::plugin_hosts(&PathBuf::from(path))?;
                let server = plugin_stdio::server::serve_websocket_hosts(
                    address,
                    None,
                    hosts,
                    move |(project, state)| Arc::new(plugin.for_host(project, state)),
                )
                .await?;
                println!("{}", server.url);
                let stopped = tokio::signal::ctrl_c().await;
                server.close().await;
                stopped?;
            }
            _ => bail!(
                "usage: --serve-plugin [--listen ADDR --token-file FILE | --listen ADDR --host-policy FILE]"
            ),
        }
        return Ok(());
    }
    let home = PathBuf::from(std::env::var_os("HOME").ok_or_else(|| anyhow!("HOME missing"))?);
    // Deliberately distinct from ~/.modular-agent and the independent builds.
    let base = home.join(".local/state/modular-agent-rs");
    let mut options = Options {
        history: base.join("sessions"),
        global_config: home.join(".config/modular-agent-rs/settings.json"),
        key_file: home.join(".config/modular-agent-experiment/openai.key"),
        secrets: vec![],
    };
    let mut terminal = TerminalOptions {
        project: std::env::current_dir()?,
        session: None,
        prompt: None,
        settings: json!({}),
        mode: Mode::Line,
        list: false,
        all_projects: false,
        history: false,
        declaration: false,
    };
    let mut acp_mode = false;
    let mut trust_project = false;
    let mut fake = None;
    let mut subagents = None;
    let mut runtime = agent_base::default_runtime();
    let mut provider_mode = if cfg!(feature = "stateful-provider-default") {
        provider_openai::Mode::Stateful
    } else {
        provider_openai::Mode::Stateless
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                println!(
                    "modular-agent [--project DIR] [--session ID] [-p PROMPT | --json [--prompt PROMPT]]\n  --data-dir DIR  --global-config FILE  --list [--all-projects]\n  --acp  --trust-project  --history  --declaration  --fake-script FILE  --runtime transient|durable\n  --provider-mode stateless|stateful\n  --serve-plugin [--listen ADDR --token-file FILE] (modular-agent-plugin/1)\n  --subagents transient|durable  --approval off|ask_always|ask_unless_read_only|never_ask\nLine mode: /commands, /after TEXT, /cancel, /quit, /questions, /answer ID VALUE, /jobs, /cancel-job ID, /tool JSON"
                );
                return Ok(());
            }
            "--acp" => acp_mode = true,
            "--trust-project" => trust_project = true,
            "--approval" => terminal.settings["approval"] = json!(take(&mut args, &arg)?),
            "--subagents" => {
                subagents = Some(match take(&mut args, &arg)?.as_str() {
                    "transient" => false,
                    "durable" => true,
                    _ => bail!("subagents must be transient or durable"),
                })
            }
            "--provider-mode" => {
                provider_mode = match take(&mut args, &arg)?.as_str() {
                    "stateless" => provider_openai::Mode::Stateless,
                    "stateful" => provider_openai::Mode::Stateful,
                    _ => bail!("provider mode must be stateless or stateful"),
                };
            }
            "--runtime" => {
                runtime = match take(&mut args, &arg)?.as_str() {
                    "transient" => Arc::new(runtime_transient::TransientPlugin),
                    "durable" => Arc::new(runtime_durable::DurablePlugin),
                    _ => bail!("runtime must be transient or durable"),
                };
            }
            "--project" => terminal.project = take(&mut args, &arg)?.into(),
            "--session" => terminal.session = Some(take(&mut args, &arg)?),
            "--data-dir" => {
                options.history = PathBuf::from(take(&mut args, &arg)?).join("sessions")
            }
            "--global-config" => options.global_config = take(&mut args, &arg)?.into(),
            "--credential-file" => options.key_file = take(&mut args, &arg)?.into(),
            "--print" | "-p" => {
                terminal.prompt = Some(take(&mut args, &arg)?);
                terminal.mode = Mode::Print;
            }
            "--prompt" => terminal.prompt = Some(take(&mut args, &arg)?),
            "--json" => terminal.mode = Mode::Json,
            "--list" => terminal.list = true,
            "--all-projects" => terminal.all_projects = true,
            "--history" => terminal.history = true,
            "--declaration" => terminal.declaration = true,
            "--fake-script" => fake = Some(PathBuf::from(take(&mut args, &arg)?)),
            _ => bail!("unknown argument {arg}; use --help"),
        }
    }
    // The binding's directory is authoritative, including settings and trust.
    // Explicit CLI paths cannot accidentally escape the host's isolated state.
    if let Some(base) = std::env::var_os("MODULAR_AGENT_DATA_DIR") {
        let base = PathBuf::from(base);
        options.history = base.join("sessions");
        options.global_config = base.join("settings.json");
    }
    let provider = if let Some(path) = fake {
        let values: Vec<Value> = serde_json::from_slice(&std::fs::read(path)?)?;
        let scripts = values
            .into_iter()
            .map(|v| -> Result<_> {
                let response = if let Some(text) = v.as_str() {
                    ModelResponse::text(text)
                } else {
                    serde_json::from_value(v)?
                };
                Ok(provider_fake::Script::response(response))
            })
            .collect::<Result<Vec<_>>>()?;
        terminal.settings["model"] = json!("fake");
        agent_base::fake_provider(scripts)
    } else {
        agent_base::real_provider(options.history.with_file_name("openai"), provider_mode)
    };
    if acp_mode {
        ensure!(
            terminal.prompt.is_none() && terminal.session.is_none() && !trust_project,
            "ACP sessions and trust are controlled by the client"
        );
        ensure!(
            subagents.is_none(),
            "configure ACP subagents in plugin settings"
        );
        let (identity, limits) = policy::load()?.map_or_else(
            || (None, agent_harness::ResourceLimits::default()),
            |(identity, limits)| (Some(identity), limits),
        );
        let factory = Arc::new(agent_base::acp::Factory {
            options,
            provider,
            runtime,
            settings: terminal.settings,
            pool: Arc::new(agent_harness::ReservationPool::new(limits)),
        });
        return match identity {
            Some(identity) => interface_acp::run_stdio(factory, identity).await,
            None => interface_acp::run(factory).await,
        };
    }
    let interface = Arc::new(TerminalPlugin {
        sink: Arc::new(TerminalSink::new(terminal.mode)),
    });
    if let Some(session) = &terminal.session {
        terminal.project = match history_http::HttpHistory::from_env()? {
            Some(http) => http.load(session)?,
            None => history_fs::FileHistory::new(&options.history)?.load(session)?,
        }
        .project;
    }
    if trust_project {
        config_files::FilesConfiguration::new(options.global_config.clone())
            .trust(&terminal.project)?;
    }
    let api = compose_project(options, provider, interface, runtime, &terminal.project).await?;
    if let Some(durable) = subagents {
        api.load(Arc::new(feature_subagents::SubagentsPlugin {
            durable,
            replacement: true,
        }))
        .await?;
    }
    let result = interface_terminal::run(api.clone(), terminal).await;
    let shutdown = api.shutdown().await;
    result.and(shutdown)
}
