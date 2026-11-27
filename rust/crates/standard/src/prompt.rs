//! System prompt for the standard configuration.
use crate::skills::{self, SkillsPlugin};
use anyhow::{Context, Result};
use modular_agent::{Code, Error, Order, Plugin, TurnAddition};
use std::path::{Path, PathBuf};

const PREAMBLE: &str = "You are a coding assistant running inside Modular Agent, a coding agent harness. Help users inspect files, run commands, and modify code.";
const RULES: &str = "<rules>
- Do your work through codemode, with the functions on `tools`.
- Batch independent file reads, searches, and edits in one codemode script.
- Print only short, relevant excerpts from large files and command output.
- Use tools.read to examine files instead of cat or sed, and tools.find and tools.list to look for them. Use tools.exec for everything else, such as rg and git.
- Build shell commands with quote-safe Python strings, such as triple-quoted strings for commands with nested quotes.
- Use tools.edit for targeted changes. Batch changes to one file in a single call.
- Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.
- Use tools.write only for new files or complete rewrites.
- Reuse AGENTS.md and CLAUDE.md instructions already in this prompt. Re-read those files only to verify a change made during this session.
- Be concise in your responses
- Show file paths clearly when working with files
</rules>";
/// The instruction file names looked for in each folder. The first found wins.
const NAMES: [&str; 2] = ["AGENTS.md", "CLAUDE.md"];

pub struct PromptPlugin {
    /// The person's own instructions, for every project.
    pub global: PathBuf,
}

fn project_files(project: &Path) -> Result<Vec<(String, String)>> {
    let mut files = vec![];
    for folder in project.ancestors().collect::<Vec<_>>().into_iter().rev() {
        for name in NAMES {
            let path = folder.join(name);
            match std::fs::read_to_string(&path) {
                Ok(text) => {
                    if !text.trim().is_empty() {
                        files.push((path.to_string_lossy().into_owned(), text));
                    }
                    break;
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::NotFound
                            | std::io::ErrorKind::NotADirectory
                            | std::io::ErrorKind::PermissionDenied
                            | std::io::ErrorKind::Unsupported
                    ) => {}
                Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
            }
        }
    }
    Ok(files)
}

fn render(files: &[(String, String)]) -> String {
    let mut out = String::from("<project_context>\nProject-specific instructions and guidelines:");
    for (path, content) in files {
        out.push_str(&format!(
            "\n\n<project_instructions path=\"{path}\">\n{}\n</project_instructions>",
            content.trim_end()
        ));
    }
    out.push_str("\n</project_context>");
    out
}

impl PromptPlugin {
    pub fn plugin(self, skills: SkillsPlugin) -> Plugin {
        Plugin::new("standard.prompt").on_turn_before_with(Order::Last, move |cx| {
            let (global, skills) = (self.global.clone(), skills.clone());
            async move {
                let project = cx.project.ok_or_else(|| {
                    Error::new(
                        Code::NotSupported,
                        "the prompt needs the in-process project",
                    )
                })?;
                let tools = cx.tools.ok_or_else(|| {
                    Error::new(
                        Code::NotSupported,
                        "the prompt needs the in-process tool catalog",
                    )
                })?;
                let mut sections = vec![format!("{PREAMBLE}\n\n{RULES}")];
                let mut files = vec![];
                if let Ok(text) = std::fs::read_to_string(&global)
                    && !text.trim().is_empty()
                {
                    files.push((global.to_string_lossy().into_owned(), text));
                }
                files.extend(project_files(&project)?);
                if !files.is_empty() {
                    sections.push(render(&files));
                }
                let listing = skills::prompt(&skills.for_project(&project));
                if !listing.is_empty() {
                    sections.push(format!("<skills>\n{listing}\n</skills>"));
                }
                let tools = tools
                    .into_iter()
                    .map(serde_json::to_value)
                    .collect::<serde_json::Result<Vec<_>>>()?;
                sections.push(tools_code::catalog::prompt(&tools_code::functions(tools)?));
                sections.push(format!(
                    "<cwd>\n{}\n</cwd>\n\n<date>\n{}\n</date>",
                    project.display(),
                    jiff::Zoned::now().date()
                ));
                Ok(TurnAddition {
                    system: Some(sections.join("\n\n")),
                    context: None,
                    sources: Some(vec![]),
                })
            }
        })
    }
}
