use modular_agent::{
    Actor, Answer, Approval, Durability, Gate, OutputDecision, Plugin, Rights, ServicePlugin, Tool,
    testing::{advance_clock, test_agent},
};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tokio::sync::Notify;

#[tokio::test]
async fn both_runtimes_check_decision_and_deadline_at_first_dispatch() -> anyhow::Result<()> {
    // A process-scoped controlled clock, used only by this test binary.
    advance_clock(0);
    for served in [false, true] {
        for case in [
            "allow",
            "decline",
            "expired",
            "lapsed",
            "changed",
            "approver revoked",
            "worker revoked",
            "view blocked",
        ] {
            let dir = tempfile::tempdir()?;
            let root = dir.path();
            let token = root.join("service-token");
            fs::write(&token, "disposable-waiting-test-token")?;
            fs::set_permissions(&token, fs::Permissions::from_mode(0o600))?;
            let server = if served {
                Some(
                    plugin_stdio::server::serve_websocket(
                        "127.0.0.1:0",
                        token.clone(),
                        None,
                        || Arc::new(plugin_stdio::server::Conformance::runtime_only(false)),
                    )
                    .await?,
                )
            } else {
                None
            };
            let count = root.join("count");
            let tool = Tool::new("bump", "Increment once").run(move |_: Value, _| {
                let path = count.clone();
                async move {
                    fs::write(&path, "1")?;
                    Ok("done")
                }
            });
            let passes = Arc::new(AtomicUsize::new(0));
            let reached = Arc::new(Notify::new());
            let release = Arc::new(Notify::new());
            let block = Arc::new(AtomicBool::new(false));
            let hold = matches!(
                case,
                "lapsed" | "approver revoked" | "worker revoked" | "changed" | "view blocked"
            );
            let gate = Plugin::new("before-handoff")
                .on_tool_before({
                    let reached = reached.clone();
                    let release = release.clone();
                    move |_| {
                        let hold = hold && passes.fetch_add(1, Ordering::SeqCst) > 0;
                        let reached = reached.clone();
                        let release = release.clone();
                        async move {
                            if hold {
                                reached.notify_one();
                                release.notified().await;
                            }
                            Ok(if hold && case == "changed" {
                                Gate::Change(json!({"n":2}))
                            } else {
                                Gate::Allow
                            })
                        }
                    }
                })
                .on_output({
                    let block = block.clone();
                    move |view| {
                        let blocked = view.recipient == "reviewer"
                            && view.value["question"].is_object()
                            && block.load(Ordering::SeqCst);
                        async move {
                            Ok(if blocked {
                                OutputDecision::Block
                            } else {
                                OutputDecision::Allow
                            })
                        }
                    }
                });
            let mut builder = test_agent()
                .project(root)
                .data_dir(root.join("data"))
                .durability(Durability::Kept)
                .several_actors(true)
                .approval(Approval::All)
                .max_approval_wait_ms(30_000)
                .setting("approvalWait", json!("untilDeadline"))
                .setting(
                    "approval_timeout_ms",
                    json!(if case == "expired" { 400 } else { 40_000 }),
                )
                .tool(tool)
                .plugin(gate)
                .script(json!([{"toolCalls":[{"name":"bump","input":{}}]},{"text":"Finished"}]));
            if let Some(server) = &server {
                builder = builder.service_plugin(ServicePlugin {
                    url: server.url.clone(),
                    token_file: token,
                    config: json!({}),
                });
            }
            let agent = builder.build().await?;
            let owner = agent.session().await?;
            let member = |id: &str, rights: &[&str]| Actor {
                id: id.into(),
                kind: "user".into(),
                rights: Rights::only(rights),
            };
            owner
                .join(member("reviewer", &["watch", "approve"]))
                .await?;
            owner
                .join(member("worker", &["watch", "input", "tools"]))
                .await?;
            let reviewer = owner.r#as("reviewer")?;
            let origin = owner.r#as("worker")?.prompt("Bump").await?;
            assert_eq!(
                origin.open_tool_calls.len(),
                1,
                "served={served} case={case}: {origin:?}"
            );
            let rows = owner.history().await?;
            let request = rows.iter().find(|e| e["kind"] == "inputRequest").unwrap();
            let q = &request["data"]["request"];
            let id = q["id"].as_str().unwrap();
            let ms = if case == "expired" { 400 } else { 30_000 };
            assert_eq!(q["answerable"], false);
            assert_eq!(q["timeLimitMs"], ms);
            assert_eq!(
                q["deadlineAt"].as_u64(),
                Some(request["time"].as_u64().unwrap() + ms)
            );
            if case == "view blocked" {
                block.store(true, Ordering::SeqCst);
                assert!(reviewer.questions_present().await?.is_empty());
                assert!(reviewer.answer(id, Answer::Allow).await.is_err());
                block.store(false, Ordering::SeqCst);
            }
            assert_eq!(reviewer.questions_present().await?.len(), 1);
            assert!(
                owner
                    .r#as("reviewer")?
                    .answer(id, Answer::Allow)
                    .await
                    .is_err()
            );
            if case == "expired" {
                advance_clock(ms);
                assert!(reviewer.answer(id, Answer::Allow).await.is_err());
            } else {
                reviewer
                    .answer(
                        id,
                        if case == "decline" {
                            Answer::Declined { reason: None }
                        } else {
                            Answer::Allow
                        },
                    )
                    .await?;
            }
            if hold {
                reached.notified().await;
                match case {
                    "lapsed" => advance_clock(ms),
                    "view blocked" => block.store(true, Ordering::SeqCst),
                    "worker revoked" => owner.join(member("worker", &["watch", "input"])).await?,
                    "approver revoked" => owner.join(member("reviewer", &["watch"])).await?,
                    _ => (),
                };
                release.notify_one();
            }
            owner.wait_idle().await?;
            let rows = owner.history().await?;
            let result = rows
                .iter()
                .find(|e| e["kind"] == "toolResult")
                .unwrap_or_else(|| panic!("served={served} case={case}: missing settlement"));
            assert_eq!(
                result["data"]["status"],
                match case {
                    "allow" => "completed",
                    "expired" | "lapsed" => "notStarted",
                    _ => "refused",
                },
                "served={served} case={case}"
            );
            assert_eq!(root.join("count").exists(), case == "allow");
            for (kind, n) in [
                ("inputRequest", 1),
                ("toolPending", 1),
                ("inputAnswer", 1),
                ("toolResult", 1),
                ("input", 1),
                ("turnStart", 2),
                ("toolStarted", usize::from(case == "allow")),
            ] {
                assert_eq!(
                    rows.iter().filter(|e| e["kind"] == kind).count(),
                    n,
                    "served={served} case={case} kind={kind}"
                );
            }
            let a = rows.iter().find(|e| e["kind"] == "inputAnswer").unwrap();
            assert!(a["data"].get("approvalView").is_none());
            if case == "expired" {
                assert_eq!(a["data"]["reason"], "timeLimit")
            } else if case != "decline" {
                assert_eq!(a["data"]["value"], "allow");
            }
            agent.close().await?;
            if let Some(s) = server {
                s.close().await;
            }
        }
    }
    Ok(())
}
