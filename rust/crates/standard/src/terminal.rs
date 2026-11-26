//! Line and print Interfaces over SDK sessions.
use crate::sink::Sink;
use anyhow::{Result, anyhow, bail};
use futures_util::StreamExt;
use modular_agent::{
    Agent, AgentBuilder, Answer, Outcome, Question, QuestionKind, Session, Timing,
};
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

struct Pending {
    id: String,
    kind: QuestionKind,
    prompt: Option<String>,
    sender: oneshot::Sender<Answer>,
}
#[derive(Default)]
struct PendingAnswers {
    items: Vec<Pending>,
    closed: bool,
    hidden_input: bool,
}
impl PendingAnswers {
    fn approval(&self) -> Option<&Pending> {
        self.items.iter().find(|p| p.prompt.is_some())
    }
    fn remove(&mut self, id: &str) -> Option<Pending> {
        let front = self.approval().is_some_and(|p| p.id == id);
        let item = self
            .items
            .remove(self.items.iter().position(|p| p.id == id)?);
        if front && let Some(prompt) = self.approval().and_then(|p| p.prompt.as_ref()) {
            eprintln!("{prompt}");
        }
        Some(item)
    }
}
/// Remove a terminal prompt even if the SDK drops the handler on cancellation.
struct Showing(Questions, String);
impl Drop for Showing {
    fn drop(&mut self) {
        self.0.0.lock().unwrap().remove(&self.1);
    }
}
#[derive(Clone, Default)]
pub struct Questions(Arc<Mutex<PendingAnswers>>);
impl Questions {
    /// `hidden_input` says whether a secret can be read with echo off.
    pub fn new(hidden_input: bool) -> Self {
        let questions = Self::default();
        questions.0.lock().unwrap().hidden_input = hidden_input;
        questions
    }

    pub fn install(&self, b: AgentBuilder) -> AgentBuilder {
        let this = self.clone();
        b.on_question(move |q| {
            let this = this.clone();
            async move { this.ask(q).await }
        })
    }

    async fn ask(&self, q: Question) -> Answer {
        let declined = |reason: &str| Answer::Declined {
            reason: Some(reason.into()),
        };
        let (sender, rx) = oneshot::channel();
        let _showing = {
            let mut pending = self.0.lock().unwrap();
            if pending.closed {
                return declined("terminal closed");
            }
            if q.kind == QuestionKind::Secret && !pending.hidden_input {
                return declined("a secret needs a terminal to hide it");
            }
            let prompt = (q.kind == QuestionKind::Approval && q.call.is_some())
                .then(|| format!("{}\nAllow? (y/n)", q.question));
            if pending.approval().is_none()
                && let Some(prompt) = &prompt
            {
                eprintln!("{prompt}");
            }
            let shown = prompt.is_none();
            pending.items.push(Pending {
                id: q.id.clone(),
                kind: q.kind,
                prompt,
                sender,
            });
            if shown {
                let options = if q.options.is_empty() {
                    String::new()
                } else {
                    format!(" {}", serde_json::json!(q.options))
                };
                eprintln!(
                    "Question {}: {}{options}\nUse /answer REQUEST_ID {}",
                    q.id,
                    q.question,
                    if q.kind == QuestionKind::Secret {
                        "(hidden input)"
                    } else {
                        "VALUE"
                    },
                );
            }
            Showing(self.clone(), q.id)
        };
        rx.await.unwrap_or_else(|_| declined("terminal closed"))
    }

    /// Handles `/answer REQUEST_ID [VALUE]`. Returns the ID of a secret
    /// question whose answer is still to be read with echo off.
    fn answer_command(&self, args: &str) -> Result<Option<String>> {
        let (id, value) = match args.split_once(' ') {
            Some((id, value)) => (id, Some(value)),
            None => (args, None),
        };
        let kind = self
            .0
            .lock()
            .unwrap()
            .items
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.kind)
            .ok_or_else(|| anyhow!("no question named {id}"))?;
        let answer = match (kind, value) {
            (_, Some("decline")) => Answer::Declined {
                reason: Some("declined".into()),
            },
            (QuestionKind::Secret, Some(_)) => {
                bail!("Do not put the secret on the command line; use /answer REQUEST_ID")
            }
            (QuestionKind::Secret, None) => return Ok(Some(id.into())),
            (_, None) => bail!("use /answer REQUEST_ID VALUE"),
            (QuestionKind::Approval, Some("allow")) => Answer::Allow,
            (_, Some(value)) => Answer::Value(value.into()),
        };
        self.reply(id, answer)?;
        Ok(None)
    }

    fn reply(&self, id: &str, answer: Answer) -> Result<()> {
        let Pending { sender, .. } = self
            .0
            .lock()
            .unwrap()
            .remove(id)
            .ok_or_else(|| anyhow!("no question named {id}"))?;
        sender
            .send(answer)
            .map_err(|_| anyhow!("question is no longer answerable"))
    }

    fn decline_all(&self) {
        self.0.lock().unwrap().items.clear();
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
            // A batch invocation has no approver. Do not park new calls, and
            // do not close someone else's wait by changing its session mode.
            let waiting = session.settings()?["approvalWait"] == "untilDeadline"
                && agent.declaration()?["approvalsOutlastTurns"] == true;
            if waiting {
                if session
                    .questions()?
                    .iter()
                    .any(|q| q.approval_wait.is_some())
                {
                    bail!(
                        "This session has a waiting approval. Answer it before using print mode."
                    );
                }
                session.set_setting("approvalWait", serde_json::json!("live"))?;
            }
            let result = session.prompt(text).await;
            if waiting {
                session.wait_idle().await?;
                session.set_setting("approvalWait", serde_json::json!("untilDeadline"))?;
            }
            let result = result?;
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
                    { let mut pending = questions.0.lock().unwrap(); pending.closed = true; pending.items.clear(); }
                    session.wait_idle().await?;
                    break;
                };
                let line = line.trim();
                let approving = questions.0.lock().unwrap().approval().is_some();
                if line.is_empty() && !approving { continue; }
                if line == "/quit" && !approving {
                    questions.decline_all();
                    session.cancel().await?;
                    break;
                }
                let result = match input(session, &questions, mode, line).await {
                    Ok(Some(id)) => {
                        let read = read_hidden(&mut lines).await?;
                        let interrupted = matches!(read, Hidden::Interrupted);
                        let answer = match read {
                            Hidden::Line(secret) => Answer::Secret(secret),
                            _ => Answer::Declined { reason: Some("no secret was read".into()) },
                        };
                        let replied = questions.reply(&id, answer);
                        if interrupted && session.is_running() {
                            session.cancel().await?;
                        }
                        replied
                    }
                    other => other.map(drop),
                };
                if let Err(error) = result {
                    eprintln!("{error:#}");
                }
            }
        }
    }
    Ok(())
}

enum Hidden {
    Line(String),
    Unavailable,
    Interrupted,
}

/// The line reader keeps reading standard input, so the secret is its next
/// line, typed while echo is off.
async fn read_hidden(lines: &mut mpsc::Receiver<std::io::Result<String>>) -> Result<Hidden> {
    let Some(echo) = crate::hidden::EchoOff::new() else {
        return Ok(Hidden::Unavailable);
    };
    eprint!("Secret: ");
    let read = tokio::select! {
        ctrl = tokio::signal::ctrl_c() => {
            ctrl?;
            Hidden::Interrupted
        }
        line = lines.recv() => match line {
            Some(Ok(line)) => Hidden::Line(line),
            _ => Hidden::Unavailable,
        },
    };
    drop(echo);
    eprintln!();
    Ok(read)
}

const SESSION_COMMANDS: [&str; 4] = ["compact", "model", "skills", "thinking"];

/// Returns the ID of a secret question to read with echo off.
async fn input(
    session: &Session,
    questions: &Questions,
    mode: Mode,
    line: &str,
) -> Result<Option<String>> {
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
    } else if let Some(id) = {
        let pending = questions.0.lock().unwrap();
        pending.approval().map(|p| p.id.clone())
    } {
        let answer = match line.to_ascii_lowercase().as_str() {
            "y" => Answer::Allow,
            "n" => Answer::Declined {
                reason: Some("declined".into()),
            },
            _ => bail!("Answer y or n."),
        };
        questions.reply(&id, answer)?;
    } else if let Some(args) = line.strip_prefix("/answer ") {
        return questions.answer_command(args);
    } else if line == "/questions" {
        display(&serde_json::to_string(
            &questions
                .0
                .lock()
                .unwrap()
                .items
                .iter()
                .map(|p| &p.id)
                .collect::<Vec<_>>(),
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
        let mut commands = [
            "after",
            "answer",
            "cancel",
            "commands",
            "questions",
            "quit",
            "skill:NAME",
            "tool",
        ]
        .to_vec();
        commands.extend(SESSION_COMMANDS);
        commands.sort();
        for name in commands {
            display(&format!("/{name}"));
        }
    } else if line.starts_with('/') && !line.starts_with("/skill:") {
        let name = line[1..].split_whitespace().next().unwrap_or_default();
        if !SESSION_COMMANDS.contains(&name) {
            bail!("unknown command {name}");
        }
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
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn question(kind: &str) -> Question {
        serde_json::from_value(serde_json::json!({
            "id": "q1", "sessionId": "s", "kind": kind, "question": "Key?", "credential": "key",
        }))
        .unwrap()
    }

    async fn open(questions: &Questions, kind: &str) -> tokio::task::JoinHandle<Answer> {
        let asking = tokio::spawn({
            let questions = questions.clone();
            let q = question(kind);
            async move { questions.ask(q).await }
        });
        while questions.0.lock().unwrap().items.is_empty() {
            tokio::task::yield_now().await;
        }
        asking
    }

    #[tokio::test]
    async fn without_a_terminal_a_secret_question_is_declined_when_it_opens() {
        let answer = Questions::new(false).ask(question("secret")).await;
        assert!(matches!(answer, Answer::Declined { .. }), "{answer:?}");
    }

    #[tokio::test]
    async fn a_secret_given_inline_is_refused_and_the_question_stays_open() {
        let questions = Questions::new(true);
        let asking = open(&questions, "secret").await;
        let error = questions.answer_command("q1 hunter2").unwrap_err();
        assert_eq!(
            error.to_string(),
            "Do not put the secret on the command line; use /answer REQUEST_ID"
        );
        assert_eq!(
            questions.answer_command("q1").unwrap().as_deref(),
            Some("q1")
        );
        assert_eq!(questions.0.lock().unwrap().items.len(), 1);
        questions
            .reply("q1", Answer::Secret("typed".into()))
            .unwrap();
        assert!(matches!(asking.await.unwrap(), Answer::Secret(s) if s == "typed"));
    }

    #[tokio::test]
    async fn answer_takes_a_value_or_decline() {
        let questions = Questions::new(true);
        let asking = open(&questions, "secret").await;
        assert_eq!(questions.answer_command("q1 decline").unwrap(), None);
        assert!(matches!(asking.await.unwrap(), Answer::Declined { .. }));
        let asking = open(&questions, "text").await;
        assert!(questions.answer_command("q1").is_err());
        assert_eq!(questions.answer_command("q1 teal").unwrap(), None);
        assert!(matches!(asking.await.unwrap(), Answer::Value(v) if v == "teal"));
    }
}
