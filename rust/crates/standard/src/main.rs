use anyhow::{Context, Result, anyhow, bail, ensure};
use modular_agent::{
    self as sdk, ClientIdentity, SignInOptions, SignInStep, testing::SCRIPTED_MODEL,
};
use modular_agent_mcp::{Mcp, Server};
use serde_json::json;
use standard::terminal::TerminalOptions;
use standard::{
    Standard, builder,
    terminal::{Mode, Questions},
};

mod sandbox_worker;
mod telemetry;
use standard::policy::Policy;

const HELP: &str = "ma, the standard Modular Agent

Usage:
  ma [options]                 talk to the agent in this folder
  ma [options] -p PROMPT       answer one prompt and exit
  ma login PROVIDER [--device] sign in: chatgpt, grok or claude
  ma logout PROVIDER
  ma auth                      show what is signed in
  ma models                    list the models on offer
  ma skills                    list the skills found for this folder
  ma mcp                       list the configured MCP servers
  ma sessions [--all]          list saved sessions

Options:
  --model PROVIDER/ID   for example chatgpt/gpt-6.1-sol, grok/grok-4.7, claude/claude-sonnet-5-5
  --thinking LEVEL      off, minimal, low, medium, high or xhigh, as the model allows
  --session ID          reopen a session
  -c, --continue        reopen this folder's most recent session
  --project DIR         work in DIR instead of the current folder
  --trust-project       let this project's own .modular-agent.json and .mcp.json start programs
  --runtime KIND        durable (default: a turn cut off by a crash carries on) or transient
  -v, --verbose         also show each call the code makes and what commands print
  --json                print every event as a JSON line
  --history             print the session's history
  --declaration         print what this agent declares it supports
  --acp                 serve the Agent Client Protocol on stdio, for an editor or host
  --agui                serve AG-UI over HTTP and SSE; requires --listen
  --approval POLICY     set each new session's default approval policy: off, ask, all or never
  --resume-open         reopen interrupted turns before serving --acp or --agui
  --listen ADDR         loopback listener for --agui, --acp, or both
  --token-file FILE     configure a single local token for --listen
  --policy FILE         read operator policy instead of policy.json

While the agent works, a line you type steers it; /after TEXT queues a new
turn; /cancel or Ctrl-C stops the turn. /commands lists the rest, including
/model, /thinking, /compact, /skills and /skill:NAME.

Files: settings.json, mcp.json, models.json, AGENTS.md and skills/ in
~/.config/modular-agent. Sessions are kept in ~/.local/state/modular-agent/rust.";

fn take(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String> {
    args.next().ok_or_else(|| anyhow!("{flag} needs a value"))
}

fn client_identity_from_env() -> Result<ClientIdentity> {
    match std::env::var("MA_CLIENT_IDENTITY") {
        Ok(value) => value.parse().context("MA_CLIENT_IDENTITY"),
        Err(std::env::VarError::NotPresent) => Ok(ClientIdentity::default()),
        Err(std::env::VarError::NotUnicode(_)) => {
            bail!("MA_CLIENT_IDENTITY must contain only ASCII characters")
        }
    }
}

fn main() -> std::process::ExitCode {
    let client_identity = match client_identity_from_env() {
        Ok(identity) => identity,
        Err(error) => {
            eprintln!("Error: {error:#}");
            return std::process::ExitCode::FAILURE;
        }
    };
    if !cfg!(any(target_os = "linux", target_os = "macos")) {
        eprintln!("ma supports only Linux and macOS");
        return std::process::ExitCode::FAILURE;
    }
    // monty-pool invokes its worker with this argument. Do not load agent
    // settings, credentials, or start a Tokio runtime in the worker.
    if std::env::args_os().skip(1).eq(["subprocess"]) {
        return match sandbox_worker::run() {
            Ok(status) => status,
            Err(error) => {
                eprintln!("Sandbox worker: {error}");
                std::process::ExitCode::FAILURE
            }
        };
    }
    agent_main(client_identity);
    std::process::ExitCode::SUCCESS
}

#[tokio::main]
async fn agent_main(client_identity: ClientIdentity) {
    let telemetry = telemetry::Export::install();
    let result = start(client_identity).await;
    telemetry.shutdown().await;
    if let Err(error) = result {
        eprintln!("Error: {error:#}");
        std::process::exit(1)
    }
}

fn show_device(address: &str, code: &str) {
    eprintln!("Open this address in a browser:\n\n  {address}\n\nand enter the code: {code}\n");
    open_browser(address);
    eprintln!("Waiting for the sign-in to finish...");
}

fn show_sign_in(step: SignInStep<'_>, can_paste: bool) {
    match step {
        SignInStep::DeviceCode { url, code } => show_device(url, code),
        SignInStep::Waiting => (),
        SignInStep::OpenAndPaste { url } => {
            eprintln!("Open this address in a browser to sign in:\n\n  {url}\n");
            open_browser(url);
            if can_paste {
                eprintln!(
                    "If the browser is elsewhere, copy its localhost address and paste it here."
                );
                eprint!("Paste the address (or the code): ");
            } else {
                eprintln!("Waiting for the sign-in to finish...");
            }
        }
    }
}

/// Lines typed at the terminal, for pasting a sign-in's redirect address. None
/// when standard input is not a terminal.
fn terminal_lines() -> Option<tokio::sync::mpsc::UnboundedReceiver<String>> {
    use std::io::{BufRead, IsTerminal};
    if !std::io::stdin().is_terminal() {
        return None;
    }
    let (send, receive) = tokio::sync::mpsc::unbounded_channel();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if send.send(line).is_err() {
                break;
            }
        }
    });
    Some(receive)
}
/// Best effort. The address is printed either way.
fn open_browser(address: &str) {
    let remote =
        std::env::var_os("SSH_CONNECTION").is_some() || std::env::var_os("SSH_TTY").is_some();
    let display =
        std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some();
    // Over SSH, a browser opened here is not in front of the person signing in.
    if !address.starts_with("https://")
        || std::env::var_os("MA_NO_BROWSER").is_some()
        || remote
        || !display
    {
        return;
    }
    let _ = std::process::Command::new("xdg-open")
        .arg(address)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

fn login_options(mut args: impl Iterator<Item = String>) -> Result<(&'static str, bool)> {
    let raw = args
        .next()
        .ok_or_else(|| anyhow!("which provider? chatgpt, grok or claude"))?;
    let provider = match raw.as_str() {
        "chatgpt" => "chatgpt",
        "grok" => "grok",
        "claude" => "claude",
        _ => bail!("unknown provider {raw}; use chatgpt, grok or claude"),
    };
    let device = match args.next().as_deref() {
        None => false,
        Some("--device") => true,
        Some(other) => bail!("unknown argument {other}"),
    };
    Ok((provider, device))
}

#[cfg(test)]
#[test]
fn login_accepts_only_subscription_names_and_keeps_device_mode() {
    for id in standard::PROVIDERS {
        assert_eq!(
            login_options([id, "--device"].map(str::to_owned).into_iter()).unwrap(),
            (id, true)
        );
    }
    assert!(login_options(["xai".into()].into_iter()).is_err());
}

async fn login(standard: &Standard, args: impl Iterator<Item = String>) -> Result<()> {
    let (provider, device) = login_options(args)?;
    if provider == "claude" {
        // Claude Code holds this sign-in. The sidecar uses it; nothing is stored here.
        eprintln!("Claude signs in through Claude Code. Running `claude auth login`.");
        let status = std::process::Command::new("claude")
            .args(["auth", "login"])
            .status()
            .map_err(|e| {
                anyhow!(
                    "could not run claude: {e}. Install Claude Code, then run `claude auth login`."
                )
            })?;
        ensure!(status.success(), "claude auth login did not complete");
        return Ok(());
    }
    let label = subscription_label(provider).expect("checked subscription id");
    let paste = if provider == "chatgpt" && !device {
        terminal_lines()
    } else {
        None
    };
    let can_paste = paste.is_some();
    sdk::sign_in(
        provider,
        &standard.auth().subscription_logins(),
        SignInOptions {
            device,
            paste,
            client_identity: Some(standard.client_identity.as_str().into()),
            on_step: Some(&|step| show_sign_in(step, can_paste)),
            on_notice: Some(&|text| eprintln!("{text}")),
            ..Default::default()
        },
    )
    .await?;
    eprintln!("Signed in to {label} ({provider}).");
    Ok(())
}

fn subscription_label(provider: &str) -> Option<&'static str> {
    match provider {
        "chatgpt" => Some("ChatGPT subscription"),
        "grok" => Some("Grok subscription"),
        _ => None,
    }
}

async fn auth_status(standard: &Standard) -> Result<()> {
    let auth = standard.auth().subscription_logins();
    for (id, label) in standard::PROVIDERS
        .into_iter()
        .filter_map(|id| subscription_label(id).map(|label| (id, label)))
    {
        let state = match auth.login(id)? {
            Some(login) if login.expired() => "signed in (token will refresh on next use)",
            Some(_) => "signed in",
            None => "not signed in",
        };
        println!("{id:<13} {label:<22} {state}");
    }
    let status = match sdk::claude(sdk::ClaudeOptions::default()) {
        Ok(provider) => provider
            .unavailable_reason()
            .await
            .unwrap_or_else(|| "signed in through Claude Code".into()),
        Err(e) => e.message().to_owned(),
    };
    println!("{:<13} {:<22} {status}", "claude", "Claude subscription");
    Ok(())
}

async fn start(client_identity: ClientIdentity) -> Result<()> {
    let mut standard = Standard::from_env(client_identity)?;
    let mut raw = std::env::args().skip(1);
    let mut remaining = Vec::new();
    let mut policy_file = None;
    while let Some(arg) = raw.next() {
        if arg == "--policy" {
            ensure!(
                policy_file.is_none(),
                "--policy was supplied more than once"
            );
            policy_file = Some(std::path::PathBuf::from(take(&mut raw, &arg)?));
        } else {
            remaining.push(arg);
            if matches!(
                remaining.last().map(String::as_str),
                Some(
                    "-p" | "--print"
                        | "--project"
                        | "--model"
                        | "--thinking"
                        | "--runtime"
                        | "--approval"
                        | "--session"
                        | "--listen"
                        | "--token-file"
                )
            ) && let Some(value) = raw.next()
            {
                remaining.push(value);
            }
        }
    }
    let required = policy_file.is_some();
    let policy_file = policy_file.unwrap_or_else(|| standard.config.join("policy.json"));
    let mut policy = Policy::read(&policy_file, required).await?;
    let bounds = policy.bounds()?;
    standard.limits = bounds.counts();
    standard.byte_limits = bounds.bytes();
    standard.approval_wait_max_ms = policy.approval_wait_max_ms;
    standard.tenant_scopes = policy.named_tenants();
    let mut args = remaining.into_iter().peekable();
    let mut project = std::env::current_dir()?;
    match args.peek().map(String::as_str) {
        Some("login") => return login(&standard, args.skip(1)).await,
        Some("logout") => {
            let provider = args.nth(1).ok_or_else(|| anyhow!("which provider?"))?;
            if provider == "claude" {
                bail!("Claude Code holds that sign-in; run `claude auth logout`");
            }
            let label = subscription_label(&provider)
                .ok_or_else(|| anyhow!("unknown provider {provider}"))?;
            sdk::sign_out(&provider, &standard.auth().subscription_logins()).await?;
            eprintln!("Signed out of {label}.");
            return Ok(());
        }
        Some("auth") => return auth_status(&standard).await,
        Some("models") => {
            standard.claude = !standard.conformance
                && standard.scripted.is_none()
                && sdk::claude(sdk::ClaudeOptions::default()).is_ok();
            let agent = builder(&standard, &project, &Mcp::default(), vec![])?
                .build()
                .await?;
            for model in agent.models()? {
                println!(
                    "{:<34} context {:>7}  thinking {}",
                    format!("{}/{}", model.model.provider, model.model.id),
                    model.context_window,
                    model.thinking.join(",")
                );
            }
            agent.close().await?;
            return Ok(());
        }
        Some("skills") => {
            let plugin = standard.skills();
            let (skills, problems) = standard::skills::discover(&plugin.folders(&project));
            for skill in skills {
                println!(
                    "{:<28} {}\n{:<28} {}",
                    skill.name,
                    skill.description,
                    "",
                    skill.file.display()
                );
            }
            for problem in problems {
                eprintln!("skipped {problem}");
            }
            return Ok(());
        }
        Some("mcp") => {
            let config = standard::mcp::McpConfig {
                global: standard.config.join("mcp.json"),
                project_trusted: standard.configuration().trusted(&project.canonicalize()?)?,
            };
            let (servers, problems) = config.servers(&project);
            for server in servers {
                match server {
                    Server::Stdio {
                        name,
                        command,
                        args,
                        ..
                    } => {
                        println!("{name:<20} stdio  {command} {}", args.join(" "))
                    }
                    Server::Http { name, url, .. } => {
                        println!("{name:<20} http   {url}")
                    }
                }
            }
            for problem in problems {
                eprintln!("{problem}");
            }
            return Ok(());
        }
        _ => (),
    }
    let mut terminal = TerminalOptions {
        session: None,
        prompt: None,
        settings: json!({}),
        mode: Mode::Line,
        list: false,
        all_projects: false,
        history: false,
        declaration: false,
        verbose: false,
    };
    let (mut acp, mut trust, mut resume) = (false, false, false);
    let mut agui = false;
    let mut resume_open = false;
    let (mut listen, mut token_file) = (None, None);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                println!("{HELP}");
                return Ok(());
            }
            "--version" | "-V" => {
                println!("ma {} (rust)", env!("CARGO_PKG_VERSION"));
                return Ok(());
            }
            "sessions" => terminal.list = true,
            "--all" => terminal.all_projects = true,
            "--acp" => acp = true,
            "--agui" => agui = true,
            "--resume-open" => resume_open = true,
            "--listen" => listen = Some(take(&mut args, &arg)?),
            "--token-file" => token_file = Some(take(&mut args, &arg)?),
            "--trust-project" => trust = true,
            "--model" => terminal.settings["model"] = json!(take(&mut args, &arg)?),
            "--thinking" => terminal.settings["thinking"] = json!(take(&mut args, &arg)?),
            "--runtime" => {
                standard.durable = match take(&mut args, &arg)?.as_str() {
                    "transient" => false,
                    "durable" => true,
                    _ => bail!("runtime must be transient or durable"),
                }
            }
            "--approval" => {
                standard.approval = Some(standard::approval_policy(&take(&mut args, &arg)?)?)
            }
            "--project" => project = take(&mut args, &arg)?.into(),
            "--session" => terminal.session = Some(take(&mut args, &arg)?),
            "--continue" | "-c" => resume = true,
            "--print" | "-p" => {
                terminal.prompt = Some(take(&mut args, &arg)?);
                if terminal.mode != Mode::Json {
                    terminal.mode = Mode::Print;
                }
            }
            "--verbose" | "-v" => terminal.verbose = true,
            "--json" => terminal.mode = Mode::Json,
            "--history" => terminal.history = true,
            "--declaration" => terminal.declaration = true,
            _ => bail!("unknown argument {arg}; use --help"),
        }
    }
    ensure!(!agui || listen.is_some(), "--agui requires --listen");
    let clients = if agui { policy.agui_clients()? } else { vec![] };
    let service = match (listen, token_file) {
        (Some(listen), token_file) if acp || agui => Some(sdk::AcpServiceOptions {
            listen,
            actors: policy
                .network(token_file.map(Into::into))
                .map_err(|error| anyhow!("policy {}: {error}", policy_file.display()))?,
            tls: None,
        }),
        (None, None) => None,
        _ => bail!("--listen requires --acp or --agui, and --token-file requires --listen"),
    };
    let local = policy.stdio();
    if acp || agui {
        ensure!(
            terminal.prompt.is_none() && terminal.session.is_none() && !resume,
            "with --acp or --agui the client creates or reopens sessions"
        );
        if trust {
            standard.configuration().trust(&project)?;
        }
        if standard.resume_open()? || resume_open {
            let factory = standard::acp::Factory {
                standard: standard.clone(),
                settings: terminal.settings.clone(),
                mcp: Mcp::default(),
            };
            factory.resume_open(&project, &local).await?;
        }
    }
    if agui {
        let project = project.canonicalize()?;
        let configured = standard.configuration().settings(&project)?;
        let mut model = terminal.settings["model"]
            .as_str()
            .or(configured["model"].as_str())
            .map(str::to_owned);
        if standard.scripted.is_some() {
            model = Some(SCRIPTED_MODEL.into());
        } else if model.is_none() && !standard.conformance {
            model = standard::default_model(&standard).await.map(str::to_owned);
        }
        standard.claude = model.as_deref().is_some_and(|s| s.starts_with("claude/"));
        let mcp = Mcp::default();
        let mut b = builder(&standard, &project, &mcp, vec![])?;
        if let Some(model) = model {
            b = b.model(model);
        }
        if let Some(thinking) = terminal.settings.get("thinking") {
            b = b.setting("thinking", thinking.clone());
        }
        let agent = b.build().await?;
        let service = service.expect("AG-UI requires a listener");
        let result = async {
            let server = agent
                .serve_agui(sdk::AguiOptions {
                    listen: service.listen,
                    actors: service
                        .actors
                        .into_iter()
                        .zip(clients)
                        .map(|(p, id)| sdk::AguiActor::new(id, p))
                        .collect(),
                    acp,
                    acp_composition: Some(std::sync::Arc::new(standard::acp::Factory {
                        standard,
                        settings: terminal.settings,
                        mcp,
                    })),
                    ..Default::default()
                })
                .await?;
            println!("{}", server.url);
            let stopped = tokio::signal::ctrl_c().await;
            server.close().await;
            Ok::<_, anyhow::Error>(stopped?)
        }
        .await;
        let closed = agent.close().await;
        return result.and(closed.map_err(Into::into));
    }
    if acp {
        let mcp = Mcp::default();
        // The bootstrap agent supplies the declaration. Only the actual
        // project/session composition can choose to start Claude.
        let launch = tempfile::tempdir_in(&standard.state).or_else(|err| {
            if err.kind() != std::io::ErrorKind::NotFound {
                return Err(err);
            }
            std::fs::create_dir_all(&standard.state)?;
            tempfile::tempdir_in(&standard.state)
        })?;
        let agent = builder(&standard, launch.path(), &mcp, vec![])?
            .build()
            .await?;
        let mut options = local;
        options.compose = Some(std::sync::Arc::new(standard::acp::Factory {
            standard,
            settings: terminal.settings,
            mcp,
        }));
        let served = if let Some(service) = service {
            async {
                let server = agent.serve_acp_websocket(options, service).await?;
                let stopped = tokio::signal::ctrl_c().await;
                server.close().await;
                Ok(stopped?)
            }
            .await
        } else {
            agent.serve_acp(options).await
        };
        let closed = agent.close().await;
        return Ok(served.and(closed)?);
    }
    if terminal.list {
        let project = project.canonicalize()?;
        let sessions = standard
            .history()?
            .sessions((!terminal.all_projects).then_some(project.as_path()))?;
        println!("{}", serde_json::to_string_pretty(&sessions.into_iter().map(|s| {
            json!({"id":s.id,"project":s.project,"lastActive":s.last_active,"model":s.model.map(|model| model.to_string())})
        }).collect::<Vec<_>>())?);
        return Ok(());
    }
    if resume && terminal.session.is_none() {
        let canonical = project.canonicalize()?;
        terminal.session = standard
            .history()?
            .sessions(Some(&canonical))?
            .into_iter()
            .max_by_key(|s| s.last_active)
            .map(|s| s.id);
        ensure!(
            terminal.session.is_some(),
            "this folder has no saved session to continue"
        );
    }
    let recorded = match &terminal.session {
        Some(session) => {
            let data = standard.history()?.session_info(session)?;
            project = data.project;
            data.model.map(|model| model.to_string())
        }
        None => None,
    };
    if trust {
        standard.configuration().trust(&project)?;
    }
    if terminal.declaration {
        // A declaration describes the parts without opening a session or
        // starting a sidecar for a model that will not be used.
        let agent = builder(&standard, &project, &Mcp::default(), vec![])?
            .build()
            .await?;
        let mut declaration = agent.declaration()?;
        declaration["limits"] = serde_json::to_value(bounds)?;
        println!("{}", serde_json::to_string_pretty(&declaration)?);
        agent.close().await?;
        return Ok(());
    }
    // Which model this run will use decides whether the Claude sidecar starts.
    let configured = {
        standard
            .configuration()
            .settings(&project.canonicalize()?)?["model"]
            .as_str()
            .map(str::to_owned)
    };
    let chosen = terminal.settings["model"]
        .as_str()
        .map(str::to_owned)
        .or(recorded)
        .or(configured);
    let inspecting = terminal.history;
    let chosen = if standard.scripted.is_some() {
        Some(SCRIPTED_MODEL.into())
    } else if standard.conformance {
        chosen.or_else(|| Some("conformance/echo".into()))
    } else {
        match chosen {
            Some(model) => Some(model),
            None if !inspecting => standard::default_model(&standard).await.map(str::to_owned),
            None => None,
        }
    };
    if chosen.is_none() && !inspecting {
        bail!(
            "no model is available. Sign in with `ma login chatgpt`, `ma login grok` or `ma login claude`, or pass --model. See `ma models`."
        );
    }
    standard.claude = chosen.as_ref().is_some_and(|m| m.starts_with("claude/"));
    if standard.scripted.is_some() {
        terminal.settings["model"] = json!(SCRIPTED_MODEL);
    }
    let mut b = builder(&standard, &project, &Mcp::default(), vec![])?;
    if let Some(model) = chosen {
        b = b.model(model);
    }
    let questions = Questions::default();
    if terminal.prompt.is_none() && !inspecting {
        b = questions.install(b);
    }
    let agent = b.build().await?;
    let result = standard::terminal::run(&agent, terminal, questions).await;
    let shutdown = agent.close().await;
    result.and(shutdown.map_err(Into::into))
}
