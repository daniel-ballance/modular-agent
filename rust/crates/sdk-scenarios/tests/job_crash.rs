use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
};

#[tokio::test]
async fn a_served_job_resumes_through_session_start_after_sigkill() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let dir = tempfile::tempdir().unwrap();
        let program = env!("CARGO_BIN_EXE_sdk-job-test-agent");
        let mut crashed = Command::new(program)
            .arg("crash")
            .arg(dir.path())
            .env_remove("MODULAR_AGENT_PLUGINS")
            .process_group(0)
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let id = BufReader::new(crashed.stdout.take().unwrap())
            .lines()
            .next_line()
            .await
            .unwrap()
            .unwrap();
        let group = crashed.id().unwrap() as i32;
        // Kill the run and its owning plugin, not just the writer.
        assert_eq!(unsafe { libc::kill(-group, libc::SIGKILL) }, 0);
        assert!(!crashed.wait().await.unwrap().success());
        assert!(
            Command::new(program)
                .arg("reopen")
                .arg(dir.path())
                .arg(id)
                .env_remove("MODULAR_AGENT_PLUGINS")
                .kill_on_drop(true)
                .status()
                .await
                .unwrap()
                .success()
        );
    })
    .await
    .expect("job crash test stalled");
}
