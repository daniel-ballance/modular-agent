use anyhow::{Result, anyhow, bail, ensure};
use modular_agent::{self as sdk, testing::SCRIPTED_MODEL};
use modular_agent_mcp::{Mcp, Server};
use provider_responses::{Vendor, oauth};
use serde_json::json;
use standard::terminal::TerminalOptions;
use standard::{
    Standard, builder,
    terminal::{Mode, Questions},
};

const HELP: &str = "ma, the standard Modular Agent

Usage:
  ma [options]                 talk to the agent in this folder
  ma [options] -p PROMPT       answer one prompt and exit
  ma login PROVIDER [--device] sign in: openai-codex, xai or claude
  ma logout PROVIDER
  ma auth                      show what is signed in
  ma models                    list the models on offer
  ma skills                    list the skills found for this folder
  ma mcp                       list the configured MCP servers
  ma sessions [--all]          list saved sessions

Options:
  --model PROVIDER/ID   for example openai-codex/gpt-6.1-sol, xai/grok-4.7, claude/claude-sonnet-5-5
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

While the agent works, a line you type steers it; /after TEXT queues a new
turn; /cancel or Ctrl-C stops the turn. /commands lists the rest, including
/model, /thinking, /compact, /skills and /skill:NAME.

Files: settings.json, mcp.json, models.json, AGENTS.md and skills/ in
~/.config/modular-agent. Sessions are kept in ~/.local/state/modular-agent/rust.";

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

fn show(step: oauth::Step<'_>) {
    match step {
        oauth::Step::Open(address) => {
            eprintln!("Open this address in a browser to sign in:\n\n  {address}\n");
            open_browser(address);
            eprintln!("Waiting for the sign-in to finish...");
        }
        oauth::Step::Code { address, code } => {
            eprintln!(
                "Open this address in a browser:\n\n  {address}\n\nand enter the code: {code}\n"
            );
            open_browser(address);
            eprintln!("Waiting for the sign-in to finish...");
        }
        oauth::Step::OpenAndPaste(address) => {
            eprintln!(
                "Open this address in a browser, on this machine or any other:\n\n  {address}\n"
            );
            open_browser(address);
            eprintln!(
                "After you sign in, the browser goes to a localhost address. If the browser is on this\n\
                 machine, that finishes the sign-in. Otherwise the page will not load: copy the whole\n\
                 address from the browser's address bar and paste it here.\n"
            );
            eprint!("Paste the address (or the code): ");
        }
        oauth::Step::Note(text) => eprintln!("{text}"),
    }
}

/// Lines typed at the terminal, for pasting a sign-in's redirect address. None
/// when standard input is not a terminal.
fn terminal_lines() -> Option<oauth::Pasted> {
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

async fn login(standard: &Standard, mut args: impl Iterator<Item = String>) -> Result<()> {
    let provider = args
        .next()
        .ok_or_else(|| anyhow!("which provider? openai-codex, xai or claude"))?;
    let device = match args.next().as_deref() {
        None => false,
        Some("--device") => true,
        Some(other) => bail!("unknown argument {other}"),
    };
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
    let vendor = Vendor::parse(&provider)
        .ok_or_else(|| anyhow!("unknown provider {provider}; use openai-codex, xai or claude"))?;
    let login = oauth::login(vendor, device, terminal_lines(), &show).await?;
    standard.auth().set_login(vendor.id(), Some(login))?;
    eprintln!("Signed in to {} ({}).", vendor.label(), vendor.id());
    Ok(())
}

fn claude_status() -> String {
    match std::process::Command::new("claude")
        .args(["auth", "status"])
        .stdin(std::process::Stdio::null())
        .output()
    {
        Ok(output) if output.status.success() => "signed in through Claude Code".into(),
        Ok(_) => "not signed in (run `ma login claude`)".into(),
        Err(_) => "Claude Code is not installed".into(),
    }
}

fn auth_status(standard: &Standard) -> Result<()> {
    let auth = standard.auth();
    for vendor in [Vendor::Codex, Vendor::Xai] {
        let state = match auth.login(vendor.id())? {
            Some(login) if login.expired() => "signed in (token will refresh on next use)",
            Some(_) => "signed in",
            None => "not signed in",
        };
        println!("{:<13} {:<22} {state}", vendor.id(), vendor.label());
    }
    println!(
        "{:<13} {:<22} {}",
        "claude",
        "Claude subscription",
        claude_status()
    );
    if standard.claude_launch().is_none() {
        println!(
            "              the Claude sidecar is not installed (build typescript/sidecars/claude)"
        );
    }
    Ok(())
}

async fn start() -> Result<()> {
    let mut standard = Standard::from_env()?;
    let mut args = std::env::args().skip(1).peekable();
    let mut project = std::env::current_dir()?;
    match args.peek().map(String::as_str) {
        Some("login") => return login(&standard, args.skip(1)).await,
        Some("logout") => {
            let provider = args.nth(1).ok_or_else(|| anyhow!("which provider?"))?;
            if provider == "claude" {
                bail!("Claude Code holds that sign-in; run `claude auth logout`");
            }
            let vendor =
                Vendor::parse(&provider).ok_or_else(|| anyhow!("unknown provider {provider}"))?;
            standard.auth().set_login(vendor.id(), None)?;
            eprintln!("Signed out of {}.", vendor.label());
            return Ok(());
        }
        Some("auth") => return auth_status(&standard),
        Some("models") => {
            standard.claude = standard.claude_launch().is_some();
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
    if acp {
        ensure!(
            terminal.prompt.is_none() && terminal.session.is_none() && !resume,
            "with --acp the client creates or reopens sessions"
        );
        if trust {
            standard.configuration().trust(&project)?;
        }
        let mcp = Mcp::default();
        // The bootstrap agent supplies the declaration. Only the actual
        // project/session composition can choose to start Claude.
        let agent = builder(&standard, &project, &mcp, vec![])?.build().await?;
        let served = agent
            .serve_acp(sdk::AcpOptions {
                compose: Some(std::sync::Arc::new(standard::acp::Factory {
                    standard,
                    settings: terminal.settings,
                    mcp,
                })),
            })
            .await;
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
        println!("{}", serde_json::to_string_pretty(&agent.declaration()?)?);
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
        chosen.or_else(|| standard::default_model(&standard).map(str::to_owned))
    };
    if chosen.is_none() && !inspecting {
        bail!(
            "no model is available. Sign in with `ma login openai-codex`, `ma login xai` or `ma login claude`, or pass --model. See `ma models`."
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
