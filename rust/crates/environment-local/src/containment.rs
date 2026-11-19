//! Linux descendant containment. All tracing lives on an agent-owned thread.
//! Sources: https://man7.org/linux/man-pages/man2/ptrace.2.html
//! https://man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html
#[cfg(test)]
#[path = "containment_tests.rs"]
mod tests;
use agent_api::*;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    ffi::CString,
    fs::{self, File, OpenOptions},
    io::Write,
    os::{
        fd::AsRawFd,
        unix::{
            ffi::OsStrExt,
            fs::{DirBuilderExt, OpenOptionsExt},
            net::UnixStream,
            process::ExitStatusExt,
        },
    },
    path::Path,
    process::ExitStatus,
    sync::mpsc,
    time::Duration,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Identity {
    pid: i32,
    tgid: i32,
    start: String,
}
fn identity(pid: i32) -> Option<(Identity, bool)> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields = stat
        .rsplit_once(')')?
        .1
        .split_whitespace()
        .collect::<Vec<_>>();
    Some((
        Identity {
            pid,
            tgid: fs::read_to_string(format!("/proc/{pid}/status"))
                .ok()?
                .lines()
                .find_map(|line| {
                    line.strip_prefix("Tgid:")
                        .and_then(|v| v.trim().parse().ok())
                })?,
            start: fields.get(19)?.to_string(),
        },
        fields[0] != "Z" && fields[0] != "X",
    ))
}
fn matches(who: &Identity) -> bool {
    identity(who.pid)
        .is_some_and(|(now, live)| live && now.start == who.start && now.tgid == who.tgid)
}
// Pin a process with pidfd before checking identity, so PID reuse cannot redirect a kill.
// https://man7.org/linux/man-pages/man2/pidfd_send_signal.2.html
fn kill(who: &Identity) {
    unsafe {
        let fd = libc::syscall(libc::SYS_pidfd_open, who.tgid, 0) as i32;
        if fd >= 0 {
            if matches(who) {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    fd,
                    libc::SIGKILL,
                    std::ptr::null::<libc::siginfo_t>(),
                    0,
                );
            }
            libc::close(fd);
        }
    }
}
#[derive(Serialize, Deserialize)]
struct Record {
    boot: String,
    owner: Identity,
    tracer: Identity,
    members: Vec<Identity>,
}
fn boot() -> Result<String> {
    Ok(fs::read_to_string("/proc/sys/kernel/random/boot_id")?)
}
fn save(path: &Path, record: &Record) -> Result<()> {
    let _lock = lock(path.parent().unwrap())?;
    let tmp = path.with_extension("tmp");
    let mut f = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(&tmp)?;
    f.write_all(&serde_json::to_vec(record)?)?;
    f.sync_all()?;
    fs::rename(tmp, path)?;
    File::open(path.parent().unwrap())?.sync_all()?;
    Ok(())
}
struct JournalLock(File);
impl Drop for JournalLock {
    fn drop(&mut self) {
        // A forked command may hold this file description while stopped
        // before exec. Closing our descriptor alone would keep the lock held.
        let _ = FileExt::unlock(&self.0);
    }
}

fn lock(root: &Path) -> Result<JournalLock> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(root.join(".lock"))?;
    file.lock_exclusive()?;
    Ok(JournalLock(file))
}
pub fn prepare(root: &Path) -> Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(root)?;
    let _lock = lock(root)?;
    let boot = boot()?;
    for entry in fs::read_dir(root)? {
        let path = entry?.path();
        if path.extension().is_some_and(|e| e == "tmp") {
            fs::remove_file(path)?;
            continue;
        }
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        let record: Record = serde_json::from_slice(&fs::read(&path)?)?;
        if record.boot == boot && matches(&record.owner) && matches(&record.tracer) {
            continue;
        }
        if record.boot == boot {
            for member in &record.members {
                kill(member);
            }
            for _ in 0..500 {
                if !record.members.iter().any(matches) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            ensure!(
                !record.members.iter().any(matches),
                "cannot clean interrupted command; environment lost"
            );
        }
        fs::remove_file(path)?;
    }
    Ok(())
}

pub struct Command {
    pub stdout: Option<tokio::net::UnixStream>,
    pub stderr: Option<tokio::net::UnixStream>,
    pub done: tokio::sync::oneshot::Receiver<Result<ExitStatus>>,
    control: Option<mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Command {
    pub fn stop(&mut self) {
        self.control.take();
    }
    pub fn join(&mut self) -> Result<()> {
        if let Some(thread) = self.thread.take() {
            thread
                .join()
                .map_err(|_| anyhow!("command tracer panicked"))?;
        }
        Ok(())
    }
}
impl Drop for Command {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn spawn(root: &Path, project: &Path, command: &str, keep_background: bool) -> Result<Command> {
    let (out, out_child) = UnixStream::pair()?;
    let (err, err_child) = UnixStream::pair()?;
    out.set_nonblocking(true)?;
    err.set_nonblocking(true)?;
    let (control, receiver) = mpsc::channel();
    let (sender, done) = tokio::sync::oneshot::channel();
    let root = root.to_owned();
    let project = project.to_owned();
    let command = command.to_owned();
    let thread = std::thread::Builder::new()
        .name("command-tracer".into())
        .spawn(move || {
            let mut sender = Some(sender);
            let result = trace(
                &root,
                &project,
                &command,
                out_child,
                err_child,
                receiver,
                &mut sender,
                keep_background,
            );
            if let Some(sender) = sender {
                let _ = sender.send(result);
            }
        })?;
    Ok(Command {
        stdout: Some(tokio::net::UnixStream::from_std(out)?),
        stderr: Some(tokio::net::UnixStream::from_std(err)?),
        done,
        control: Some(control),
        thread: Some(thread),
    })
}
fn ptrace(request: libc::c_uint, pid: i32, data: usize) -> Result<()> {
    ensure!(
        unsafe { libc::ptrace(request, pid, 0usize, data) } >= 0,
        "ptrace failed: {}",
        std::io::Error::last_os_error()
    );
    Ok(())
}
struct TraceSet {
    members: BTreeMap<i32, Identity>,
}
impl Drop for TraceSet {
    fn drop(&mut self) {
        for member in self.members.values() {
            kill(member);
        }
        // Error and cancellation paths also reap. EXITKILL remains the final
        // kernel backstop if this thread itself dies before Drop runs.
        for _ in 0..500 {
            self.members.retain(|pid, _| {
                let mut status = 0;
                let n = unsafe { libc::waitpid(*pid, &mut status, libc::__WALL | libc::WNOHANG) };
                if n > 0 && libc::WIFSTOPPED(status) {
                    let _ = ptrace(libc::PTRACE_CONT, *pid, libc::SIGKILL as usize);
                    true
                } else {
                    n == 0
                }
            });
            if self.members.is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}
#[allow(clippy::too_many_arguments)]
fn trace(
    root: &Path,
    project: &Path,
    command: &str,
    out: UnixStream,
    err: UnixStream,
    receiver: mpsc::Receiver<()>,
    done: &mut Option<tokio::sync::oneshot::Sender<Result<ExitStatus>>>,
    keep_background: bool,
) -> Result<ExitStatus> {
    // Prepare all allocation and environment access before fork. The child uses
    // only async-signal-safe syscalls until exec; no Rust destructors or locks.
    let program = CString::new("/bin/bash")?;
    let project = CString::new(project.as_os_str().as_bytes())?;
    let args = ["bash", "--noprofile", "--norc", "-c", command]
        .iter()
        .map(|s| CString::new(*s))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut argv = args.iter().map(|s| s.as_ptr()).collect::<Vec<_>>();
    argv.push(std::ptr::null());
    let env = std::env::vars_os()
        .map(|(k, v)| {
            let mut item = k.as_bytes().to_vec();
            item.push(b'=');
            item.extend(v.as_bytes());
            CString::new(item)
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut envp = env.iter().map(|s| s.as_ptr()).collect::<Vec<_>>();
    envp.push(std::ptr::null());
    let null = File::open("/dev/null")?;
    let parent = std::process::id() as i32;
    let tid = unsafe { libc::syscall(libc::SYS_gettid) } as i32;
    let mut record = Record {
        boot: boot()?,
        owner: identity(parent)
            .ok_or_else(|| anyhow!("missing agent identity"))?
            .0,
        tracer: identity(tid)
            .ok_or_else(|| anyhow!("missing tracer identity"))?
            .0,
        members: vec![],
    };
    let path = root.join(format!("{}.json", id()));
    let mut set = TraceSet {
        members: BTreeMap::new(),
    };
    let pid = unsafe { libc::fork() };
    ensure!(pid >= 0, "fork failed");
    if pid == 0 {
        unsafe {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) < 0
                || libc::getppid() != parent
            {
                libc::_exit(126);
            }
            if libc::dup2(null.as_raw_fd(), 0) < 0
                || libc::dup2(out.as_raw_fd(), 1) < 0
                || libc::dup2(err.as_raw_fd(), 2) < 0
                || libc::chdir(project.as_ptr()) < 0
            {
                libc::_exit(126);
            }
            libc::setpgid(0, 0);
            if libc::ptrace(libc::PTRACE_TRACEME, 0, 0usize, 0usize) < 0 {
                libc::_exit(126);
            }
            libc::raise(libc::SIGSTOP);
            libc::execve(program.as_ptr(), argv.as_ptr(), envp.as_ptr());
            libc::_exit(127);
        }
    }
    drop(out);
    drop(err);
    let who = identity(pid)
        .ok_or_else(|| anyhow!("missing command identity"))?
        .0;
    set.members.insert(pid, who);
    let mut status = 0;
    ensure!(
        unsafe { libc::waitpid(pid, &mut status, libc::__WALL) } == pid && libc::WIFSTOPPED(status),
        "cannot establish command containment"
    );
    let options = libc::PTRACE_O_EXITKILL
        | libc::PTRACE_O_TRACEFORK
        | libc::PTRACE_O_TRACEVFORK
        | libc::PTRACE_O_TRACECLONE
        | libc::PTRACE_O_TRACEEXEC;
    ptrace(libc::PTRACE_SETOPTIONS, pid, options as usize)?;
    record.members = set.members.values().cloned().collect();
    save(&path, &record)?;
    ptrace(libc::PTRACE_CONT, pid, 0)?;
    let mut root_status = None;
    let mut stopping = false;
    let mut exited = vec![];
    while !set.members.is_empty() {
        if receiver.try_recv() != Err(mpsc::TryRecvError::Empty) {
            stopping = true;
        }
        if stopping {
            for who in set.members.values() {
                kill(who);
            }
        }
        // __WNOTHREAD prevents concurrent tracers (or Tokio) stealing these waits.
        let n = unsafe {
            libc::waitpid(
                -1,
                &mut status,
                libc::__WALL | libc::__WNOTHREAD | libc::WNOHANG,
            )
        };
        if n < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            bail!("command wait failed: {error}");
        }
        if n == 0 {
            std::thread::sleep(Duration::from_millis(1));
            continue;
        }
        if libc::WIFEXITED(status) || libc::WIFSIGNALED(status) {
            if n == pid {
                root_status = Some(status);
                if keep_background && !stopping && libc::WIFEXITED(status) {
                    if let Some(sender) = done.take() {
                        let _ = sender.send(Ok(ExitStatus::from_raw(status)));
                    }
                } else {
                    stopping = true;
                }
            }
            set.members.remove(&n);
            exited.push(n);
            continue;
        }
        if !libc::WIFSTOPPED(status) {
            continue;
        }
        if let std::collections::btree_map::Entry::Vacant(entry) = set.members.entry(n) {
            entry.insert(
                identity(n)
                    .ok_or_else(|| anyhow!("missing descendant identity"))?
                    .0,
            );
        }
        let event = status >> 16;
        if [
            libc::PTRACE_EVENT_FORK,
            libc::PTRACE_EVENT_VFORK,
            libc::PTRACE_EVENT_CLONE,
        ]
        .contains(&event)
        {
            let mut child = 0usize;
            ensure!(
                unsafe { libc::ptrace(libc::PTRACE_GETEVENTMSG, n, 0usize, &mut child) } >= 0,
                "cannot find descendant"
            );
            set.members.insert(
                child as i32,
                identity(child as i32)
                    .ok_or_else(|| anyhow!("missing fork identity"))?
                    .0,
            );
        } else if event == libc::PTRACE_EVENT_EXEC {
            let mut former = 0usize;
            ensure!(
                unsafe { libc::ptrace(libc::PTRACE_GETEVENTMSG, n, 0usize, &mut former) } >= 0,
                "cannot find exec identity"
            );
            if former as i32 != n {
                set.members.remove(&(former as i32));
            }
            set.members.insert(
                n,
                identity(n)
                    .ok_or_else(|| anyhow!("missing exec identity"))?
                    .0,
            );
        }
        record.members = set.members.values().cloned().collect();
        save(&path, &record)?;
        let signal = libc::WSTOPSIG(status);
        // Creation SIGSTOPs and ptrace events are not program-delivered signals.
        let signal = if stopping {
            libc::SIGKILL
        } else if event != 0 || signal == libc::SIGSTOP {
            0
        } else {
            signal
        };
        if let Err(error) = ptrace(libc::PTRACE_CONT, n, signal as usize) {
            if matches!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH)
            ) {
                continue;
            }
            return Err(error);
        }
    }
    // Traced grandchildren can also become ordinary subreaper children. Reap
    // those by exact PID, never consume another command's wait status.
    for pid in exited {
        unsafe {
            libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG);
        }
    }
    let _lock = lock(root)?;
    fs::remove_file(path)?;
    Ok(ExitStatus::from_raw(
        root_status.ok_or_else(|| anyhow!("missing shell status"))?,
    ))
}
