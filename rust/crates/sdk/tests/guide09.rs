use std::{
    net::SocketAddr,
    path::Path,
    time::{Duration, Instant},
};

use modular_agent::{
    Agent, Durability, Result, ServeHistoryOptions, file_history, http_history, serve_history,
    testing::scripted_provider,
};
use serde_json::json;

#[path = "guide09/handoff_faults.rs"]
mod handoff_faults;

struct Stages {
    pending: &'static str,
    since: Instant,
    completed: Vec<(&'static str, Duration)>,
}

impl Stages {
    fn new(pending: &'static str) -> Self {
        Self {
            pending,
            since: Instant::now(),
            completed: Vec::new(),
        }
    }

    fn stage(&mut self, pending: &'static str) {
        let now = Instant::now();
        self.completed.push((self.pending, now - self.since));
        self.pending = pending;
        self.since = now;
    }

    fn diagnostic(&self) -> String {
        format!(
            "pending {} for {:?}; completed {:?}",
            self.pending,
            self.since.elapsed(),
            self.completed
        )
    }
}

async fn serve_store(address: SocketAddr, store_dir: &Path, token_file: &Path) -> Result<()> {
    let options = ServeHistoryOptions::new(address, token_file);
    serve_history(file_history(store_dir)?, options).await
}

async fn connect_history(
    project: &Path,
    data_dir: &Path,
    url: &str,
    token_file: &Path,
) -> Result<Agent> {
    Agent::builder()
        .project(project)
        .data_dir(data_dir)
        .durability(Durability::Kept)
        .history(http_history(url, token_file)?)
        .provider(scripted_provider(
            json!([{ "text": "Whitby." }, { "text": "14:02." }]),
        ))
        .model("scripted/script")
        .build()
        .await
}

async fn handoff(
    project: &Path,
    writer_dir: &Path,
    reader_dir: &Path,
    url: &str,
    token_file: &Path,
    stages: &mut Stages,
) -> Result<()> {
    stages.stage("build writer");
    let writer = connect_history(project, writer_dir, url, token_file).await?;
    stages.stage("create writer session");
    let first = writer.session().await?;
    stages.stage("prompt writer");
    assert_eq!(first.prompt("Name a harbour.").await?.text, "Whitby.");
    let id = first.id().to_owned();
    stages.stage("close writer");
    writer.close().await?; // Give up the writer lease.

    stages.stage("build reader");
    let reader = connect_history(project, reader_dir, url, token_file).await?;
    stages.stage("open session on reader");
    let reopened = reader.open_session(&id).await?;
    stages.stage("read replayed turn");
    assert_eq!(reopened.last_turn().await?.unwrap().text, "Whitby.");
    stages.stage("prompt reader");
    assert_eq!(
        reopened.prompt("When is high tide there?").await?.text,
        "14:02."
    );
    stages.stage("read durable history");
    let history = reopened.history().await?;
    let actors: Vec<_> = history
        .iter()
        .filter(|entry| entry["kind"] == "input")
        .map(|entry| entry["actorId"].as_str())
        .collect();
    assert_eq!(actors, [Some("user"), Some("user")]);
    stages.stage("close reader");
    reader.close().await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hands_off_a_session_over_http() -> Result<()> {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};

    let tmp = tempfile::tempdir()?;
    let project = tempfile::tempdir_in(tmp.path())?;
    let token_file = tmp.path().join("token");
    // A disposable token for this isolated loopback test.
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&token_file)?
        .write_all(b"guide09-test-token-not-for-deployment\n")?;

    let reserved = std::net::TcpListener::bind("127.0.0.1:0")?;
    let address = reserved.local_addr()?;
    drop(reserved);
    let store_dir = tmp.path().join("history");
    // The HTTP client also makes blocking calls, so serve on a separate task
    // on the multi-thread runtime, not inside the handoff future.
    let mut service = tokio::task::JoinSet::new();
    let server_token_file = token_file.clone();
    service.spawn(async move { serve_store(address, &store_dir, &server_token_file).await });
    let mut stages = Stages::new("history listener readiness");
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        let run = async {
            while tokio::net::TcpStream::connect(address).await.is_err() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            handoff(
                project.path(),
                &tmp.path().join("writer"),
                &tmp.path().join("reader"),
                &format!("http://{address}"),
                &token_file,
                &mut stages,
            )
            .await
        };
        tokio::select! {
            result = service.join_next() => panic!("history service exited early: {result:?}"),
            result = run => result,
        }
    })
    .await
    .unwrap_or_else(|_| panic!("history handoff timed out: {}", stages.diagnostic()));
    service.shutdown().await;
    if let Err(error) = &result {
        panic!("history handoff failed: {error:?}; {}", stages.diagnostic());
    }
    result
}
