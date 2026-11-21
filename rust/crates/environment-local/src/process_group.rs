//! The supervisor leads the group and keeps its identity reserved after bash exits.
use agent_api::*;
use std::{
    io::{BufRead, BufReader},
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::{
            net::UnixStream,
            process::{CommandExt, ExitStatusExt},
        },
    },
    path::Path,
    process::{ExitStatus, Stdio},
};

// The monitor owns the lifetime read end. Neither the command nor its children
// get any lifetime/status descriptors. EOF covers both explicit stop and SIGKILL.
const SUPERVISOR: &str = r#"
set +m
exec 4<&0
/bin/bash --noprofile --norc -c "$1" </dev/null 3>&- 4<&- &
command_pid=$!
trap '' TERM PIPE
exec </dev/null >/dev/null 2>&1
(
    read -r unused <&4
    kill -TERM -- "-$$"
    sleep 0.25
    kill -KILL -- "-$$"
) 3>&- &
monitor=$!
exec 4<&-
wait "$command_pid"
printf '%d\n' "$?" >&3
exec 3>&-
wait "$monitor"
"#;

pub fn prepare(root: &Path) -> Result<()> {
    Ok(std::fs::create_dir_all(root)?)
}

pub struct Command {
    pub stdout: Option<tokio::net::UnixStream>,
    pub stderr: Option<tokio::net::UnixStream>,
    pub done: tokio::sync::oneshot::Receiver<Result<ExitStatus>>,
    control: Option<UnixStream>,
    thread: Option<std::thread::JoinHandle<Result<()>>>,
}

impl Command {
    pub fn stop(&mut self) {
        self.control.take();
    }

    pub fn join(&mut self) -> Result<()> {
        if let Some(thread) = self.thread.take() {
            thread
                .join()
                .map_err(|_| anyhow!("command supervisor panicked"))??;
        }
        Ok(())
    }
}

impl Drop for Command {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn spawn(
    _root: &Path,
    project: &Path,
    command: &str,
    _keep_background: bool,
) -> Result<Command> {
    let (out, out_child) = UnixStream::pair()?;
    let (err, err_child) = UnixStream::pair()?;
    let (control, lifetime) = UnixStream::pair()?;
    let (status, status_child) = UnixStream::pair()?;
    out.set_nonblocking(true)?;
    err.set_nonblocking(true)?;
    let stdout = Some(tokio::net::UnixStream::from_std(out)?);
    let stderr = Some(tokio::net::UnixStream::from_std(err)?);
    let (sender, done) = tokio::sync::oneshot::channel();
    let mut cmd = std::process::Command::new("/bin/bash");
    cmd.args([
        "--noprofile",
        "--norc",
        "-c",
        SUPERVISOR,
        "ma-command",
        command,
    ])
    .current_dir(project)
    .env_remove("BASH_ENV")
    .process_group(0)
    .stdin(Stdio::from(OwnedFd::from(lifetime)))
    .stdout(Stdio::from(OwnedFd::from(out_child)))
    .stderr(Stdio::from(OwnedFd::from(err_child)));
    let fd = status_child.as_raw_fd();
    // Only async-signal-safe operations are allowed here, before exec.
    unsafe {
        cmd.pre_exec(move || {
            if libc::dup2(fd, 3) < 0 || libc::fcntl(3, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let thread = std::thread::Builder::new()
        .name("command-supervisor".into())
        .spawn(move || {
            let mut child = match cmd.spawn() {
                Ok(child) => child,
                Err(error) => {
                    let _ = sender.send(Err(error.into()));
                    return Ok(());
                }
            };
            drop(cmd);
            drop(status_child);
            let mut line = String::new();
            let read = BufReader::new(status).read_line(&mut line);
            if matches!(read, Ok(n) if n > 0) {
                let code = line
                    .trim()
                    .parse::<i32>()
                    .map(|code| ExitStatus::from_raw(code << 8));
                let _ = sender.send(code.map_err(Into::into));
            } else {
                let _ = sender.send(Ok(ExitStatus::from_raw(libc::SIGKILL)));
            }
            let status = child.wait()?;
            ensure!(
                status.signal() == Some(libc::SIGKILL),
                "command group cleanup unconfirmed"
            );
            Ok(())
        })?;
    Ok(Command {
        stdout,
        stderr,
        done,
        control: Some(control),
        thread: Some(thread),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    async fn darwin_process_group_preserves_background_then_stops_it() {
        let root = tempfile::tempdir().unwrap();
        prepare(root.path()).unwrap();
        let mut command = spawn(
            root.path(),
            root.path(),
            "sleep 60 </dev/null >/dev/null 2>&1 & echo $! > child; printf ready",
            true,
        )
        .unwrap();
        let status = tokio::time::timeout(Duration::from_secs(3), &mut command.done)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(status.success());
        let mut output = String::new();
        command
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut output)
            .await
            .unwrap();
        assert_eq!(output, "ready");
        let mut errors = String::new();
        command
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut errors)
            .await
            .unwrap();
        assert!(errors.is_empty(), "{errors}");
        let pid = std::fs::read_to_string(root.path().join("child"))
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
        command.stop();
        command.join().unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let process = std::process::Command::new("ps")
                    .args(["-p", &pid.to_string(), "-o", "state="])
                    .output()
                    .unwrap();
                let state = String::from_utf8_lossy(&process.stdout);
                if state.trim().is_empty() || state.trim_start().starts_with('Z') {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
    }
}
