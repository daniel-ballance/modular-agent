#[path = "agui/listing.rs"]
mod listing;

use modular_agent::{
    AcpActor, Agent, AguiActor, AguiOptions, AguiServer, InterfaceToolSource, Plugin,
    testing::scripted_provider,
};
use serde_json::{Value, json};
use std::{os::unix::fs::PermissionsExt, path::Path, sync::Arc};
const TOKEN: &str = "agui-disposable-test-token";
fn actor(dir: &Path, client: &str, token: &str) -> anyhow::Result<AguiActor> {
    let path = dir.join(client);
    std::fs::write(&path, token)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    Ok(AguiActor::new(client, AcpActor::local(path)))
}
async fn serve(agent: &Agent, dir: &Path) -> anyhow::Result<AguiServer> {
    Ok(agent
        .serve_agui(AguiOptions {
            listen: "127.0.0.1:0".into(),
            actors: vec![actor(dir, "test-client", TOKEN)?],
            ..Default::default()
        })
        .await?)
}
fn url(server: &AguiServer, route: &str) -> String {
    format!("{}/agui/v1{route}", server.url)
}
async fn thread(server: &AguiServer) -> anyhow::Result<String> {
    let t: Value = reqwest::Client::new()
        .post(url(server, "/threads"))
        .bearer_auth(TOKEN)
        .json(&json!({}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(t["threadId"].as_str().unwrap().into())
}
fn input(id: &str, run: &str, content: Value) -> Value {
    json!({"protocolVersion":"1.0","threadId":id,"runId":run,"messages":[{"id":"local","role":"user","content":content}]})
}
async fn post(server: &AguiServer, request: Value) -> reqwest::Result<reqwest::Response> {
    reqwest::Client::new()
        .post(url(server, "/run"))
        .bearer_auth(TOKEN)
        .json(&request)
        .send()
        .await
}
async fn exchange(server: &AguiServer, request: Value) -> anyhow::Result<Vec<Value>> {
    Ok(post(server, request)
        .await?
        .error_for_status()?
        .text()
        .await?
        .lines()
        .filter_map(|l| l.strip_prefix("data: "))
        .map(serde_json::from_str)
        .collect::<Result<Vec<_>, _>>()?)
}
#[tokio::test]
async fn authenticated_listener_serves_a_scripted_turn_and_detaches_on_close() -> anyhow::Result<()>
{
    let dir = tempfile::tempdir()?;
    let agent = Agent::builder()
        .project(dir.path())
        .provider(scripted_provider(json!([{"text":"An answer."}])))
        .build()
        .await?;
    let server = serve(&agent, dir.path()).await?;
    let origin = url(&server, "");
    assert_eq!(reqwest::get(&origin).await?.status(), 401);
    let frames = exchange(&server, input(&thread(&server).await?, "one", json!("Hi"))).await?;
    assert_eq!(frames.first().unwrap()["type"], "RUN_STARTED");
    assert_eq!(frames.last().unwrap()["outcome"]["type"], "success");
    assert!(
        frames
            .iter()
            .any(|e| e["type"] == "TEXT_MESSAGE_CONTENT" && e["delta"] == "An answer.")
    );
    server.close().await;
    assert!(reqwest::get(origin).await.is_err());
    agent.close().await?;
    Ok(())
}

#[tokio::test]
async fn listing_returns_only_kept_threads_without_their_content() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let agent = Agent::builder()
        .project(dir.path())
        .data_dir(dir.path().join("data"))
        .durability(modular_agent::Durability::Kept)
        .provider(scripted_provider(json!([{"text":"Private answer."}])))
        .build()
        .await?;
    let server = serve(&agent, dir.path()).await?;
    let _provisional = thread(&server).await?;
    let id = thread(&server).await?;
    exchange(&server, input(&id, "start", json!("Private input"))).await?;
    let page: Value = reqwest::Client::new()
        .get(url(&server, "/threads"))
        .bearer_auth(TOKEN)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let updated = page["threads"][0]["updatedAt"].as_str().unwrap();
    chrono::DateTime::parse_from_rfc3339(updated)?;
    assert_eq!(
        page,
        json!({"threads":[{"threadId":id,"updatedAt":updated,
        "waiting":{"questions":0,"toolCalls":0,"turn":"none"}}]})
    );
    server.close().await;
    agent.close().await?;
    Ok(())
}

#[tokio::test]
async fn service_rejects_an_ambiguous_route_before_listening() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let agent=Agent::builder().project(dir.path()).plugin_host(true).interface_tools([InterfaceToolSource{source_id:"selection".into(),route_id:"application".into(),actor_id:"alice".into(),result_timeout_ms:1000,tools:vec![json!({"name":"selected","description":"Read selection","parameters":{},"callers":["model"]})]}]).build().await?;
    let mut p = actor(dir.path(), "application", TOKEN)?;
    p.principal.actor.id = "bob".into();
    let err = agent
        .serve_agui(AguiOptions {
            listen: "127.0.0.1:0".into(),
            actors: vec![p],
            ..Default::default()
        })
        .await
        .err()
        .unwrap();
    assert_eq!(err.code(), modular_agent::Code::InvalidComposition);
    agent.close().await?;
    Ok(())
}

#[tokio::test]
async fn tenant_without_input_never_starts_a_provisional_session() -> anyhow::Result<()> {
    use std::sync::atomic::{AtomicBool, Ordering};
    let dir = tempfile::tempdir()?;
    let started = Arc::new(AtomicBool::new(false));
    let seen = started.clone();
    let agent = Agent::builder()
        .project(dir.path())
        .tenants(json!({"reader":{"rights":["watch"]}}))
        .plugin(Plugin::new("observe-start").on_session_start(move |_| {
            seen.store(true, Ordering::SeqCst);
            async { Ok(()) }
        }))
        .build()
        .await?;
    let mut a = actor(dir.path(), "view", TOKEN)?;
    a.principal.tenants = Some(vec![Some("reader".into())]);
    let server = agent
        .serve_agui(AguiOptions {
            listen: "127.0.0.1:0".into(),
            actors: vec![a],
            tenant: Some("reader".into()),
            ..Default::default()
        })
        .await?;
    let result = reqwest::Client::new()
        .post(url(&server, "/threads"))
        .bearer_auth(TOKEN)
        .json(&json!({}))
        .send()
        .await?;
    assert_eq!(result.status(), 403);
    assert!(!started.load(Ordering::SeqCst));
    server.close().await;
    agent.close().await?;
    Ok(())
}

#[tokio::test]
async fn a_left_open_question_can_be_answered_without_presence() -> anyhow::Result<()> {
    left_open_exchange(
        modular_agent::Ask::choice("Which?", &["first", "second"]),
        None,
    )
    .await
}

#[tokio::test]
async fn link_interrupt_contains_its_gated_uri() -> anyhow::Result<()> {
    let uri = "https://example.test/authorize";
    left_open_exchange(
        modular_agent::Ask::link("Visit the account page", uri),
        Some(uri),
    )
    .await
}

async fn left_open_exchange(
    question: modular_agent::Ask,
    link: Option<&str>,
) -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let ask = modular_agent::Tool::new("choose", "Choose a label").run(move |_: Value, cx| {
        let question = question.clone();
        async move {
            cx.ask_with(
                question,
                modular_agent::AskWait {
                    wait: std::time::Duration::ZERO,
                },
            )
            .await?;
            Ok("Answered.".to_owned())
        }
    });
    let agent = Agent::builder()
        .project(dir.path())
        .data_dir(dir.path().join("data"))
        .durability(modular_agent::Durability::Kept)
        .tool(ask)
        .provider(scripted_provider(
            json!([{"toolCalls":[{"name":"choose","input":{}}]},{"text":"Finished."}]),
        ))
        .build()
        .await?;
    let server = listing::clients(&agent, dir.path()).await?;
    let id = thread(&server).await?;
    let first = exchange(&server, input(&id, "start", json!("Choose"))).await?;
    for (token, questions) in [(TOKEN, 1), (listing::READER, 0)] {
        let page = listing::list_ok(&server, token, "").await?;
        assert_eq!(
            page["threads"][0]["waiting"],
            json!({"questions":questions,"toolCalls":0,"turn":"none"})
        );
        assert!(!page.to_string().contains("Which?"));
    }
    let end = &first.last().unwrap()["outcome"];
    assert_eq!(end["type"], "interrupt");
    let interrupt = &end["interrupts"][0];
    assert!(interrupt.get("expiresAt").is_none());
    if let Some(uri) = link {
        assert_eq!(interrupt["metadata"]["modular-agent.link"], uri);
        assert_eq!(interrupt["message"], "Visit the account page");
    }
    let snapshot: Value = reqwest::Client::new()
        .get(url(&server, &format!("/threads/{id}")))
        .bearer_auth(TOKEN)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    assert_eq!(snapshot["waiting"]["questions"][0], *interrupt);
    let next=exchange(&server,json!({"protocolVersion":"1.0","threadId":id,"runId":"answer","messages":snapshot["messages"],"resume":[{"interruptId":interrupt["id"],"status":"resolved","payload":"second"}]})).await?;
    assert_eq!(next.last().unwrap()["outcome"]["type"], "success");
    let page = listing::list_ok(&server, TOKEN, "").await?;
    assert_eq!(page["threads"][0]["waiting"]["questions"], 0);
    assert!(
        next.iter()
            .any(|e| e["type"] == "TEXT_MESSAGE_CONTENT" && e["delta"] == "Finished.")
    );
    server.close().await;
    agent.close().await?;
    Ok(())
}

#[tokio::test]
async fn blocked_wire_text_is_not_reintroduced_by_a_recipient_snapshot() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let gate = Plugin::new("block-text").on_output(|view| async move {
        Ok(
            if view.recipient == "test-client" && view.value["type"] == "TEXT_MESSAGE_CONTENT" {
                modular_agent::OutputDecision::Block
            } else {
                modular_agent::OutputDecision::Allow
            },
        )
    });
    let agent = Agent::builder()
        .project(dir.path())
        .plugin(gate)
        .provider(scripted_provider(json!([{"text":"Private answer."}])))
        .build()
        .await?;
    let server = serve(&agent, dir.path()).await?;
    let session = agent.session().await?;
    let first = exchange(&server, input(session.id(), "one", json!("Hi"))).await?;
    assert_eq!(first.last().unwrap()["type"], "RUN_ERROR");
    session.wait_idle().await?;
    assert_eq!(session.last_turn().await?.unwrap().text, "Private answer.");
    let snapshot: Value = reqwest::Client::new()
        .get(url(&server, &format!("/threads/{}", session.id())))
        .bearer_auth(TOKEN)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    assert!(!snapshot.to_string().contains("Private answer."));
    server.close().await;
    agent.close().await?;
    Ok(())
}

#[tokio::test]
async fn explicit_origin_preflight_has_no_authority() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let agent = Agent::builder()
        .project(dir.path())
        .plugin_host(true)
        .build()
        .await?;
    let server = agent
        .serve_agui(AguiOptions {
            listen: "127.0.0.1:0".into(),
            actors: vec![actor(dir.path(), "client", TOKEN)?],
            origins: vec!["https://app.example".into()],
            ..Default::default()
        })
        .await?;
    let client = reqwest::Client::new();
    let path = url(&server, "/threads");
    let response = client
        .request(reqwest::Method::OPTIONS, &path)
        .header("Origin", "https://app.example")
        .send()
        .await?;
    assert_eq!(response.status(), 204);
    assert_eq!(
        response.headers()["access-control-allow-origin"],
        "https://app.example"
    );
    assert!(response.bytes().await?.is_empty());
    assert_eq!(
        client
            .post(&path)
            .header("Origin", "https://app.example")
            .json(&json!({}))
            .send()
            .await?
            .status(),
        401
    );
    assert_eq!(
        client
            .post(&path)
            .bearer_auth(TOKEN)
            .header("Origin", "https://other.example")
            .json(&json!({}))
            .send()
            .await?
            .status(),
        403
    );
    assert!(agent.sessions(None)?.is_empty());
    server.close().await;
    agent.close().await?;
    Ok(())
}

#[tokio::test]
async fn closing_a_listener_detaches_without_cancelling_the_admitted_turn() -> anyhow::Result<()> {
    use tokio::sync::Notify;
    let dir = tempfile::tempdir()?;
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let hold = Plugin::new("hold-step").on_step_before({
        let entered = entered.clone();
        let release = release.clone();
        move |_| {
            let entered = entered.clone();
            let release = release.clone();
            async move {
                entered.notify_one();
                release.notified().await;
                Ok(None)
            }
        }
    });
    let agent = Agent::builder()
        .project(dir.path())
        .plugin_host(true)
        .plugin(hold)
        .provider(scripted_provider(json!([{"text":"Work survived."}])))
        .build()
        .await?;
    let session = agent.session().await?;
    let server = serve(&agent, dir.path()).await?;
    let request = input(session.id(), "one", json!("Hello"));
    let response = post(&server, request.clone()).await?.error_for_status()?;
    entered.notified().await;
    assert_eq!(post(&server, request).await?.status(), 409);
    server.close().await;
    drop(response);
    release.notify_one();
    session.wait_idle().await?;
    assert_eq!(session.last_turn().await?.unwrap().text, "Work survived.");
    agent.close().await?;
    Ok(())
}

#[tokio::test]
async fn server_tool_frames_form_a_settled_group_and_media_are_not_fetched() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let agent = Agent::builder()
        .project(dir.path())
        .plugin_host(true)
        .approval(modular_agent::Approval::Off)
        .tool(
            modular_agent::Tool::new("label", "Label an item")
                .run(|_: Value, _| async { Ok("Label added.".to_owned()) }),
        )
        .provider(scripted_provider(
            json!([{"toolCalls":[{"name":"label","input":{"tag":"one"}}]},{"text":"Done."}]),
        ))
        .build()
        .await?;
    let server = serve(&agent, dir.path()).await?;
    let frames=exchange(&server,input(&thread(&server).await?,"one",json!([{"type":"text","text":"Label this"},{"type":"image","source":{"type":"data","value":"aGk=","mimeType":"image/png"}},{"type":"document","source":{"type":"url","value":"https://unreachable.invalid/document"}}]))).await?;
    let snapshot = frames
        .iter()
        .rev()
        .find(|e| e["type"] == "MESSAGES_SNAPSHOT")
        .unwrap();
    assert_eq!(
        snapshot["messages"][0]["content"],
        json!([{"type":"text","text":"Label this"},{"type":"image","source":{"type":"data","value":"aGk=","mimeType":"image/png"}}])
    );
    let start = frames
        .iter()
        .position(|e| e["type"] == "TOOL_CALL_START")
        .unwrap();
    let group = &frames[start..start + 4];
    assert_eq!(
        group
            .iter()
            .map(|e| e["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "TOOL_CALL_START",
            "TOOL_CALL_ARGS",
            "TOOL_CALL_END",
            "TOOL_CALL_RESULT"
        ]
    );
    assert!(
        group
            .iter()
            .all(|e| e["toolCallId"] == group[0]["toolCallId"])
    );
    assert_eq!(group[3]["content"], "Label added.");
    assert_eq!(snapshot["messages"][1]["id"], group[0]["parentMessageId"]);
    assert_eq!(frames.last().unwrap()["outcome"], json!({"type":"success"}));
    server.close().await;
    agent.close().await?;
    Ok(())
}
