//! The code tool. The model writes Python, and a Monty sandbox runs it. Every
//! other tool the agent has is a function in that sandbox. A function call
//! leaves the sandbox as a nested tool call, so it passes the same gates and
//! is recorded like any other call. The sandbox itself reaches nothing.
use anyhow::{Result, ensure};
use modular_agent::{Plugin, Tool, ToolContext, ToolOutput, ToolStatus};
use monty_pool::Pool;
use monty_types::{CallArgs, ExcType, MontyException};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::OnceCell;

pub mod catalog;
pub mod convert;
mod sandbox;
use catalog::Function;

pub const TOOL: &str = "codemode";
/// The name the functions live under in the sandbox.
pub const MODULE: &str = "tools";
const MAX_OUTPUT_LINES: usize = 2000;
const MAX_OUTPUT_BYTES: usize = 50 * 1024;

#[derive(Clone)]
pub struct CodeTool {
    /// A Monty worker executable. By default the pool re-executes `ma`.
    pub worker: Option<PathBuf>,
    /// Longest stretch of Python between two function calls.
    pub compute: Duration,
    /// Most function calls one run may make.
    pub calls: usize,
    pub recursion: usize,
    /// Most bytes `print` may collect.
    pub print_bytes: usize,
}
impl Default for CodeTool {
    fn default() -> Self {
        Self {
            worker: None,
            compute: Duration::from_secs(30),
            calls: 500,
            recursion: 200,
            print_bytes: 1024 * 1024,
        }
    }
}

impl CodeTool {
    pub fn plugin(&self) -> Plugin {
        let tool = self.clone();
        let pool = Arc::new(OnceCell::new());
        Plugin::new("code").tool(
            Tool::new(TOOL, "Run Python in a sandbox. The functions listed under \"Functions in codemode\" in the system prompt are the only way to reach files, commands and other tools. Call them on `tools`, for example `text = tools.read(path=\"README.md\")`. The value of the last expression and anything printed come back as the result. Each run starts fresh: no variables carry over. The sandbox runs a subset of Python: no classes with inheritance, no third-party packages, and no direct file, network or process access.")
                .input_schema(json!({"type":"object","properties":{"code":{"type":"string","description":"Python source to run"}},"required":["code"],"additionalProperties":false}))
                .run(move |input: Value, cx| {
                    let tool = tool.clone();
                    let pool = pool.clone();
                    async move { tool.run(input["code"].as_str().expect("validated code"), cx, &pool).await }
                })
        )
    }
}

pub fn functions(tools: Vec<Value>) -> Result<Vec<Function>> {
    let mut functions: Vec<Function> = vec![];
    for tool in tools {
        if tool["name"] == TOOL {
            continue;
        }
        let function = Function::new(tool)?;
        ensure!(
            !functions.iter().any(|f| f.name == function.name),
            "two tools share the function name {}",
            function.name
        );
        functions.push(function);
    }
    Ok(functions)
}

fn raise(kind: ExcType, text: impl Into<String>) -> MontyException {
    MontyException::new(kind, Some(text.into()))
}

struct Run<'a> {
    tool: &'a CodeTool,
    cx: ToolContext,
    functions: BTreeMap<String, Function>,
    made: usize,
}
impl Run<'_> {
    /// One function call from the sandbox, as a value or a Python exception.
    async fn call(
        &mut self,
        name: &str,
        args: &CallArgs,
    ) -> std::result::Result<Value, MontyException> {
        match name {
            "describe_tool" | "search_tools" => {
                let text = args
                    .arg(0)
                    .or_else(|| {
                        args.kwarg(if name == "describe_tool" {
                            "name"
                        } else {
                            "query"
                        })
                    })
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .ok_or_else(|| {
                        raise(ExcType::TypeError, format!("{name}() takes one string"))
                    })?;
                return if name == "describe_tool" {
                    self.functions
                        .get(&text)
                        .map(Function::describe)
                        .ok_or_else(|| {
                            raise(ExcType::KeyError, format!("no function named {text}"))
                        })
                } else {
                    Ok(catalog::search(self.functions.values(), &text))
                };
            }
            _ => (),
        }
        let function = self
            .functions
            .get(name)
            .ok_or_else(|| raise(ExcType::NameError, format!("name '{name}' is not defined")))?;
        let input = function
            .input(args)
            .map_err(|e| raise(ExcType::TypeError, format!("{name}(): {e}")))?;
        self.made += 1;
        if self.made > self.tool.calls {
            return Err(raise(
                ExcType::RuntimeError,
                format!("this run made more than {} function calls", self.tool.calls),
            ));
        }
        let result = self
            .cx
            .tools()
            .call(&function.tool.name, input)
            .await
            .map_err(|e| {
                raise(
                    ExcType::RuntimeError,
                    format!("{name}() could not run: {e:#}"),
                )
            })?;
        // A result with content beyond text: an image reaches the code as a
        // dict it can return, as in Pi's codemode.
        if result.status == ToolStatus::Completed
            && let Some(image) = result.content.iter().find(|part| part["type"] == "image")
        {
            return Ok(
                json!({"type":"image","mimeType":image["mimeType"],"data":image["data"],"note":result.text()}),
            );
        }
        let text = result.text().to_owned();
        match (result.status, result.value) {
            (ToolStatus::Completed, Some(value)) => Ok(value),
            (ToolStatus::Completed, None) => Ok(json!(text)),
            // A tool that reports in a shape reports its failures in it too.
            (ToolStatus::Failed, Some(value))
                if function.tool.name == "exec" && value.is_object() =>
            {
                Ok(value)
            }
            (status, _) => Err(raise(
                ExcType::RuntimeError,
                format!("{name}() {}: {}", convert::status_word(&status), text),
            )),
        }
    }
}

fn bounded(text: String) -> String {
    let lines = text.lines().count();
    if lines <= MAX_OUTPUT_LINES && text.len() <= MAX_OUTPUT_BYTES {
        return text;
    }
    let mut kept = String::new();
    let mut count = 0;
    for line in text.lines().take(MAX_OUTPUT_LINES) {
        if kept.len() + line.len() + 1 > MAX_OUTPUT_BYTES {
            break;
        }
        kept.push_str(line);
        kept.push('\n');
        count += 1;
    }
    format!(
        "{kept}\n[Output cut: showing the first {count} of {lines} lines ({} of {} bytes). Return or print less, or write the rest to a file.]",
        kept.len(),
        text.len()
    )
}

impl CodeTool {
    async fn run(
        &self,
        code: &str,
        cx: ToolContext,
        pool: &OnceCell<Pool>,
    ) -> modular_agent::Result<ToolOutput> {
        let pool = pool.get_or_try_init(|| sandbox::pool(self)).await?;
        let mut run = Run {
            tool: self,
            functions: functions(cx.tools().list().await?)?
                .into_iter()
                .map(|f| (f.name.clone(), f))
                .collect(),
            cx,
            made: 0,
        };
        let (outcome, mut text) = run.sandbox(code, pool).await;
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        Ok(match outcome {
            Ok(value) => {
                let mut value = convert::to_json(value.as_ref());
                // Images the code returns, alone or in a list, are attached
                // to the result. The rest is shown as text.
                let mut images = vec![];
                let is_image = |v: &Value| {
                    v["type"] == "image" && v["data"].is_string() && v["mimeType"].is_string()
                };
                if is_image(&value) {
                    images.push(std::mem::take(&mut value));
                } else if let Some(items) = value.as_array_mut() {
                    let (found, rest): (Vec<Value>, Vec<Value>) =
                        std::mem::take(items).into_iter().partition(|v| is_image(v));
                    images = found;
                    value = if rest.is_empty() && !images.is_empty() {
                        Value::Null
                    } else {
                        Value::Array(rest)
                    };
                }
                for image in &images {
                    if let Some(note) = image["note"].as_str() {
                        text.push_str(note);
                        text.push('\n');
                    }
                }
                match &value {
                    Value::Null => (),
                    Value::String(string) => text.push_str(string),
                    other => text.push_str(
                        &serde_json::to_string_pretty(other).unwrap_or_else(|_| other.to_string()),
                    ),
                }
                if text.is_empty() {
                    text = "(no output)".into();
                }
                let text = bounded(text);
                let mut result = ToolOutput::from(text.clone());
                result.value = Some(json!({"calls": run.made}));
                if images.is_empty() {
                    result
                } else {
                    let mut content = vec![json!({"type":"text","text":text})];
                    content.extend(images.into_iter().map(|image| {
                        json!({"type":"image","mimeType":image["mimeType"],"data":image["data"]})
                    }));
                    result.with_content(content)
                }
            }
            Err(error) => {
                if text.len() + error.len() <= MAX_OUTPUT_BYTES
                    && text.lines().count() + error.lines().count() <= MAX_OUTPUT_LINES
                {
                    text.push_str(&error);
                } else {
                    // Do not let printed output hide why the run stopped.
                    // Monty puts the exception type and message on the last line.
                    let reason = error.lines().next_back().unwrap_or(&error);
                    let end = reason.floor_char_boundary(1024);
                    text.insert(0, '\n');
                    text.insert_str(0, &reason[..end]);
                }
                ToolOutput {
                    status: ToolStatus::Failed,
                    ..ToolOutput::from(bounded(text))
                }
            }
        })
    }
}
