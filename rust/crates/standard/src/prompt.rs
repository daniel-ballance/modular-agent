//! The system prompt, built as Pi builds its own: a preamble and rules, then
//! the instruction files, the skills and the working directory. The code
//! tool adds its function list between the two halves.
use crate::skills::{self, SkillsPlugin};
use agent_api::*;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

const PREAMBLE: &str = "You are a coding assistant running inside Modular Agent, a coding agent harness. Help users inspect files, run commands, and modify code.";
const RULES: &str = "<rules>
- Do your work through codemode, with the functions on `tools`.
- Use tools.read to examine files instead of cat or sed, and tools.find and tools.list to look for them. Use tools.exec for everything else, such as rg and git.
- Use tools.edit for targeted changes. Batch changes to one file in a single call.
- Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.
- Use tools.write only for new files or complete rewrites.
- Be concise in your responses
- Show file paths clearly when working with files
</rules>";
/// The instruction file names looked for in each folder. The first found wins.
const NAMES: [&str; 2] = ["AGENTS.md", "CLAUDE.md"];

pub struct PromptPlugin {
    /// The person's own instructions, for every project.
    pub global: PathBuf,
}

fn optional(error: &anyhow::Error) -> bool {
    is_file_not_found(error)
        || error.downcast_ref::<std::io::Error>().is_some_and(|e| {
            matches!(
                e.kind(),
                std::io::ErrorKind::Unsupported
                    | std::io::ErrorKind::NotADirectory
                    | std::io::ErrorKind::PermissionDenied
            )
        })
}

/// Instruction files from the outermost folder down to the project, read
/// through the session's working environment.
async fn project_files(
    env: &Arc<dyn WorkingEnvironment>,
    project: &Path,
) -> Result<Vec<(String, String)>> {
    let mut folders: Vec<&Path> = project.ancestors().collect();
    folders.reverse();
    let mut files = vec![];
    for folder in folders {
        for name in NAMES {
            let path = folder.join(name).to_string_lossy().into_owned();
            match env.read(project, &path).await {
                Ok(text) => {
                    if !text.trim().is_empty() {
                        files.push((path, text));
                    }
                    break;
                }
                Err(error) if optional(&error) => (),
                Err(error) => return Err(error.context(format!("reading {path}"))),
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

impl Plugin for PromptPlugin {
    fn name(&self) -> &str {
        "system.prompt"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.on(
            "before.turn",
            Order::First,
            handler(|_, _, _| {
                Box::pin(async move {
                    Ok(answer(
                        json!({"system": format!("{PREAMBLE}\n\n{RULES}"), "sources": []}),
                    ))
                })
            }),
        );
        let global = self.global.clone();
        r.on(
            "before.turn",
            Order::Last,
            handler(move |api, scope, _| {
                let global = global.clone();
                Box::pin(async move {
                    let session = api.snapshot(&scope.session)?;
                    let env: Arc<dyn WorkingEnvironment> = capability(api.as_ref(), "environment")?;
                    let env = env
                        .scoped(api.clone(), scope.clone(), api.cancellation(&scope.session)?)
                        .unwrap_or(env);
                    let mut files = vec![];
                    // The person's own file is configuration, read from this machine.
                    if let Ok(text) = std::fs::read_to_string(&global)
                        && !text.trim().is_empty()
                    {
                        files.push((global.to_string_lossy().into_owned(), text));
                    }
                    files.extend(project_files(&env, &session.project).await?);
                    let mut sections = vec![];
                    if !files.is_empty() {
                        sections.push(render(&files));
                    }
                    if let Ok(plugin) = capability::<SkillsPlugin>(api.as_ref(), "skills") {
                        let listing = skills::prompt(&plugin.for_project(&session.project));
                        if !listing.is_empty() {
                            sections.push(format!("<skills>\n{listing}\n</skills>"));
                        }
                    }
                    sections.push(format!("<cwd>\n{}\n</cwd>", session.project.display()));
                    Ok(answer(
                        json!({"system": sections.join("\n\n"), "sources": []}),
                    ))
                })
            }),
        );
        Ok(())
    }
}
