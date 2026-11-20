use std::{net::SocketAddr, path::Path, time::Duration};

use modular_agent::{
    Agent, Durability, Result, ServeHistoryOptions, file_history, http_history, serve_history,
    testing::scripted_provider,
};
use serde_json::json;

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
) -> Result<()> {
    let writer = connect_history(project, writer_dir, url, token_file).await?;
    let first = writer.session().await?;
    assert_eq!(first.prompt("Name a harbour.").await?.text, "Whitby.");
    let id = first.id().to_owned();
    writer.close().await?; // Give up the writer lease.

    let reader = connect_history(project, reader_dir, url, token_file).await?;
    let reopened = reader.open_session(&id).await?;
    assert_eq!(reopened.last_turn()?.unwrap().text, "Whitby.");
    assert_eq!(
        reopened.prompt("When is high tide there?").await?.text,
        "14:02."
    );
    let history = reopened.history()?;
    let actors: Vec<_> = history
        .iter()
        .filter(|entry| entry["kind"] == "input")
        .map(|entry| entry["actorId"].as_str())
        .collect();
    assert_eq!(actors, [Some("user"), Some("user")]);
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
        )
        .await
    };
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::select! {
            result = service.join_next() => panic!("history service exited early: {result:?}"),
            result = run => result,
        }
    })
    .await
    .expect("history handoff timed out");
    service.shutdown().await;
    result
}
