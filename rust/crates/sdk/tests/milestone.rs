use futures_util::StreamExt;
use modular_agent::{
    Code, Command, Disposition, Event, Gate, HookRule, Plugin, Result, Timing, Tool, ToolChange,
    ToolContext, TurnAddition,
    testing::{memory_environment, test_agent},
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::sync::Notify;

#[tokio::test]
async fn queued_prompt_cancel_and_settings() -> Result<()> {
    let running = Arc::new(Notify::new());
    let entered = running.clone();
    let hold = Tool::new("hold", "Wait for cancellation.").run(move |_: Value, cx: ToolContext| {
        let entered = entered.clone();
        async move {
            entered.notify_one();
            cx.cancelled().cancelled().await;
            Ok("held")
        }
    });
    let agent = test_agent()
        .tool(hold)
        .script(json!([
            {"toolCalls":[{"name":"hold","input":{}}]}, {"text":"next"}
        ]))
        .build()
        .await?;
    let session = agent.session().await?;
    let first = session.send("one", Timing::Now).await?;
    tokio::time::timeout(Duration::from_secs(5), running.notified())
        .await
        .unwrap();
    assert_eq!(
        session
            .set_setting("maxSteps", json!(2))
            .unwrap_err()
            .code(),
        Code::Busy
    );
    let second = session
        .send_with("two", Timing::After, Some("retry".into()))
        .await?;
    assert_eq!(second.taken, "after");
    let returned = session.cancel().await?;
    assert_eq!(returned[0].input_id, second.input_id);
    let back = session.prompt_with("two", Some("retry".into())).await?;
    assert_eq!(back.disposition, Disposition::HandedBack);
    // A retry attaches to the admission that was cancelled, not a new turn.
    let cancelled = session.prompt_with("one", None).await?;
    assert_ne!(cancelled.input_id, first.input_id);
    session.set_setting("maxSteps", json!(3))?;
    assert_eq!(session.settings()?["maxSteps"], 3);
    let fork = session.fork()?;
    assert_ne!(fork.id(), session.id());
    assert_eq!(fork.settings()?["maxSteps"], 3);
    agent.close().await
}

fn hooks() -> Plugin {
    Plugin::new("hooks")
        .on_turn_before(|before| async move {
            assert_eq!(before.input[0]["text"], "go");
            Ok(TurnAddition {
                system: Some("A test contribution.".into()),
                context: None,
            })
        })
        .on_tool_after(|after| async move {
            assert_eq!(after.call["name"], "echo");
            Ok(ToolChange {
                content: Some(json!([{"type":"text","text":"after"}])),
                value: None,
            })
        })
        .on_step_after(|_| async { Ok(Gate::Allow) })
        .on_turn_end(|ended| async move {
            assert_eq!(ended.outcome["kind"], "completed");
            Ok(())
        })
        .command(Command::new(
            "echo_args",
            "Echo the argument.",
            |args, cx| async move {
                assert_eq!(cx.actor_id, "user");
                Ok(Some(args))
            },
        ))
        .tool(
            Tool::new("echo", "Report progress.").run(|_: Value, cx: ToolContext| async move {
                cx.progress("working").await?;
                Ok("before")
            }),
        )
}
#[tokio::test]
async fn hooks_commands_and_progress_have_wire_parity() -> Result<()> {
    for wire in [false, true] {
        let builder = test_agent()
            .script(json!([{"toolCalls":[{"name":"echo","input":{}}]}, {"text":"done"}]));
        let agent = if wire {
            builder.over_wire(hooks())
        } else {
            builder.plugin(hooks())
        }
        .build()
        .await?;
        let session = agent.session().await?;
        assert_eq!(
            session.run_command("/echo_args a b").await?.as_deref(),
            Some("a b")
        );
        let mut events = session.prompt_stream("go").await?;
        let mut progress = false;
        while let Some(event) = events.next().await {
            if let Event::ToolOutput { text, .. } = event? {
                progress |= text == "working";
            }
        }
        assert!(progress, "wire={wire}");
        let last = session.last_turn()?.unwrap();
        assert_eq!(last.text, "done");
        assert_eq!(last.tool_results()[0].text(), "after");
        agent.close().await?;
    }
    Ok(())
}

#[tokio::test]
async fn nested_result_and_stale_context_in_both_placements() -> Result<()> {
    for wire in [false, true] {
        let child = Tool::new("child", "A nested tool.")
            .run(|_: Value, _: ToolContext| async { Ok("child result") });
        let stored = Arc::new(std::sync::Mutex::new(None));
        let held = stored.clone();
        let parent =
            Tool::new("parent", "Calls a nested tool.").run(move |_: Value, cx: ToolContext| {
                let held = held.clone();
                async move {
                    assert!(
                        cx.tools()
                            .list()
                            .await?
                            .iter()
                            .any(|d| d["name"] == "child")
                    );
                    let result = cx.tools().call("child", json!({})).await?;
                    assert!(!result.call_id.is_empty());
                    *held.lock().unwrap() = Some(cx);
                    Ok(result.text().to_owned())
                }
            });
        let plugin = Plugin::new("nested").tool(parent).tool(child);
        let builder = test_agent()
            .script(json!([{"toolCalls":[{"name":"parent","input":{}}]}, {"text":"done"}]));
        let agent = if wire {
            builder.over_wire(plugin)
        } else {
            builder.plugin(plugin)
        }
        .build()
        .await?;
        let result = agent.session().await?.prompt("go").await?;
        let texts: Vec<_> = result.tool_results().iter().map(|r| r.text()).collect();
        assert_eq!(texts, ["child result", "child result"], "wire={wire}");
        let cx = stored.lock().unwrap().take().unwrap();
        assert_eq!(
            cx.tools().list().await.err().unwrap().code(),
            Code::InvalidRequest
        );
        agent.close().await?;
    }
    Ok(())
}

#[tokio::test]
async fn serving_refuses_local_items_including_setup_registrations() -> Result<()> {
    let direct = Plugin::new("local").define_hook("local.test", HookRule::Observe);
    let error = modular_agent::serve(direct).await.unwrap_err();
    assert_eq!(error.code(), Code::NotSupported);
    assert!(error.message().contains("local.test"));
    let dynamic = Plugin::new("local").setup(|r| {
        r.tool(
            Tool::new("local_only", "Local.")
                .in_process_only()
                .run(|_: Value, _: ToolContext| async { Ok("ok") }),
        );
        Ok(())
    });
    let error = test_agent().over_wire(dynamic).build().await.err().unwrap();
    assert_eq!(error.code(), Code::NotSupported);
    assert!(error.message().contains("local_only"));
    Ok(())
}

#[tokio::test]
async fn memory_environment_reads_writes_and_runs_only_registered_commands() -> Result<()> {
    use modular_agent::testing::{ExecOutput, memory_environment_with};
    for wire in [false, true] {
        let environment = memory_environment_with([("greeting".into(), "hello".into())])?.on_exec(
            "echo",
            |args| {
                Ok(ExecOutput {
                    exit_code: 0,
                    output: args.into(),
                })
            },
        );
        let plugin = Plugin::new("environment_tool").tool(
            Tool::new("check_environment", "Check a test environment.").run(
                |_: Value, cx: ToolContext| async move {
                    let environment = cx.environment();
                    let greeting = environment.read("greeting").await?;
                    environment.write("result", &greeting).await?;
                    assert!(environment.exists("result").await?);
                    let output = environment.exec(&format!("echo {greeting}")).await?;
                    assert_eq!(output.exit_code, Some(0));
                    assert_eq!(
                        environment.exec("unregistered").await.unwrap_err().code(),
                        Code::NotSupported
                    );
                    Ok(output.output)
                },
            ),
        );
        let builder = test_agent().environment(environment).script(json!([
            {"toolCalls":[{"name":"check_environment","input":{}}]}, {"text":"done"}
        ]));
        let agent = if wire {
            builder.over_wire(plugin)
        } else {
            builder.plugin(plugin)
        }
        .build()
        .await?;
        let result = agent.session().await?.prompt("go").await?;
        assert_eq!(result.tool_results()[0].text(), "hello", "wire={wire}");
        agent.close().await?;
    }
    Ok(())
}

#[tokio::test]
async fn declaration_matches_installed_parts() -> Result<()> {
    let agent = test_agent()
        .environment(memory_environment())
        .build()
        .await?;
    let d = agent.declaration()?;
    assert_eq!(d["portableSessions"], false);
    assert_eq!(d["erasure"], false);
    assert_eq!(d["severalActors"], false);
    assert_eq!(d["continuesAfterRestart"], false);
    assert_eq!(d["commandContainment"], "none");
    assert_eq!(d["confinesFiles"], true);
    assert_eq!(d["settingsDuringTurn"], "refused");
    assert_eq!(d["startsTurnsUnasked"], "never");
    assert_eq!(d["nestedToolCalls"], true);
    agent.close().await
}
