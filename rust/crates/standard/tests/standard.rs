//! The standard configuration, driven with the SDK scripted Provider.
use modular_agent::{Agent, Gate, Outcome, Plugin, Session, Tool, ToolOutput};
use modular_agent_mcp::Mcp;
use serde_json::{Value, json};
use standard::{Standard, script::Script};
#[cfg(target_os = "linux")]
use std::os::fd::{FromRawFd, OwnedFd};
use std::{
    collections::BTreeMap,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tempfile::TempDir;

struct Rig {
    agent: Agent,
    session: Session,
    root: TempDir,
    project: TempDir,
    seen: Arc<Mutex<Vec<Value>>>,
    ids: BTreeMap<String, String>,
}

fn call(id: &str, name: &str, input: Value) -> Value {
    json!({"toolCalls":[{"name":name,"input":input}],"label":id})
}
fn code(id: &str, source: &str) -> Value {
    call(id, "codemode", json!({"code":source}))
}
fn text(value: &str) -> Value {
    json!({"text":value})
}

impl Rig {
    async fn new(scripts: Vec<Value>) -> Self {
        Self::with(scripts, vec![], json!({}), |_| ()).await
    }
    async fn with(
        scripts: Vec<Value>,
        plugins: Vec<Plugin>,
        settings: Value,
        prepare: impl FnOnce(&Path),
    ) -> Self {
        let root = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        prepare(project.path());
        Self::start(scripts, plugins, settings, root, project, true, None).await
    }
    async fn start(
        scripts: Vec<Value>,
        mut plugins: Vec<Plugin>,
        settings: Value,
        root: TempDir,
        project: TempDir,
        durable: bool,
        worker: Option<PathBuf>,
    ) -> Self {
        let ids = scripts
            .iter()
            .enumerate()
            .filter_map(|(i, step)| {
                step["label"]
                    .as_str()
                    .map(|id| (id.into(), format!("call-{i}-0")))
            })
            .collect();
        // Give each rig a distinct command line so tests can find their own worker.
        let worker = worker.unwrap_or_else(|| {
            let worker = root.path().join("sandbox-worker");
            std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_ma"), &worker).unwrap();
            worker
        });
        let standard = Standard {
            approval: None,
            approval_wait_max_ms: None,
            limits: standard::policy::Bounds::default().counts(),
            byte_limits: standard::policy::Bounds::default().bytes(),
            tenant_scopes: false,
            config: root.path().join("config"),
            state: root.path().join("state"),
            durable,
            claude: false,
            client_identity: Default::default(),
            conformance: false,
            scripted: Some(Script::new(json!(scripts), None)),
            code: tools_code::CodeTool {
                worker: Some(worker),
                compute: Duration::from_millis(300),
                calls: 5,
                ..Default::default()
            },
        };
        let seen = Arc::new(Mutex::new(vec![]));
        let probe = seen.clone();
        plugins.push(Plugin::new("probe").on_step_before(move |p| {
            probe.lock().unwrap().push(p.request.0);
            async { Ok(None) }
        }));
        let mut b = standard::builder(&standard, project.path(), &Mcp::default(), plugins).unwrap();
        for (k, v) in settings.as_object().unwrap() {
            b = b.setting(k, v.clone());
        }
        let agent = b.build().await.unwrap();
        let session = agent.session().await.unwrap();
        Self {
            agent,
            session,
            root,
            project,
            seen,
            ids,
        }
    }
    async fn run(&self, text: &str) -> Outcome {
        self.session.prompt(text).await.unwrap().outcome.unwrap()
    }
    async fn entries(&self, kind: &str) -> Vec<Value> {
        self.session
            .history()
            .await
            .unwrap()
            .into_iter()
            .filter(|e| e["kind"] == kind)
            .collect()
    }
    async fn result(&self, id: &str) -> ResultEntry {
        let record = self
            .entries("toolResult")
            .await
            .into_iter()
            .find(|e| e["toolCallId"] == self.ids[id])
            .unwrap();
        ResultEntry {
            status: record["data"]["status"].as_str().unwrap().into(),
            text: message_text(&record["message"]),
        }
    }
    fn requests(&self) -> Vec<Value> {
        self.seen.lock().unwrap().clone()
    }
}

struct ResultEntry {
    status: String,
    text: String,
}
fn array(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or_default()
}
fn message_text(message: &Value) -> String {
    array(&message["content"])
        .iter()
        .filter_map(|p| p["text"].as_str())
        .collect::<Vec<_>>()
        .join("")
}

#[tokio::test]
async fn the_model_is_offered_one_tool_and_its_calls_are_nested_and_private() {
    let rig = Rig::new(vec![
        code(
            "c1",
            "import tools as t\nt.write(path='a.txt', content='one\\ntwo\\n')\ntools.edit('a.txt', [{'oldText': 'two', 'newText': '2'}])\nprint('printed')\nread = t.read\nread('a.txt')",
        ),
        text("done"),
    ])
    .await;
    let result = rig.run("go").await;
    assert_eq!(result, Outcome::Completed);
    assert_eq!(
        std::fs::read_to_string(rig.project.path().join("a.txt")).unwrap(),
        "one\n2\n"
    );
    let outer = rig.result("c1").await;
    assert_eq!(outer.status, "completed");
    assert_eq!(outer.text, "printed\none\n2");

    // The model was offered the code tool and nothing else.
    let requests = rig.requests();
    assert!(
        requests
            .iter()
            .all(|r| array(&r["tools"]).len() == 1 && r["tools"][0]["name"] == "codemode")
    );
    assert!(
        requests[0]["systemPrompt"]
            .as_str()
            .unwrap()
            .contains("## tools.read(path: str")
    );
    assert!(
        requests[0]["systemPrompt"]
            .as_str()
            .unwrap()
            .contains("tools.exec(command: str")
    );

    // Each call the code made is its own record, tied to the code call.
    let calls = rig.entries("toolStarted").await;
    let nested: Vec<_> = calls
        .iter()
        .map(|e| &e["data"]["call"])
        .filter(|c| c["startedBy"] == "tool")
        .collect();
    assert_eq!(
        nested
            .iter()
            .map(|c| c["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["write", "edit", "read"]
    );
    assert!(nested.iter().all(|c| c["parentCallId"] == rig.ids["c1"]));
    assert_eq!(calls.len(), 4);

    // The model's next request holds its own call and that call's result only.
    let second = array(&requests[1]["messages"]);
    let roles: Vec<&str> = second.iter().map(|m| m["role"].as_str().unwrap()).collect();
    assert_eq!(roles, ["user", "assistant", "toolResult"]);
    assert!(message_text(&second[2]).ends_with("printed\none\n2"));
}

#[tokio::test]
async fn failures_come_back_as_python_errors_and_a_failed_run_says_why() {
    let rig = Rig::new(vec![
        code(
            "c1",
            "try:\n    tools.read('nope.txt')\nexcept RuntimeError as e:\n    print('caught', e)\nr = tools.exec('echo hi; exit 2')\n[r['exit_code'], r['output']]",
        ),
        code("c2", "tools.read(path='x', bogus=1)"),
        code("c3", "tools.nothing()"),
        code("c4", "x = 1 +\n"),
        text("done"),
    ])
    .await;
    assert_eq!(rig.run("go").await, Outcome::Completed);
    let first = rig.result("c1").await;
    assert_eq!(first.status, "completed");
    assert!(first.text.starts_with("caught File not found: nope.txt\n"));
    assert!(first.text.contains("\"hi\\n\""));
    let second = rig.result("c2").await;
    assert_eq!(second.status, "failed");
    assert!(
        second
            .text
            .contains("TypeError: read(): unexpected argument bogus"),
        "{}",
        second.text
    );
    assert!(second.text.contains("line 1"));
    assert_eq!(rig.result("c3").await.status, "failed");
    let fourth = rig.result("c4").await;
    assert_eq!(fourth.status, "failed");
    assert!(fourth.text.contains("SyntaxError"), "{}", fourth.text);
}

#[tokio::test]
async fn lossy_arguments_raise_type_error_without_dispatching_a_tool() {
    let echo = Plugin::new("echo").tool(
        Tool::new("echo", "Return the input")
            .input_schema(json!({"type":"object","properties":{"value":{}},"required":["value"]}))
            .run(|input: Value, _| async move {
                Ok(ToolOutput {
                    value: Some(input["value"].clone()),
                    ..ToolOutput::from("echo")
                })
            }),
    );
    let rig = Rig::with(
        vec![
            code("bad", "for value in [b'bytes', {1}, {'nested': [float('nan')]}, {1: 'key'}, 2**70 + 1, -(2**70 + 1)]:\n    try:\n        tools.echo(value=value)\n    except TypeError:\n        print('not JSON')"),
            code("exact", "tools.echo(value=2**64 - 1)"),
            text("done"),
        ],
        vec![echo],
        json!({}),
        |_| (),
    ).await;
    assert_eq!(rig.run("go").await, Outcome::Completed);
    let bad = rig.result("bad").await;
    assert_eq!(bad.status, "completed", "{}", bad.text);
    assert_eq!(bad.text, "not JSON\n".repeat(6));
    assert_eq!(rig.result("exact").await.text, "18446744073709551615");
    // Two codemode calls and only the exact echo call.
    assert_eq!(rig.entries("toolStarted").await.len(), 3);
}

#[tokio::test]
async fn codemode_shows_a_message_less_exception_and_leads_with_the_reason_on_a_cut() {
    let rig = Rig::new(vec![
        code("empty", "print('before')\nraise ValueError"),
        code("explicit", "raise ValueError('')"),
        code(
            "cut",
            "print('before')\nprint('é' * 30000)\nraise ValueError('too far')",
        ),
        text("done"),
    ])
    .await;
    assert_eq!(rig.run("go").await, Outcome::Completed);
    let empty = rig.result("empty").await;
    assert_eq!(empty.status, "failed");
    assert!(
        empty.text.starts_with("before\nTraceback"),
        "{}",
        empty.text
    );
    assert_eq!(empty.text.lines().last(), Some("ValueError"));
    assert_eq!(
        rig.result("explicit").await.text.lines().last(),
        Some("ValueError")
    );
    let cut = rig.result("cut").await;
    assert_eq!(cut.status, "failed");
    assert!(
        cut.text
            .starts_with("ValueError: too far\nbefore\n[Output cut."),
        "{}",
        cut.text
    );
    assert_eq!(cut.text.lines().count(), 3);
}

#[tokio::test]
async fn the_sandbox_reaches_nothing_itself_and_is_bounded() {
    let rig = Rig::new(vec![
        code(
            "fs",
            "from pathlib import Path\nPath('/etc/hostname').read_text()",
        ),
        code("clock", "import time\ntime.time()"),
        code("spin", "while True:\n    pass"),
        code("after-spin", "print('still here')"),
        code("many", "for i in range(9):\n    tools.list()"),
        code("deep", "def f(n):\n    return f(n + 1)\nf(0)"),
        text("done"),
    ])
    .await;
    assert_eq!(rig.run("go").await, Outcome::Completed);
    let fs = rig.result("fs").await;
    assert_eq!(fs.status, "failed");
    assert!(fs.text.contains("no direct access"), "{}", fs.text);
    let clock = rig.result("clock").await;
    assert_eq!(clock.status, "failed");
    assert!(clock.text.contains("no direct access"), "{}", clock.text);
    let spin = rig.result("spin").await;
    assert_eq!(spin.status, "failed");
    assert!(spin.text.contains("TimeoutError"), "{}", spin.text);
    let after = rig.result("after-spin").await;
    assert_eq!(after.status, "completed");
    assert_eq!(after.text, "still here\n");
    let many = rig.result("many").await;
    assert_eq!(many.status, "failed");
    assert!(
        many.text.contains("more than 5 function calls"),
        "{}",
        many.text
    );
    let deep = rig.result("deep").await;
    assert_eq!(deep.status, "failed");
    assert!(deep.text.contains("RecursionError"), "{}", deep.text);
}

#[tokio::test]
async fn codemode_spends_its_wall_budget_running_python_not_waiting_for_a_tool() {
    let delay = Plugin::new("delay").tool(Tool::new("pause", "Wait outside the interpreter").run(
        |_: Value, _| async {
            // Longer than the rig's entire interpreter budget, after the worker has suspended.
            tokio::time::sleep(Duration::from_millis(350)).await;
            Ok(ToolOutput::from("back"))
        },
    ));
    let rig = Rig::with(
        vec![
            code("resumed", "tools.pause()"),
            code("spin", "tools.pause()\nwhile True:\n    pass"),
            code(
                "lookup-spin",
                "for i in range(6000):\n    for j in range(1000):\n        pass\n    describe_tool('pause')\n'done'",
            ),
            text("done"),
        ],
        vec![delay],
        json!({}),
        |_| (),
    )
    .await;
    assert_eq!(rig.run("go").await, Outcome::Completed);
    assert_eq!(rig.result("resumed").await.text, "back");
    let spin = rig.result("spin").await;
    assert_eq!(spin.status, "failed");
    assert!(spin.text.contains("TimeoutError:"), "{}", spin.text);
    let lookup = rig.result("lookup-spin").await;
    assert_eq!(lookup.status, "failed", "{}", lookup.text);
    assert_eq!(lookup.text, "TimeoutError: sandbox time limit exceeded");
}

#[tokio::test]
async fn only_nested_tool_calls_spend_the_call_allowance() {
    let probe = Plugin::new("probe-tool").tool(
        Tool::new("ping", "Say pong").run(|_: Value, _| async { Ok(ToolOutput::from("pong")) }),
    );
    let prelude = "import tools\ndescribe_tool('ping')\nsearch_tools('ping')\ntry:\n    missing_name\nexcept NameError:\n    pass\n";
    let rig = Rig::with(
        vec![
            code(
                "limit",
                &format!(
                    "{prelude}for i in range(5):\n    tools.ping()\nsearch_tools('ping')\n'done'"
                ),
            ),
            code(
                "over",
                &format!("{prelude}for i in range(6):\n    tools.ping()"),
            ),
            text("done"),
        ],
        vec![probe],
        json!({}),
        |_| (),
    )
    .await;
    assert_eq!(rig.run("go").await, Outcome::Completed);
    let limit = rig.result("limit").await;
    assert_eq!(limit.status, "completed", "{}", limit.text);
    assert_eq!(limit.text, "done");
    let over = rig.result("over").await;
    assert_eq!(over.status, "failed");
    assert!(
        over.text
            .contains("RuntimeError: this run made more than 5 function calls"),
        "{}",
        over.text
    );
}

#[tokio::test]
async fn recursion_allows_200_python_frames_but_not_201() {
    let def = "def f(n):\n    return f(n - 1) if n > 1 else 'bottom'\n";
    let rig = Rig::new(vec![
        code("limit", &format!("{def}f(200)")),
        code("over", &format!("{def}f(201)")),
        text("done"),
    ])
    .await;
    assert_eq!(rig.run("go").await, Outcome::Completed);
    assert_eq!(rig.result("limit").await.text, "bottom");
    let over = rig.result("over").await;
    assert_eq!(over.status, "failed");
    assert!(over.text.contains("RecursionError:"), "{}", over.text);
}

#[tokio::test]
async fn codemode_denies_ambient_os_access_but_allows_explicit_random_seeds() {
    let rig = Rig::new(vec![
        code(
            "probe",
            r#"import os
import time
import random

def denied(name, f):
    try:
        f()
    except Exception:
        print(name, 'denied')

def network():
    import socket
    socket.socket()

def process():
    import subprocess
    subprocess.run(['true'])

denied('files', lambda: open('sandbox.txt', 'w'))
denied('network', network)
denied('process', process)
denied('clock', lambda: time.time())
denied('monotonic', lambda: time.monotonic())
denied('sleep', lambda: time.sleep(0))
denied('entropy', lambda: os.urandom(8))
denied('random', lambda: random.random())
denied('Random()', lambda: random.Random().random())
denied('seed()', lambda: random.seed())
print('seeded', random.Random(7).random() == random.Random(7).random())
print(time.process_time(), time.thread_time(), time.process_time_ns(), time.thread_time_ns())
"#,
        ),
        text("done"),
    ])
    .await;
    assert_eq!(rig.run("go").await, Outcome::Completed);
    let probe = rig.result("probe").await;
    assert_eq!(probe.status, "completed", "{}", probe.text);
    assert_eq!(
        probe.text,
        concat!(
            "files denied\nnetwork denied\nprocess denied\nclock denied\nmonotonic denied\n",
            "sleep denied\nentropy denied\nrandom denied\nRandom() denied\nseed() denied\nseeded True\n",
            "0.0 0.0 0 0\n",
        )
    );
    assert!(!rig.project.path().join("sandbox.txt").exists());
}

#[tokio::test]
async fn the_memory_limit_fails_the_run_and_the_next_run_works() {
    let rig = Rig::new(vec![
        code(
            "fill",
            "print('x' * 60000)\nx = []\nfor i in range(300):\n    x.append('y' * 1048576)\nprint('unreachable')",
        ),
        code("next", "print('still here')"),
        text("done"),
    ])
    .await;
    assert_eq!(rig.run("go").await, Outcome::Completed);
    let fill = rig.result("fill").await;
    assert_eq!(fill.status, "failed");
    assert!(fill.text.contains("MemoryError"), "{}", fill.text);
    assert!(!fill.text.contains("unreachable"));
    let next = rig.result("next").await;
    assert_eq!(next.status, "completed");
    assert_eq!(next.text, "still here\n");
}

#[tokio::test]
async fn starting_the_worker_does_not_spend_the_execution_budget() {
    let root = TempDir::new().unwrap();
    let worker = root.path().join("delayed-worker");
    std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_ma"), worker.with_extension("ma")).unwrap();
    // Model a cold launch that outlasts the compute budget plus the pipe allowance.
    std::fs::write(&worker, "#!/bin/sh\n/bin/sleep 1\nexec \"$0.ma\" \"$@\"\n").unwrap();
    std::fs::set_permissions(&worker, std::fs::Permissions::from_mode(0o700)).unwrap();
    let rig = Rig::start(
        vec![code("fast", "print(42)"), text("done")],
        vec![],
        json!({}),
        root,
        TempDir::new().unwrap(),
        true,
        Some(worker),
    )
    .await;
    assert_eq!(rig.run("go").await, Outcome::Completed);
    let result = rig.result("fast").await;
    assert_eq!(result.status, "completed", "{}", result.text);
    assert_eq!(result.text, "42\n");
}

/// Stop at a known point in a run, without guessing how long worker startup takes.
async fn suspended_rig(scripts: Vec<Value>) -> (Rig, Arc<tokio::sync::Notify>) {
    let started = Arc::new(tokio::sync::Notify::new());
    let signal = started.clone();
    let plugin = Plugin::new("checkpoint").tool(Tool::new("hold", "Wait at a checkpoint").run(
        move |_: Value, _| {
            signal.notify_one();
            std::future::pending::<modular_agent::Result<ToolOutput>>()
        },
    ));
    (
        Rig::with(scripts, vec![plugin], json!({}), |_| ()).await,
        started,
    )
}

fn sandbox_pid(rig: &Rig) -> libc::pid_t {
    let expected = format!(
        "{} subprocess",
        rig.root.path().join("sandbox-worker").display()
    );
    let processes = std::process::Command::new("ps")
        .args(["-axww", "-o", "pid=,command="])
        .output()
        .unwrap();
    assert!(processes.status.success());
    String::from_utf8_lossy(&processes.stdout)
        .lines()
        .find_map(|line| {
            let (pid, command) = line.trim_start().split_once(' ')?;
            (command.trim_start() == expected).then(|| pid.parse().unwrap())
        })
        .expect("the suspended sandbox worker is running")
}

#[tokio::test]
async fn a_worker_death_fails_its_call_without_waiting_for_the_nested_tool() {
    let (rig, held) = suspended_rig(vec![
        code("lost", "tools.hold()"),
        code("next", "print('new worker')"),
        text("done"),
    ])
    .await;
    let rig = Arc::new(rig);
    let mut turn = tokio::spawn({
        let rig = rig.clone();
        async move { rig.run("go").await }
    });
    tokio::select! {
        held = tokio::time::timeout(Duration::from_secs(10), held.notified()) => held.unwrap(),
        outcome = &mut turn => panic!("turn ended before the nested call: {outcome:?}, {:?}", rig.result("lost").await.text),
    }
    assert_eq!(unsafe { libc::kill(sandbox_pid(&rig), libc::SIGKILL) }, 0);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(10), turn)
            .await
            .unwrap()
            .unwrap(),
        Outcome::Completed
    );
    let lost = rig.result("lost").await;
    assert_eq!(lost.status, "failed");
    assert!(lost.text.contains("worker died"), "{}", lost.text);
    let next = rig.result("next").await;
    assert_eq!(next.status, "completed");
    assert_eq!(next.text, "new worker\n");
}

#[tokio::test]
#[cfg(target_os = "linux")] // Uses pidfd to observe exit without recycling the PID.
async fn cancelling_a_run_kills_the_worker_and_a_new_run_can_start() {
    let (rig, held) = suspended_rig(vec![
        code("held", "tools.hold()"),
        code("next", "print('after cancellation')"),
        text("done"),
    ])
    .await;
    let rig = Arc::new(rig);
    let turn = tokio::spawn({
        let rig = rig.clone();
        async move { rig.run("go").await }
    });
    tokio::time::timeout(Duration::from_secs(10), held.notified())
        .await
        .unwrap();
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, sandbox_pid(&rig), 0) };
    assert!(fd >= 0, "{}", std::io::Error::last_os_error());
    // The pidfd stays open and is owned by the registration.
    let worker =
        unsafe { tokio::io::unix::AsyncFd::register(OwnedFd::from_raw_fd(fd as i32)) }.unwrap();
    rig.session.cancel().await.unwrap();
    assert_eq!(turn.await.unwrap(), Outcome::Cancelled);
    assert_eq!(rig.result("held").await.status, "cancelled");
    let _ready = tokio::time::timeout(Duration::from_secs(10), worker.readable())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(rig.run("go again").await, Outcome::Completed);
    let next = rig.result("next").await;
    assert_eq!(next.status, "completed");
    assert_eq!(next.text, "after cancellation\n");
}

/// A gate that refuses one tool, as an approval or policy plugin would.
fn no_writes() -> Plugin {
    Plugin::new("no-writes").on_tool_before(|p| async move {
        Ok(if p.name == "write" {
            Gate::Refuse("writes are not allowed here".into())
        } else {
            Gate::Allow
        })
    })
}

#[tokio::test]
async fn a_nested_call_passes_its_own_gate() {
    let rig = Rig::with(
        vec![
            code(
                "c1",
                "try:\n    tools.write('a.txt', 'x')\nexcept RuntimeError as e:\n    print(e)\ntools.list()",
            ),
            text("done"),
        ],
        vec![no_writes()],
        json!({}),
        |project| std::fs::write(project.join("kept.txt"), "k").unwrap(),
    )
    .await;
    assert_eq!(rig.run("go").await, Outcome::Completed);
    assert!(!rig.project.path().join("a.txt").exists());
    let outer = rig.result("c1").await;
    assert_eq!(outer.status, "completed");
    assert!(
        outer
            .text
            .starts_with("The call was refused and did not run: writes are not allowed here\n"),
        "{}",
        outer.text
    );
    assert!(outer.text.ends_with("kept.txt"));
    let refused = rig
        .entries("toolResult")
        .await
        .iter()
        .filter(|e| e["data"]["status"] == "refused")
        .count();
    assert_eq!(refused, 1);
    // Refused before dispatch: the code call and list started, write did not.
    assert_eq!(rig.entries("toolStarted").await.len(), 2);
}

#[tokio::test]
async fn without_the_setting_the_tools_are_offered_directly_too() {
    let call = call("direct", "read", json!({"path":"a.txt"}));
    let rig = Rig::with(
        vec![call, text("done")],
        vec![],
        json!({"model_tools": null}),
        |project| std::fs::write(project.join("a.txt"), "direct read").unwrap(),
    )
    .await;
    assert_eq!(rig.run("go").await, Outcome::Completed);
    let offered: Vec<String> = array(&rig.requests()[0]["tools"])
        .iter()
        .map(|t| t["name"].as_str().unwrap().into())
        .collect();
    for name in ["codemode", "read", "exec", "edit", "write", "find", "list"] {
        assert!(
            offered.iter().any(|n| n == name),
            "{name} missing from {offered:?}"
        );
    }
    assert_eq!(rig.result("direct").await.text, "direct read");
}

#[tokio::test]
async fn a_direct_call_is_refused_when_only_the_code_tool_is_offered() {
    let call = call("direct", "write", json!({"path":"a.txt","content":"x"}));
    let rig = Rig::new(vec![call, text("done")]).await;
    assert_eq!(rig.run("go").await, Outcome::Completed);
    assert_eq!(rig.result("direct").await.status, "refused");
    assert!(!rig.project.path().join("a.txt").exists());
}

#[tokio::test]
async fn instructions_and_skills_reach_the_prompt_and_a_skill_can_be_loaded_by_hand() {
    let rig = Rig::with(
        vec![text("first"), text("second")],
        vec![],
        json!({}),
        |project| {
            std::fs::write(project.join("AGENTS.md"), "Always answer in haiku.").unwrap();
            let skill = project.join(".agents/skills/release");
            std::fs::create_dir_all(&skill).unwrap();
            std::fs::write(
                skill.join("SKILL.md"),
                "---\nname: release\ndescription: Cut a release.\n---\nBump the version, then tag.",
            )
            .unwrap();
        },
    )
    .await;
    std::fs::create_dir_all(rig.root.path().join("config")).unwrap();
    std::fs::write(
        rig.root.path().join("config/AGENTS.md"),
        "My own standing rule.",
    )
    .unwrap();
    rig.run("hello").await;
    rig.run("/skill:release for 2.0").await;
    let requests = rig.requests();
    let system = requests[0]["systemPrompt"].as_str().unwrap();
    assert!(system.starts_with("You are a coding assistant running inside Modular Agent"));
    assert!(system.contains("Always answer in haiku."));
    assert!(system.contains("My own standing rule."));
    assert!(system.contains("<name>release</name>"));
    assert!(system.contains("<description>Cut a release.</description>"));
    let order = [
        "<rules>",
        "<project_context>",
        "<skills>",
        "# Functions in codemode",
        "<cwd>",
        "<date>",
    ]
    .map(|part| {
        system
            .find(part)
            .unwrap_or_else(|| panic!("{part} missing"))
    });
    assert!(order.windows(2).all(|pair| pair[0] < pair[1]));
    let loaded = message_text(array(&requests[1]["messages"]).last().unwrap());
    assert!(loaded.starts_with("<skill name=\"release\""), "{loaded}");
    assert!(loaded.contains("Bump the version, then tag.\n</skill>\n\nfor 2.0"));
}

#[tokio::test]
async fn mcp_servers_from_configuration_are_functions_and_a_dead_one_is_skipped() {
    let fixture = format!(
        "{}/../../scripts/mcp-fixture.py",
        env!("CARGO_MANIFEST_DIR")
    );
    let root = TempDir::new().unwrap();
    let project = TempDir::new().unwrap();
    std::fs::create_dir_all(root.path().join("config")).unwrap();
    std::fs::write(
        root.path().join("config/mcp.json"),
        json!({"mcpServers":{
            "notes":{"command":"/usr/bin/python3","args":[fixture],"env":{"MCP_PREFIX":"noted:"}},
            "broken":{"command":"/nonexistent/server"}
        }})
        .to_string(),
    )
    .unwrap();
    let rig = Rig::start(vec![
        code(
            "c1",
            "found = [t['name'] for t in search_tools('offline echo')]\nout = tools.mcp_notes__echo(text='hello')\n[found, out]",
        ),
        text("done"),
], vec![], json!({}), root, project, false, None).await;
    assert_eq!(rig.run("go").await, Outcome::Completed);
    let requests = rig.requests();
    assert!(
        array(&requests[0]["tools"])
            .iter()
            .all(|t| t["name"] == "codemode")
    );
    assert!(
        requests[0]["systemPrompt"]
            .as_str()
            .unwrap()
            .contains("tools.mcp_notes__echo(text: str = None)")
    );
    let result = message_text(array(&requests[1]["messages"]).last().unwrap());
    assert!(result.contains("mcp_notes__echo"), "{result}");
    assert!(result.contains("noted:hello"), "{result}");
    rig.agent.close().await.unwrap();
}

/// The smallest PNG there is: one transparent pixel.
const PNG: &[u8] = &[
    0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, b'I', b'H', b'D', b'R', 0, 0, 0,
    1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0d, b'I', b'D', b'A', b'T',
    0x78, 0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4, 0, 0, 0, 0, b'I', b'E', b'N',
    b'D', 0xae, 0x42, 0x60, 0x82,
];

#[tokio::test]
async fn an_image_read_in_code_reaches_the_model_and_survives_a_reopen() {
    let mut rig = Rig::with(
        vec![
            code("c1", "print('looking')\ntools.read('pic.png')"),
            text("seen"),
            text("again"),
        ],
        vec![],
        json!({}),
        |project| std::fs::write(project.join("pic.png"), PNG).unwrap(),
    )
    .await;
    assert_eq!(rig.run("go").await, Outcome::Completed);
    let image_in = |request: &Value| {
        let result = array(&request["messages"])
            .iter()
            .find(|m| m["role"] == "toolResult")
            .expect("no tool message");
        assert_eq!(
            message_text(result),
            "looking\nRead image file [image/png]\n"
        );
        array(&result["content"])
            .iter()
            .find(|p| p["type"] == "image")
            .expect("the image did not reach the model")
            .clone()
    };
    let live = image_in(&rig.requests()[1]);
    assert_eq!(live["mimeType"], "image/png");
    assert!(live["data"].as_str().unwrap().starts_with("iVBORw0KGgo"));
    // Through the store and back: the same message, image included.
    let id = rig.session.id().to_owned();
    rig.session.close().await.unwrap();
    rig.session = rig.agent.open_session(&id).await.unwrap();
    rig.run("and now?").await;
    assert_eq!(image_in(&rig.requests()[2]), live);
}

#[tokio::test]
async fn nesting_is_bounded_and_a_deadline_ends_a_command() {
    let rig = Rig::with(
        vec![
            // codemode -> nest -> nest -> nest -> nest is five deep.
            code(
                "deep",
                "tools.nest(name='nest', input={'name': 'nest', 'input': {'name': 'nest', 'input': {'name': 'nest', 'input': {'name': 'list', 'input': {}}}}})",
            ),
            code(
                "shallow",
                "tools.nest(name='nest', input={'name': 'list', 'input': {}})",
            ),
            code(
                "slow",
                "tools.exec(command='echo begun; sleep 20', timeout=0.3)",
            ),
            text("done"),
        ],
        vec![Plugin::new("nest").tool(Tool::new("nest", "Run one nested call.").input_schema(json!({
            "type":"object","properties":{"name":{"type":"string"},"input":{"type":"object"}},"required":["name","input"]
        })).run(|input: Value, cx| async move {
            let reply = cx.tools().call(input["name"].as_str().unwrap(), input["input"].clone()).await?;
            Ok(ToolOutput { status:reply.status, ..ToolOutput::from(reply.text()) })
        }))],
        json!({}),
        |project| std::fs::write(project.join("here.txt"), "x").unwrap(),
    )
    .await;
    assert_eq!(rig.run("go").await, Outcome::Completed);
    let deep = rig.result("deep").await;
    assert_eq!(deep.status, "failed", "{}", deep.text);
    assert!(deep.text.contains("4 deep at most"), "{}", deep.text);
    let shallow = rig.result("shallow").await;
    assert_eq!(shallow.status, "completed", "{}", shallow.text);
    assert_eq!(shallow.text, "here.txt");
    let slow = rig.result("slow").await;
    assert_eq!(slow.status, "failed", "{}", slow.text);
    assert!(slow.text.contains("RuntimeError: begun"), "{}", slow.text);
    assert!(
        slow.text
            .trim_end()
            .ends_with("Command timed out after 0.3 seconds"),
        "{}",
        slow.text
    );
}

#[tokio::test]
async fn the_offer_is_a_portable_setting_and_a_call_from_the_ui_stays_out_of_context() {
    let rig = Rig::with(vec![text("first")], vec![], json!({}), |project| {
        std::fs::write(project.join("a.txt"), "ui read this").unwrap()
    })
    .await;
    // A person runs a tool directly, outside any turn.
    let direct = rig
        .session
        .call_tool("read", json!({"path":"a.txt"}))
        .await
        .unwrap();
    assert_eq!(direct.text(), "ui read this");
    rig.run("hello").await;
    let request = &rig.requests()[0];
    assert_eq!(
        array(&request["messages"]).len(),
        1,
        "{:?}",
        array(&request["messages"])
    );
    assert!(!format!("{:?}", array(&request["messages"])).contains("ui read this"));
    // What another build would read: the standard key, not this build's own.
    let file = rig
        .root
        .path()
        .join("state/sessions")
        .join(format!("{}.json", rig.session.id()));
    let stored: Value = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
    let setting = stored["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["kind"] == "setting")
        .expect("no setting entry");
    assert_eq!(setting["data"]["value"]["modelTools"], json!(["codemode"]));
    assert!(setting["data"]["value"].get("model_tools").is_none());
}
