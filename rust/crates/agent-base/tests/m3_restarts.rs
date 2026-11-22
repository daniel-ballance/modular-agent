mod support;
use agent_api::*;
use provider_fake::FakePlugin;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use support::*;
use tempfile::TempDir;
// These probes use the local environment. Only the Linux implementation
// confirms cleanup after SIGKILL well enough to repeat a started call.
const CAN_REPEAT_STARTED_CALL: bool = cfg!(target_os = "linux");

struct Pause {
    root: PathBuf,
    before: bool,
}
impl Plugin for Pause {
    fn name(&self) -> &str {
        "test.pause"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        let root = self.root.clone();
        r.on(
            if self.before {
                "runtime.before.tool"
            } else {
                "runtime.after.tool"
            },
            Order::Last,
            handler(move |_, _, _| {
                let root = root.clone();
                Box::pin(async move {
                    std::fs::write(root.join("ready"), "paused")?;
                    std::future::pending::<Result<HookResult>>().await
                })
            }),
        );
        Ok(())
    }
}
async fn wait_for(mut check: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(8), async {
        while !check() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("restart probe timeout");
}
#[tokio::test]
async fn m3_process_helper() {
    let Ok(root) = std::env::var("M3_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let case = std::env::var("M3_CASE").unwrap();
    let runtime = std::env::var("M3_RUNTIME").unwrap();
    let durable_jobs = std::env::var("M3_JOBS").unwrap() == "durable";
    let reopen = std::env::var("M3_REOPEN").unwrap() == "yes";
    let is_job = matches!(case.as_str(), "job" | "job-done");
    let scripts = if reopen {
        if is_job {
            vec![
                text("child real result").for_task("job-child"),
                text("parent report described"),
            ]
        } else {
            vec![text("continued after answer")]
        }
    } else if case == "job-done" {
        vec![text("child result before crash").for_task("job-child")]
    } else if is_job {
        vec![
            calls(vec![ToolCall::new(
                "ask_user",
                json!({"question":"Child question?"}),
            )])
            .for_task("job-child"),
        ]
    } else {
        vec![calls(vec![ToolCall::new(
            if case == "revoked" {
                "write"
            } else {
                "ask_user"
            },
            if case == "revoked" {
                json!({"path":"forbidden","content":"bad"})
            } else {
                json!({"question":"Question?","timeout_ms":if case == "timeout" { json!(1) } else { Value::Null }})
            },
        )])]
    };
    let fake = Arc::new(FakePlugin::new(scripts));
    let events = Arc::new(Events::default());
    let h = agent_base::compose(
        agent_base::Options {
            history: root.join("sessions"),
            global_config: root.join("settings"),
            key_file: root.join("NO-KEY"),
            secrets: vec![],
        },
        fake.clone(),
        Arc::new(interface_terminal::TerminalPlugin {
            sink: events.clone(),
        }),
        if runtime == "durable" {
            Arc::new(runtime_durable::DurablePlugin)
        } else {
            Arc::new(runtime_transient::TransientPlugin)
        },
    )
    .await
    .unwrap();
    h.load(Arc::new(feature_subagents::SubagentsPlugin {
        durable: durable_jobs,
        replacement: true,
    }))
    .await
    .unwrap();
    if !reopen && matches!(case.as_str(), "answered" | "revoked") {
        h.load(Arc::new(Pause {
            root: root.clone(),
            before: case == "revoked",
        }))
        .await
        .unwrap();
    }
    let svc = requests(h.as_ref()).unwrap();
    if reopen {
        let id = std::fs::read_to_string(root.join("session")).unwrap();
        svc.presence(&id, "user", true);
        if CAN_REPEAT_STARTED_CALL
            && ((case == "open" && runtime == "durable") || (case == "job" && durable_jobs))
        {
            let h2 = h.clone();
            let svc2 = svc.clone();
            let id2 = id.clone();
            let events2 = events.clone();
            tokio::spawn(async move {
                events2.wait("request.opened").await;
                let q = svc2
                    .visible(h2.as_ref(), &id2, "user")
                    .unwrap()
                    .into_iter()
                    .find(|q| q.answerable)
                    .unwrap();
                svc2.answer(h2, &id2, "user", &q.id, json!("resumed answer"), false)
                    .await
                    .unwrap();
            });
        }
        h.open(&id).await.unwrap();
        if case == "timeout" {
            assert!(
                h.snapshot(&id)
                    .unwrap()
                    .entries
                    .iter()
                    .all(|e| e.kind != "tool.result")
            );
            let q = svc
                .visible(h.as_ref(), &id, "user")
                .unwrap()
                .into_iter()
                .find(|q| q.answerable)
                .unwrap();
            svc.answer(h.clone(), &id, "user", &q.id, json!("late answer"), false)
                .await
                .unwrap();
            h.run_next(&id).await.unwrap();
        }
        if is_job {
            let j = jobs(&h.snapshot(&id).unwrap()).unwrap().pop().unwrap();
            job_service(h.as_ref())
                .unwrap()
                .wait(h.clone(), &id, &j.id)
                .await
                .unwrap();
            if case == "job-done" {
                assert_eq!(
                    h.run_next(&id).await.unwrap().unwrap().text,
                    "parent report described"
                );
            }
        }
        std::fs::write(root.join("report"), serde_json::to_vec(&json!({"data":h.snapshot(&id).unwrap(),"events":*events.values.lock().unwrap(),"requests":*fake.probe.requests.lock().unwrap(),"questions":svc.visible(h.as_ref(), &id, "user").unwrap()})).unwrap()).unwrap();
        h.close(&id).await.unwrap();
    } else {
        let id = h.create(&root, json!({"model":"fake","approval":if case == "revoked" { "ask_always" } else { "off" }})).await.unwrap();
        std::fs::write(root.join("session"), &id).unwrap();
        svc.presence(&id, "user", true);
        if is_job {
            let rt: Arc<dyn Runtime> = capability(h.as_ref(), "runtime").unwrap();
            rt.tool(
                h.clone(),
                Scope::session(&id),
                ToolCall::new("delegate", json!({"task":"job-child"})),
            )
            .await
            .unwrap();
            if case == "job-done" {
                let j = jobs(&h.snapshot(&id).unwrap()).unwrap().pop().unwrap();
                job_service(h.as_ref())
                    .unwrap()
                    .wait(h.clone(), &id, &j.id)
                    .await
                    .unwrap();
            } else {
                events.wait("request.opened").await;
            }
            std::fs::write(root.join("ready"), "job waiting").unwrap();
        } else {
            h.submit(&id, "user", "start", Timing::Now, None)
                .await
                .unwrap();
            let h2 = h.clone();
            let id2 = id.clone();
            tokio::spawn(async move {
                h2.run_next(&id2).await.unwrap();
            });
            events.wait("request.opened").await;
            if matches!(case.as_str(), "answered" | "revoked") {
                let q = svc.visible(h.as_ref(), &id, "user").unwrap().pop().unwrap();
                svc.answer(
                    h.clone(),
                    &id,
                    "user",
                    &q.id,
                    json!(if case == "revoked" {
                        "allow"
                    } else {
                        "saved answer"
                    }),
                    false,
                )
                .await
                .unwrap();
                wait_for(|| root.join("ready").exists()).await;
                if case == "revoked" {
                    let mut cap = Authority::full();
                    cap.0.remove("approve");
                    h.grant(&Scope::session(&id), "user", cap).unwrap();
                }
            } else if case == "timeout" {
                wait_for(|| !h.is_running(&id)).await;
            }
            std::fs::write(root.join("ready-to-kill"), "ready").unwrap();
        }
        if is_job {
            std::fs::write(root.join("ready-to-kill"), "ready").unwrap();
        }
        std::future::pending::<()>().await;
    }
}
struct Process(std::process::Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn process(root: &Path, runtime: &str, case: &str, durable_jobs: bool, reopen: bool) -> Process {
    Process(
        std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "m3_process_helper", "--nocapture"])
            .env("M3_ROOT", root)
            .env("M3_CASE", case)
            .env("M3_RUNTIME", runtime)
            .env(
                "M3_JOBS",
                if durable_jobs { "durable" } else { "transient" },
            )
            .env("M3_REOPEN", if reopen { "yes" } else { "no" })
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    )
}
async fn crash_and_reopen(runtime: &str, case: &str, durable_jobs: bool) -> (TempDir, Value) {
    let root = TempDir::new().unwrap();
    let mut child = process(root.path(), runtime, case, durable_jobs, false);
    wait_for(|| {
        assert!(child.0.try_wait().unwrap().is_none(), "start probe exited");
        root.path().join("ready-to-kill").exists()
    })
    .await;
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    let mut second = process(root.path(), runtime, case, durable_jobs, true);
    let mut status = None;
    wait_for(|| {
        status = second.0.try_wait().unwrap();
        status.is_some()
    })
    .await;
    assert!(status.unwrap().success(), "reopen probe failed");
    let report =
        serde_json::from_slice(&std::fs::read(root.path().join("report")).unwrap()).unwrap();
    (root, report)
}
#[tokio::test]
async fn sigkill_after_report_commit_restores_input_and_starts_one_parent_turn() {
    for runtime in ["transient", "durable"] {
        let (_, report) = crash_and_reopen(runtime, "job-done", true).await;
        let data: SessionData = serde_json::from_value(report["data"].clone()).unwrap();
        assert_eq!(
            data.entries.iter().filter(|e| e.kind == "job.end").count(),
            1
        );
        assert_eq!(
            data.entries
                .iter()
                .filter(|e| e.kind == "turn.start")
                .count(),
            1
        );
        assert_eq!(data.entries.iter().filter(|e| e.kind == "input").count(), 1);
        let turn = data
            .entries
            .iter()
            .find(|e| e.kind == "turn.start")
            .unwrap();
        assert!(turn.scope.actor.starts_with("job:"));
    }
}
#[tokio::test]
async fn sigkill_open_question_reasks_with_durable_and_closes_with_transient() {
    for runtime in ["transient", "durable"] {
        let (_, report) = crash_and_reopen(runtime, "open", true).await;
        let events = report["events"].as_array().unwrap();
        let can_reask = runtime == "durable" && CAN_REPEAT_STARTED_CALL;
        assert_eq!(
            events.iter().any(|e| e["kind"] == "request.opened"),
            can_reask
        );
        let data: SessionData = serde_json::from_value(report["data"].clone()).unwrap();
        assert!(questions(&data).unwrap().iter().all(|q| !q.answerable));
        let result = data
            .entries
            .iter()
            .find(|e| e.kind == "tool.result")
            .unwrap()
            .content
            .as_ref()
            .unwrap();
        assert_eq!(
            result["status"],
            if can_reask { "completed" } else { "unknown" }
        );
    }
}
#[tokio::test]
async fn sigkill_saved_answer_is_reused_but_revoked_approval_is_not() {
    for case in ["answered", "revoked"] {
        let (root, report) = crash_and_reopen("durable", case, true).await;
        let data: SessionData = serde_json::from_value(report["data"].clone()).unwrap();
        let results: Vec<_> = data
            .entries
            .iter()
            .filter(|e| e.kind == "tool.result")
            .collect();
        assert_eq!(results.len(), 1);
        assert_eq!(
            results[0].content.as_ref().unwrap()["status"],
            match case {
                "answered" if CAN_REPEAT_STARTED_CALL => "completed",
                "answered" => "unknown",
                _ => "refused",
            }
        );
        assert!(
            !report["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["kind"] == "request.opened")
        );
        assert!(!root.path().join("forbidden").exists());
        assert_eq!(
            data.entries
                .iter()
                .filter(|e| e.kind == "request.open")
                .count(),
            if case == "answered" { 1 } else { 2 }
        );
    }
}
#[tokio::test]
async fn sigkill_questions_already_past_their_turn_survive_with_either_runtime() {
    for runtime in ["transient", "durable"] {
        let (_, report) = crash_and_reopen(runtime, "timeout", true).await;
        let data: SessionData = serde_json::from_value(report["data"].clone()).unwrap();
        assert_eq!(
            data.entries
                .iter()
                .filter(|e| e.kind == "tool.result")
                .count(),
            1
        );
        assert_eq!(
            data.entries
                .iter()
                .filter(|e| e.kind == "turn.start")
                .count(),
            2
        );
    }
}
#[tokio::test]
async fn sigkill_subagents_report_unknown_or_resume_real_result_with_either_parent_runtime() {
    for runtime in ["transient", "durable"] {
        for durable in [false, true] {
            let (_, report) = crash_and_reopen(runtime, "job", durable).await;
            let data: SessionData = serde_json::from_value(report["data"].clone()).unwrap();
            let j = jobs(&data).unwrap().pop().unwrap();
            assert_eq!(
                j.state,
                if durable {
                    JobState::Completed
                } else {
                    JobState::Unknown
                }
            );
            assert!(
                data.entries
                    .iter()
                    .any(|e| e.kind == "input.accepted" && e.scope.job.as_ref() == Some(&j.id))
            );
            if durable {
                assert_eq!(j.result.unwrap().text, "child real result");
            } else {
                assert!(j.result.unwrap().error.unwrap().contains("unknown"));
            }
            assert!(
                report["questions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|q| q["answerable"] == false)
            );
        }
    }
}
