//! The six file and command tools of the standard configuration: read, exec,
//! edit, write, find and list. They follow Pi's built-in tools in inputs,
//! limits and wording. Every operation goes through the session's working
//! environment, so the same tools work against another environment.
use agent_api::*;
use std::{path::Path, sync::Arc, time::Duration};

pub mod text;
use text::*;

pub const MAX_LINES: usize = 2000;
pub const MAX_BYTES: usize = 50 * 1024;
const FIND_LIMIT: usize = 1000;
const LIST_LIMIT: usize = 500;

/// `callers` limits who may start these tools; `None` allows every caller.
/// Whether the model is offered them directly is the session's `model_tools`
/// setting. The standard configuration offers only the code tool, which
/// calls these.
pub struct FileTools {
    pub callers: Option<Vec<String>>,
    /// Where exec keeps the full output of a call whose output was cut.
    pub spill: std::path::PathBuf,
}
impl FileTools {
    pub fn new(spill: std::path::PathBuf) -> Self {
        Self {
            callers: None,
            spill,
        }
    }
}
impl Plugin for FileTools {
    fn name(&self) -> &str {
        "tools.files"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.provide::<dyn ToolSource>(
            "tools.files",
            Arc::new(Self {
                callers: self.callers.clone(),
                spill: self.spill.clone(),
            }),
        )
    }
}

fn tool(
    name: &str,
    description: String,
    properties: Value,
    required: &[&str],
    read_only: bool,
) -> ToolDefinition {
    ToolDefinition {
        name: name.into(),
        description,
        input: json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}),
        read_only,
        safe_to_repeat: read_only,
        parallel: read_only,
        hints: json!({}),
    }
}

pub fn definitions() -> Vec<ToolDefinition> {
    let kb = MAX_BYTES / 1024;
    vec![
        tool(
            "read",
            format!(
                "Read the contents of a file. For text files, output is truncated to {MAX_LINES} lines or {kb}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete."
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
    if path == "~" || path.starts_with("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return format!("{}{}", home.to_string_lossy(), &path[1..]);
        }
    }
    path.into()
}
fn unsupported(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|e| e.kind() == std::io::ErrorKind::Unsupported)
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
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("image/webp"),
        _ => None,
    }
}

struct Work {
    api: Api,
    scope: Scope,
    cancel: CancellationToken,
    project: std::path::PathBuf,
    env: Arc<dyn WorkingEnvironment>,
}
impl Work {
    /// A command the tool runs for itself where the environment has no native
    /// operation. Its output is not streamed as the call's own.
    async fn command(&self, command: &str) -> Result<String> {
        let result = self
            .env
            .bash(
                self.api.clone(),
                self.scope.clone(),
                self.project.clone(),
                command,
                self.cancel.clone(),
            )
            .await?;
        ensure!(
            result.status == ToolStatus::Completed,
            "{}",
            result.text.trim()
        );
        Ok(result.text)
    }
    async fn read(&self, input: &Value) -> Result<(String, Option<Value>)> {
        let path = clean_path(string(input, "path")?);
        let offset = optional_number(input, "offset")?.map(|n| n as usize);
        let limit = optional_number(input, "limit")?.map(|n| n as usize);
        let bytes = self.env.read_bytes(&self.project, &path).await?;
        if let Some(mime) = image_type(&bytes) {
            return Ok((
                format!(
                    "Read image file [{mime}], {}. This build does not pass images to the model.",
                    format_size(bytes.len())
                ),
                None,
            ));
        }
        let content = String::from_utf8_lossy(&bytes);
        read_window(&content, &path, offset, limit).map(|text| (text, None))
    }
    async fn write(&self, input: &Value) -> Result<(String, Option<Value>)> {
        let path = clean_path(string(input, "path")?);
        let content = string(input, "content")?;
        self.env
            .write_bytes(&self.project, &path, content.as_bytes())
            .await?;
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
        let bytes = self.env.read_bytes(&self.project, &path).await?;
        let original =
            String::from_utf8(bytes).map_err(|_| anyhow!("{path} is not UTF-8 text"))?;
        let changed = apply_edits(&original, &edits, &path)?;
        self.env
            .write_bytes(&self.project, &path, changed.as_bytes())
            .await?;
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
        let mut names = match self.env.list_dir(&self.project, &path).await {
            Ok(names) => names,
            Err(error) if unsupported(&error) => self
                .command(&format!("ls -1Ap -- {}", shell_quote(&path)))
                .await?
                .lines()
                .map(str::to_owned)
                .collect(),
            Err(error) => return Err(error),
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
        let files = match self.env.walk_files(&self.project, &path).await {
            Ok(files) => files,
            Err(error) if unsupported(&error) => self
                .command(&format!(
                    "cd -- {} && (git ls-files -co --exclude-standard 2>/dev/null || find . -type f -not -path './.git/*' | sed 's|^\\./||')",
                    shell_quote(&path)
                ))
                .await?
                .lines()
                .map(str::to_owned)
                .collect(),
            Err(error) => return Err(error),
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
    async fn exec(&self, input: &Value, spill: &Path) -> Result<ToolResult> {
        let command = string(input, "command")?;
        let timeout = optional_number(input, "timeout")?.filter(|n| *n > 0.0);
        let cancel = self.cancel.child_token();
        let started = std::time::Instant::now();
        let run = self.env.bash(
            self.api.clone(),
            self.scope.clone(),
            self.project.clone(),
            command,
            cancel.clone(),
        );
        tokio::pin!(run);
        let mut timed_out = false;
        let mut result = match timeout {
            None => run.await?,
            Some(seconds) => {
                tokio::select! {
                    result = &mut run => result?,
                    _ = tokio::time::sleep(Duration::from_secs_f64(seconds)) => {
                        timed_out = true;
                        cancel.cancel();
                        run.await?
                    }
                }
            }
        };
        let exit_code = result
            .value
            .as_ref()
            .and_then(|v| v["exit_code"].as_i64());
        let cut = truncate_tail(&result.text, MAX_LINES, MAX_BYTES);
        let mut text = cut.content.clone();
        let mut value = json!({
            "output": cut.content,
            "truncated": cut.truncated,
            "exit_code": exit_code,
            "wall_time_seconds": (started.elapsed().as_secs_f64() * 1000.0).round() / 1000.0,
        });
        if cut.truncated {
            let file = spill.join(format!("exec-{}.log", id()));
            let saved = std::fs::create_dir_all(spill)
                .and_then(|()| std::fs::write(&file, &result.text))
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
            result.status = ToolStatus::Failed;
            text.push_str(&format!(
                "\n\nCommand timed out after {} seconds",
                timeout.unwrap_or_default()
            ));
            value["timed_out"] = json!(true);
        } else if result.status == ToolStatus::Failed {
            match exit_code {
                Some(code) => text.push_str(&format!("\n\nCommand exited with code {code}")),
                None => text.push_str("\n\nCommand was ended by a signal"),
            }
        } else if result.status == ToolStatus::Cancelled {
            text.push_str("\n\nCommand aborted");
        }
        result.text = text;
        result.value = Some(value);
        Ok(result)
    }
}

#[async_trait]
impl ToolSource for FileTools {
    fn tools(&self, _: &SessionData) -> Vec<ToolDefinition> {
        match &self.callers {
            Some(callers) => {
                let callers: Vec<&str> = callers.iter().map(String::as_str).collect();
                definitions()
                    .into_iter()
                    .map(|d| d.for_callers(&callers))
                    .collect()
            }
            None => definitions(),
        }
    }
    async fn run(
        &self,
        api: Api,
        scope: Scope,
        call: ToolCall,
        cancel: CancellationToken,
    ) -> ToolResult {
        let result: Result<ToolResult> = async {
            if cancel.is_cancelled() {
                return Ok(ToolResult::new(&call, ToolStatus::Cancelled, "cancelled"));
            }
            let definition = definitions()
                .into_iter()
                .find(|d| d.name == call.name)
                .ok_or_else(|| anyhow!("unknown tool {}", call.name))?;
            let object = call
                .input
                .as_object()
                .ok_or_else(|| anyhow!("tool input must be an object"))?;
            let properties = definition.input["properties"].as_object().unwrap();
            if let Some(extra) = object.keys().find(|k| !properties.contains_key(*k)) {
                bail!("unexpected field {extra}");
            }
            for required in definition.input["required"].as_array().unwrap() {
                ensure!(
                    object.contains_key(required.as_str().unwrap()),
                    "missing field {required}"
                );
            }
            let data = api.snapshot(&scope.session)?;
            let env: Arc<dyn WorkingEnvironment> = capability(api.as_ref(), "environment")?;
            let env = env
                .scoped(api.clone(), scope.clone(), cancel.clone())
                .unwrap_or(env);
            let work = Work {
                api,
                scope,
                cancel,
                project: data.project,
                env,
            };
            let (text, value) = match call.name.as_str() {
                "read" => work.read(&call.input).await?,
                "write" => work.write(&call.input).await?,
                "edit" => work.edit(&call.input).await?,
                "find" => work.find(&call.input).await?,
                "list" => work.list(&call.input).await?,
                "exec" => {
                    let mut result = work.exec(&call.input, &self.spill).await?;
                    result.call = call.id.clone();
                    return Ok(result);
                }
                _ => bail!("unknown tool {}", call.name),
            };
            let mut result = ToolResult::new(&call, ToolStatus::Completed, text);
            result.value = value;
            Ok(result)
        }
        .await;
        result.unwrap_or_else(|error| {
            let status = if error.downcast_ref::<LostPart>().is_some() {
                ToolStatus::Unknown
            } else {
                ToolStatus::Failed
            };
            let text = if is_file_not_found(&error) {
                format!(
                    "File not found: {}",
                    call.input["path"].as_str().unwrap_or(".")
                )
            } else {
                error.to_string()
            };
            ToolResult::new(&call, status, text)
        })
    }
}
