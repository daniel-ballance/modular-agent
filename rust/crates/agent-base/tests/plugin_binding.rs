mod support;
use agent_api::*;
use agent_harness::Harness;
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use support::Events;
use tokio::sync::Notify;

// Run the supplied kits one at a time without serializing the other tests.
static KIT_RUN: Mutex<()> = Mutex::new(());

fn executable() -> &'static str {
    env!("CARGO_BIN_EXE_modular-agent")
}
fn conformance(parts: &str) -> plugin_stdio::Launch {
    plugin_stdio::Launch {
        command: vec![executable().into(), "--serve-plugin".into()],
        env: BTreeMap::from([("MODULAR_AGENT_PLUGIN_PARTS".into(), parts.into())]),
        config: json!({}),
    }
}
fn tool(name: &str) -> Value {
    json!({"name":name,"description":"fixture","parameters":{"type":"object"},"hints":{"safeToRepeat":true}})
}
fn fixture(config: Value) -> plugin_stdio::Launch {
    plugin_stdio::Launch {
        command: vec![
            "python3".into(),
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../scripts/plugin-fixture.py")
                .canonicalize()
                .unwrap()
                .display()
                .to_string(),
        ],
        env: BTreeMap::new(),
        config,
    }
}
struct Rig {
    h: Arc<Harness>,
    root: tempfile::TempDir,
    project: tempfile::TempDir,
    events: Arc<Events>,
    probe: Arc<provider_fake::Probe>,
}
impl Rig {
    async fn new(scripts: Vec<provider_fake::Script>) -> Self {
        let root = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let events = Arc::new(Events::default());
        let provider = Arc::new(provider_fake::FakePlugin::new(scripts));
        let probe = provider.probe.clone();
        let h = agent_base::vanilla(
            agent_base::Options {
                history: root.path().join("sessions"),
                global_config: root.path().join("settings.json"),
                key_file: root.path().join("no-key"),
                secrets: vec![],
            },
            provider,
            Arc::new(interface_terminal::TerminalPlugin {
                sink: events.clone(),
            }),
        )
        .await
        .unwrap();
        Self {
            h,
            root,
            project,
            events,
            probe,
        }
    }
    async fn load(
        &self,
        launch: plugin_stdio::Launch,
        index: usize,
    ) -> Result<Arc<plugin_stdio::Remote>> {
        plugin_stdio::load(
            &self.h,
            launch,
            self.project.path(),
            &self.root.path().join(format!("plugin-{index}")),
            index,
        )
        .await
    }
    async fn session(&self, model: &str) -> String {
        self.h
            .create(self.project.path(), json!({"model":model,"approval":"off"}))
            .await
            .unwrap()
    }
    async fn turn(&self, id: &str, text: &str) -> TurnResult {
        self.h
            .submit(id, "user", text, Timing::Now, None)
            .await
            .unwrap();
        self.h.run_next(id).await.unwrap().unwrap()
    }
    async fn end(&self, id: &str) {
        self.h.close(id).await.unwrap();
        self.h.shutdown().await.unwrap();
    }
}
#[tokio::test]
#[cfg_attr(
    not(target_os = "linux"),
    ignore = "requires Linux process inspection or strong containment"
)]
async fn closing_plugin_stdin_joins_a_running_command_and_its_setsid_descendant() {
    use std::io::{BufRead, Write};
    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let project = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let mut child = Child(
        std::process::Command::new(executable())
            .arg("--serve-plugin")
            .env("MODULAR_AGENT_PLUGIN_PARTS", "environment")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap(),
    );
    let mut output = std::io::BufReader::new(child.0.stdout.take().unwrap());
    writeln!(child.0.stdin.as_mut().unwrap(),"{}",json!({"jsonrpc":"2.0","id":1,"method":"plugin/initialize","params":{"binding":"modular-agent-plugin/1","data":"modular-agent-data/1","host":{"name":"test","version":"1"},"project":project.path(),"home":home.path(),"config":{}}})).unwrap();
    let mut initialized = String::new();
    output.read_line(&mut initialized).unwrap();
    assert!(
        serde_json::from_str::<Value>(&initialized).unwrap()["result"]["workingEnvironment"]
            .is_object()
    );
    let pid_file = project.path().join("pid");
    let command = format!(
        "setsid sleep 60 & echo $! > {}; sleep 60",
        pid_file.display()
    );
    writeln!(child.0.stdin.as_mut().unwrap(),"{}",json!({"jsonrpc":"2.0","id":2,"method":"env/exec","params":{"sessionId":"close-test","cwd":project.path(),"command":command}})).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while !pid_file.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let pid: libc::pid_t = std::fs::read_to_string(pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    drop(child.0.stdin.take());
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while child.0.try_wait().unwrap().is_none() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let alive = unsafe { libc::kill(pid, 0) } == 0;
    if alive {
        unsafe { libc::kill(pid, libc::SIGKILL) };
    }
    assert!(!alive, "plugin left a descendant after EOF: {pid}");
}
#[test]
fn supplied_plugin_kit_is_mandatory() {
    let _kit = KIT_RUN.lock().unwrap_or_else(|e| e.into_inner());
    let home = tempfile::tempdir().unwrap();
    let output = std::process::Command::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/plugin/run.mjs"))
        .args(["--", executable(), "--serve-plugin"])
        .env("HOME", home.path())
        .env_remove("MODULAR_AGENT_PLUGINS")
        .env_remove("MODULAR_AGENT_PLUGIN_PARTS")
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    // The kit checks setsid escapees only when the environment declares strong containment.
    let expected = if cfg!(target_os = "macos") {
        "145/145 checks passed"
    } else {
        "146/146 checks passed"
    };
    assert!(stdout.contains(expected), "{stdout}");
}
#[test]
fn supplied_acp_kit_with_two_external_plugins_is_mandatory() {
    let _kit = KIT_RUN.lock().unwrap_or_else(|e| e.into_inner());
    let home = tempfile::tempdir().unwrap();
    let plugins = json!([{"command":[executable(),"--serve-plugin"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"provider,hooks"}},{"command":[executable(),"--serve-plugin"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":"tools,environment"}}]);
    let output = std::process::Command::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/acp/run.mjs"))
        .args([
            "--plugin-checks",
            "--job-checks",
            "--",
            executable(),
            "--acp",
        ])
        .env("HOME", home.path())
        .env("MODULAR_AGENT_PLUGINS", plugins.to_string())
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(stdout.contains("132/132 checks passed"), "{stdout}");
}
#[test]
fn supplied_acp_crash_kit_with_native_runtime() {
    acp_crash_kit(None);
}
#[test]
fn supplied_acp_crash_kit_with_external_durable_runtime() {
    acp_crash_kit(Some("durable-runtime"));
}
#[test]
fn supplied_acp_crash_kit_with_external_transient_runtime() {
    acp_crash_kit(Some("runtime"));
}
fn acp_crash_kit(part: Option<&str>) {
    let _kit = KIT_RUN.lock().unwrap_or_else(|e| e.into_inner());
    let home = tempfile::tempdir().unwrap();
    let mut cmd = std::process::Command::new("node");
    cmd.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/acp/run.mjs"))
        .args(["--crash-checks", "--", executable(), "--acp"])
        .env("HOME", home.path())
        .env_remove("MODULAR_AGENT_PLUGINS");
    if let Some(part) = part {
        cmd.env("MODULAR_AGENT_PLUGINS", json!([{"command":[executable(),"--serve-plugin"],"env":{"MODULAR_AGENT_PLUGIN_PARTS":part}}]).to_string());
    }
    let output = cmd.output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    // A Runtime served from another process does not run nested calls, so
    // the agent does not declare them and the kit leaves those checks out.
    let expected = if part.is_some() {
        "111/111 checks passed"
    } else {
        "123/123 checks passed"
    };
    assert!(stdout.contains(expected), "{stdout}");
}
#[tokio::test]
async fn replacements_leave_local_items_out_and_route_tools_to_a_third_process() {
    let rig = Rig::new(vec![]).await;
    rig.h
        .load(Arc::new(provider_fake::ConformancePlugin))
        .await
        .unwrap();
    let local_provider: Arc<dyn Provider> =
        capability(rig.h.as_ref(), "provider.conformance").unwrap();
    let local_environment: Arc<dyn WorkingEnvironment> =
        capability(rig.h.as_ref(), "environment").unwrap();
    let p = rig.load(conformance("provider,hooks"), 0).await.unwrap();
    let t = rig.load(conformance("tools"), 1).await.unwrap();
    let e = rig.load(conformance("environment"), 2).await.unwrap();
    let remote_provider: Arc<dyn Provider> =
        capability(rig.h.as_ref(), "provider.conformance").unwrap();
    let remote_environment: Arc<dyn WorkingEnvironment> =
        capability(rig.h.as_ref(), "environment").unwrap();
    assert!(!Arc::ptr_eq(&local_provider, &remote_provider));
    assert!(!Arc::ptr_eq(&local_environment, &remote_environment));
    let id = rig.session("conformance/echo").await;
    let local: Arc<dyn ToolSource> = capability(rig.h.as_ref(), "tools.builtin").unwrap();
    let names = local
        .tools(&rig.h.snapshot(&id).unwrap())
        .into_iter()
        .map(|t| t.name)
        .collect::<Vec<_>>();
    assert_eq!(names, ["write", "edit"]);
    let excluded = local
        .run(
            rig.h.clone(),
            Scope::session(&id),
            ToolCall::new("read", json!({"path":"AGENTS.md"})),
            CancellationToken::new(),
        )
        .await;
    assert_eq!(excluded.status, ToolStatus::NotStarted);
    assert_eq!(rig.turn(&id, "hello").await.text, "echo: hello");
    assert!(
        rig.h
            .snapshot(&id)
            .unwrap()
            .entries
            .iter()
            .find(|e| e.kind == "turn.start")
            .unwrap()
            .content
            .as_ref()
            .unwrap()["system"]
            .as_str()
            .unwrap()
            .contains("The conformance plugin is loaded.")
    );
    std::fs::write(rig.project.path().join("read.txt"), "shared env").unwrap();
    assert_eq!(
        rig.turn(&id, "tool:read {\"path\":\"read.txt\"}")
            .await
            .text,
        "done: shared env"
    );
    assert_eq!(
        rig.turn(
            &id,
            "tool:bash {\"command\":\"printf three-process > proof; cat proof\"}"
        )
        .await
        .text,
        "done: three-process\n[exit code 0]"
    );
    assert_eq!(
        std::fs::read_to_string(rig.project.path().join("proof")).unwrap(),
        "three-process"
    );
    assert_eq!(
        rig.turn(
            &id,
            "tool:bash {\"command\":\"echo conformance-forbidden > forbidden\"}"
        )
        .await
        .outcome,
        Outcome::Completed
    );
    assert!(!rig.project.path().join("forbidden").exists());
    rig.end(&id).await;
    p.shutdown().await.unwrap();
    t.shutdown().await.unwrap();
    e.shutdown().await.unwrap();
}
#[tokio::test]
async fn collisions_and_failed_replacements_roll_back_without_shadowing() {
    let rig = Rig::new(vec![]).await;
    let original: Arc<dyn WorkingEnvironment> = capability(rig.h.as_ref(), "environment").unwrap();
    let collision =
        fixture(json!({"registration":{"toolSources":[{"id":"fixture","tools":[tool("read")]}]}}));
    assert!(rig.load(collision, 0).await.is_err());
    let unsupported = fixture(
        json!({"registration":{"hooks":[{"hook":"unknown.hook","handlerId":1}],"workingEnvironment":{"containment":"none","platforms":["linux"]},"replaces":["working-environment"]}}),
    );
    assert!(rig.load(unsupported, 1).await.is_err());
    let current: Arc<dyn WorkingEnvironment> = capability(rig.h.as_ref(), "environment").unwrap();
    assert!(Arc::ptr_eq(&original, &current));
    rig.load(conformance("tools"), 2).await.unwrap();
    assert!(
        rig.load(conformance("tools"), 3).await.is_err(),
        "a second external plugin must not replace another external one"
    );
    rig.h.shutdown().await.unwrap();
}
fn output_gate(mode: &str) -> plugin_stdio::Launch {
    fixture(json!({"mode":mode,"registration":{"hooks":[{"hook":"output","handlerId":1}]}}))
}

#[tokio::test]
async fn output_gate_numeric_echo_keeps_acp_history_and_replay() {
    use support::acp::rpc;
    let mut rig = support::acp::Rig::new(json!(["reply to replay"]));
    let gate = output_gate("numeric-output-echo");
    rig.plugins = json!([{"command":gate.command,"config":gate.config}]);
    let cwd = rig.project.path().to_path_buf();
    let events = rig.events.clone();
    rig.client(Some(true), false, async move |cx| {
        let new = rpc(&cx, "session/new", json!({"cwd":cwd,"mcpServers":[]})).await?;
        let id = &new["sessionId"];
        rpc(
            &cx,
            "session/prompt",
            json!({"sessionId":id,"prompt":[{"type":"text","text":"input to replay"}]}),
        )
        .await?;
        let history = rpc(&cx, "_modular-agent/history", json!({"sessionId":id})).await?;
        let kinds: Vec<_> = history["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|e| e["kind"].as_str())
            .collect();
        for kind in ["input", "turnStart", "response", "turnEnd"] {
            assert!(kinds.contains(&kind), "missing {kind} in {kinds:?}");
        }
        rpc(&cx, "session/close", json!({"sessionId":id})).await?;
        events.lock().unwrap().clear();
        rpc(
            &cx,
            "session/load",
            json!({"sessionId":id,"cwd":cwd,"mcpServers":[]}),
        )
        .await?;
        let replay = std::mem::take(&mut *events.lock().unwrap());
        for (kind, text) in [
            ("user_message_chunk", "input to replay"),
            ("agent_message_chunk", "reply to replay"),
        ] {
            assert!(
                replay
                    .iter()
                    .any(|event| event["update"]["sessionUpdate"] == kind
                        && event["update"]["content"]["text"] == text),
                "missing {kind} in {replay:?}"
            );
        }
        rpc(&cx, "session/close", json!({"sessionId":id})).await?;
        Ok(())
    })
    .await;
}

#[tokio::test]
async fn output_gate_redacts_live_turn_end_entries_without_rebuilding_the_turn() {
    let rig = Rig::new(vec![support::text("original reply")]).await;
    rig.load(output_gate("redact-turn-end"), 0).await.unwrap();
    let id = rig.session("fake").await;
    assert_eq!(rig.turn(&id, "work").await.text, "original reply");
    let record = rig
        .h
        .snapshot(&id)
        .unwrap()
        .entries
        .into_iter()
        .find(|e| e.kind == "turn.end")
        .unwrap();
    let mut expected = json!(record);
    expected["content"]["text"] = json!("[redacted]");
    {
        let entries = rig.events.values.lock().unwrap();
        let entry = entries
            .iter()
            .find(|e| e.kind == "history.entry" && e.content["id"] == record.id)
            .expect("the gate must not drop the turnEnd entry");
        assert_eq!(entry.content, expected);
    }
    rig.end(&id).await;
}

#[tokio::test]
async fn unused_acp_session_closes_after_an_external_rewind_replaces_the_project() {
    let mut rig = support::acp::Rig::new(json!(["first reply", "second reply"]));
    rig.launch_in_project = true;
    let point = "_Wy4O1zpUCfMO9hPL6Y-9aoO";
    let log = rig.root.path().join("environment.jsonl");
    let environment = fixture(json!({
        "log":log,
        "points":["first_point",point,"rollback-point"],
        "readError":{"code":"not_found","message":"file not found"},
        "replaceProjectOnRestore":true,
        "registration":{
            "workingEnvironment":{"containment":"processGroup","platforms":["linux"],"points":true},
            "hooks":[{"hook":"plugin.load","handlerId":1}],
            "replaces":["working-environment"]
        }
    }));
    rig.plugins = json!([{"command":environment.command,"config":environment.config}]);

    let cwd = rig.project.path().to_path_buf();
    let sessions = rig.root.path().join("sessions");
    rig.client(Some(true), false, async move |cx| {
        use support::acp::rpc;
        let new = || rpc(&cx, "session/new", json!({"cwd":cwd,"mcpServers":[]}));
        let used = new().await?;
        let used_id = &used["sessionId"];
        let prompt = |text| {
            rpc(
                &cx,
                "session/prompt",
                json!({
                    "sessionId":used_id,"prompt":[{"type":"text","text":text}]
                }),
            )
        };
        let history = || rpc(&cx, "_modular-agent/history", json!({"sessionId":used_id}));
        assert_eq!(prompt("one").await?["stopReason"], "end_turn");
        let before = history().await?;
        let mark = &before["entries"].as_array().unwrap().last().unwrap()["id"];
        assert_eq!(prompt("two").await?["stopReason"], "end_turn");
        assert!(
            history().await?["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| { e["kind"] == "turnStart" && e["data"]["point"] == point })
        );
        rpc(
            &cx,
            "_modular-agent/move",
            json!({"sessionId":used_id,"entryId":mark,"rewind":true}),
        )
        .await?;

        let unused = new().await?;
        let unused_id = &unused["sessionId"];
        rpc(&cx, "session/close", json!({"sessionId":unused_id})).await?;
        assert!(
            !sessions
                .join(format!("{}.json", unused_id.as_str().unwrap()))
                .exists()
        );
        let listed = rpc(&cx, "session/list", json!({"cwd":cwd})).await?;
        assert_eq!(listed["sessions"], json!([{"sessionId":used_id,"cwd":cwd}]));
        rpc(&cx, "session/close", json!({"sessionId":used_id})).await?;

        let requests = std::fs::read_to_string(log)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert!(
            requests
                .iter()
                .any(|r| r["method"] == "env/read" && r["params"]["path"] == "AGENTS.md")
        );
        assert!(
            requests
                .iter()
                .any(|r| r["method"] == "env/restore" && r["params"]["point"] == point)
        );
        assert!(requests.iter().any(|r| r["method"] == "hook/handle"
            && r["params"]["hook"] == "plugin.load"
            && r["params"]["payload"]["project"] == json!(cwd)));
        let unused_methods = requests
            .iter()
            .filter(|r| r["params"]["sessionId"] == *unused_id)
            .map(|r| r["method"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(unused_methods, ["env/sessionEnded"]);
        Ok(())
    })
    .await;
}
#[tokio::test]
async fn missing_agents_file_allows_a_turn_with_local_and_external_environments() {
    for external in [false, true] {
        let rig = Rig::new(vec![support::text("completed without instructions")]).await;
        if external {
            rig.load(
                fixture(json!({
                    "readError":{"code":"not_found","message":"aucun document disponible"},
                    "registration":{
                        "workingEnvironment":{"containment":"none","platforms":["linux"]},
                        "replaces":["working-environment"]
                    }
                })),
                0,
            )
            .await
            .unwrap();
        }
        let id = rig.session("fake").await;
        let result = rig.turn(&id, "hello").await;
        rig.end(&id).await;
        assert_eq!(
            result.outcome,
            Outcome::Completed,
            "external={external}: {result:?}"
        );
        assert_eq!(result.text, "completed without instructions");
    }
}
#[tokio::test]
async fn agents_read_failures_are_not_missing_files_even_when_the_message_says_so() {
    for environment in ["local", "internal", "not_supported"] {
        let rig = Rig::new(vec![provider_fake::Script::response(ModelResponse::text(
            "prepared",
        ))])
        .await;
        if environment == "local" {
            std::fs::create_dir(rig.project.path().join("AGENTS.md")).unwrap();
        } else {
            rig.load(
                fixture(json!({
                    "readError":{"code":environment,"message":"No such file or directory (os error 2)"},
                    "registration":{
                        "workingEnvironment":{"containment":"none","platforms":["linux"]},
                        "replaces":["working-environment"]
                    }
                })),
                0,
            )
            .await
            .unwrap();
        }
        let id = rig.session("fake").await;
        let result = rig.turn(&id, "hello").await;
        rig.end(&id).await;
        if environment == "not_supported" {
            assert_eq!(result.outcome, Outcome::Completed);
            assert_eq!(result.text, "prepared");
            assert_eq!(rig.probe.requests.lock().unwrap().len(), 1);
        } else {
            assert_eq!(result.outcome, Outcome::Failed, "{environment}: {result:?}");
            assert!(rig.probe.requests.lock().unwrap().is_empty());
        }
    }
}
#[tokio::test]
async fn forwarding_missing_reads_returns_not_found_from_local_and_external_environments() {
    for environment in ["local", "served", "fixture"] {
        let rig = Rig::new(vec![]).await;
        match environment {
            "served" => {
                rig.load(conformance("environment"), 0).await.unwrap();
            }
            "fixture" => {
                rig.load(
                    fixture(json!({
                        "readError":{"code":"not_found","message":"aucun document disponible"},
                        "registration":{
                            "name":"fixture-environment",
                            "workingEnvironment":{"containment":"none","platforms":["linux"]},
                            "replaces":["working-environment"]
                        }
                    })),
                    0,
                )
                .await
                .unwrap();
            }
            _ => {}
        }
        rig.load(
            fixture(json!({"mode":"read","registration":{
                "toolSources":[{"id":"fixture","tools":[tool("probe")]}]
            }})),
            1,
        )
        .await
        .unwrap();
        let id = rig.session("fake").await;
        let runtime: Arc<dyn Runtime> = capability(rig.h.as_ref(), "runtime").unwrap();
        let result = runtime
            .tool(
                rig.h.clone(),
                Scope::session(&id),
                ToolCall::new("probe", json!({"path":"AGENTS.md"})),
            )
            .await
            .unwrap();
        rig.end(&id).await;
        assert_eq!(result.status, ToolStatus::Completed, "{}", result.text);
        let reply: Value = serde_json::from_str(&result.text).unwrap();
        assert_eq!(
            reply["error"]["data"]["code"], "not_found",
            "{environment}: {reply}"
        );
    }
}
#[tokio::test]
async fn a_refused_tool_result_tells_the_model_that_the_call_did_not_run_and_why() {
    for served in [false, true] {
        let call = ToolCall::new("write", json!({"path":"forbidden","content":"no"}));
        let rig = Rig::new(vec![
            support::calls(vec![call.clone()]),
            support::text("done"),
        ])
        .await;
        if served {
            rig.load(conformance("durable-runtime"), 0).await.unwrap();
        }
        let id = rig.session("fake").await;
        rig.h
            .grant(
                &Scope::session(&id),
                "guest",
                Authority::only(&["watch", "input"]),
            )
            .unwrap();
        rig.h
            .submit(&id, "guest", "start", Timing::Now, None)
            .await
            .unwrap();
        let turn = rig.h.run_next(&id).await.unwrap().unwrap();
        assert_eq!(
            turn.outcome,
            Outcome::Completed,
            "served={served}: {turn:?}"
        );
        let data = rig.h.snapshot(&id).unwrap();
        let requests = rig.probe.requests.lock().unwrap().clone();
        rig.end(&id).await;

        let entry = data
            .entries
            .iter()
            .find(|e| e.kind == "tool.result" && e.scope.call.as_ref() == Some(&call.id))
            .unwrap();
        let shared = portable::entry(entry, &data).unwrap();
        assert_eq!(shared["data"]["status"], "refused");
        assert!(!rig.project.path().join("forbidden").exists());
        let expected = "The call was refused and did not run: actor lacks tools authority";
        assert_eq!(
            shared["message"]["content"],
            json!([{"type":"text","text":expected}])
        );
        let result = requests[1]
            .messages
            .iter()
            .find(|m| m.role == "tool" && m.call.as_ref() == Some(&call.id))
            .unwrap();
        assert!(result.text_content().contains(expected), "{result:?}");
    }
}

struct RefuseDraft;
impl Plugin for RefuseDraft {
    fn name(&self) -> &str {
        "test.refuse-draft"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.on(
            "runtime.result.ready",
            Order::Normal,
            handler(|_, _, value| {
                Box::pin(async move {
                    if value["text"] == "draft" {
                        Ok(HookResult {
                            refused: Some("Try a checked result.".into()),
                            ..HookResult::default()
                        })
                    } else {
                        Ok(answer(value))
                    }
                })
            }),
        );
        Ok(())
    }
}

#[tokio::test]
async fn result_feedback_is_committed_once_and_only_projected_into_the_retry() {
    for served in [false, true] {
        let rig = Rig::new(vec![
            support::text("draft"),
            support::text("checked"),
            support::text("later"),
        ])
        .await;
        if served {
            rig.load(conformance("durable-runtime"), 0).await.unwrap();
        }
        rig.h.load(Arc::new(RefuseDraft)).await.unwrap();
        let session = rig.session("fake").await;
        assert_eq!(rig.turn(&session, "start").await.text, "checked");
        assert_eq!(rig.turn(&session, "new turn").await.text, "later");
        let requests = rig.probe.requests.lock().unwrap().clone();
        let history = rig.h.snapshot(&session).unwrap();
        rig.end(&session).await;
        let feedback = history
            .entries
            .iter()
            .filter(|e| e.kind == "resultFeedback")
            .collect::<Vec<_>>();
        assert_eq!(feedback.len(), 1);
        let projected = portable::entry(feedback[0], &history).unwrap();
        assert_eq!(projected["data"], json!({"reason":"Try a checked result."}));
        let attempts = history
            .entries
            .iter()
            .filter(|e| e.kind == "model.request")
            .collect::<Vec<_>>();
        assert!(attempts[1].copies.contains(&feedback[0].id));
        assert!(!attempts[2].copies.contains(&feedback[0].id));
        assert_eq!(
            requests[1]
                .messages
                .iter()
                .filter(|m| m.role == "user" && m.text_content() == "Try a checked result.")
                .count(),
            1
        );
        assert!(
            !requests[2]
                .messages
                .iter()
                .any(|m| m.text_content() == "Try a checked result.")
        );
    }
}

#[tokio::test]
async fn tenant_usage_stops_at_a_step_and_carries_across_sessions_and_reopen() {
    for remote in [false, true] {
        let mut response =
            ModelResponse::calls(vec![ToolCall::new("read", json!({"path":"missing"}))]);
        response.usage.input_tokens = 3;
        response.usage.output_tokens = 2;
        let rig = Rig::new(vec![provider_fake::Script::response(response)]).await;
        if remote {
            rig.load(conformance("durable-runtime"), 0).await.unwrap();
        }
        rig.h
            .configure_tenants(Some(
                r#"{"team":{"rights":["watch","input","tools"],"tokens":5}}"#,
            ))
            .unwrap();
        let settings = json!({"model":"fake","approval":"off","thinking":"xhigh"});
        let a = rig
            .h
            .create_in_tenant(rig.project.path(), settings.clone(), Some("team"))
            .await
            .unwrap();
        let b = rig
            .h
            .create_in_tenant(rig.project.path(), settings, Some("team"))
            .await
            .unwrap();
        assert_eq!(rig.h.snapshot(&a).unwrap().entries[0].kind, "tenant");
        let first = rig.turn(&a, "use budget").await;
        assert_eq!(first.outcome, Outcome::Limit);
        assert_eq!(first.limit.as_deref(), Some("tenantTokens"));
        assert_eq!(rig.probe.requests.lock().unwrap()[0].thinking, "high");
        rig.h.close(&a).await.unwrap();
        let capped = rig.turn(&b, "cannot start a model request").await;
        assert_eq!(capped.limit.as_deref(), Some("tenantTokens"));
        assert!(
            !rig.h
                .snapshot(&b)
                .unwrap()
                .entries
                .iter()
                .any(|e| e.kind == "model.request" || e.kind == "model.response")
        );
        assert_eq!(
            rig.h.tenant(&b).unwrap()["tokens"],
            json!({"budget":5,"used":5})
        );
        assert_eq!(rig.probe.requests.lock().unwrap().len(), 1);
        rig.h.open(&a).await.unwrap();
        assert_eq!(rig.h.tenant(&a).unwrap()["tokens"]["used"], 5);
        rig.h.close(&a).await.unwrap();
        rig.end(&b).await;
    }
}

#[tokio::test]
async fn rewind_restores_files_reports_open_world_calls_and_rejects_other_branches() {
    let rig = Rig::new(vec![]).await;
    let mut probe = tool("probe");
    probe["hints"]["openWorld"] = json!(true);
    rig.load(
        fixture(json!({"registration":{"toolSources":[{"id":"fixture","tools":[probe]}]}})),
        0,
    )
    .await
    .unwrap();
    let id = rig.session("fake").await;
    let scope = Scope::session(&id);
    let mark = rig.h.snapshot(&id).unwrap().position.unwrap();
    let path = rig.project.path().join("state.txt");
    std::fs::write(&path, "before").unwrap();
    let runtime: Arc<dyn Runtime> = capability(rig.h.as_ref(), "runtime").unwrap();
    let call = ToolCall::new("probe", json!({}));
    let call_id = call.id.clone();
    runtime
        .tool(rig.h.clone(), scope.clone(), call)
        .await
        .unwrap();
    let later = rig.h.snapshot(&id).unwrap().position.unwrap();
    std::fs::write(&path, "after").unwrap();
    assert_eq!(
        rig.h.rewind(&scope, mark.clone()).await.unwrap(),
        vec![call_id]
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "before");
    assert!(rig.h.rewind(&scope, later).await.is_err());
    assert_eq!(
        rig.h.snapshot(&id).unwrap().position.as_deref(),
        Some(mark.as_str())
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "before");
    rig.end(&id).await;
}

struct RefusePositionSave {
    store: Arc<dyn HistoryStore>,
    observed: std::path::PathBuf,
}
impl Plugin for RefusePositionSave {
    fn name(&self) -> &str {
        "test.history"
    }
    fn replaces(&self) -> Option<&str> {
        Some("history.files")
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.provide::<dyn HistoryStore>(
            "history",
            Arc::new(Self {
                store: self.store.clone(),
                observed: self.observed.clone(),
            }),
        )
    }
}
impl HistoryStore for RefusePositionSave {
    fn acquire(&self, session: &str) -> Result<Box<dyn Lease>> {
        self.store.acquire(session)
    }
    fn load(&self, session: &str) -> Result<SessionData> {
        self.store.load(session)
    }
    fn save(&self, session: &SessionData) -> Result<()> {
        if session.entries.last().is_some_and(|e| {
            e.kind == "position" && e.content.as_ref().is_some_and(|c| c["restore"].is_object())
        }) {
            assert_eq!(std::fs::read_to_string(&self.observed)?, "after");
            bail!("test: history lease lost");
        }
        self.store.save(session)
    }
    fn list(&self, project: Option<&Path>) -> Result<Vec<SessionData>> {
        self.store.list(project)
    }
    fn erase(&self, entries: Vec<String>, held: &[String]) -> Result<Vec<SessionData>> {
        self.store.erase(entries, held)
    }
}

#[tokio::test]
async fn rewind_restores_the_original_files_when_the_move_cannot_be_recorded() {
    let rig = Rig::new(vec![provider_fake::Script::response(ModelResponse::text(
        "saved",
    ))])
    .await;
    let state = rig.project.path().join("state.txt");
    let history = capability::<dyn HistoryStore>(rig.h.as_ref(), "history").unwrap();
    rig.h
        .load(Arc::new(RefusePositionSave {
            store: history,
            observed: state.clone(),
        }))
        .await
        .unwrap();
    let id = rig.session("fake").await;
    let mark = rig.h.snapshot(&id).unwrap().position.unwrap();
    std::fs::write(&state, "before").unwrap();
    assert_eq!(
        rig.turn(&id, "save a point").await.outcome,
        Outcome::Completed
    );
    let previous = rig.h.snapshot(&id).unwrap().position;
    std::fs::write(&state, "after").unwrap();
    let error = rig.h.rewind(&Scope::session(&id), mark).await.unwrap_err();
    assert!(error.to_string().contains("history lease lost"));
    assert_eq!(std::fs::read_to_string(state).unwrap(), "after");
    assert_eq!(rig.h.snapshot(&id).unwrap().position, previous);
    rig.end(&id).await;
}

#[tokio::test]
async fn history_sends_an_entry_that_fits_alone_with_its_cursor() {
    let rig = Rig::new(vec![]).await;
    rig.load(fixture(json!({"mode":"history-boundary","registration":{"toolSources":[{"id":"fixture","tools":[tool("probe")]}]}})),0).await.unwrap();
    let id = rig.session("fake").await;
    let scope = Scope::session(&id);
    let before = rig.h.snapshot(&id).unwrap();
    let sample = Entry {
        id: agent_api::id(),
        parent: before.position.clone(),
        scope: scope.clone(),
        writer: "test".into(),
        at: now(),
        kind: "test.padding".into(),
        visible: false,
        copies: vec![],
        content: Some(json!({"data":""})),
    };
    let size = serde_json::to_vec(&json!({"entries":[wire::entry(&sample,&before).unwrap()]}))
        .unwrap()
        .len();
    let blob = rig
        .h
        .append(
            &scope,
            "test",
            Draft::new(
                "test.padding",
                false,
                json!({"data":"x".repeat(4*1024*1024 - size)}),
            ),
        )
        .unwrap();
    let runtime: Arc<dyn Runtime> = capability(rig.h.as_ref(), "runtime").unwrap();
    let answer = runtime
        .tool(rig.h.clone(), scope, ToolCall::new("probe", json!({})))
        .await
        .unwrap();
    let reply: Value = serde_json::from_str(&answer.text).unwrap();
    assert_eq!(reply["entries"], 1, "{reply}");
    assert_eq!(reply["next"], blob.id, "{reply}");
    assert!(reply["following"].as_u64().unwrap() > 0);
    rig.end(&id).await;
}

#[tokio::test]
async fn a_job_end_acknowledges_admission_not_execution_and_records_effective_rights() {
    let rig = Rig::new(vec![]).await;
    rig.load(fixture(json!({"mode":"job-report","registration":{"toolSources":[{"id":"fixture","tools":[tool("probe")]}]}})),0).await.unwrap();
    let id = rig.session("fake").await;
    let scope = Scope::session(&id);
    let rights = ["watch", "tools", "jobs", "input"];
    rig.h
        .append(
            &scope,
            "test",
            Draft::new("limit", false, json!({"rights":rights})),
        )
        .unwrap();
    let runtime: Arc<dyn Runtime> = capability(rig.h.as_ref(), "runtime").unwrap();
    let answer = runtime
        .tool(rig.h.clone(), scope, ToolCall::new("probe", json!({})))
        .await
        .unwrap();
    let wire = wire::result(&answer);
    let entries = wire["value"]["entries"].as_array().unwrap();
    let start = entries.iter().find(|e| e["kind"] == "jobStarted").unwrap();
    assert_eq!(start["data"]["rights"], json!(Authority::only(&rights)));
    let end = entries
        .iter()
        .position(|e| e["kind"] == "jobEnded")
        .unwrap();
    let report = &entries[end + 1];
    assert_eq!(report["kind"], "inputAccepted");
    assert_eq!(
        report["data"]["key"],
        format!("job:{}", start["jobId"].as_str().unwrap())
    );
    assert_eq!(
        report["data"]["content"],
        json!([{"type":"text","text":"report"}])
    );
    assert!(!entries.iter().any(|e| e["kind"] == "turnStart"));
    rig.end(&id).await;
}

#[tokio::test]
async fn history_reports_an_unpageable_entry_without_skipping_it() {
    let rig = Rig::new(vec![]).await;
    rig.load(fixture(json!({"mode":"oversized-history","registration":{"toolSources":[{"id":"fixture","tools":[tool("probe")]}]}})),0).await.unwrap();
    let id = rig.session("fake").await;
    let scope = Scope::session(&id);
    rig.h
        .append(
            &scope,
            "test",
            Draft::new("test.blob", false, json!({"data":"x".repeat(4*1024*1024)})),
        )
        .unwrap();
    let runtime: Arc<dyn Runtime> = capability(rig.h.as_ref(), "runtime").unwrap();
    let answer = runtime
        .tool(rig.h.clone(), scope, ToolCall::new("probe", json!({})))
        .await
        .unwrap();
    let reply: Value = serde_json::from_str(&answer.text).unwrap();
    assert_eq!(reply["error"]["code"], -32000);
    assert_eq!(reply["error"]["data"]["code"], "result_too_large");
    rig.end(&id).await;
}
#[tokio::test]
async fn stateful_provider_receives_erase_and_the_host_reports_pending() {
    let rig = Rig::new(vec![]).await;
    rig.load(fixture(json!({"mode":"erase","registration":{"providers":[{"id":"fixture","supports":{"keepsState":true,"runsTools":false},"models":[]}]}})),0).await.unwrap();
    let id = rig.session("fake").await;
    let scope = Scope::session(&id);
    let entry = rig
        .h
        .append(
            &scope,
            "test",
            Draft::new("test.secret", false, json!({"data":"remove"})),
        )
        .unwrap();
    let report = rig.h.erase(&scope, vec![entry.id.clone()]).await.unwrap();
    assert_eq!(report.pending, vec![entry.id]);
    assert!(report.out_of_reach.contains(&"vendor retention".into()));
    rig.end(&id).await;
}
#[tokio::test]
async fn every_host_callback_is_authorized_and_binary_environment_operations_round_trip() {
    let rig = Rig::new(vec![]).await;
    let provider =
        json!({"id":"fixture","supports":{"keepsState":false,"runsTools":false},"models":[]});
    rig.load(fixture(json!({"mode":"callbacks","registration":{"providers":[provider],"toolSources":[{"id":"fixture","tools":[tool("probe")]}]}})),0).await.unwrap();
    let id = rig.session("fake").await;
    let runtime: Arc<dyn Runtime> = capability(rig.h.as_ref(), "runtime").unwrap();
    let result = runtime
        .tool(
            rig.h.clone(),
            Scope::session(&id),
            ToolCall::new("probe", json!({})),
        )
        .await
        .unwrap();
    assert_eq!(result.status, ToolStatus::Completed, "{}", result.text);
    let replies: Value = serde_json::from_str(&result.text).unwrap();
    assert_eq!(replies["host/session:0"]["id"], id);
    assert!(
        replies["host/history:1"]["entries"]
            .as_array()
            .unwrap()
            .len()
            <= 1
    );
    assert!(replies["host/declaration:2"]["inputKeys"].is_boolean());
    assert_eq!(
        replies["host/credentials/read:3"]["credential"],
        Value::Null
    );
    for key in [
        "host/credentials/read:4",
        "host/session:5",
        "host/session:6",
        "host/hook:7",
        "host/env/read:13",
    ] {
        assert_eq!(
            replies[key]["error"]["data"]["code"], "invalid_request",
            "{key}: {}",
            replies[key]
        );
    }
    assert_eq!(replies["host/env/read:9"]["data"], "AP8q");
    assert_eq!(replies["host/env/exists:10"]["exists"], true);
    assert_eq!(replies["host/env/exec:11"]["output"], "callback-output");
    assert_eq!(replies["host/env/exec:12"]["timedOut"], true);
    assert!(
        replies["host/history:14"]["entries"].is_array(),
        "{}",
        replies["host/history:14"]
    );
    assert_eq!(replies["host/history:14"], replies["host/history:15"]);
    for key in ["host/history:16", "host/history:17", "host/history:18"] {
        assert_eq!(replies[key]["error"]["data"]["code"], "invalid_request");
    }
    assert_eq!(
        replies["host/declaration:19"],
        replies["host/declaration:20"]
    );
    assert_eq!(
        replies["host/credentials/read:21"],
        json!({"credential":null})
    );
    assert_eq!(
        std::fs::read(rig.project.path().join("callback.bin")).unwrap(),
        [0, 255, 42]
    );
    // A custom event is attributed to the sender and has no reply barrier.
    rig.events.wait("plugin.fixture.fixture.event").await;
    rig.end(&id).await;
}
#[tokio::test]
async fn forwarding_exec_treats_zero_null_and_absent_timeout_as_no_limit() {
    for remote_environment in [false, true] {
        let rig = Rig::new(vec![]).await;
        if remote_environment {
            rig.load(conformance("environment"), 0).await.unwrap();
        }
        rig.load(
            fixture(json!({"mode":"exec","registration":{
                "toolSources":[{"id":"fixture","tools":[tool("probe")]}]
            }})),
            1,
        )
        .await
        .unwrap();
        let id = rig.session("fake").await;
        let runtime: Arc<dyn Runtime> = capability(rig.h.as_ref(), "runtime").unwrap();
        let mut results = Vec::new();
        for timeout in [
            None,
            Some(Value::Null),
            Some(json!(0)),
            Some(json!(1000)),
            Some(json!(20)),
        ] {
            let limited = timeout == Some(json!(20));
            let mut input = json!({"command":if limited {"sleep 0.2; printf too-late"} else {"sleep 0.05; printf no-limit"}});
            if let Some(ms) = &timeout {
                input["timeoutMs"] = ms.clone();
            }
            let result = runtime
                .tool(
                    rig.h.clone(),
                    Scope::session(&id),
                    ToolCall::new("probe", input),
                )
                .await
                .unwrap();
            results.push((timeout, limited, result));
        }
        rig.end(&id).await;
        for (timeout, limited, result) in results {
            assert_eq!(result.status, ToolStatus::Completed, "{}", result.text);
            let reply: Value = serde_json::from_str(&result.text).unwrap();
            assert_eq!(
                reply["timedOut"], limited,
                "remote={remote_environment}, timeoutMs={timeout:?}: {reply}"
            );
            if limited {
                assert_eq!(reply["exitCode"], Value::Null);
                assert!(!reply["output"].as_str().unwrap().contains("too-late"));
            } else {
                assert_eq!(
                    reply,
                    json!({"exitCode":0,"output":"no-limit","timedOut":false})
                );
            }
        }
    }
}
#[tokio::test]
async fn changed_tools_are_refreshed_before_the_call_result_is_returned() {
    let rig = Rig::new(vec![]).await;
    rig.load(fixture(json!({"mode":"changing","registration":{"toolSources":[{"id":"fixture","tools":[tool("probe")]}]}})),0).await.unwrap();
    let id = rig.session("fake").await;
    let runtime: Arc<dyn Runtime> = capability(rig.h.as_ref(), "runtime").unwrap();
    let result = runtime
        .tool(
            rig.h.clone(),
            Scope::session(&id),
            ToolCall::new("probe", json!({})),
        )
        .await
        .unwrap();
    assert_eq!(result.status, ToolStatus::Completed);
    let data = rig.h.snapshot(&id).unwrap();
    assert!(rig.h.capability_names("tools.").iter().any(|key| {
        capability::<dyn ToolSource>(rig.h.as_ref(), key)
            .unwrap()
            .tools(&data)
            .iter()
            .any(|t| t.name == "new")
    }));
    rig.end(&id).await;
}
#[tokio::test]
async fn conflicting_changed_lists_are_refused_without_replacing_the_last_good_list() {
    let rig = Rig::new(vec![]).await;
    rig.load(fixture(json!({"mode":"changing","changedName":"read","registration":{"toolSources":[{"id":"fixture","tools":[tool("probe")]}]}})),0).await.unwrap();
    let id = rig.session("fake").await;
    let runtime: Arc<dyn Runtime> = capability(rig.h.as_ref(), "runtime").unwrap();
    let result = runtime
        .tool(
            rig.h.clone(),
            Scope::session(&id),
            ToolCall::new("probe", json!({})),
        )
        .await
        .unwrap();
    assert_eq!(result.status, ToolStatus::Completed);
    assert_eq!(result.text, "changed");
    assert!(rig.events.values.lock().unwrap().iter().any(|e| {
        e.kind == "tools.refresh_failed"
            && e.content["reason"]
                .as_str()
                .is_some_and(|r| r.contains("duplicate changed tool"))
    }));
    let data = rig.h.snapshot(&id).unwrap();
    let definitions = rig
        .h
        .capability_names("tools.")
        .iter()
        .flat_map(|key| {
            capability::<dyn ToolSource>(rig.h.as_ref(), key)
                .unwrap()
                .tools(&data)
        })
        .collect::<Vec<_>>();
    assert_eq!(definitions.iter().filter(|d| d.name == "read").count(), 1);
    assert!(!definitions.iter().any(|d| d.name == "probe"));
    rig.end(&id).await;
}
#[tokio::test]
async fn session_specific_lists_and_shared_project_environments_keep_their_scopes() {
    let rig = Rig::new(vec![]).await;
    rig.load(conformance("provider,environment"), 0)
        .await
        .unwrap();
    rig.load(
        fixture(
            json!({"registration":{"toolSources":[{"id":"fixture","tools":[],"perSession":true}]}}),
        ),
        1,
    )
    .await
    .unwrap();
    let a = rig.session("conformance/echo").await;
    let b = rig.session("conformance/echo").await;
    std::fs::write(rig.project.path().join("shared.txt"), "scope preserved").unwrap();
    let (ra, rb) = tokio::join!(
        rig.turn(&a, "tool:read {\"path\":\"shared.txt\"}"),
        rig.turn(&b, "tool:read {\"path\":\"shared.txt\"}")
    );
    assert_eq!(ra.text, "done: scope preserved");
    assert_eq!(rb.text, "done: scope preserved");
    let definitions = rig
        .h
        .capability_names("tools.")
        .iter()
        .flat_map(|key| {
            capability::<dyn ToolSource>(rig.h.as_ref(), key)
                .unwrap()
                .tools(&rig.h.snapshot(&a).unwrap())
        })
        .collect::<Vec<_>>();
    assert!(definitions.iter().any(|d| d.name == "probe"));
    rig.h.close(&a).await.unwrap();
    rig.end(&b).await;
}
#[tokio::test]
async fn remote_model_failure_handler_can_change_the_single_retry_request() {
    let rig = Rig::new(vec![
        provider_fake::Script::failure(FailureKind::Temporary),
        support::text("retried"),
    ])
    .await;
    let retry = json!({"systemPrompt":"changed retry","messages":[{"role":"user","content":[{"type":"text","text":"retry input"}]}],"tools":[],"settings":{"reasoning":"low","maxOutput":512}});
    rig.load(fixture(json!({"registration":{"hooks":[{"hook":"model.failed","handlerId":1}]},"answers":{"model.failed":{"retry":true,"request":retry}}})),0).await.unwrap();
    let id = rig.session("fake").await;
    assert_eq!(rig.turn(&id, "original input").await.text, "retried");
    let sent = rig.probe.requests.lock().unwrap().clone();
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[1].system, "changed retry");
    rig.end(&id).await;
}
#[tokio::test]
async fn lost_tools_have_one_unknown_outcome_and_lost_observers_do_not_fail_turns() {
    let rig = Rig::new(vec![support::text("local survives")]).await;
    rig.load(fixture(json!({"mode":"lost","registration":{"toolSources":[{"id":"fixture","tools":[tool("probe")]}],"hooks":[{"hook":"turn.end","handlerId":1},{"hook":"tool.before","handlerId":2}]}})),0).await.unwrap();
    let id = rig.session("fake").await;
    let runtime: Arc<dyn Runtime> = capability(rig.h.as_ref(), "runtime").unwrap();
    let call = ToolCall::new("probe", json!({}));
    let result = runtime
        .tool(rig.h.clone(), Scope::session(&id), call.clone())
        .await
        .unwrap();
    assert_eq!(result.status, ToolStatus::Unknown);
    assert_eq!(
        rig.h
            .snapshot(&id)
            .unwrap()
            .entries
            .iter()
            .filter(|e| e.kind == "tool.result" && e.scope.call.as_deref() == Some(&call.id))
            .count(),
        1
    );
    assert_eq!(rig.turn(&id, "continue").await.outcome, Outcome::Completed);
    let refused = runtime
        .tool(
            rig.h.clone(),
            Scope::session(&id),
            ToolCall::new("read", json!({"path":"anything"})),
        )
        .await
        .unwrap();
    assert_eq!(refused.status, ToolStatus::Refused);
    rig.end(&id).await;
}
#[tokio::test]
async fn remote_questions_replay_from_the_top_with_the_same_key() {
    let rig = Rig::new(vec![]).await;
    rig.load(conformance("provider"), 0).await.unwrap();
    rig.load(fixture(json!({"mode":"ask","registration":{"toolSources":[{"id":"fixture","tools":[tool("probe")]}]}})),1).await.unwrap();
    let id = rig.session("conformance/echo").await;
    let first = rig.turn(&id, "tool:probe {}").await;
    assert_eq!(first.open_calls.len(), 1);
    let q = questions(&rig.h.snapshot(&id).unwrap())
        .unwrap()
        .into_iter()
        .find(|q| q.answerable)
        .unwrap();
    assert_eq!(q.extra["futureQuestion"], 17);
    assert_eq!(q.extra["details"]["hint"], "retained");
    requests(rig.h.as_ref())
        .unwrap()
        .answer(
            rig.h.clone(),
            &id,
            "user",
            &q.id,
            json!("fixture answer"),
            false,
        )
        .await
        .unwrap();
    let resumed = rig.h.run_next(&id).await.unwrap().unwrap();
    assert_eq!(resumed.outcome, Outcome::Completed);
    let data = rig.h.snapshot(&id).unwrap();
    assert_eq!(
        data.entries
            .iter()
            .filter(|e| e.kind == "request.open")
            .count(),
        1
    );
    assert_eq!(
        data.entries
            .iter()
            .filter(|e| e.kind == "tool.result")
            .count(),
        1
    );
    assert!(
        data.entries
            .iter()
            .filter(|e| e.kind == "tool.result")
            .any(|e| e.content.as_ref().unwrap()["text"]
                .as_str()
                .unwrap()
                .contains("fixture answer"))
    );
    rig.end(&id).await;
}
#[tokio::test]
async fn runtime_callbacks_need_the_active_turn_parent() {
    let rig = Rig::new(vec![support::text("answered through the host")]).await;
    let observed = rig.root.path().join("callback-errors.json");
    rig.load(fixture(json!({"mode":"runtime-parent","observed":observed,"registration":{"runtime":{"id":"fixture","supports":{}}}})), 0).await.unwrap();
    assert!(rig.load(conformance("runtime"), 1).await.is_err());
    let id = rig.session("fake").await;
    let r = rig.turn(&id, "test").await;
    assert_eq!(r.outcome, Outcome::Completed);
    assert_eq!(r.text, "answered through the host");
    let errors: Value = serde_json::from_slice(&std::fs::read(observed).unwrap()).unwrap();
    assert_eq!(
        errors["errors"],
        json!(["invalid_request", "invalid_request", "invalid_request"])
    );
    assert_eq!(rig.probe.requests.lock().unwrap().len(), 1);
    assert_eq!(errors["forged"]["error"]["data"]["code"], "invalid_request");
    assert_eq!(errors["entry"]["id"], errors["repeat"]["id"]);
    assert!(errors["entry"]["id"].is_string());
    rig.end(&id).await;
}
#[tokio::test]
async fn changing_an_allowed_call_settles_the_original_without_dispatch() {
    for change in [
        json!({"name":"read"}),
        json!({"input":{"path":"changed","content":"new"}}),
    ] {
        let call = ToolCall::new("write", json!({"path":"original","content":"old"}));
        let rig = Rig::new(vec![support::calls(vec![call.clone()])]).await;
        let observed = rig.root.path().join("changed-call.json");
        rig.load(
            fixture(
                json!({"mode":"runtime-changed-call","change":change,"observed":observed,
            "registration":{"runtime":{"id":"fixture","supports":{}}}}),
            ),
            0,
        )
        .await
        .unwrap();
        let id = rig.session("fake").await;
        let outcome = rig.turn(&id, "try changing an allowance").await;
        let history = rig.h.snapshot(&id).unwrap();
        rig.end(&id).await;
        assert_eq!(outcome.outcome, Outcome::Completed, "{outcome:?}");
        let trace: Value = serde_json::from_slice(&std::fs::read(observed).unwrap()).unwrap();
        assert_eq!(trace["tool"]["status"], "refused", "{trace}");
        assert_eq!(trace["again"]["error"]["data"]["code"], "invalid_request");
        assert!(!history.entries.iter().any(|e| e.kind == "tool.started"));
        assert_eq!(
            history
                .entries
                .iter()
                .filter(|e| e.kind == "tool.result" && e.scope.call.as_ref() == Some(&call.id))
                .count(),
            1
        );
        assert!(!rig.project.path().join("original").exists());
        assert!(!rig.project.path().join("changed").exists());
    }
}

#[derive(Default)]
struct RuntimeObservers {
    ends: Arc<std::sync::Mutex<Vec<TurnResult>>>,
}
impl Plugin for RuntimeObservers {
    fn name(&self) -> &str {
        "test.runtime-observers"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.on(
            "runtime.after.step",
            Order::Normal,
            handler(|_, _, _| {
                Box::pin(async {
                    Ok(HookResult {
                        refused: Some("simultaneous step refusal".into()),
                        ..HookResult::default()
                    })
                })
            }),
        );
        let ends = self.ends.clone();
        r.on(
            "runtime.turn.end",
            Order::Normal,
            handler(move |_, _, value| {
                let ends = ends.clone();
                Box::pin(async move {
                    ends.lock().unwrap().push(serde_json::from_value(value)?);
                    Ok(HookResult::default())
                })
            }),
        );
        Ok(())
    }
}
#[tokio::test]
async fn a_latched_limit_wins_even_if_the_runtime_does_not_prepare_again() {
    for prepare_again in [false, true] {
        let mut response = ModelResponse::text("answer");
        response.usage.input_tokens = 1;
        let rig = Rig::new(vec![provider_fake::Script::response(response)]).await;
        let observed = rig.root.path().join("limit.json");
        rig.load(
            fixture(
                json!({"mode":"runtime-latched","observed":observed,"prepareAgain":prepare_again,
            "registration":{"runtime":{"id":"fixture","supports":{}}}}),
            ),
            0,
        )
        .await
        .unwrap();
        let observers = Arc::new(RuntimeObservers::default());
        rig.h.load(observers.clone()).await.unwrap();
        rig.h
            .configure_tenants(Some(
                r#"{"limited":{"rights":["watch","input","tools"],"tokens":1}}"#,
            ))
            .unwrap();
        let id = rig
            .h
            .create_in_tenant(rig.project.path(), json!({"model":"fake"}), Some("limited"))
            .await
            .unwrap();
        let outcome = rig.turn(&id, "use the budget").await;
        let history = rig.h.snapshot(&id).unwrap();
        rig.end(&id).await;
        assert_eq!(outcome.outcome, Outcome::Limit, "{outcome:?}");
        assert_eq!(outcome.limit.as_deref(), Some("tenantTokens"));
        assert_eq!(
            history
                .entries
                .iter()
                .filter(|e| e.kind == "model.request")
                .count(),
            1
        );
        let trace: Value = serde_json::from_slice(&std::fs::read(observed).unwrap()).unwrap();
        assert_eq!(trace["after"]["refused"], "simultaneous step refusal");
        let ends = observers.ends.lock().unwrap();
        assert_eq!(ends.len(), 1);
        assert_eq!(ends[0].limit.as_deref(), Some("tenantTokens"));
        if prepare_again {
            assert_eq!(trace["next"]["error"]["data"]["code"], "turn_limit");
            assert_eq!(trace["next"]["error"]["data"]["limit"], "tenantTokens");
        }
    }
}
#[tokio::test]
async fn a_call_not_in_the_committed_offer_is_refused_without_dispatch() {
    let call = ToolCall::new("not-offered", json!({}));
    let rig = Rig::new(vec![support::calls(vec![call.clone()])]).await;
    let observed = rig.root.path().join("unoffered.json");
    rig.load(
        fixture(json!({"mode":"runtime-unoffered","observed":observed,
        "registration":{"runtime":{"id":"fixture","supports":{}}}})),
        0,
    )
    .await
    .unwrap();
    let id = rig.session("fake").await;
    assert_eq!(
        rig.turn(&id, "try unoffered tool").await.outcome,
        Outcome::Completed
    );
    let history = rig.h.snapshot(&id).unwrap();
    rig.end(&id).await;
    let trace: Value = serde_json::from_slice(&std::fs::read(observed).unwrap()).unwrap();
    assert_eq!(trace["gate"]["refused"], "not offered");
    assert!(!history.entries.iter().any(|e| e.kind == "tool.started"));
    assert!(
        history
            .entries
            .iter()
            .any(|e| e.kind == "tool.result" && e.scope.call.as_ref() == Some(&call.id))
    );
}

#[tokio::test]
async fn remote_provider_must_checkpoint_at_its_request_callback() {
    for served in [false, true] {
        for skips_hook in [false, true] {
            let rig = Rig::new(vec![]).await;
            let observed = rig.root.path().join("provider-checkpoint.json");
            let mode = if skips_hook {
                "provider-skips-hook"
            } else {
                "provider-checkpoint"
            };
            rig.load(fixture(json!({"mode":mode,"observed":observed,
                "registration":{"providers":[{"id":"fixture","models":[{"provider":"fixture","id":"echo",
                    "contextWindow":4096,"maxOutput":512,"input":["text"],"reasoning":false}],
                    "supports":{"keepsState":false,"runsTools":false,"safeToRepeat":true}}]}})),0).await.unwrap();
            if served {
                rig.load(conformance("durable-runtime"), 1).await.unwrap();
            }
            let id = rig.session("fixture/echo").await;
            let outcome = rig.turn(&id, "checkpoint this attempt").await;
            let history = rig.h.snapshot(&id).unwrap();
            rig.end(&id).await;
            let trace: Value = serde_json::from_slice(&std::fs::read(observed).unwrap()).unwrap();
            let intents = |v: &Value| {
                v["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|e| e["kind"] == "modelRequest")
                    .cloned()
                    .collect::<Vec<_>>()
            };
            assert!(intents(&trace["before"]).is_empty());
            if skips_hook {
                assert_eq!(outcome.outcome, Outcome::Failed, "{outcome:?}");
                assert!(
                    !history
                        .entries
                        .iter()
                        .any(|e| e.kind == "model.request" || e.kind == "model.response")
                );
            } else {
                assert_eq!(outcome.outcome, Outcome::Completed, "{outcome:?}");
                assert_eq!(outcome.text, "fixture model");
                let checkpoint = intents(&trace["checkpoint"]);
                assert_eq!(checkpoint.len(), 1);
                assert_eq!(
                    checkpoint[0]["data"]["request"],
                    trace["effective"]["request"]
                );
                let response = history
                    .entries
                    .iter()
                    .find(|e| e.kind == "model.response")
                    .unwrap();
                assert_eq!(response.copies, vec![checkpoint[0]["id"].as_str().unwrap()]);
            }
        }
    }
}

struct BlockRuntimeCallbacks {
    step: Arc<Notify>,
}

impl Plugin for BlockRuntimeCallbacks {
    fn name(&self) -> &str {
        "block-runtime-callbacks"
    }

    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        {
            let point = "runtime.before.step";
            let entered = self.step.clone();
            r.on(
                point,
                Order::First,
                handler(move |_, _, _| {
                    let entered = entered.clone();
                    Box::pin(async move {
                        entered.notify_one();
                        std::future::pending().await
                    })
                }),
            );
        }
        Ok(())
    }
}

#[tokio::test]
async fn runtime_cancels_in_flight_host_callbacks_and_the_turn_ends_promptly() {
    let rig = Rig::new(vec![]).await;
    let observed = rig.root.path().join("cancelled-callbacks.json");
    rig.load(
        fixture(json!({"mode":"runtime-cancel","observed":observed,
        "registration":{"runtime":{"id":"fixture","supports":{}}}})),
        0,
    )
    .await
    .unwrap();
    let blocks = Arc::new(BlockRuntimeCallbacks {
        step: Arc::default(),
    });
    rig.h.load(blocks.clone()).await.unwrap();
    let id = rig.session("fake").await;

    let cancel = async {
        let entered = tokio::time::timeout(Duration::from_secs(3), async {
            blocks.step.notified().await;
        })
        .await;
        let start = Instant::now();
        rig.h.cancel(&id).await.unwrap();
        (entered, start)
    };
    let (turn, (entered, start)) = tokio::join!(rig.turn(&id, "cancel callbacks"), cancel);
    let elapsed = start.elapsed();
    rig.end(&id).await;

    entered.expect("both host callbacks must be in flight before cancellation");
    assert_eq!(turn.outcome, Outcome::Cancelled);
    assert!(
        elapsed < Duration::from_secs(3),
        "turn still waited for the cancellation timeout: {elapsed:?}"
    );
    let trace: Value = serde_json::from_slice(&std::fs::read(observed).unwrap()).unwrap();
    let replies = trace["replies"].as_array().unwrap();
    assert_eq!(replies.len(), 2);
    for reply in replies {
        assert_eq!(reply["error"]["data"]["code"], "cancelled", "{reply}");
    }
    assert_eq!(trace["history"]["entries"].as_array().unwrap().len(), 1);
    assert_eq!(trace["end"], Value::Null);
}

#[tokio::test]
async fn cancellation_during_a_served_runtimes_tool_is_not_a_failed_turn() {
    let rig = Rig::new(vec![support::calls(vec![ToolCall::new(
        "bash",
        json!({"command":"touch running; sleep 60"}),
    )])])
    .await;
    let observed = rig.root.path().join("cancel-tool.json");
    rig.load(
        fixture(json!({"mode":"runtime-cancel-tool","observed":observed,
        "registration":{"runtime":{"id":"fixture","supports":{}}}})),
        0,
    )
    .await
    .unwrap();
    let id = rig.session("fake").await;
    let cancel = async {
        let entered = tokio::time::timeout(Duration::from_secs(3), async {
            while !rig.project.path().join("running").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        rig.h.cancel(&id).await.unwrap();
        entered.expect("tool must start before cancellation");
    };
    let (turn, ()) = tokio::join!(rig.turn(&id, "cancel the running tool"), cancel);
    let history = rig.h.snapshot(&id).unwrap();
    rig.end(&id).await;
    let trace: Value = serde_json::from_slice(&std::fs::read(observed).unwrap()).unwrap();
    assert!(
        trace["tool"]["result"]["status"] == "cancelled"
            || trace["tool"]["error"]["data"]["code"] == "cancelled",
        "{trace}"
    );
    assert_eq!(trace["after"]["error"]["data"]["code"], "cancelled");
    assert_eq!(trace["end"], Value::Null, "{trace}");
    assert_eq!(turn.outcome, Outcome::Cancelled);
    let ends: Vec<_> = history
        .entries
        .iter()
        .filter(|e| e.kind == "turn.end")
        .collect();
    assert_eq!(ends.len(), 1);
    assert_eq!(ends[0].content.as_ref().unwrap()["outcome"], "cancelled");
}

#[tokio::test]
async fn host_refuses_outcomes_that_misreport_a_late_question() {
    for (reported, open) in [
        (json!({"kind":"limit","limit":"questions"}), None),
        (json!({"kind":"limit","limit":"steps"}), None),
        (json!({"kind":"completed"}), Some(json!([]))),
    ] {
        let call = ToolCall::new("ask_user", json!({"question":"Which?", "timeout_ms":1}));
        let rig = Rig::new(vec![support::calls(vec![call.clone()])]).await;
        let observed = rig.root.path().join("open.json");
        let mut config = json!({"mode":"runtime-open","observed":observed,"outcome":reported,
            "registration":{"runtime":{"id":"fixture","supports":{}}}});
        if let Some(open) = open {
            config["openToolCalls"] = open;
        }
        rig.load(fixture(config), 0).await.unwrap();
        let id = rig.session("fake").await;
        let result = rig.turn(&id, "leave a call open").await;
        let history = rig.h.snapshot(&id).unwrap();
        rig.end(&id).await;
        let trace: Value = serde_json::from_slice(&std::fs::read(observed).unwrap()).unwrap();
        assert_eq!(trace["tool"]["callId"], call.id);
        assert!(trace["tool"]["pending"].is_string(), "{trace}");
        assert!(trace["after"]["error"].is_null(), "{trace}");
        assert_eq!(trace["end"]["error"]["data"]["code"], "invalid_request");
        assert_eq!(result.outcome, Outcome::Failed, "{result:?}");
        assert!(result.open_calls.is_empty());
        assert!(history.entries.iter().any(|e| {
            e.kind == "turn.end" && e.content.as_ref().unwrap()["outcome"] == "failed"
        }));
    }
}

#[tokio::test]
async fn external_runtime_continues_a_call_after_its_question_is_answered() {
    let call = ToolCall::new(
        "ask_user",
        json!({"kind":"choice","question":"Which?","options":["a","b"],"timeout_ms":1}),
    );
    let rig = Rig::new(vec![
        support::calls(vec![call.clone()]),
        support::text("after the answer"),
    ])
    .await;
    rig.load(conformance("durable-runtime"), 0).await.unwrap();
    let id = rig.session("fake").await;
    let first = rig.turn(&id, "start").await;
    assert_eq!(first.outcome, Outcome::Completed, "{first:?}");
    assert_eq!(first.limit, None);
    assert_eq!(
        first
            .open_calls
            .iter()
            .map(|c| c.id.as_str())
            .collect::<Vec<_>>(),
        [call.id.as_str()]
    );
    assert!(rig.h.run_next(&id).await.unwrap().is_none());
    let history = rig.h.snapshot(&id).unwrap();
    let q = questions(&history)
        .unwrap()
        .into_iter()
        .find(|q| q.answerable)
        .unwrap();
    let start = history
        .entries
        .iter()
        .find(|e| e.kind == "tool.started")
        .unwrap();
    let pending = history
        .entries
        .iter()
        .find(|e| e.kind == "tool.pending")
        .unwrap();
    assert_eq!(pending.scope.call, start.scope.call);
    assert_eq!(
        pending.content.as_ref().unwrap(),
        &json!({
            "requestIds":[q.id], "toolStartedId":start.id
        })
    );
    requests(rig.h.as_ref())
        .unwrap()
        .answer(rig.h.clone(), &id, "user", &q.id, json!("a"), false)
        .await
        .unwrap();
    let continued = rig.h.run_next(&id).await.unwrap().unwrap();
    assert_eq!(continued.outcome, Outcome::Completed);
    assert_eq!(continued.text, "after the answer");
    let history = rig.h.snapshot(&id).unwrap();
    let results = history
        .entries
        .iter()
        .filter(|e| e.kind == "tool.result")
        .collect::<Vec<_>>();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].scope.call.as_ref(), Some(&call.id));
    assert_eq!(results[0].content.as_ref().unwrap()["status"], "completed");
    assert!(
        rig.events
            .values
            .lock()
            .unwrap()
            .iter()
            .any(|e| e.kind == "model.delta" && e.content.as_str().is_some_and(|s| !s.is_empty()))
    );
    rig.end(&id).await;
}
#[tokio::test]
async fn collected_text_reaches_native_providers_without_needing_another_remote_hook() {
    let rig = Rig::new(vec![support::text("native result")]).await;
    rig.load(fixture(json!({"registration":{"hooks":[{"hook":"turn.before","handlerId":1}]},"answers":{"turn.before":{"context":[{"type":"text","text":"collected context","futureContext":true}]}}})),0).await.unwrap();
    let id = rig.session("fake").await;
    assert_eq!(rig.turn(&id, "prompt").await.outcome, Outcome::Completed);
    let request = rig.probe.requests.lock().unwrap()[0].clone();
    let body = provider_openai::request_body(&request).unwrap();
    assert!(body["input"].as_array().unwrap().iter().any(|m| {
        m["content"]
            .as_str()
            .is_some_and(|text| text.contains("collected context"))
            || m["content"]
                .as_array()
                .is_some_and(|parts| parts.iter().any(|p| p["text"] == "collected context"))
    }));
    let wire = plugin_stdio::wire::request(&request, None);
    assert!(
        wire["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["content"][0]["futureContext"] == true)
    );
    rig.end(&id).await;
}
#[tokio::test]
async fn standard_hook_payloads_and_commands_translate_without_losing_request_extensions() {
    let rig = Rig::new(vec![support::text("local model")]).await;
    let log = rig.root.path().join("hooks.jsonl");
    let hooks = [
        "session.start",
        "input",
        "turn.before",
        "turn.start",
        "step.before",
        "step.after",
        "turn.result",
        "turn.end",
        "session.end",
        "provider.request",
        "provider.response",
    ];
    rig.load(fixture(json!({"mode":"hooks","log":log,"registration":{"hooks":hooks.iter().enumerate().map(|(i,hook)|json!({"hook":hook,"handlerId":i+1})).collect::<Vec<_>>(),"commands":[{"name":"fixture","description":"test"}]},"answers":{"turn.before":{"system":"wire system","context":[{"type":"text","text":"wire context","futureField":42}]}}})),0).await.unwrap();
    let id = rig.session("fake").await;
    assert_eq!(
        rig.h
            .command(&Scope::session(&id), "fixture", "abc")
            .await
            .unwrap()["output"],
        "fixture command: abc"
    );
    assert_eq!(rig.turn(&id, "prompt").await.outcome, Outcome::Completed);
    let data = rig.h.snapshot(&id).unwrap();
    assert!(data.entries.iter().any(|e| {
        e.kind == "input"
            && e.content
                .as_ref()
                .is_some_and(|c| c["context"][0]["text"] == "wire context")
    }));
    let sent = rig.probe.requests.lock().unwrap()[0].clone();
    assert!(sent.system.contains("wire step hook"));
    assert_eq!(sent.extra["settings"]["futureSetting"], "kept");
    assert!(sent.messages.iter().any(|m| plugin_stdio::wire::request(
        &ModelRequest {
            messages: vec![m.clone()],
            ..ModelRequest::default()
        },
        None
    )["messages"][0]["content"][0]["futureField"]
        == 42));
    let log = std::fs::read_to_string(log).unwrap();
    let lines = log
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .collect::<Vec<_>>();
    let before = lines
        .iter()
        .find(|v| v["params"]["hook"] == "step.before")
        .unwrap();
    assert_eq!(before["params"]["payload"]["model"]["id"], "fake");
    let end = lines
        .iter()
        .find(|v| v["params"]["hook"] == "turn.end")
        .unwrap();
    assert_eq!(
        end["params"]["payload"]["outcome"],
        json!({"kind":"completed"})
    );
    assert_eq!(
        end["params"]["payload"]["result"],
        json!({"text":"local model","openToolCalls":[]})
    );
    rig.end(&id).await;
}
