use modular_agent::{AcpActor, Agent, AguiActor, AguiOptions, testing::scripted_provider};
use serde_json::{Value, json};
use std::os::unix::fs::PermissionsExt;

#[tokio::test]
async fn authenticated_listener_serves_a_scripted_turn_and_detaches_on_close() -> anyhow::Result<()>
{
    let dir = tempfile::tempdir()?;
    let token = dir.path().join("test.token");
    std::fs::write(&token, "agui-disposable-test-token")?;
    std::fs::set_permissions(&token, std::fs::Permissions::from_mode(0o600))?;
    let agent = Agent::builder()
        .project(dir.path())
        .plugin_host(true)
        .provider(scripted_provider(json!([{"text":"An answer."}])))
        .model("scripted/script")
        .build()
        .await?;
    let server = agent
        .serve_agui(AguiOptions {
            listen: "127.0.0.1:0".into(),
            actors: vec![AguiActor::new("test-client", AcpActor::local(token))],
            ..Default::default()
        })
        .await?;
    let url = format!("{}/agui/v1", server.url);
    let client = reqwest::Client::new();
    assert_eq!(client.get(&url).send().await?.status(), 401);
    let thread: Value = client
        .post(format!("{url}/threads"))
        .bearer_auth("agui-disposable-test-token")
        .json(&json!({}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let events=client.post(format!("{url}/run")).bearer_auth("agui-disposable-test-token").json(&json!({"protocolVersion":"1.0","threadId":thread["threadId"],"runId":"one","messages":[{"id":"local","role":"user","content":"Hi"}]})).send().await?.error_for_status()?.text().await?;
    let frames = events
        .lines()
        .filter_map(|l| l.strip_prefix("data: "))
        .map(serde_json::from_str::<Value>)
        .collect::<Result<Vec<_>, _>>()?;
    assert_eq!(frames.first().unwrap()["type"], "RUN_STARTED");
    assert_eq!(
        frames.last().unwrap()["outcome"]["type"],
        "success",
        "{frames:?}"
    );
    assert!(
        frames
            .iter()
            .any(|e| e["type"] == "TEXT_MESSAGE_CONTENT" && e["delta"] == "An answer.")
    );
    server.close().await;
    assert!(client.get(&url).send().await.is_err());
    agent.close().await?;
    Ok(())
}
