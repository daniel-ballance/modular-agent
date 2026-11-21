//! The code tool. The model writes Python, and a Monty sandbox runs it. Every
//! other tool the agent has is a function in that sandbox. A function call
//! leaves the sandbox as a nested tool call, so it passes the same gates and
//! is recorded like any other call. The sandbox itself reaches nothing.
use anyhow::{Result, ensure};
use modular_agent::{Plugin, Tool, ToolContext, ToolOutput, ToolStatus};
use monty_pool::Pool;
use monty_types::{
    CallArgs, ExcType, MontyException,
    unstable::{self, MontyNode},
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::OnceCell;

pub mod catalog;
pub mod convert;
mod render;
mod sandbox;
use catalog::Function;
use sandbox::RunError;

pub const TOOL: &str = "codemode";
/// The name the functions live under in the sandbox.
pub const MODULE: &str = "tools";
const MAX_OUTPUT_LINES: usize = 2000;
const MAX_OUTPUT_BYTES: usize = 50 * 1024;

#[derive(Clone)]
pub struct CodeTool {
    /// A Monty worker executable. By default the pool re-executes `ma`.
    pub worker: Option<PathBuf>,
    /// Active interpreter wall time between nested tool calls.
    pub compute: Duration,
    /// Most nested tool calls one run may make.
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
    calls: Calls,
}

struct Calls {
    limit: usize,
    made: usize,
}

impl Calls {
    fn start(&mut self) -> std::result::Result<(), MontyException> {
        if self.made == self.limit {
            return Err(raise(
                ExcType::RuntimeError,
                format!("this run made more than {} function calls", self.limit),
            ));
        }
        self.made += 1;
        Ok(())
    }
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
                let keyword = if name == "describe_tool" {
                    "name"
                } else {
                    "query"
                };
                let text = (args.args().len() + args.kwargs().count() == 1)
                    .then(|| args.arg(0).or_else(|| args.kwarg(keyword)))
                    .flatten()
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
        let function = name
            .strip_prefix("tools.")
            .and_then(|name| self.functions.get(name))
            .ok_or_else(|| raise(ExcType::NameError, format!("name '{name}' is not defined")))?;
        let name = &function.name;
        let input = function
            .input(args)
            .map_err(|e| raise(ExcType::TypeError, format!("{name}(): {e}")))?;
        self.calls.start()?;
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
            && result.value.is_none()
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
            // A command that ran to a non-zero exit still returns its dict.
            // The exec tool marks deadlines separately from exit status.
            (ToolStatus::Failed, Some(value))
                if function.tool.name == "exec"
                    && value["timed_out"] != true
                    && value["exit_code"].as_i64().is_some_and(|code| code != 0) =>
            {
                Ok(value)
            }
            _ => Err(raise(ExcType::RuntimeError, text)),
        }
    }
}

const CUT: &str = "[Output cut. Return or print less, or write the rest to a file.]";

fn fits(text: &str) -> bool {
    text.len() <= MAX_OUTPUT_BYTES && text.lines().count() <= MAX_OUTPUT_LINES
}

fn bounded(mut text: String) -> String {
    if !fits(&text) {
        let mut end = 0;
        for line in text.split_inclusive('\n').take(MAX_OUTPUT_LINES - 1) {
            if end + line.len() > MAX_OUTPUT_BYTES - CUT.len() {
                break;
            }
            end += line.len();
        }
        text.truncate(end);
        end_printed_line(&mut text);
        text.push_str(CUT);
    }
    text
}

fn end_printed_line(printed: &mut String) {
    if !printed.is_empty() && !printed.ends_with('\n') {
        printed.push('\n');
    }
}

fn append_error(printed: &mut String, error: &str) {
    let start = printed.len();
    printed.push_str(error);
    if fits(printed) {
        return;
    }
    // If the traceback cannot follow the printed output, put its reason first.
    let last = error.lines().next_back().unwrap_or(error);
    let first = if last.len() < MAX_OUTPUT_BYTES - CUT.len() {
        last
    } else {
        // Even the last line can be too long. Keep the type, without a partial
        // message, before the cut notice.
        last.split_once(": ").map_or("", |(kind, _)| kind)
    };
    if !first.is_empty() {
        if let Some(prefix) = error.strip_suffix(last) {
            // Move rather than duplicate the last line. Keep the original
            // line when only its type can be shown, so it triggers the cut.
            if first == last {
                printed.truncate(start + prefix.len());
            }
        }
        printed.insert(0, '\n');
        printed.insert_str(0, first);
    }
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
            calls: Calls {
                limit: self.calls,
                made: 0,
            },
        };
        let (outcome, mut text) = run.sandbox(code, pool).await;
        Ok(match outcome {
            Ok(value) => {
                let (mut graph, root) = unstable::into_graph_parts(value);
                if !matches!(graph.node(root), MontyNode::None) {
                    end_printed_line(&mut text);
                }
                // Keep image parts separate from the text result.
                let mut images = vec![];
                if let Some(image) = convert::image(graph.value(root), &mut text) {
                    images.push(image);
                    *graph.node_mut(root) = MontyNode::None;
                } else if let MontyNode::List(items) | MontyNode::Tuple(items) = graph.node(root) {
                    let mut rest = Vec::new();
                    for &id in items {
                        if let Some(image) = convert::image(graph.value(id), &mut text) {
                            images.push(image);
                        } else {
                            rest.push(id);
                        }
                    }
                    if !images.is_empty() {
                        let node = graph.node_mut(root);
                        if rest.is_empty() {
                            *node = MontyNode::None;
                        } else if let MontyNode::List(items) | MontyNode::Tuple(items) = node {
                            *items = rest;
                        }
                    }
                }
                render::value(&mut text, &graph, root, MAX_OUTPUT_BYTES);
                if text.is_empty() {
                    text = "(no output)".into();
                }
                let text = bounded(text);
                let mut result = ToolOutput::from(text.clone());
                result.value = Some(json!({"calls": run.calls.made}));
                if images.is_empty() {
                    result
                } else {
                    let mut content = vec![json!({"type":"text","text":text})];
                    content.extend(images);
                    result.with_content(content)
                }
            }
            Err(error) => {
                match error {
                    RunError::PrintLimit(cap) => {
                        text.insert_str(
                            0,
                            &format!("RuntimeError: printed output exceeded {cap} bytes\n"),
                        );
                    }
                    RunError::Failed(error) => {
                        end_printed_line(&mut text);
                        append_error(&mut text, &error);
                    }
                }
                ToolOutput {
                    status: ToolStatus::Failed,
                    ..ToolOutput::from(bounded(text))
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{Calls, CodeTool, MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES, bounded};

    #[test]
    fn the_default_allowance_admits_500_nested_calls_not_501() {
        let mut calls = Calls {
            limit: CodeTool::default().calls,
            made: 0,
        };
        for _ in 0..500 {
            calls.start().unwrap();
        }
        assert!(calls.start().is_err());
        assert_eq!(calls.made, 500);
    }

    #[test]
    fn the_result_cut_keeps_only_whole_lines() {
        let head = "RuntimeError: printed output exceeded 1048576 bytes";
        let cut = bounded(format!("{head}\n{}", "é".repeat(MAX_OUTPUT_BYTES)));
        assert_eq!(cut, format!("{head}\n{}", super::CUT));

        let cut = bounded("line\n".repeat(MAX_OUTPUT_LINES + 1));
        assert_eq!(
            cut,
            format!("{}{}", "line\n".repeat(MAX_OUTPUT_LINES - 1), super::CUT)
        );
    }
}
