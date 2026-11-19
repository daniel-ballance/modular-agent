use agent_api::*;
use interface_terminal::{Mode, TerminalOptions, TerminalPlugin};
use provider_responses::{Vendor, oauth};
use standard::{Standard, compose, sink::Sink};
use std::{path::PathBuf, sync::Arc};

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
~/.config/modular-agent. Sessions are kept in ~/.local/state/modular-agent.";

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
            eprintln!("Open this address in a browser:\n\n  {address}\n\nand enter the code: {code}\n");
            open_browser(address);
            eprintln!("Waiting for the sign-in to finish...");
        }
        oauth::Step::Note(text) => eprintln!("{text}"),
    }
}
/// Best effort. The address is printed either way.
fn open_browser(address: &str) {
    if !address.starts_with("https://") || std::env::var_os("MA_NO_BROWSER").is_some() {
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
            .map_err(|e| anyhow!("could not run claude: {e}. Install Claude Code, then run `claude auth login`."))?;
        ensure!(status.success(), "claude auth login did not complete");
        return Ok(());
    }
    let vendor = Vendor::parse(&provider)
        .ok_or_else(|| anyhow!("unknown provider {provider}; use openai-codex, xai or claude"))?;
    let login = oauth::login(vendor, device, &show).await?;
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
    println!("{:<13} {:<22} {}", "claude", "Claude subscription", claude_status());
    if standard.claude_launch().is_none() {
        println!("              the Claude sidecar is not installed (build sidecars/claude)");
    }
    Ok(())
}

struct Quiet;
impl EventSink for Quiet {
    fn send(&self, _: Event) {}
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
            let vendor = Vendor::parse(&provider).ok_or_else(|| anyhow!("unknown provider {provider}"))?;
            standard.auth().set_login(vendor.id(), None)?;
            eprintln!("Signed out of {}.", vendor.label());
            return Ok(());
        }
        Some("auth") => return auth_status(&standard),
        Some("models") => {
            standard.claude = standard.claude_launch().is_some();
            let api = compose(&standard, Arc::new(TerminalPlugin { sink: Arc::new(Quiet) }), &project).await?;
            for model in standard::models(api.as_ref())? {
                println!(
                    "{:<34} context {:>7}  thinking {}",
                    model.name,
                    model.context_window,
                    model.thinking.join(",")
                );
            }
            return api.shutdown().await;
        }
        Some("skills") => {
            let plugin = standard.skills();
            let (skills, problems) = standard::skills::discover(&plugin.folders(&project));
            for skill in skills {
                println!("{:<28} {}\n{:<28} {}", skill.name, skill.description, "", skill.file.display());
            }
            for problem in problems {
                eprintln!("skipped {problem}");
            }
            return Ok(());
        }
        Some("mcp") => {
            let config = standard::mcp::McpConfig {
                service: Arc::default(),
                global: standard.config.join("mcp.json"),
                project_trusted: standard.configuration().trusted(&project.canonicalize()?)?,
            };
            let (servers, problems) = config.servers(&project);
            for server in servers {
                match server {
                    tools_mcp::Server::Stdio { name, command, args, .. } => {
                        println!("{name:<20} stdio  {command} {}", args.join(" "))
                    }
                    tools_mcp::Server::Http { name, url, .. } => println!("{name:<20} http   {url}"),
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
        project: project.clone(),
        session: None,
        prompt: None,
        settings: json!({}),
        mode: Mode::Line,
        list: false,
        all_projects: false,
        history: false,
        declaration: false,
    };
    let (mut acp, mut trust, mut resume, mut verbose) = (false, false, false, false);
    let mut fake = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                println!("{HELP}");
                return Ok(());
            }
            "--version" | "-V" => {
                println!("ma {}", env!("CARGO_PKG_VERSION"));
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
                terminal.mode = Mode::Print;
            }
            "--verbose" | "-v" => verbose = true,
            "--json" => terminal.mode = Mode::Json,
            "--history" => terminal.history = true,
            "--declaration" => terminal.declaration = true,
            // Tests only: answers scripted in a file instead of a model.
            "--fake-script" => fake = Some(PathBuf::from(take(&mut args, &arg)?)),
            _ => bail!("unknown argument {arg}; use --help"),
        }
    }
    if let Some(path) = fake {
        let values: Vec<Value> = serde_json::from_slice(&std::fs::read(path)?)?;
        let scripts = values
            .into_iter()
            .map(|v| -> Result<_> {
                let response = match v.as_str() {
                    Some(text) => ModelResponse::text(text),
                    None => serde_json::from_value(v)?,
                };
                Ok(provider_fake::Script::response(response))
            })
            .collect::<Result<Vec<_>>>()?;
        terminal.settings["model"] = json!("fake");
        standard.scripted = Some(Arc::new(provider_fake::FakePlugin::new(scripts)));
    }
    if acp {
        ensure!(
            terminal.prompt.is_none() && terminal.session.is_none() && !trust && !resume,
            "with --acp the client creates sessions and grants trust"
        );
        standard.claude = standard.claude_launch().is_some();
        return interface_acp::run(Arc::new(standard::acp::Factory {
            standard,
            settings: terminal.settings,
        }))
        .await;
    }
    if resume && terminal.session.is_none() {
        let canonical = project.canonicalize()?;
        terminal.session = standard
            .list(Some(&canonical))?
            .into_iter()
            .max_by_key(|s| s.entries.last().map_or(0, |e| e.at))
            .map(|s| s.id);
        ensure!(terminal.session.is_some(), "this folder has no saved session to continue");
    }
    let recorded = match &terminal.session {
        Some(session) => {
            let data = standard.load(session)?;
            project = data.project.clone();
            data.settings["model"].as_str().map(str::to_owned)
        }
        None => None,
    };
    terminal.project = project.clone();
    if trust {
        standard.configuration().trust(&project)?;
    }
    // Which model this run will use decides whether the Claude sidecar starts.
    let configured = {
        use agent_api::Configuration;
        standard.configuration().settings(&project.canonicalize()?)?["model"]
            .as_str()
            .map(str::to_owned)
    };
    let chosen = terminal.settings["model"]
        .as_str()
        .map(str::to_owned)
        .or(recorded)
        .or(configured);
    let inspecting = terminal.list || terminal.history || terminal.declaration;
    match &chosen {
        Some(model) => standard.claude = model.starts_with("claude/"),
        None if inspecting || standard.scripted.is_some() => (),
        None => match standard::default_model(&standard) {
            Some(model) => terminal.settings["model"] = json!(model),
            None if standard.claude_launch().is_some() => {
                standard.claude = true;
                terminal.settings["model"] = json!("claude/claude-sonnet-5-5");
            }
            None => bail!(
                "no model is available. Sign in with `ma login openai-codex`, `ma login xai` or `ma login claude`, or pass --model. See `ma models`."
            ),
        },
    }
    let interface = Arc::new(TerminalPlugin {
        sink: Arc::new(Sink::new(terminal.mode, verbose)),
    });
    let api = compose(&standard, interface, &project).await?;
    let result = interface_terminal::run(api.clone(), terminal).await;
    let shutdown = api.shutdown().await;
    result.and(shutdown)
}
