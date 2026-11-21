use modular_agent::{
    Durability, ServeHistoryOptions, file_history, http_history, listen_history,
    testing::test_agent,
};
use serde_json::json;
use std::{io::Write, os::unix::fs::OpenOptionsExt};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn raw_history_isolated_by_instance_credential_and_namespace() -> modular_agent::Result<()> {
    let root = tempfile::tempdir()?;
    let token = |name: &str, body: &str| -> std::io::Result<_> {
        let path = root.path().join(name);
        writeln!(
            std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&path)?,
            "{body}"
        )?;
        Ok(path)
    };
    let ka = token("a-token", "fc9116d07384683ab140257f2bf05c91")?;
    let kb = token("b-token", "f81c5e67c8b165274992a752d04ef3d2")?;
    let addr = "127.0.0.1:0".parse().unwrap();
    let a = listen_history(
        file_history(root.path().join("a"))?,
        ServeHistoryOptions::new(addr, &ka),
    )
    .await?;
    let b = listen_history(
        file_history(root.path().join("b"))?,
        ServeHistoryOptions::new(addr, &kb),
    )
    .await?;
    let store = http_history(&b.url, &kb)?;
    let agent = test_agent()
        .project(root.path())
        .durability(Durability::Kept)
        .history(store.clone())
        .script(json!([{"text":"stored only on B"}]))
        .build()
        .await?;
    let session = agent.session().await?;
    session.prompt("seed").await?;
    let id = session.id().to_owned();
    assert_eq!(agent.declaration()?["erasure"], true);
    let client = reqwest::Client::new();
    let unauthorized = client
        .get(format!("{}/v1", b.url))
        .bearer_auth(std::fs::read_to_string(&ka)?.trim())
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized.status().as_u16(), 401);
    let other = http_history(&a.url, &ka)?;
    assert!(other.sessions(None)?.is_empty());
    assert!(other.session_info(&id).is_err());
    assert_eq!(store.session_info(&id)?.id, id);
    agent.close().await?;
    a.close().await;
    b.close().await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_registry_stays_unavailable_after_restart() -> modular_agent::Result<()> {
    let root = tempfile::tempdir()?;
    let token = "Y7lSWvfTrVXoqDjufeu2ARTGQcHBq9w";
    let token_file = root.path().join("token");
    std::fs::write(&token_file, token)?;
    let dir = root.path().join("history");
    let opts = || ServeHistoryOptions::new("127.0.0.1:0".parse().unwrap(), &token_file);
    let server = listen_history(file_history(&dir)?, opts()).await?;
    let client = reqwest::Client::new();
    assert!(
        client
            .put(format!("{}/v1/sessions/known", server.url))
            .bearer_auth(token)
            .json(&json!({"project":"/","created":0}))
            .send()
            .await
            .unwrap()
            .status()
            .is_success()
    );
    let read_plans = |url: &str| {
        client
            .get(format!("{url}/v1/sessions/known/pending-erasure"))
            .bearer_auth(token)
    };
    assert!(
        read_plans(&server.url)
            .send()
            .await
            .unwrap()
            .status()
            .is_success()
    );
    let control = dir.join("history-service-control-v1.json");
    std::fs::remove_file(&control)?;
    let reply = read_plans(&server.url).send().await.unwrap();
    assert_eq!(reply.status(), 503);
    assert_eq!(
        reply.json::<serde_json::Value>().await.unwrap()["code"],
        "unavailable"
    );
    server.close().await;

    let restarted = listen_history(file_history(&dir)?, opts()).await?;
    let reply = read_plans(&restarted.url).send().await.unwrap();
    assert_eq!(reply.status(), 503);
    assert_eq!(
        reply.json::<serde_json::Value>().await.unwrap()["code"],
        "unavailable"
    );
    assert!(!control.exists());
    restarted.close().await;
    Ok(())
}
