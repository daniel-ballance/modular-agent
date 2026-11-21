use futures_util::StreamExt;
use modular_agent::{
    Agent, Ask, Code, Command, Configuration, Durability, Event, Interface, OutputDecision, Plugin,
    Result, Timing, Tool, ToolSource, ToolsChanged, file_history, testing::test_agent,
};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{Arc, Mutex},
};

#[tokio::test]
async fn content_survives_proposal_and_typed_streaming() -> Result<()> {
    let agent = test_agent()
        .several_actors(true)
        .script(json!([{"text":"reply"}]))
        .build()
        .await?;
    let session = agent.session().await?;
    let parts = vec![
        json!({"type":"text", "text":"request"}),
        json!({"type":"example.opaque", "keep":42}),
    ];
    let rejected = session.send(parts.clone(), Timing::Propose).await?;
    assert_eq!(session.proposals().await?[0].content, parts);
    session.withdraw(&rejected.input_id).await?;
    assert!(session.proposals().await?.is_empty());
    let admitted = session.send(parts.clone(), Timing::Propose).await?;
    session
        .release(&admitted.input_id, Timing::Now, false)
        .await?;
    session.wait_idle().await?;
    let rows = session.history().await?;
    let input = rows.iter().find(|row| row["kind"] == "input").unwrap();
    assert_eq!(input["message"]["content"], json!(parts));
    let session = agent.session().await?;
    let mut stream = session.prompt_stream(parts).await?;
    let mut text = String::new();
    while let Some(event) = stream.next().await.transpose()? {
        if let Event::Text { delta, .. } = event {
            text.push_str(&delta);
        }
    }
    assert_eq!(text, "reply");
    agent.close().await
}

#[tokio::test]
async fn local_observers_and_actor_output_gate() -> Result<()> {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let joined = seen.clone();
    let left = seen.clone();
    let piece = seen.clone();
    let plugin = Plugin::new("local-hooks")
        .on_session_join(move |m| {
            joined
                .lock()
                .unwrap()
                .push(format!("joined {}", m.actor_id));
            std::future::ready(Ok(()))
        })
        .on_session_leave(move |m| {
            left.lock().unwrap().push(format!("left {}", m.actor_id));
            std::future::ready(Ok(()))
        })
        .on_provider_piece(move |p| {
            piece
                .lock()
                .unwrap()
                .push(format!("piece {}", p.delta.as_str().unwrap()));
            std::future::ready(Ok(()))
        })
        .on_output(|output| async move {
            let mut event = output.value;
            if output.recipient == "user" && event["type"] == "text" {
                event["data"]["delta"] = json!("redacted");
                return Ok(OutputDecision::Redact(event));
            }
            Ok(OutputDecision::Allow)
        });
    let agent = test_agent()
        .several_actors(true)
        .plugin(plugin.clone())
        .script(json!([{"text":"original"}]))
        .build()
        .await?;
    let session = agent.session().await?;
    session
        .join(modular_agent::Actor {
            id: "guest".into(),
            kind: "user".into(),
            rights: modular_agent::Rights::only(&["watch"]),
        })
        .await?;
    session.leave("guest").await?;
    let mut stream = session.prompt_stream("prompt").await?;
    let mut text = String::new();
    while let Some(event) = stream.next().await.transpose()? {
        if let Event::Text { delta, .. } = event {
            text.push_str(&delta);
        }
    }
    assert_eq!(text, "redacted");
    assert_eq!(
        *seen.lock().unwrap(),
        ["joined guest", "left guest", "piece original"]
    );
    agent.close().await?;
    assert_eq!(
        test_agent()
            .over_wire(plugin)
            .build()
            .await
            .err()
            .unwrap()
            .code(),
        Code::NotSupported
    );
    Ok(())
}

#[tokio::test]
async fn a_local_command_asks_without_a_turn() -> Result<()> {
    let plugin = Plugin::new("asks").command(
        Command::new("choose", "Choose a colour.", |_, cx| async move {
            match cx.ask(Ask::choice("Which?", &["red", "blue"])).await? {
                modular_agent::Answer::Value(value) => Ok(Some(value)),
                answer => panic!("expected a choice, got {answer:?}"),
            }
        })
        .in_process_only(),
    );
    let agent = test_agent()
        .plugin(plugin)
        .on_question(|_| async { modular_agent::Answer::Value("blue".into()) })
        .build()
        .await?;
    let session = agent.session().await?;
    assert_eq!(
        session.run_command("/choose").await?.as_deref(),
        Some("blue")
    );
    assert!(session.last_turn()?.is_none());
    agent.close().await
}

#[derive(Default)]
struct Changing(Arc<Mutex<(bool, Option<ToolsChanged>)>>);
impl ToolSource for Changing {
    fn per_session(&self) -> bool {
        false
    }
    fn catalog_notifier(&self, notify: ToolsChanged) {
        self.0.lock().unwrap().1 = Some(notify);
    }
    fn tools(&self, _session: &str) -> Vec<Tool> {
        if self.0.lock().unwrap().0 {
            vec![Tool::new("new", "New tool.").run(|_: Value, _| async { Ok("ready") })]
        } else {
            let state = self.0.clone();
            vec![
                Tool::new("swap", "Swap the tool list.").run(move |_: Value, _| {
                    let state = state.clone();
                    async move {
                        let mut state = state.lock().unwrap();
                        state.0 = true;
                        state.1.as_ref().unwrap().changed();
                        Ok("swapped")
                    }
                }),
            ]
        }
    }
}

#[tokio::test]
async fn dynamic_sources_change_before_the_next_dispatch_in_both_placements() -> Result<()> {
    for served in [false, true] {
        let plugin = Plugin::new("changing").setup(|r| {
            r.tools("catalog", Changing::default());
            Ok(())
        });
        let builder = test_agent();
        let agent = if served {
            builder.over_wire(plugin)
        } else {
            builder.plugin(plugin)
        }
        .build()
        .await?;
        let session = agent.session().await?;
        assert_eq!(
            session.call_tool("swap", json!({})).await?.text(),
            "swapped"
        );
        assert_eq!(session.call_tool("new", json!({})).await?.text(), "ready");
        agent.close().await?;
    }
    Ok(())
}

#[tokio::test]
async fn a_plugin_defines_a_hook_other_plugins_can_answer() -> Result<()> {
    use modular_agent::{HookAnswer, HookRule, Order};
    let owner = Plugin::new("publisher").setup(|r| {
        let hook = r.define_hook("publisher.value", HookRule::FirstAnswer);
        r.tool(
            Tool::new("publish", "Call the plugin hook.")
                .in_process_only()
                .run(move |input: Value, cx| {
                    let hook = hook.clone();
                    async move {
                        let answer = cx.call_hook(&hook, input).await?;
                        assert!(answer.answered);
                        Ok(answer.value.as_str().unwrap().to_owned())
                    }
                }),
        );
        Ok(())
    });
    let subscriber = Plugin::new("subscriber").setup(|r| {
        r.on_hook("publisher.value", Order::First, |input| async move {
            Ok(HookAnswer::Value(json!(format!(
                "value: {}",
                input["name"].as_str().unwrap()
            ))))
        });
        Ok(())
    });
    let agent = test_agent()
        .plugin(owner)
        .plugin(subscriber)
        .build()
        .await?;
    let app = agent.session().await?;
    assert_eq!(
        app.call_tool("publish", json!({"name":"Whitby"}))
            .await?
            .text(),
        "value: Whitby"
    );
    agent.close().await
}

struct Defaults;
impl Configuration for Defaults {
    fn settings(&self, _: &Path) -> Result<Value> {
        Ok(json!({"title":"from configuration"}))
    }
}
struct TestInterface(Arc<Mutex<Vec<String>>>);
#[modular_agent::async_trait]
impl Interface for TestInterface {
    async fn start(&self, agent: Agent) -> Result<()> {
        let session = agent.session().await?;
        self.0
            .lock()
            .unwrap()
            .push(session.settings()?["title"].as_str().unwrap().into());
        session.set_setting("title", json!("stored"))?;
        session.close().await
    }
    async fn stop(&self) -> Result<()> {
        self.0.lock().unwrap().push("stopped".into());
        Ok(())
    }
}

#[tokio::test]
async fn registrar_supplies_history_configuration_environment_and_interface() -> Result<()> {
    let data = tempfile::tempdir()?;
    let history = file_history(data.path().join("store"))?;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let records = seen.clone();
    let plugin = Plugin::new("parts")
        .replaces("working-environment")
        .setup(move |r| {
            r.history_store(history.clone())?;
            r.configuration(Defaults)?;
            r.environment(modular_agent::testing::memory_environment())?;
            r.interface(TestInterface(records.clone()));
            Ok(())
        });
    let rejected = Agent::builder()
        .plugin(plugin.clone())
        .build()
        .await
        .err()
        .unwrap();
    assert_eq!(rejected.code(), Code::InvalidComposition);
    assert!(rejected.message().contains("kept"));
    let agent = Agent::builder()
        .durability(Durability::Kept)
        .plugin(plugin)
        .build()
        .await?;
    assert_eq!(agent.sessions(None)?.len(), 1);
    assert_eq!(agent.declaration()?["confinesFiles"], true);
    agent.close().await?;
    assert_eq!(*seen.lock().unwrap(), ["from configuration", "stopped"]);
    Ok(())
}
