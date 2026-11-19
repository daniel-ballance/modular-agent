use agent_api::*;
use std::sync::Arc;
#[tokio::test]
async fn configured_plugins_load_with_options_only_after_project_trust() -> Result<()> {
    let root = tempfile::tempdir()?;
    let project = tempfile::tempdir()?;
    let config = root.path().join("settings.json");
    std::fs::write(
        &config,
        r#"{"plugins":[{"name":"guardrail.literal","options":{"secrets":["global-secret"]}}]}"#,
    )?;
    std::fs::write(
        project.path().join(".modular-agent.json"),
        r#"{"model":"fake","plugins":[{"name":"feature.subagents","options":{"durable":false}}],"plugin_settings":{"guardrail.literal":{"secrets":["project-secret"]}}}"#,
    )?;
    for trusted in [false, true] {
        if trusted {
            config_files::FilesConfiguration::new(config.clone()).trust(project.path())?;
        }
        let h = modular_agent::compose_project(
            modular_agent::Options {
                history: root.path().join("sessions"),
                global_config: config.clone(),
                key_file: root.path().join("NO-KEY"),
                secrets: vec![],
            },
            modular_agent::fake_provider(vec![]),
            Arc::new(interface_terminal::TerminalPlugin {
                sink: Arc::new(Sink),
            }),
            modular_agent::default_runtime(),
            project.path(),
        )
        .await?;
        let session = h.create(project.path(), json!({})).await?;
        assert_eq!(h.snapshot(&session)?.settings["model"], "fake");
        let output = h
            .output(
                &Scope::session(&session),
                Output {
                    recipient: "interface".into(),
                    value: json!("global-secret project-secret"),
                    stream: None,
                    end: true,
                },
            )
            .await?
            .unwrap();
        assert_eq!(
            output,
            if trusted {
                json!("global-secret [REDACTED]")
            } else {
                json!("[REDACTED] project-secret")
            }
        );
        assert_eq!(h.declaration()?["subagents"]["durable"], json!(!trusted));
        h.close(&session).await?;
    }
    Ok(())
}
struct Sink;
impl EventSink for Sink {
    fn send(&self, _: Event) {}
}
