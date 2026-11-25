use futures_util::StreamExt;
use modular_agent::{Agent, Plugin, ProcessPlugin, Result};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

#[path = "../../sdk/tests/fixtures/git_project.rs"]
mod git_project;
use git_project::git_project;

#[tokio::test]
async fn serves_a_provider_over_stdio_and_streams_through_both_callbacks() -> Result<()> {
    let observed = Arc::new(AtomicBool::new(false));
    let observed_hook = observed.clone();
    let hooks = Plugin::new("provider-hooks")
        .on_provider_request(|mut p| async move {
            assert_eq!(p.provider, "scripted");
            assert_eq!(p.model.id, "script");
            // Add a preceding assistant message so the Provider picks the second script item.
            p.request["messages"].as_array_mut().unwrap().push(json!({
                "role":"assistant","content":[{"type":"text","text":"prior answer"}],"stop":"finished"
            }));
            Ok(Some(p.request))
        })
        .on_provider_response(move |p| {
            let observed = observed_hook.clone();
            async move {
                assert_eq!(p.message["content"][0]["text"], "served");
                observed.store(true, Ordering::Release);
                Ok(())
            }
        });
    let project = git_project();
    let agent = Agent::builder()
        .project(project.path())
        .plugin(hooks)
        .process_plugin(
            ProcessPlugin::new([
                env!("CARGO_BIN_EXE_modular-agent-fixtures"),
                "provider-script",
            ])
            .config(json!({"script":[{"text":"untransformed"},{"text":"served"}]})),
        )
        .build()
        .await?;
    assert_eq!(agent.models()?[0].model.id, "script");
    let session = agent.session().await?;
    let mut stream = session.prompt_stream("hello").await?;
    let mut seen = false;
    while let Some(event) = stream.next().await.transpose()? {
        match event.event_type.as_str() {
            "text" if event.data["delta"] == "served" => seen = true,
            "turnEnded" => {
                assert_eq!(event.data["outcome"]["kind"], "completed");
                assert_eq!(event.data["result"]["text"], "served");
            }
            _ => (),
        }
    }
    assert!(seen);
    assert!(observed.load(Ordering::Acquire));
    agent.close().await
}
