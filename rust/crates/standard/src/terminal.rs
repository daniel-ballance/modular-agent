//! Line and print Interfaces over SDK sessions.
use crate::sink::Sink;
use anyhow::{Result, anyhow, bail};
use futures_util::StreamExt;
use modular_agent::{Agent, AgentBuilder, Answer, Outcome, Session, Timing};
use serde_json::Value;
use std::{
    io::BufRead,
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, oneshot};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mode {
    Line,
    Print,
    Json,
}

type PendingAnswers =
    std::collections::BTreeMap<String, (modular_agent::QuestionKind, oneshot::Sender<Answer>)>;
#[derive(Clone, Default)]
pub struct Questions(Arc<Mutex<PendingAnswers>>);
impl Questions {
    pub fn install(&self, b: AgentBuilder) -> AgentBuilder {
        let this = self.clone();
        b.on_question(move |q| {
            let (tx, rx) = oneshot::channel();
            this.0.lock().unwrap().insert(q.id, (q.kind, tx));
            async move {
                rx.await.unwrap_or(Answer::Declined {
                    reason: Some("terminal closed".into()),
                })
            }
        })
    }

    fn answer(&self, id: &str, value: &str) -> Result<()> {
        let (kind, sender) = self
            .0
            .lock()
            .unwrap()
            .remove(id)
            .ok_or_else(|| anyhow!("no question named {id}"))?;
        let answer = match value {
            "allow" if kind == modular_agent::QuestionKind::Approval => Answer::Allow,
            "decline" => Answer::Declined {
                reason: Some("declined".into()),
            },
            value if kind == modular_agent::QuestionKind::Secret => Answer::Secret(value.into()),
            value => Answer::Value(value.into()),
        };
        sender
            .send(answer)
            .map_err(|_| anyhow!("question is no longer answerable"))
    }

    fn decline_all(&self) {
        self.0.lock().unwrap().clear();
    }
}

/// A dedicated reader can outlive /quit without blocking Tokio's shutdown.
/// See https://docs.rs/tokio/1.54.1/tokio/io/fn.stdin.html.
fn lines() -> mpsc::Receiver<std::io::Result<String>> {
    let (tx, rx) = mpsc::channel(32);
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            if tx.blocking_send(line).is_err() {
                break;
            }
        }
    });
    rx
}

pub struct TerminalOptions {
    pub session: Option<String>,
    pub prompt: Option<String>,
    pub settings: Value,
    pub mode: Mode,
    pub list: bool,
    pub all_projects: bool,
    pub history: bool,
    pub declaration: bool,
    pub verbose: bool,
}

pub async fn run(agent: &Agent, options: TerminalOptions, questions: Questions) -> Result<()> {
    let TerminalOptions {
        session,
        prompt,
        mode,
        verbose,
        history,
        settings,
        ..
    } = options;
    let id = session.as_deref();
    let sink = Arc::new(Sink::new(mode, verbose));
    let mut events = agent.events();
    let run = async {
        let session = match id {
            Some(id) => agent.open_session(id).await?,
            None => agent.session().await?,
        };
        {
            for key in ["model", "thinking"] {
                if (id.is_some() || key == "thinking")
                    && let Some(value) = settings.get(key)
                {
                    session.set_setting(
                        if key == "thinking" { "reasoning" } else { key },
                        value.clone(),
                    )?;
                }
            }
        }
        if history {
            println!(
                "{}",
                serde_json::to_string_pretty(&session.history().await?)?
            );
        } else if let Some(text) = prompt {
            let result = session.prompt(text).await?;
            if mode != Mode::Json {
                println!("{}", result.text);
            }
            if let Some(outcome) = result.outcome
                && outcome != Outcome::Completed
            {
                bail!("turn {}", outcome.kind());
            }
        } else {
            interactive(&session, questions, mode).await?;
        }
        session.close().await?;
        Ok(())
    };
    tokio::pin!(run);
    loop {
        tokio::select! {
            event = events.next() => match event {
                Some(Ok(event)) if !history => sink.send(event),
                Some(Ok(_)) => (),
                Some(Err(error)) => return Err(error.into()),
                None => return run.await,
            },
            result = &mut run => {
                while let Some(Some(event)) = futures_util::FutureExt::now_or_never(events.next()) {
                    let event = event?;
                    if !history { sink.send(event); }
                }
                return result;
            }
        }
    }
}

async fn interactive(session: &Session, questions: Questions, mode: Mode) -> Result<()> {
    let mut lines = lines();
    loop {
        tokio::select! {
            ctrl = tokio::signal::ctrl_c() => {
                ctrl?;
                if session.is_running() { session.cancel().await?; } else { break; }
            }
            line = lines.recv() => {
                let Some(line) = line.transpose()? else {
                    // A closed pipe cannot answer questions. Decline both those
                    // already shown and any opened while the last input drains.
                    let idle = session.wait_idle();
                    tokio::pin!(idle);
                    loop {
                        questions.decline_all();
                        tokio::select! {
                            result = &mut idle => { result?; break; }
                            _ = tokio::time::sleep(std::time::Duration::from_millis(10)) => (),
                        }
                    }
                    break;
                };
                let line = line.trim();
                if line.is_empty() { continue; }
                if line == "/quit" {
                    questions.decline_all();
                    session.cancel().await?;
                    break;
                }
                if let Err(error) = input(session, &questions, mode, line).await {
                    eprintln!("{error:#}");
                }
            }
        }
    }
    Ok(())
}

async fn input(session: &Session, questions: &Questions, mode: Mode, line: &str) -> Result<()> {
    let display = |text: &str| {
        if mode == Mode::Json {
            eprintln!("{text}");
        } else {
            println!("{text}");
        }
    };
    if line == "/cancel" {
        questions.decline_all();
        session.cancel().await?;
    } else if let Some(args) = line.strip_prefix("/answer ") {
        let (id, value) = args
            .split_once(' ')
            .ok_or_else(|| anyhow!("use /answer REQUEST_ID VALUE"))?;
        questions.answer(id, value)?;
    } else if line == "/questions" {
        display(&serde_json::to_string(
            &questions.0.lock().unwrap().keys().collect::<Vec<_>>(),
        )?);
    } else if let Some(args) = line.strip_prefix("/tool ") {
        let v: Value = serde_json::from_str(args)?;
        let name = v["name"]
            .as_str()
            .ok_or_else(|| anyhow!("tool name required"))?;
        display(session.call_tool(name, v["input"].clone()).await?.text());
    } else if let Some(text) = line.strip_prefix("/after ") {
        session.send(text, Timing::After).await?;
    } else if line == "/commands" {
        let mut commands = session.commands()?;
        commands.extend(
            [
                "after",
                "answer",
                "cancel",
                "questions",
                "quit",
                "skill:NAME",
                "tool",
            ]
            .map(str::to_owned),
        );
        commands.sort();
        for name in commands {
            display(&format!("/{name}"));
        }
    } else if line.starts_with('/') && !line.starts_with("/skill:") {
        if let Some(text) = session.run_command(line).await? {
            display(&text);
        }
    } else {
        let timing = if session.is_running() {
            Timing::Steer
        } else {
            Timing::Now
        };
        session.send(line, timing).await?;
    }
    Ok(())
}
