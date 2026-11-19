//! The six file and command tools of the standard configuration: read, exec,
//! edit, write, find and list. They follow Pi's built-in tools in inputs,
//! limits and wording. Every operation goes through the session's working
//! environment, so the same tools work against another environment.
use anyhow::{Result, anyhow, bail, ensure};
use base64::Engine;
use modular_agent::{Code, Plugin, Tool, ToolEnvironment, ToolOutput, ToolStatus};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

pub mod text;
use text::*;

pub const MAX_LINES: usize = 2000;
pub const MAX_BYTES: usize = 50 * 1024;
const FIND_LIMIT: usize = 1000;
const LIST_LIMIT: usize = 500;
/// The largest image `read` attaches. Pi resizes larger ones; this build does not.
pub const MAX_IMAGE_BYTES: usize = 4_718_592;

pub struct Definition {
    pub name: String,
    pub description: String,
    pub input: Value,
    pub read_only: bool,
}
fn tool(
    name: &str,
    description: String,
    properties: Value,
    required: &[&str],
    read_only: bool,
) -> Definition {
    Definition {
        name: name.into(),
        description,
        input: json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}),
        read_only,
    }
}

pub fn definitions() -> Vec<Definition> {
    let kb = MAX_BYTES / 1024;
    vec![
        tool(
            "read",
            format!(
                "Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to {MAX_LINES} lines or {kb}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete."
            ),
            json!({
                "path":{"type":"string","description":"Path to the file to read (relative or absolute)"},
                "offset":{"type":"number","description":"Line number to start reading from (1-indexed)"},
                "limit":{"type":"number","description":"Maximum number of lines to read"}
            }),
            &["path"],
            true,
        ),
        tool(
            "exec",
            format!(
                "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last {MAX_LINES} lines or {kb}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds."
            ),
            json!({
                "command":{"type":"string","description":"Shell command to execute"},
                "timeout":{"type":"number","description":"Timeout in seconds (optional, no default timeout)"}
            }),
            &["command"],
            false,
        ),
        tool(
            "edit",
            "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.".into(),
            json!({
                "path":{"type":"string","description":"Path to the file to edit (relative or absolute)"},
                "edits":{"type":"array","description":"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
                    "items":{"type":"object","properties":{
                        "oldText":{"type":"string","description":"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call."},
                        "newText":{"type":"string","description":"Replacement text for this targeted edit."}
                    },"required":["oldText","newText"],"additionalProperties":false}}
            }),
            &["path", "edits"],
            false,
        ),
        tool(
            "write",
            "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.".into(),
            json!({
                "path":{"type":"string","description":"Path to the file to write (relative or absolute)"},
                "content":{"type":"string","description":"Content to write to the file"}
            }),
            &["path", "content"],
            false,
        ),
        tool(
            "find",
            format!(
                "Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to {FIND_LIMIT} results or {kb}KB (whichever is hit first)."
            ),
            json!({
                "pattern":{"type":"string","description":"Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'"},
                "path":{"type":"string","description":"Directory to search in (default: current directory)"},
                "limit":{"type":"number","description":"Maximum number of results (default: 1000)"}
            }),
            &["pattern"],
            true,
        ),
        tool(
            "list",
            format!(
                "List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to {LIST_LIMIT} entries or {kb}KB (whichever is hit first)."
            ),
            json!({
                "path":{"type":"string","description":"Directory to list (default: current directory)"},
                "limit":{"type":"number","description":"Maximum number of entries to return (default: 500)"}
            }),
            &[],
            true,
        ),
    ]
}

fn string<'a>(input: &'a Value, key: &str) -> Result<&'a str> {
    input[key]
        .as_str()
        .ok_or_else(|| anyhow!("{key} must be a string"))
}
fn optional_string<'a>(input: &'a Value, key: &str) -> Result<Option<&'a str>> {
    match &input[key] {
        Value::Null => Ok(None),
        Value::String(text) => Ok(Some(text)),
        _ => bail!("{key} must be a string"),
    }
}
fn optional_number(input: &Value, key: &str) -> Result<Option<f64>> {
    match &input[key] {
        Value::Null => Ok(None),
        value => Ok(Some(
            value
                .as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0)
                .ok_or_else(|| anyhow!("{key} must be a number, zero or more"))?,
        )),
    }
}
/// Pi accepts a leading '@' (as pasted from a mention) and '~'.
fn clean_path(path: &str) -> String {
    let path = path.strip_prefix('@').unwrap_or(path);
    if (path == "~" || path.starts_with("~/"))
        && let Some(home) = std::env::var_os("HOME")
    {
        return format!("{}{}", home.to_string_lossy(), &path[1..]);
    }
    path.into()
}
fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}
fn image_type(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => Some("image/png"),
        [0xff, 0xd8, 0xff, ..] => Some("image/jpeg"),
        [b'G', b'I', b'F', b'8', ..] => Some("image/gif"),
        [b'B', b'M', ..] if bytes.len() > 26 => Some("image/bmp"),
        [
            b'R',
            b'I',
            b'F',
            b'F',
            _,
            _,
            _,
            _,
            b'W',
            b'E',
            b'B',
            b'P',
            ..,
        ] => Some("image/webp"),
        _ => None,
    }
}

struct Work<'a>(ToolEnvironment<'a>);
impl Work<'_> {
    /// A command the tool runs for itself where the environment has no native
    /// operation. Its output is not streamed as the call's own.
    async fn command(&self, command: &str) -> Result<String> {
        let result = self.0.exec(command, None).await?;
        ensure!(
            result.status == ToolStatus::Completed,
            "{}",
            result.output.trim()
        );
        Ok(result.output)
    }
    async fn read(&self, input: &Value) -> Result<(String, Option<Value>)> {
        let path = clean_path(string(input, "path")?);
        let offset = optional_number(input, "offset")?.map(|n| n as usize);
        let limit = optional_number(input, "limit")?.map(|n| n as usize);
        let bytes = self.0.read(&path).await?;
        if let Some(mime) = image_type(&bytes) {
            if bytes.len() > MAX_IMAGE_BYTES {
                return Ok((
                    format!(
                        "Read image file [{mime}], {}. It is over the {} limit for images, so it was not attached.",
                        format_size(bytes.len()),
                        format_size(MAX_IMAGE_BYTES)
                    ),
                    None,
                ));
            }
            let note = format!("Read image file [{mime}]");
            let image = json!({"type":"image","mimeType":mime,"data":base64::engine::general_purpose::STANDARD.encode(&bytes)});
            return Ok((
                note.clone(),
                Some(json!([{"type":"text","text":note}, image])),
            ));
        }
        let content = String::from_utf8_lossy(&bytes);
        read_window(&content, &path, offset, limit).map(|text| (text, None))
    }
    async fn write(&self, input: &Value) -> Result<(String, Option<Value>)> {
        let path = clean_path(string(input, "path")?);
        let content = string(input, "content")?;
        self.0.write(&path, content.as_bytes()).await?;
        Ok((
            format!("Successfully wrote {} bytes to {path}", content.len()),
            None,
        ))
    }
    async fn edit(&self, input: &Value) -> Result<(String, Option<Value>)> {
        let path = clean_path(string(input, "path")?);
        let edits = input["edits"]
            .as_array()
            .ok_or_else(|| anyhow!("edits must be an array"))?
            .iter()
            .map(|edit| Ok((string(edit, "oldText")?, string(edit, "newText")?)))
            .collect::<Result<Vec<_>>>()?;
        let bytes = self.0.read(&path).await?;
        let original = String::from_utf8(bytes).map_err(|_| anyhow!("{path} is not UTF-8 text"))?;
        let changed = apply_edits(&original, &edits, &path)?;
        self.0.write(&path, changed.as_bytes()).await?;
        Ok((
            format!("Successfully replaced {} block(s) in {path}.", edits.len()),
            None,
        ))
    }
    async fn list(&self, input: &Value) -> Result<(String, Option<Value>)> {
        let path = clean_path(optional_string(input, "path")?.unwrap_or("."));
        let limit = optional_number(input, "limit")?
            .map(|n| (n as usize).max(1))
            .unwrap_or(LIST_LIMIT);
        let mut names = match self.0.list(&path).await {
            Ok(names) => names,
            Err(error) if error.code() == Code::NotSupported => self
                .command(&format!("ls -1Ap -- {}", shell_quote(&path)))
                .await?
                .lines()
                .map(str::to_owned)
                .collect(),
            Err(error) => return Err(error.into()),
        };
        names.sort_by_key(|name| name.to_lowercase());
        if names.is_empty() {
            return Ok(("(empty directory)".into(), None));
        }
        let mut notices = vec![];
        if names.len() > limit {
            names.truncate(limit);
            notices.push(format!(
                "{limit} entries limit reached. Use limit={} for more",
                limit * 2
            ));
        }
        Ok((bounded_listing(names, notices), None))
    }
    async fn find(&self, input: &Value) -> Result<(String, Option<Value>)> {
        let pattern = string(input, "pattern")?;
        let path = clean_path(optional_string(input, "path")?.unwrap_or("."));
        let limit = optional_number(input, "limit")?
            .map(|n| (n as usize).max(1))
            .unwrap_or(FIND_LIMIT);
        let files = match self.0.walk_files(&path).await {
            Ok(files) => files,
            Err(error) if error.code() == Code::NotSupported => self
                .command(&format!(
                    "cd -- {} && (git ls-files -co --exclude-standard 2>/dev/null || find . -type f -not -path './.git/*' | sed 's|^\\./||')",
                    shell_quote(&path)
                ))
                .await?
                .lines()
                .map(str::to_owned)
                .collect(),
            Err(error) => return Err(error.into()),
        };
        let mut matches = glob_filter(files, pattern)?;
        matches.sort();
        if matches.is_empty() {
            return Ok(("No files found matching pattern".into(), None));
        }
        let mut notices = vec![];
        if matches.len() > limit {
            matches.truncate(limit);
            notices.push(format!(
                "{limit} results limit reached. Use limit={} for more, or refine pattern",
                limit * 2
            ));
        }
        Ok((bounded_listing(matches, notices), None))
    }
    async fn exec(&self, input: &Value, spill: &Path) -> Result<ToolOutput> {
        let command = string(input, "command")?;
        let timeout = optional_number(input, "timeout")?.filter(|n| *n > 0.0);
        let started = std::time::Instant::now();
        let timeout_duration = timeout.map(Duration::try_from_secs_f64).transpose()?;
        let result = self.0.exec(command, timeout_duration).await?;
        let timed_out = result.timed_out;
        let exit_code = result.exit_code;
        let mut status = result.status;
        let cut = truncate_tail(&result.output, MAX_LINES, MAX_BYTES);
        let mut text = cut.content.clone();
        let mut value = json!({
            "output": cut.content,
            "truncated": cut.truncated,
            "exit_code": exit_code,
            "wall_time_seconds": (started.elapsed().as_secs_f64() * 1000.0).round() / 1000.0,
        });
        if cut.truncated {
            let file = spill.join(format!("exec-{}.log", uuid::Uuid::new_v4()));
            let saved = std::fs::create_dir_all(spill)
                .and_then(|()| std::fs::write(&file, &result.output))
                .is_ok();
            let first = cut.total_lines - cut.output_lines + 1;
            let mut note = format!(
                "\n\n[Showing lines {first}-{} of {}",
                cut.total_lines, cut.total_lines
            );
            if cut.by_bytes {
                note.push_str(&format!(" ({} limit)", format_size(MAX_BYTES)));
            }
            if saved {
                note.push_str(&format!(". Full output: {}", file.display()));
                value["full_output_path"] = json!(file);
            }
            note.push(']');
            text.push_str(&note);
        }
        if text.is_empty() {
            text = "(no output)".into();
        }
        if timed_out {
            status = ToolStatus::Failed;
            text.push_str(&format!(
                "\n\nCommand timed out after {} seconds",
                timeout.unwrap_or_default()
            ));
            value["timed_out"] = json!(true);
        } else if status == ToolStatus::Failed {
            match exit_code {
                Some(code) => text.push_str(&format!("\n\nCommand exited with code {code}")),
                None => text.push_str("\n\nCommand was ended by a signal"),
            }
        } else if status == ToolStatus::Cancelled {
            text.push_str("\n\nCommand aborted");
        }
        Ok(ToolOutput {
            status,
            text,
            value: Some(value),
            content: None,
        })
    }
}

/// Register the six file and command tools.
pub fn files(spill: impl Into<PathBuf>) -> Plugin {
    let spill = spill.into();
    let mut plugin = Plugin::new("files");
    for d in definitions() {
        let name = d.name.clone();
        let target = spill.clone();
        let mut tool = Tool::new(d.name, d.description).input_schema(d.input);
        if d.read_only {
            tool = tool.read_only().safe_to_repeat().parallel();
        }
        plugin = plugin.tool(tool.run(move |input: Value, cx| {
            let name = name.clone();
            let target = target.clone();
            async move {
                let work = Work(cx.environment());
                let result: Result<ToolOutput> = async {
                    let (text, parts) = match name.as_str() {
                        "read" => work.read(&input).await?,
                        "write" => work.write(&input).await?,
                        "edit" => work.edit(&input).await?,
                        "find" => work.find(&input).await?,
                        "list" => work.list(&input).await?,
                        "exec" => return work.exec(&input, &target).await,
                        _ => unreachable!(),
                    };
                    let output = ToolOutput::from(text);
                    Ok(match parts.and_then(|v| v.as_array().cloned()) {
                        Some(parts) => output.with_content(parts),
                        None => output,
                    })
                }
                .await;
                Ok(result.unwrap_or_else(|error| {
                    let sdk = error.downcast_ref::<modular_agent::Error>();
                    let status = if sdk.is_some_and(|e| e.code() == Code::Lost) {
                        ToolStatus::OutcomeUnknown
                    } else {
                        ToolStatus::Failed
                    };
                    let text = match sdk {
                        Some(e) if e.code() == Code::NotFound => {
                            format!("File not found: {}", input["path"].as_str().unwrap_or("."))
                        }
                        Some(e) => e.message().into(),
                        None => error.to_string(),
                    };
                    ToolOutput {
                        status,
                        text,
                        value: None,
                        content: None,
                    }
                }))
            }
        }));
    }
    plugin
}
