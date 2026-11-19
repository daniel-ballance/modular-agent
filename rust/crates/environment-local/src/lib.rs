use agent_api::*;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::io::AsyncReadExt;
mod containment;
mod points;
pub struct LocalPlugin {
    pub state: PathBuf,
}
pub struct ServedEnvironment {
    pub state: PathBuf,
}
pub struct LocalEnvironment {
    state: PathBuf,
    keep_background: bool,
    points: Arc<points::Points>,
    background: std::sync::Mutex<std::collections::BTreeMap<String, Vec<containment::Command>>>,
}
#[derive(Default)]
struct TextDecoder(Vec<u8>);
impl TextDecoder {
    fn push(&mut self, bytes: &[u8], end: bool) -> String {
        self.0.extend_from_slice(bytes);
        if end {
            return String::from_utf8_lossy(&std::mem::take(&mut self.0)).into_owned();
        }
        let mut text = String::new();
        while !self.0.is_empty() {
            match std::str::from_utf8(&self.0) {
                Ok(valid) => {
                    text.push_str(valid);
                    self.0.clear();
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    text.push_str(std::str::from_utf8(&self.0[..valid]).unwrap());
                    if let Some(length) = error.error_len() {
                        text.push('\u{fffd}');
                        self.0.drain(..valid + length);
                    } else {
                        self.0.drain(..valid);
                        break;
                    }
                }
            }
        }
        text
    }
}
impl Plugin for LocalPlugin {
    fn name(&self) -> &str {
        "environment.local"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        install(r, &self.state, false)
    }
}
impl Plugin for ServedEnvironment {
    fn name(&self) -> &str {
        "environment.local"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        install(r, &self.state, true)
    }
}
fn install(r: &mut Registrar<'_>, state: &Path, keep_background: bool) -> Result<()> {
    // Adopt and reap shell grandchildren instead of leaving zombies to PID 1.
    // https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html
    ensure!(
        unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } == 0,
        "cannot become child subreaper"
    );
    containment::prepare(state)?;
    r.provide::<dyn WorkingEnvironment>(
        "environment",
        Arc::new(LocalEnvironment {
            state: state.into(),
            keep_background,
            points: Arc::default(),
            background: Default::default(),
        }),
    )
}
fn path(project: &Path, name: &str) -> PathBuf {
    project.join(name)
}
#[async_trait]
impl WorkingEnvironment for LocalEnvironment {
    async fn session_ended(&self, session: &str) -> Result<()> {
        let mut jobs = self
            .background
            .lock()
            .unwrap()
            .remove(session)
            .unwrap_or_default();
        for job in &mut jobs {
            job.stop();
        }
        tokio::task::spawn_blocking(move || {
            jobs.iter_mut().try_for_each(containment::Command::join)
        })
        .await?
    }
    fn declaration(&self) -> Value {
        json!({"local":true,"rewinding":true,"stops_commands_after_sigkill":true,"escaped_process_groups":true,"normal_cleanup":true,"containment":"linux-ptrace-exitkill","startup_cleanup":true})
    }
    async fn save_point(&self, session: &str, project: &Path) -> Result<String> {
        let (points, session, project, state) = (
            self.points.clone(),
            session.to_owned(),
            project.to_owned(),
            self.state.clone(),
        );
        tokio::task::spawn_blocking(move || points.save(&session, &project, &state)).await?
    }
    async fn check_point(&self, session: &str, project: &Path, point: &str) -> Result<bool> {
        self.points.check(session, project, point)
    }
    async fn restore_point(&self, session: &str, project: &Path, point: &str) -> Result<()> {
        let (points, session, project, point) = (
            self.points.clone(),
            session.to_owned(),
            project.to_owned(),
            point.to_owned(),
        );
        tokio::task::spawn_blocking(move || points.restore(&session, &project, &point)).await?
    }
    async fn read_bytes(&self, project: &Path, name: &str) -> Result<Vec<u8>> {
        Ok(tokio::fs::read(path(project, name)).await?)
    }
    async fn write_bytes(&self, project: &Path, name: &str, bytes: &[u8]) -> Result<()> {
        let target = path(project, name);
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(target, bytes).await?;
        Ok(())
    }
    async fn exists(&self, project: &Path, name: &str) -> Result<bool> {
        Ok(tokio::fs::try_exists(path(project, name)).await?)
    }
    async fn list_dir(&self, project: &Path, name: &str) -> Result<Vec<String>> {
        let mut names = vec![];
        let mut entries = tokio::fs::read_dir(path(project, name)).await?;
        while let Some(entry) = entries.next_entry().await? {
            let mut name = entry.file_name().to_string_lossy().into_owned();
            // Follow links, as a listing for a person does.
            if tokio::fs::metadata(entry.path())
                .await
                .is_ok_and(|m| m.is_dir())
            {
                name.push('/');
            }
            names.push(name);
        }
        Ok(names)
    }
    async fn walk_files(&self, project: &Path, name: &str) -> Result<Vec<String>> {
        let root = path(project, name);
        ensure!(
            tokio::fs::metadata(&root).await?.is_dir(),
            "not a directory: {name}"
        );
        tokio::task::spawn_blocking(move || {
            let mut files = vec![];
            let walk = ignore::WalkBuilder::new(&root)
                .hidden(false)
                .require_git(false)
                .filter_entry(|e| e.file_name() != ".git")
                .build();
            for entry in walk.flatten() {
                if entry.file_type().is_some_and(|t| !t.is_dir())
                    && let Ok(relative) = entry.path().strip_prefix(&root)
                {
                    files.push(relative.to_string_lossy().replace('\\', "/"));
                }
            }
            Ok(files)
        })
        .await?
    }
    async fn read(&self, project: &Path, name: &str) -> Result<String> {
        Ok(tokio::fs::read_to_string(path(project, name)).await?)
    }
    async fn write(&self, project: &Path, name: &str, text: &str) -> Result<()> {
        let target = path(project, name);
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(target, text).await?;
        Ok(())
    }
    async fn edit(&self, project: &Path, name: &str, old: &str, new: &str) -> Result<()> {
        ensure!(!old.is_empty(), "edit old text must not be empty");
        let text = self.read(project, name).await?;
        ensure!(
            text.matches(old).count() == 1,
            "edit old text must match exactly once"
        );
        self.write(project, name, &text.replacen(old, new, 1)).await
    }
    async fn bash(
        &self,
        api: Api,
        scope: Scope,
        project: PathBuf,
        command: &str,
        cancel: CancellationToken,
    ) -> Result<ToolResult> {
        let mut child = containment::spawn(&self.state, &project, command, self.keep_background)?;
        let mut stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let mut out = [0u8; 4096];
        let mut err = [0u8; 4096];
        let mut output = String::new();
        let mut stdout_text = TextDecoder::default();
        let mut stderr_text = TextDecoder::default();
        let mut out_open = true;
        let mut err_open = true;
        let mut exit = None;
        let drain = tokio::time::sleep(Duration::ZERO);
        tokio::pin!(drain);
        let mut settled = false;
        let mut cancelled = false;
        let stream = format!("bash-{}", scope.call.as_deref().unwrap_or("unknown"));
        let result:Result<()>=async{
            loop {
                if exit.is_some() && !out_open && !err_open {break}
                tokio::select! {
                    biased;
                    _=cancel.cancelled(),if !cancelled && exit.is_none()=>{
                        cancelled=true;child.stop();
                    },
                    status=&mut child.done,if !settled=>{
                        settled=true;
                        exit=Some(status??);
                        drain.as_mut().reset(tokio::time::Instant::now() + Duration::from_millis(250));
                    },
                    bytes=stdout.read(&mut out),if out_open=>{
                        let n=bytes?;out_open=n>0;let text=stdout_text.push(&out[..n],n==0);if !text.is_empty(){
                            output.push_str(&text);
                            let mut event=Event::new(&scope,"tool.progress",json!(text));
                            event.stream=Some(stream.clone());api.emit(event).await?;
                        }
                    },
                    bytes=stderr.read(&mut err),if err_open=>{
                        let n=bytes?;err_open=n>0;let text=stderr_text.push(&err[..n],n==0);if !text.is_empty(){
                            output.push_str(&text);
                            let mut event=Event::new(&scope,"tool.progress",json!(text));
                            event.stream=Some(stream.clone());api.emit(event).await?;
                        }
                    },
                    _=&mut drain,if exit.is_some()=>break,
                }
            }
            Ok(())
        }.await;
        if self.keep_background && result.is_ok() && !cancel.is_cancelled() && exit.is_some() {
            self.background
                .lock()
                .unwrap()
                .entry(scope.session.clone())
                .or_default()
                .push(child);
        } else {
            child.stop();
            if !settled {
                let _ = (&mut child.done).await;
            }
            child.join()?;
        }
        let mut end = Event::new(&scope, "tool.stream.end", Value::Null);
        end.stream = Some(stream);
        end.end = true;
        api.emit(end).await?;
        result?;
        let status = if cancelled {
            ToolStatus::Cancelled
        } else if exit.is_some_and(|s| s.success()) {
            ToolStatus::Completed
        } else {
            ToolStatus::Failed
        };
        Ok(ToolResult {
            call: scope.call.unwrap_or_default(),
            status,
            text: output,
            value: Some(json!({"exit_code":exit.and_then(|s|s.code())})),
        })
    }
}
