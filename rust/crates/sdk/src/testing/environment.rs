use crate::{Code, Error, Result};
use agent_api as base;
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

type Exec = Arc<dyn Fn(&str) -> Result<ExecOutput> + Send + Sync>;

#[derive(Clone, Debug, Default)]
pub struct ExecOutput {
    pub exit_code: i32,
    pub output: String,
}

/// A working environment that cannot run real programs or touch the filesystem.
#[derive(Clone, Default)]
pub struct MemoryEnvironment {
    files: Arc<Mutex<BTreeMap<PathBuf, Vec<u8>>>>,
    exec: BTreeMap<String, Exec>,
}

pub fn memory_environment() -> MemoryEnvironment {
    MemoryEnvironment::default()
}

pub fn memory_environment_with(
    files: impl IntoIterator<Item = (String, String)>,
) -> Result<MemoryEnvironment> {
    let environment = memory_environment();
    for (path, text) in files {
        environment.put(&path, text.into_bytes())?;
    }
    Ok(environment)
}

impl MemoryEnvironment {
    pub fn on_exec(
        mut self,
        name: impl Into<String>,
        handler: impl Fn(&str) -> Result<ExecOutput> + Send + Sync + 'static,
    ) -> Self {
        self.exec.insert(name.into(), Arc::new(handler));
        self
    }
    fn put(&self, path: &str, contents: Vec<u8>) -> Result<()> {
        self.files.lock().unwrap().insert(relative(path)?, contents);
        Ok(())
    }
}

fn relative(path: &str) -> Result<PathBuf> {
    let mut clean = PathBuf::new();
    for part in Path::new(path).components() {
        match part {
            Component::Normal(name) => clean.push(name),
            Component::CurDir => (),
            Component::ParentDir if clean.pop() => (),
            _ => {
                return Err(Error::new(
                    Code::InvalidRequest,
                    "path is outside the project",
                ));
            }
        }
    }
    Ok(clean)
}

impl base::Plugin for MemoryEnvironment {
    fn name(&self) -> &str {
        "environment.memory"
    }
    fn install(&self, r: &mut base::Registrar<'_>) -> base::Result<()> {
        r.provide::<dyn base::WorkingEnvironment>("environment", Arc::new(self.clone()))
    }
}

#[async_trait::async_trait]
impl base::WorkingEnvironment for MemoryEnvironment {
    fn declaration(&self) -> base::Value {
        json!({"containment":"none","rewinding":false,"confines_files":true,"safe_to_repeat":false})
    }
    async fn read(&self, project: &Path, path: &str) -> base::Result<String> {
        Ok(String::from_utf8(self.read_bytes(project, path).await?)?)
    }
    async fn read_bytes(&self, _: &Path, path: &str) -> base::Result<Vec<u8>> {
        self.files
            .lock()
            .unwrap()
            .get(&relative(path)?)
            .cloned()
            .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound).into())
    }
    async fn write(&self, _: &Path, path: &str, text: &str) -> base::Result<()> {
        Ok(self.put(path, text.as_bytes().into())?)
    }
    async fn write_bytes(&self, _: &Path, path: &str, bytes: &[u8]) -> base::Result<()> {
        Ok(self.put(path, bytes.into())?)
    }
    async fn list_dir(&self, _: &Path, path: &str) -> base::Result<Vec<String>> {
        let directory = relative(path)?;
        let files = self.files.lock().unwrap();
        let names = files
            .keys()
            .filter_map(|f| {
                let mut tail = f.strip_prefix(&directory).ok()?.components();
                let name = tail.next()?.as_os_str().to_str()?;
                Some(if tail.next().is_some() {
                    format!("{name}/")
                } else {
                    name.to_owned()
                })
            })
            .collect::<BTreeSet<_>>();
        if names.is_empty() && !directory.as_os_str().is_empty() {
            return Err(std::io::Error::from(std::io::ErrorKind::NotFound).into());
        }
        Ok(names.into_iter().collect())
    }
    async fn edit(&self, _: &Path, path: &str, old: &str, new: &str) -> base::Result<()> {
        let mut files = self.files.lock().unwrap();
        let bytes = files
            .get_mut(&relative(path)?)
            .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound))?;
        let text = std::str::from_utf8(bytes)?;
        base::ensure!(
            !old.is_empty() && text.matches(old).count() == 1,
            "edit needs exactly one match"
        );
        *bytes = text.replacen(old, new, 1).into_bytes();
        Ok(())
    }
    async fn bash(
        &self,
        _: base::Api,
        _: base::Scope,
        _: PathBuf,
        command: &str,
        cancel: CancellationToken,
    ) -> base::Result<base::ToolResult> {
        if cancel.is_cancelled() {
            return Err(Error::new(Code::Cancelled, "command cancelled").into());
        }
        let command = command.trim();
        let (name, args) = command
            .split_once(char::is_whitespace)
            .unwrap_or((command, ""));
        let run = self.exec.get(name).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                format!("no test handler for {name}"),
            )
        })?;
        let output = run(args.trim_start())?;
        Ok(base::ToolResult {
            call: String::new(),
            status: if output.exit_code == 0 {
                base::ToolStatus::Completed
            } else {
                base::ToolStatus::Failed
            },
            text: output.output,
            value: Some(json!({"exit_code":output.exit_code})),
        })
    }
}
