//! What the terminal shows. The answer goes to stdout. What the agent is
//! doing (the code it runs, the calls that code makes, command output) goes
//! to stderr, so `ma -p ... > file` captures only the answer.
use agent_api::*;
use interface_terminal::Mode;
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
impl EventSink for Sink {
    fn send(&self, event: Event) {
        let mut state = self.state.lock().unwrap();
        if self.mode == Mode::Json {
            println!("{}", serde_json::to_string(&event).unwrap());
            return;
        }
        match event.kind.as_str() {
            "session.open" => eprintln!("{}", self.dim(&format!("Session {}", event.scope.session))),
            "tool.started" => {
                let name = event.content["name"].as_str().unwrap_or("");
                let input = &event.content["input"];
                if event.content["started_by"] == "tool" {
                    state.nested.insert(event.content["id"].as_str().unwrap_or("").into());
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
                eprint!("{}", self.dim(event.content.as_str().unwrap_or("")));
                let _ = io::stderr().flush();
            }
            "tool.ended" => {
                let call = event.content["call"].as_str().unwrap_or("");
                let nested = state.nested.remove(call);
                let status = event.content["status"].as_str().unwrap_or("");
                if status != "completed" {
                    let text = event.content["text"].as_str().unwrap_or("");
                    let first = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
                    // A failed call inside a run is the code's to handle; say so only when asked.
                    if !nested || self.verbose {
                        let indent = if nested { "     " } else { "  " };
                        self.note(&mut state, &format!("{indent}{status}: {first}"));
                    }
                }
            }
            "model.delta" if self.mode == Mode::Line => {
                let text = event.content.as_str().unwrap_or("");
                print!("{text}");
                let _ = io::stdout().flush();
                if !text.is_empty() {
                    state.midline = !text.ends_with('\n');
                }
            }
            "turn.result" => {
                if self.mode == Mode::Print {
                    println!("{}", event.content["text"].as_str().unwrap_or(""));
                } else if state.midline {
                    println!();
                }
                state.midline = false;
                if let Some(error) = event.content["error"].as_str() {
                    eprintln!("{error}");
                }
            }
            "request.opened" => eprintln!(
                "Question {}: {} {}\nUse /answer REQUEST_ID VALUE",
                event.content["id"].as_str().unwrap_or(""),
                event.content["text"].as_str().unwrap_or(""),
                event.content["options"]
            ),
            "command.result" => match &event.content {
                Value::String(text) => println!("{text}"),
                other => println!(
                    "{}",
                    serde_json::to_string_pretty(other).unwrap_or_else(|_| other.to_string())
                ),
            },
            "input.returned" => eprintln!(
                "Returned input: {}",
                event.content["text"].as_str().unwrap_or("")
            ),
            _ => (),
        }
    }
}
