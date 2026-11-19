use agent_api::*;
use agent_harness::Harness;
use history_fs::HistoryPlugin;
use std::sync::Arc;
use tempfile::TempDir;
#[tokio::test]
async fn a_concurrent_fork_does_not_spuriously_keep_a_closed_session_locked() {
    use std::{
        io::Read,
        os::{
            fd::AsRawFd,
            unix::{net::UnixStream, process::CommandExt},
        },
    };
    let root = TempDir::new().unwrap();
    let p = TempDir::new().unwrap();
    let h = harness(root.path()).await;
    let id = h.create(p.path(), json!({})).await.unwrap();
    h.append(
        &Scope::session(&id),
        "test",
        Draft::new("input", true, json!({})),
    )
    .unwrap();
    let (mut receiver, sender) = UnixStream::pair().unwrap();
    let fd = sender.as_raw_fd();
    let child = std::thread::spawn(move || {
        let mut command = std::process::Command::new("true");
        // Test-only, allocation-free post-fork probe. The child inherits the
        // listener until exec closes CLOEXEC descriptors.
        unsafe {
            command.pre_exec(move || {
                libc::write(fd, b"x".as_ptr().cast(), 1);
                libc::usleep(100_000);
                Ok(())
            });
        }
        let result = command.spawn().and_then(|mut child| child.wait());
        drop(sender);
        result.unwrap()
    });
    receiver.read_exact(&mut [0u8; 1]).unwrap();
    h.close(&id).await.unwrap();
    let reopened = h.open(&id).await;
    assert!(child.join().unwrap().success());
    reopened.expect("CLOEXEC inheritance should be transient, not a conflicting writer");
}
async fn harness(root: &std::path::Path) -> Arc<Harness> {
    let h = Harness::new();
    h.load(Arc::new(HistoryPlugin { root: root.into() }))
        .await
        .unwrap();
    h
}
#[tokio::test]
async fn unused_session_has_no_store_artifact() {
    let root = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();
    let h = harness(root.path()).await;
    let id = h
        .create(project.path(), json!({"model":"test"}))
        .await
        .unwrap();
    assert_eq!(h.snapshot(&id).unwrap().settings["model"], "test");
    h.close(&id).await.unwrap();
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}
#[tokio::test]
async fn history_branches_position_and_project_lists_survive_reopen() {
    let root = TempDir::new().unwrap();
    let p = TempDir::new().unwrap();
    let q = TempDir::new().unwrap();
    let h = harness(root.path()).await;
    let id = h.create(p.path(), json!({})).await.unwrap();
    let scope = Scope::session(&id);
    let a = h
        .append(
            &scope,
            "test",
            Draft::new("input", true, json!({"text":"first"})),
        )
        .unwrap();
    let b = h
        .append(
            &scope,
            "test",
            Draft::new("input", true, json!({"text":"abandoned"})),
        )
        .unwrap();
    h.move_position(&scope, Some(a.id.clone())).unwrap();
    let c = h
        .append(
            &scope,
            "test",
            Draft::new("input", true, json!({"text":"new branch"})),
        )
        .unwrap();
    let fork = h.fork(&scope, Some(a.id.clone())).unwrap();
    let other = h.create(q.path(), json!({})).await.unwrap();
    h.append(
        &Scope::session(&other),
        "test",
        Draft::new("input", true, json!({})),
    )
    .unwrap();
    assert_eq!(h.list(Some(p.path())).unwrap().len(), 2);
    assert_eq!(h.list(None).unwrap().len(), 3);
    h.close(&id).await.unwrap();
    h.close(&fork).await.unwrap();
    drop(h);
    let h = harness(root.path()).await;
    h.open(&id).await.unwrap();
    let data = h.snapshot(&id).unwrap();
    assert_eq!(data.position, Some(c.id));
    assert_eq!(data.entries.len(), 5);
    assert!(!data.branch().iter().any(|e| e.id == b.id));
    assert!(!data.branch().iter().any(|e| e.kind == "position"));
    assert!(data.entries.iter().any(|e| e.kind == "position"));
    h.open(&fork).await.unwrap();
    assert_eq!(
        h.snapshot(&fork)
            .unwrap()
            .branch()
            .iter()
            .filter(|e| e.visible)
            .count(),
        1
    );
}
#[tokio::test]
async fn erasure_removes_original_summary_fork_and_copies_of_copies_from_disk() {
    let root = TempDir::new().unwrap();
    let p = TempDir::new().unwrap();
    let h = harness(root.path()).await;
    let id = h.create(p.path(), json!({})).await.unwrap();
    let scope = Scope::session(&id);
    let a = h
        .append(
            &scope,
            "test",
            Draft::new("input", true, json!({"text":"PRIVATE-173"})),
        )
        .unwrap();
    let b = h
        .append(
            &scope,
            "test",
            Draft::new("summary", true, json!({"text":"PRIVATE-173 summary"}))
                .copying(vec![a.id.clone()]),
        )
        .unwrap();
    h.append(
        &scope,
        "test",
        Draft::new("summary", true, json!({"text":"PRIVATE-173 again"})).copying(vec![b.id]),
    )
    .unwrap();
    let fork = h.fork(&scope, None).unwrap();
    let erased = h.erase(&scope, vec![a.id]).await.unwrap();
    assert_eq!(erased.erased.len(), 6);
    let fork_data = h.snapshot(&fork).unwrap();
    let erased_entries = fork_data
        .entries
        .iter()
        .filter(|e| e.content.is_none())
        .collect::<Vec<_>>();
    assert_eq!(erased_entries.len(), 3);
    assert_eq!(erased_entries[0].kind, "input");
    assert_eq!(fork_data.entries.last().unwrap().kind, "erasure");
    for entry in std::fs::read_dir(root.path()).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|x| x == "json") {
            assert!(
                !std::fs::read_to_string(path)
                    .unwrap()
                    .contains("PRIVATE-173")
            );
        }
    }
}
// This helper runs only in a fresh exec, so it cannot share the parent's lease.
#[tokio::test]
async fn writer_process_helper() {
    use std::io::Read;
    let Ok(root) = std::env::var("LEASE_TEST_ROOT") else {
        return;
    };
    let id = std::env::var("LEASE_TEST_SESSION").unwrap();
    let h = harness(std::path::Path::new(&root)).await;
    h.open(&id).await.unwrap();
    std::fs::write(std::path::Path::new(&root).join("ready"), b"held").unwrap();
    std::io::stdin().read_to_end(&mut Vec::new()).unwrap();
    std::hint::black_box(&h);
    // No close or destructor: prove the OS releases the lease on process exit.
    std::process::exit(0);
}

#[tokio::test]
async fn writer_lease_refuses_a_second_process_and_releases_on_process_exit() {
    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let root = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();
    let h = harness(root.path()).await;
    let id = h.create(project.path(), json!({})).await.unwrap();
    h.append(
        &Scope::session(&id),
        "test",
        Draft::new("input", true, json!({})),
    )
    .unwrap();
    h.close(&id).await.unwrap();
    let mut child = Child(
        std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "writer_process_helper", "--nocapture"])
            .env("LEASE_TEST_ROOT", root.path())
            .env("LEASE_TEST_SESSION", &id)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !root.path().join("ready").exists() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "holder exited before acquiring"
            );
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let error = h.open(&id).await.unwrap_err();
    assert!(error.to_string().contains("already held by another writer"));
    drop(child.0.stdin.take());
    assert!(child.0.wait().unwrap().success());
    h.open(&id).await.unwrap();
    h.close(&id).await.unwrap();
}

#[tokio::test]
async fn writer_lease_refuses_a_second_harness_and_releases_on_close() {
    let root = TempDir::new().unwrap();
    let p = TempDir::new().unwrap();
    let a = harness(root.path()).await;
    let b = harness(root.path()).await;
    let id = a.create(p.path(), json!({})).await.unwrap();
    a.append(
        &Scope::session(&id),
        "test",
        Draft::new("input", true, json!({})),
    )
    .unwrap();
    assert!(b.open(&id).await.is_err());
    a.close(&id).await.unwrap();
    b.open(&id).await.unwrap();
}
