use super::*;
use tempfile::TempDir;

struct Child(std::process::Child);
impl Drop for Child {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn child() -> Child {
    Child(
        std::process::Command::new("sleep")
            .arg("60")
            .spawn()
            .unwrap(),
    )
}
#[test]
fn releasing_the_journal_lock_does_not_wait_for_a_forked_child_to_exec() {
    let root = TempDir::new().unwrap();
    let held = lock(root.path()).unwrap();
    let (parent, child) = UnixStream::pair().unwrap();
    let pid = unsafe { libc::fork() };
    assert!(pid >= 0);
    if pid == 0 {
        // Model the command's pre-exec stop. The child holds the inherited
        // lock descriptor until its parent lets it proceed.
        unsafe {
            libc::close(parent.as_raw_fd());
            let mut byte = 0u8;
            libc::read(child.as_raw_fd(), (&mut byte as *mut u8).cast(), 1);
            libc::_exit(0);
        }
    }
    drop(child);
    drop(held);
    let lock_file = File::open(root.path().join(".lock")).unwrap();
    let acquired = lock_file.try_lock_exclusive();
    drop(parent);
    let mut status = 0;
    assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
    assert!(libc::WIFEXITED(status));
    acquired.expect("a child waiting to exec kept the journal locked");
}

fn self_identity() -> Identity {
    identity(std::process::id() as i32).unwrap().0
}
fn dead_tracer() -> Identity {
    std::thread::spawn(|| {
        identity(unsafe { libc::syscall(libc::SYS_gettid) } as i32)
            .unwrap()
            .0
    })
    .join()
    .unwrap()
}
#[test]
fn startup_cleanup_kills_a_live_survivor_of_a_lost_stopper() {
    let root = TempDir::new().unwrap();
    prepare(root.path()).unwrap();
    let mut child = child();
    let record = Record {
        boot: boot().unwrap(),
        owner: self_identity(),
        tracer: dead_tracer(),
        members: vec![identity(child.0.id() as i32).unwrap().0],
    };
    let path = root.path().join("lost.json");
    save(&path, &record).unwrap();
    assert!(matches(&record.members[0]));
    prepare(root.path()).unwrap();
    assert!(!child.0.wait().unwrap().success());
    assert!(!path.exists());
}
#[test]
fn startup_cleanup_never_kills_a_reused_pid_or_an_active_command() {
    let root = TempDir::new().unwrap();
    prepare(root.path()).unwrap();
    let mut child = child();
    let mut member = identity(child.0.id() as i32).unwrap().0;
    member.start = "not-this-process".into();
    let path = root.path().join("reused.json");
    save(
        &path,
        &Record {
            boot: boot().unwrap(),
            owner: self_identity(),
            tracer: dead_tracer(),
            members: vec![member],
        },
    )
    .unwrap();
    prepare(root.path()).unwrap();
    assert!(child.0.try_wait().unwrap().is_none());
    save(
        &path,
        &Record {
            boot: boot().unwrap(),
            owner: self_identity(),
            tracer: self_identity(),
            members: vec![identity(child.0.id() as i32).unwrap().0],
        },
    )
    .unwrap();
    prepare(root.path()).unwrap();
    assert!(path.exists());
    assert!(child.0.try_wait().unwrap().is_none());
}
#[test]
fn kernel_exitkill_stops_a_command_when_its_tracer_thread_dies_then_startup_cleans_the_record() {
    let root = TempDir::new().unwrap();
    prepare(root.path()).unwrap();
    let path = root.path().join("tracer-died.json");
    let journal = path.clone();
    let who = std::thread::spawn(move || {
        let tracer = identity(unsafe { libc::syscall(libc::SYS_gettid) } as i32)
            .unwrap()
            .0;
        let parent = std::process::id() as i32;
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0);
        if pid == 0 {
            unsafe {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0);
                if libc::getppid() != parent {
                    libc::_exit(126);
                }
                libc::ptrace(libc::PTRACE_TRACEME, 0, 0usize, 0usize);
                libc::raise(libc::SIGSTOP);
                loop {
                    libc::pause();
                }
            }
        }
        let who = identity(pid).unwrap().0;
        let mut guard = TraceSet {
            members: BTreeMap::from([(pid, who.clone())]),
        };
        let mut status = 0;
        assert_eq!(
            unsafe { libc::waitpid(pid, &mut status, libc::__WALL) },
            pid
        );
        ptrace(
            libc::PTRACE_SETOPTIONS,
            pid,
            libc::PTRACE_O_EXITKILL as usize,
        )
        .unwrap();
        save(
            &journal,
            &Record {
                boot: boot().unwrap(),
                owner: self_identity(),
                tracer,
                members: vec![who.clone()],
            },
        )
        .unwrap();
        ptrace(libc::PTRACE_CONT, pid, 0).unwrap();
        // Deliberately omit userspace cleanup. Exiting this thread must be enough.
        guard.members.clear();
        who
    })
    .join()
    .unwrap();
    for _ in 0..500 {
        if !matches(&who) {
            break;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(!matches(&who), "kernel did not enforce exit-kill");
    unsafe {
        libc::waitpid(who.pid, std::ptr::null_mut(), 0);
    }
    assert!(path.exists());
    prepare(root.path()).unwrap();
    assert!(!path.exists());
}
