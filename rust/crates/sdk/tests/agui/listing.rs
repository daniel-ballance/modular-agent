use super::*;
use modular_agent::{
    Durability, Rights, Timing, Tool,
    testing::{restart, test_agent},
};
use std::{collections::BTreeSet, time::Duration};

pub(super) const READER: &str = "disposable-reader-token";
const OTHER: &str = "disposable-other-token";

pub(super) async fn clients(agent: &Agent, dir: &Path) -> anyhow::Result<AguiServer> {
    let writer = actor(dir, "app", TOKEN)?;
    let mut reader = actor(dir, "reader", READER)?;
    reader.principal.actor.rights = Rights::only(&["watch"]);
    let mut other = actor(dir, "other", OTHER)?;
    other.principal.actor.id = "uninvited".into();
    other.join_on_open = false;
    Ok(agent
        .serve_agui(AguiOptions {
            listen: "127.0.0.1:0".into(),
            actors: vec![writer, reader, other],
            ..Default::default()
        })
        .await?)
}
async fn list(server: &AguiServer, token: &str, query: &str) -> anyhow::Result<(u16, Value)> {
    let r = reqwest::Client::new()
        .get(url(server, &format!("/threads{query}")))
        .bearer_auth(token)
        .send()
        .await?;
    Ok((r.status().as_u16(), r.json().await?))
}
pub(super) async fn list_ok(
    server: &AguiServer,
    token: &str,
    query: &str,
) -> anyhow::Result<Value> {
    let (code, v) = list(server, token, query).await?;
    assert_eq!(code, 200, "{v}");
    Ok(v)
}

#[tokio::test]
async fn pages_are_scoped_to_the_client_and_expire_on_restart() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let agent = Agent::builder()
        .project(dir.path())
        .data_dir(dir.path().join("data"))
        .durability(Durability::Kept)
        .provider(scripted_provider(json!([{"text":"saved"}])))
        .build()
        .await?;
    let a = agent.session().await?;
    a.prompt("first").await?;
    let b = agent.session().await?;
    b.prompt("second").await?;
    let history = a.history().await?;
    let server = clients(&agent, dir.path()).await?;
    assert_eq!(reqwest::get(url(&server, "/threads")).await?.status(), 401);
    assert_eq!(list_ok(&server, OTHER, "").await?, json!({"threads":[]}));
    let first = list_ok(&server, TOKEN, "?limit=1").await?;
    let after = format!("?after={}&limit=1", first["next"].as_str().unwrap());
    let second = list_ok(&server, TOKEN, &after).await?;
    let ids = [&first, &second].map(|p| {
        assert_eq!(p["threads"].as_array().unwrap().len(), 1);
        p["threads"][0]["threadId"].as_str().unwrap()
    });
    assert_eq!(BTreeSet::from(ids), BTreeSet::from([a.id(), b.id()]));
    assert!(
        first["threads"][0]["updatedAt"].as_str() >= second["threads"][0]["updatedAt"].as_str()
    );
    assert!(second.get("next").is_none());
    assert_eq!(
        a.history().await?,
        history,
        "discovery must not join the local host"
    );
    for (token, query) in [
        (READER, after.as_str()),
        (TOKEN, "?after=unknown"),
        (TOKEN, "?limit=0"),
        (TOKEN, "?limit=501"),
        (TOKEN, "?limit=1.1"),
    ] {
        assert_eq!(
            list(&server, token, query).await?,
            (400, json!({"code":"invalid_request"}))
        );
    }
    server.close().await;
    let server = clients(&agent, dir.path()).await?;
    assert_eq!(
        list(&server, TOKEN, &after).await?,
        (400, json!({"code":"invalid_request"}))
    );
    server.close().await;
    agent.close().await?;
    Ok(())
}

#[tokio::test]
async fn running_and_interrupted_are_distinct_and_listing_never_recovers() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let started = Arc::new(tokio::sync::Notify::new());
    let enter = started.clone();
    let hold = Tool::new("hold", "Wait for a crash").run(move |_: Value, _| {
        enter.notify_one();
        async { std::future::pending::<modular_agent::Result<String>>().await }
    });
    let agent = test_agent()
        .project(dir.path())
        .data_dir(dir.path().join("data"))
        .durability(Durability::Durable)
        .tool(hold)
        .script(json!([{"toolCalls":[{"name":"hold","input":{}}]}, {"text":"finished"}]))
        .build()
        .await?;
    let s = agent.session().await?;
    s.send("hold", Timing::Now).await?;
    tokio::time::timeout(Duration::from_secs(5), started.notified()).await?;
    let server = clients(&agent, dir.path()).await?;
    let row = |v: Value| v["threads"][0]["waiting"]["turn"].clone();
    assert_eq!(row(list_ok(&server, TOKEN, "").await?), "running");
    server.close().await;
    let agent = restart(agent).await?;
    let server = clients(&agent, dir.path()).await?;
    assert_eq!(row(list_ok(&server, TOKEN, "").await?), "interrupted");
    let rights = Rights::full();
    let mut viewer = modular_agent::SessionViewer::new("user", &rights);
    let summary = agent.session_summary(s.id(), &viewer)?.unwrap();
    assert_eq!(summary.waiting.turn, modular_agent::TurnState::Interrupted);
    assert_eq!(
        (summary.id.as_str(), summary.project.as_path()),
        (s.id(), dir.path())
    );
    assert!(summary.updated_at > 0);
    assert!(agent.session_summary("missing", &viewer)?.is_none());
    viewer.scope = &|_, _| false;
    assert!(agent.session_summary(s.id(), &viewer)?.is_none());
    assert!(agent.session_info(s.id())?.unfinished_turn);
    let recovered = agent.open_session(s.id()).await?;
    assert_eq!(recovered.last_turn().await?.unwrap().text, "finished");
    assert_eq!(row(list_ok(&server, TOKEN, "").await?), "none");
    server.close().await;
    agent.close().await?;
    Ok(())
}

#[tokio::test]
async fn only_the_executors_client_sees_the_open_call() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let executor = actor(dir.path(), "app", TOKEN)?.principal.actor.id;
    let offer = json!({"name":"pick","description":"Choose","parameters":{"type":"object"}});
    let mut registered = offer.clone();
    registered["callers"] = json!(["model"]);
    let agent = Agent::builder().project(dir.path()).data_dir(dir.path().join("data")).durability(Durability::Kept)
        .interface_tools([InterfaceToolSource { source_id:"choice".into(), route_id:"app".into(), actor_id:executor,
            result_timeout_ms:30_000, tools:vec![registered] }])
        .provider(scripted_provider(json!([{"toolCalls":[{"name":"pick","input":{"label":"private argument"}}]},{"text":"Done"}])))
        .build().await?;
    let mut peer = actor(dir.path(), "another-app", OTHER)?;
    peer.principal.actor.rights = Rights::full();
    let server = agent
        .serve_agui(AguiOptions {
            listen: "127.0.0.1:0".into(),
            actors: vec![actor(dir.path(), "app", TOKEN)?, peer],
            ..Default::default()
        })
        .await?;
    let id = thread(&server).await?;
    let mut request = input(&id, "start", json!("Pick"));
    request["tools"] = json!([offer]);
    let frames = exchange(&server, request).await?;
    assert_eq!(frames.last().unwrap()["type"], "RUN_FINISHED", "{frames:?}");
    for (token, count) in [(TOKEN, 1), (OTHER, 0)] {
        let page = list_ok(&server, token, "").await?;
        assert_eq!(
            page["threads"][0]["waiting"],
            json!({"questions":0,"toolCalls":count,"turn":"none"})
        );
        assert!(!page.to_string().contains("private argument"));
    }
    server.close().await;
    agent.close().await?;
    Ok(())
}

#[tokio::test]
async fn ephemeral_threads_are_never_listed() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let agent = Agent::builder()
        .project(dir.path())
        .provider(scripted_provider(json!([{"text":"done"}])))
        .build()
        .await?;
    let server = clients(&agent, dir.path()).await?;
    exchange(&server, input(&thread(&server).await?, "one", json!("Hi"))).await?;
    assert_eq!(list_ok(&server, TOKEN, "").await?, json!({"threads":[]}));
    server.close().await;
    agent.close().await?;
    Ok(())
}
