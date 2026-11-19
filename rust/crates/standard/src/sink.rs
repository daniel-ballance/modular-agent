//! What the terminal shows. The answer goes to stdout. What the agent is
//! doing (the code it runs, the calls that code makes, command output) goes
//! to stderr, so `ma -p ... > file` captures only the answer.
use crate::terminal::Mode;
use modular_agent::Event;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    io::{self, IsTerminal, Write},
    sync::Mutex,
};

#[derive(Default)]
struct State {
    /// Calls made from inside a code run, by id.
    nested: BTreeSet<String>,
    /// Whether the cursor sits partway through a line of streamed text.
    midline: bool,
}
pub struct Sink {
    mode: Mode,
    colour: bool,
    /// Show the calls a code run makes and what commands print.
    pub verbose: bool,
    state: Mutex<State>,
}
impl Sink {
    pub fn new(mode: Mode, verbose: bool) -> Self {
        Self {
            mode,
            colour: io::stderr().is_terminal() && std::env::var_os("NO_COLOR").is_none(),
            verbose,
            state: Mutex::default(),
        }
    }
    fn dim(&self, text: &str) -> String {
        if self.colour {
            format!("\x1b[2m{text}\x1b[0m")
        } else {
            text.into()
        }
    }
    fn note(&self, state: &mut State, text: &str) {
        if state.midline {
            println!();
            state.midline = false;
        }
        eprintln!("{}", self.dim(text));
    }
}
fn one_line(value: &Value) -> String {
    let text = match value {
        Value::Object(map) => map
            .iter()
            .map(|(key, value)| match value {
                Value::String(s) => format!("{key}={s:?}"),
                other => format!("{key}={other}"),
            })
            .collect::<Vec<_>>()
            .join(", "),
        other => other.to_string(),
    };
    match text.char_indices().nth(200) {
        Some((at, _)) => format!("{}...", &text[..at]),
        None => text,
    }
}
impl Sink {
    pub fn send(&self, event: Event) {
        let session = event.session_id().to_owned();
        let (kind, content) = match event {
            Event::Text { delta, .. } => ("model.delta".into(), json!(delta)),
            Event::ToolCall {
                name,
                input,
                call_id,
                ..
            } => (
                "tool.requested".into(),
                json!({"name":name,"input":input,"id":call_id}),
            ),
            Event::ToolOutput { text, .. } => ("tool.progress".into(), json!(text)),
            Event::ToolResult {
                call_id,
                status,
                text,
                ..
            } => (
                "tool.ended".into(),
                json!({"call":call_id,"status":status.as_str(),"text":text}),
            ),
            Event::QuestionOpened { question, .. } => (
                "request.opened".into(),
                json!({"id":question.id,"text":question.question,"options":question.options}),
            ),
            Event::TurnEnded { outcome, text, .. } => {
                ("turn.result".into(), json!({"outcome":outcome,"text":text}))
            }
            Event::Entry { entry, .. } => ("history.entry".into(), entry),
            Event::Other { kind, data, .. } => (kind, data),
            _ => return,
        };
        self.show(&session, &kind, content);
    }

    pub fn show(&self, session: &str, kind: &str, content: Value) {
        let mut state = self.state.lock().unwrap();
        if self.mode == Mode::Json {
            println!(
                "{}",
                json!({"kind":kind,"scope":{"session":session},"content":content})
            );
            return;
        }
        match kind {
            "session.open" => {
                eprintln!("{}", self.dim(&format!("Session {}", session)))
            }
            "tool.started" => {
                let name = content["name"].as_str().unwrap_or("");
                let input = &content["input"];
                if content["started_by"] == "tool" {
                    state
                        .nested
                        .insert(content["id"].as_str().unwrap_or("").into());
                    if self.verbose {
                        self.note(&mut state, &format!("  -> {name}({})", one_line(input)));
                    }
                } else if name == tools_code::TOOL {
                    let code = input["code"].as_str().unwrap_or("");
                    let shown = code
                        .lines()
                        .map(|line| format!("  | {line}"))
                        .collect::<Vec<_>>()
                        .join("\n");
                    self.note(&mut state, &format!("codemode\n{shown}"));
                } else {
                    self.note(&mut state, &format!("{name}({})", one_line(input)));
                }
            }
            "tool.progress" if self.verbose => {
                if state.midline {
                    println!();
                    state.midline = false;
                }
                eprint!("{}", self.dim(content.as_str().unwrap_or("")));
                let _ = io::stderr().flush();
            }
            "tool.ended" => {
                let call = content["call"].as_str().unwrap_or("");
                let nested = state.nested.remove(call);
                let status = content["status"].as_str().unwrap_or("");
                if status != "completed" {
                    let text = content["text"].as_str().unwrap_or("");
                    let first = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
                    // A failed call inside a run is the code's to handle; say so only when asked.
                    if !nested || self.verbose {
                        let indent = if nested { "     " } else { "  " };
                        self.note(&mut state, &format!("{indent}{status}: {first}"));
                    }
                }
            }
            "model.delta" if self.mode == Mode::Line => {
                let text = content.as_str().unwrap_or("");
                print!("{text}");
                let _ = io::stdout().flush();
                if !text.is_empty() {
                    state.midline = !text.ends_with('\n');
                }
            }
            "turn.result" => {
                if state.midline {
                    println!();
                }
                state.midline = false;
                if let Some(error) = content["error"].as_str() {
                    eprintln!("{error}");
                }
            }
            "request.opened" => eprintln!(
                "Question {}: {} {}\nUse /answer REQUEST_ID VALUE",
                content["id"].as_str().unwrap_or(""),
                content["text"].as_str().unwrap_or(""),
                content["options"]
            ),
            "command.result" => match &content {
                Value::String(text) => println!("{text}"),
                other => println!(
                    "{}",
                    serde_json::to_string_pretty(other).unwrap_or_else(|_| other.to_string())
                ),
            },
            "input.returned" => {
                eprintln!("Returned input: {}", content["text"].as_str().unwrap_or(""))
            }
            _ => (),
        }
    }
}
