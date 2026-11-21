#![cfg(target_os = "linux")] // Needs Linux /proc, subreaper, and strong containment.
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

struct Probes {
    root: PathBuf,
    parallel: bool,
}
impl Plugin for Probes {
    fn name(&self) -> &str {
        "test.probes"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.provide::<dyn ToolSource>(
            "tools.probes",
            Arc::new(Self {
                root: self.root.clone(),
                parallel: self.parallel,
            }),
        )
    }
}
#[async_trait]
impl ToolSource for Probes {
    fn tools(&self, _: &SessionData) -> Vec<ToolDefinition> {
        ["safe", "finished", "never"]
            .into_iter()
            .map(|name| ToolDefinition {
                name: name.into(),
                description: "offline crash probe".into(),
                input: json!({}),
                read_only: name == "safe",
                safe_to_repeat: name == "safe",
                parallel: self.parallel,
                hints: json!({}),
            })
            .collect()
    }
    async fn run(&self, _: Api, _: Scope, call: ToolCall, _: CancellationToken) -> ToolResult {
        let path = self.root.join(&call.name);
        let count = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .parse::<usize>()
            .unwrap_or(0)
            + 1;
        std::fs::write(&path, count.to_string()).unwrap();
        if call.name == "safe" && count == 1 {
            std::fs::write(self.root.join("ready"), "safe started").unwrap();
            std::future::pending::<()>().await;
        }
        ToolResult::new(&call, ToolStatus::Completed, &call.name)
    }
}
#[tokio::test]
async fn crash_process_helper() {
    let Ok(root) = std::env::var("CRASH_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let durable = std::env::var("CRASH_RUNTIME").unwrap() == "durable";
    let case = std::env::var("CRASH_CASE").unwrap();
    let reopen = std::env::var("CRASH_ACTION").unwrap() == "reopen";
    let scripts = if reopen {
        vec![text("continued after crash")]
    } else {
        match case.as_str() {
            "safe" => vec![calls(vec![
                ToolCall::new("safe", json!({})),
                ToolCall::new("never", json!({})),
            ])],
            "parallel" => vec![calls(vec![
                ToolCall::new("safe", json!({})),
                ToolCall::new("finished", json!({})),
            ])],
            "model" => {
                let mut response = text("interrupted response");
                response.delay_ms = 60000;
                vec![response]
            }
            _ => vec![calls(vec![
                ToolCall::new("finished", json!({})),
                ToolCall::new(
                    "bash",
                    json!({"command":"echo $$ > shell; setsid bash -c 'echo $$ > escaped; sleep 60' & while ! test -s escaped; do sleep 0.01; done; echo started > ready; sleep 60"}),
                ),
                ToolCall::new("never", json!({})),
            ])],
        }
    };
    let fake = Arc::new(FakePlugin::new(scripts));
    let h = agent_base::compose(
        agent_base::Options {
            history: root.join("sessions"),
            global_config: root.join("settings"),
            key_file: root.join("NO-KEY"),
            secrets: vec![],
        },
        fake.clone(),
        Arc::new(interface_terminal::TerminalPlugin {
            sink: Arc::new(Events::default()),
        }),
        if durable {
            Arc::new(runtime_durable::DurablePlugin)
        } else {
            Arc::new(runtime_transient::TransientPlugin)
        },
    )
    .await
    .unwrap();
    h.load(Arc::new(Probes {
        root: root.clone(),
        parallel: case == "parallel",
    }))
    .await
    .unwrap();
    if reopen {
        let id = std::fs::read_to_string(root.join("session")).unwrap();
        h.open(&id).await.unwrap();
        let snapshot = h.snapshot(&id).unwrap();
        let requests = fake.probe.requests.lock().unwrap().clone();
        std::fs::write(
            root.join("report"),
            serde_json::to_vec(&json!({"data":snapshot,"requests":requests})).unwrap(),
        )
        .unwrap();
        h.close(&id).await.unwrap();
    } else {
        let id = h
            .create(&root, json!({"model":"fake","approval":"off"}))
            .await
            .unwrap();
        std::fs::write(root.join("session"), &id).unwrap();
        h.submit(&id, "user", "perform crash probes", Timing::Now, None)
            .await
            .unwrap();
        h.run_next(&id).await.unwrap();
        panic!("probe should have been killed");
    }
}
struct Process(std::process::Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn process(root: &Path, runtime: &str, case: &str, action: &str) -> Process {
    Process(
        std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "crash_process_helper", "--nocapture"])
            .env("CRASH_ROOT", root)
            .env("CRASH_RUNTIME", runtime)
            .env("CRASH_CASE", case)
            .env("CRASH_ACTION", action)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    )
}
async fn wait_for(mut check: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(8), async {
        while !check() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("crash test timed out");
}
fn snapshot(root: &Path) -> Option<SessionData> {
    let id = std::fs::read_to_string(root.join("session")).ok()?;
    history_fs::FileHistory::new(&root.join("sessions"))
        .ok()?
        .load(&id)
        .ok()
}
fn live(pid: i32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|s| {
            s.rsplit_once(')')
                .map(|(_, tail)| tail.trim().starts_with('Z') || tail.trim().starts_with('X'))
        })
        .is_some_and(|dead| !dead)
}
#[tokio::test]
async fn sigkill_mid_tool_proves_both_recovery_policies_and_setsid_containment() {
    // Adopt killed probes' descendants so tests never leave zombies to PID 1.
    assert_eq!(
        unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) },
        0
    );
    for runtime in ["transient", "durable"] {
        for case in ["unsafe", "safe", "parallel", "model"] {
            let root = TempDir::new().unwrap();
            let mut child = process(root.path(), runtime, case, "start");
            wait_for(|| {
                assert!(
                    child.0.try_wait().unwrap().is_none(),
                    "probe exited before SIGKILL"
                );
                let Some(data) = snapshot(root.path()) else {
                    return false;
                };
                if case == "model" {
                    return data.entries.iter().any(|e| e.kind == "model.request");
                }
                root.path().join("ready").exists()
                    && (case != "parallel" || data.entries.iter().any(|e| e.kind == "tool.result"))
            })
            .await;
            let pids = if case == "unsafe" {
                ["shell", "escaped"]
                    .iter()
                    .map(|name| {
                        std::fs::read_to_string(root.path().join(name))
                            .unwrap()
                            .trim()
                            .parse::<i32>()
                            .unwrap()
                    })
                    .collect::<Vec<_>>()
            } else {
                vec![]
            };
            if case == "unsafe" {
                assert!(pids.iter().all(|pid| live(*pid)));
                let stat = std::fs::read_to_string(format!("/proc/{}/stat", pids[1])).unwrap();
                let fields = stat
                    .rsplit_once(')')
                    .unwrap()
                    .1
                    .split_whitespace()
                    .collect::<Vec<_>>();
                assert_eq!(
                    fields[2].parse::<i32>().unwrap(),
                    pids[1],
                    "setsid child did not escape process group"
                );
            }
            child.0.kill().unwrap();
            child.0.wait().unwrap();
            wait_for(|| pids.iter().all(|pid| !live(*pid))).await;
            for pid in pids {
                unsafe {
                    libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG);
                }
            }
            let mut reopened = process(root.path(), runtime, case, "reopen");
            wait_for(|| reopened.0.try_wait().unwrap().is_some()).await;
            assert!(reopened.0.wait().unwrap().success());
            let report: Value =
                serde_json::from_slice(&std::fs::read(root.path().join("report")).unwrap())
                    .unwrap();
            let data: SessionData = serde_json::from_value(report["data"].clone()).unwrap();
            let ends = data
                .entries
                .iter()
                .filter(|e| e.kind == "turn.end")
                .collect::<Vec<_>>();
            assert_eq!(ends.len(), 1);
            assert_eq!(
                ends[0].content.as_ref().unwrap()["outcome"],
                if runtime == "durable" {
                    "completed"
                } else {
                    "failed"
                }
            );
            assert_eq!(
                report["requests"].as_array().unwrap().len(),
                usize::from(runtime == "durable")
            );
            let calls = data
                .entries
                .iter()
                .filter(|e| e.kind == "tool.call")
                .collect::<Vec<_>>();
            for call in calls {
                let results = data
                    .entries
                    .iter()
                    .filter(|e| e.kind == "tool.result" && e.scope.call == call.scope.call)
                    .collect::<Vec<_>>();
                assert_eq!(results.len(), 1);
                let result: ToolResult =
                    serde_json::from_value(results[0].content.clone().unwrap()).unwrap();
                let name = call.content.as_ref().unwrap()["name"].as_str().unwrap();
                let expected = match name {
                    "finished" => ToolStatus::Completed,
                    "bash" => ToolStatus::Unknown,
                    "safe" if runtime == "durable" => ToolStatus::Completed,
                    "safe" => ToolStatus::Unknown,
                    _ if runtime == "durable" => ToolStatus::Completed,
                    _ => ToolStatus::NotStarted,
                };
                assert_eq!(result.status, expected, "{runtime}/{case}/{name}");
                if result.status == ToolStatus::Unknown {
                    assert!(
                        result.text.contains("did not finish") && result.text.contains("Check")
                    );
                }
            }
            if case == "safe" || case == "parallel" {
                assert_eq!(
                    std::fs::read_to_string(root.path().join("safe")).unwrap(),
                    if runtime == "durable" { "2" } else { "1" }
                );
            }
            if case == "unsafe" || case == "parallel" {
                assert_eq!(
                    std::fs::read_to_string(root.path().join("finished")).unwrap(),
                    "1",
                    "completed tool repeated"
                );
            }
            assert_eq!(
                std::fs::read_dir(root.path().join("commands"))
                    .unwrap()
                    .filter_map(|e| e.ok())
                    .filter(|e| e
                        .path()
                        .extension()
                        .is_some_and(|v| v == "json" || v == "tmp"))
                    .count(),
                0,
                "startup cleanup left stale command records"
            );
        }
    }
}
