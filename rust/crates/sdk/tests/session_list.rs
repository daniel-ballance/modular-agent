//! docs/reference/standard-configuration.md, "Listing sessions", and docs/sdk/api.md,
//! `sessions` and `sessionInfo`: an erased entry has no time, so a session whose last
//! entry is erased has no last activity and lists with the sessions that have no entries.
use modular_agent::{
    Durability, HistoryStore, ServeHistoryOptions, file_history, http_history, listen_history,
    testing::test_agent,
};
use serde_json::{Value, json};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_erased_last_entry_gives_no_last_activity() -> modular_agent::Result<()> {
    let root = tempfile::tempdir()?;
    let dir = root.path().join("sessions");
    let token = "Y7lSWvfTrVXoqDjufeu2ARTGQcHBq9w";
    let token_file = root.path().join("token");
    std::fs::write(&token_file, token)?;
    let opts = ServeHistoryOptions::new("127.0.0.1:0".parse().unwrap(), &token_file);
    let server = listen_history(file_history(&dir)?, opts).await?;
    let agent = test_agent()
        .project(root.path())
        .durability(Durability::Kept)
        .history(http_history(&server.url, &token_file)?)
        .script(json!([{"text":"one"}, {"text":"two"}]))
        .build()
        .await?;
    let older = agent.session().await?;
    older.prompt("first").await?;
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let newer = agent.session().await?;
    newer.prompt("second").await?;
    let (older, newer) = (older.id().to_owned(), newer.id().to_owned());
    agent.close().await?;

    // Erase the newer session's last entry through the service, as an operator can.
    let client = reqwest::Client::new();
    let page: Value = client
        .get(format!("{}/v1/sessions/{newer}", server.url))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(page["next"].is_null(), "one page holds the session");
    let last = page["entries"].as_array().unwrap().last().unwrap()["id"].clone();
    let reply = client
        .post(format!("{}/v1/sessions/{newer}/erase", server.url))
        .bearer_auth(token)
        .json(&json!({"entryIds":[last]}))
        .send()
        .await
        .unwrap();
    assert!(reply.status().is_success(), "erase: {}", reply.status());

    let order = |listed: Vec<modular_agent::SessionInfo>| {
        let active = |id: &str| listed.iter().find(|s| s.id == id).unwrap().last_active;
        (active(&newer), active(&older))
    };
    let (erased, kept) = order(http_history(&server.url, &token_file)?.sessions(None)?);
    assert_eq!(erased, 0);
    assert!(kept > 0);
    server.close().await;
    Ok(())
}

// A native store keeps an erased entry's `at` but drops its content. A store
// that erases in place, with no erasure record after it, leaves such an entry
// last; its time is not the session's last activity.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_info_matches_listing_last_activity() -> modular_agent::Result<()> {
    let root = tempfile::tempdir()?;
    let dir = root.path().join("sessions");
    let agent = test_agent()
        .project(root.path())
        .durability(Durability::Kept)
        .history(file_history(&dir)?)
        .script(json!([{"text":"one"}]))
        .build()
        .await?;
    let session = agent.session().await?;
    session.prompt("first").await?;
    let id = session.id().to_owned();
    agent.close().await?;

    let store = history_fs::FileHistory::new(&dir)?;
    let mut data = store.load(&id)?;
    let reader = test_agent()
        .project(root.path())
        .durability(Durability::Kept)
        .history(file_history(&dir)?)
        .build()
        .await?;
    let assert_activity = |id: &str, expected| -> modular_agent::Result<()> {
        assert_eq!(reader.session_info(id)?.last_active, expected);
        let listed = reader.sessions(None)?.into_iter().find(|s| s.id == id);
        assert_eq!(listed.unwrap().last_active, expected);
        Ok(())
    };

    let (last, earlier) = data.entries.split_last_mut().unwrap();
    assert!(last.at > 0);
    assert_activity(&id, last.at)?;

    assert!(
        earlier
            .iter()
            .any(|entry| entry.content.is_some() && entry.at > 0)
    );
    last.content = None;
    // Write the native snapshot directly so the tombstone still carries `at`.
    std::fs::write(dir.join(format!("{id}.json")), serde_json::to_vec(&data)?)?;
    assert_activity(&id, 0)?;

    data.id = "empty".into();
    data.entries.clear();
    data.position = None;
    store.save(&data)?;
    assert_activity("empty", 0)?;
    reader.close().await?;
    Ok(())
}
