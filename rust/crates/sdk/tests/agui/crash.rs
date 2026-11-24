//! Kill the process on either side of the write that follows transport release.
//! The other crash boundaries (including an accepted report before continuation)
//! are covered by the shared AG-UI kit.
use super::*;
use std::{
    io::{BufRead, BufReader},
    process::{Child, ChildStdout, Command, Stdio},
};

struct Boundary(&'static str);
impl log::Log for Boundary {
    fn enabled(&self, m: &log::Metadata<'_>) -> bool {
        m.target() == self.0
    }
    fn log(&self, r: &log::Record<'_>) {
        if self.enabled(r.metadata()) {
            println!("BOUNDARY");
            loop {
                std::thread::park();
            }
        }
    }
    fn flush(&self) {}
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn child_listener() -> anyhow::Result<()> {
    let Ok(dir) = std::env::var("AGUI_CRASH_TEST_DIR") else {
        return Ok(());
    };
    let dir = Path::new(&dir);
    let target = match std::env::var("AGUI_CRASH_AT").as_deref() {
        Ok("release") => "modular_agent::agui::terminal_released",
        Ok("record") => "modular_agent::agui::terminal_recorded",
        _ => "",
    };
    log::set_logger(Box::leak(Box::new(Boundary(target)))).unwrap();
    log::set_max_level(log::LevelFilter::Debug);
    let agent = Agent::builder()
        .project(dir)
        .data_dir(dir.join("data"))
        .durability(modular_agent::Durability::Kept)
        .provider(scripted_provider(json!([{"text":"Done."}])))
        .build()
        .await?;
    let server = serve(&agent, dir).await?;
    println!("ORIGIN {}", server.url);
    std::future::pending().await
}
struct Process(Child, BufReader<ChildStdout>);
impl Process {
    fn start(dir: &Path, at: &str) -> anyhow::Result<(Self, String)> {
        let mut p = Command::new(std::env::current_exe()?)
            .args(["--exact", "crash::child_listener", "--nocapture"])
            .env_clear()
            .env("HOME", dir)
            .env("PATH", std::env::var_os("PATH").unwrap())
            .env("TMPDIR", std::env::temp_dir())
            .env("AGUI_CRASH_TEST_DIR", dir)
            .env("AGUI_CRASH_AT", at)
            .stdout(Stdio::piped())
            .spawn()?;
        let reader = BufReader::new(p.stdout.take().unwrap());
        let mut p = Self(p, reader);
        let origin = p.line("ORIGIN ")?;
        Ok((p, origin))
    }
    fn line(&mut self, tag: &str) -> anyhow::Result<String> {
        for line in (&mut self.1).lines() {
            if let Some((_, value)) = line?.split_once(tag) {
                return Ok(value.into());
            }
        }
        anyhow::bail!("child closed before {tag}")
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn receipt_distinguishes_release_from_recording_across_sigkill() -> anyhow::Result<()> {
    for (at, expected) in [("release", "unknown"), ("record", "success")] {
        let dir = tempfile::tempdir()?;
        let (mut server, origin) = Process::start(dir.path(), at)?;
        let http = reqwest::Client::new();
        let t: Value = http
            .post(format!("{origin}/agui/v1/threads"))
            .bearer_auth(TOKEN)
            .json(&json!({}))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let id = t["threadId"].as_str().unwrap();
        let request = input(id, "one", json!("Finish."));
        let run = tokio::spawn(async move {
            let response = reqwest::Client::new()
                .post(format!("{origin}/agui/v1/run"))
                .bearer_auth(TOKEN)
                .json(&request)
                .send()
                .await?;
            response.bytes().await
        });
        server.line("BOUNDARY")?;
        drop(server);
        let _ = run.await?;
        let (_server, origin) = Process::start(dir.path(), "")?;
        // No snapshot first: this read cannot depend on reopening a writer.
        let receipt: Value = http
            .get(format!(
                "{origin}/agui/v1/threads/{id}/run-receipt?runId=one"
            ))
            .bearer_auth(TOKEN)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        assert_eq!(receipt, json!({"terminal":expected,"work":"completed"}));
    }
    Ok(())
}
