//! The standard configuration, driven with a scripted model.
use agent_api::*;
use agent_harness::Harness;
use interface_terminal::TerminalPlugin;
use provider_fake::{FakePlugin, Probe, Script};
use standard::Standard;
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tempfile::TempDir;

#[derive(Default)]
struct Events(Mutex<Vec<Event>>);
impl EventSink for Events {
    fn send(&self, event: Event) {
        self.0.lock().unwrap().push(event);
    }
}
struct Rig {
    h: Arc<Harness>,
    id: String,
    root: TempDir,
    project: TempDir,
    probe: Arc<Probe>,
}
fn code(id: &str, source: &str) -> Script {
    let mut call = ToolCall::new("codemode", json!({"code": source}));
    call.id = id.into();
    Script::response(ModelResponse::calls(vec![call]))
}
fn text(value: &str) -> Script {
    Script::response(ModelResponse::text(value))
}
impl Rig {
    async fn new(scripts: Vec<Script>) -> Self {
        Self::with(scripts, vec![], json!({}), |_| ()).await
    }
    async fn with(
        scripts: Vec<Script>,
        plugins: Vec<Arc<dyn Plugin>>,
        settings: Value,
        prepare: impl FnOnce(&Path),
    ) -> Self {
        let root = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        prepare(project.path());
        let fake = Arc::new(FakePlugin::new(scripts));
        let probe = fake.probe.clone();
        let standard = Standard {
            config: root.path().join("config"),
            state: root.path().join("state"),
            durable: true,
            claude: false,
            scripted: Some(fake),
            code: tools_code::CodeTool {
                compute: Duration::from_millis(300),
                calls: 5,
                ..Default::default()
            },
        };
        let h = standard::compose(
            &standard,
            Arc::new(TerminalPlugin {
                sink: Arc::new(Events::default()),
            }),
            project.path(),
        )
        .await
        .unwrap();
        for plugin in plugins {
            h.load(plugin).await.unwrap();
        }
        let mut initial = json!({"model":"fake"});
        merge(&mut initial, settings);
        let id = h.create(project.path(), initial).await.unwrap();
        Self {
            h,
            id,
            root,
            project,
            probe,
        }
    }
    async fn run(&self, text: &str) -> TurnResult {
        self.h
            .submit(&self.id, "user", text, Timing::Now, None)
            .await
            .unwrap();
        self.h.run_next(&self.id).await.unwrap().unwrap()
    }
    fn entries(&self, kind: &str) -> Vec<Entry> {
        self.h
            .snapshot(&self.id)
            .unwrap()
            .entries
            .into_iter()
            .filter(|e| e.kind == kind)
            .collect()
    }
    /// The result of the model's own call, by id.
    fn result(&self, call: &str) -> ToolResult {
        self.entries("tool.result")
            .iter()
            .map(|e| serde_json::from_value::<ToolResult>(e.content.clone().unwrap()).unwrap())
            .find(|r| r.call == call)
            .unwrap()
    }
    fn requests(&self) -> Vec<ModelRequest> {
        self.probe.requests.lock().unwrap().clone()
    }
}

#[tokio::test]
async fn the_model_is_offered_one_tool_and_its_calls_are_nested_and_private() {
    let rig = Rig::new(vec![
        code(
            "c1",
            "tools.write(path='a.txt', content='one\\ntwo\\n')\ntools.edit('a.txt', [{'oldText': 'two', 'newText': '2'}])\nprint('printed')\ntools.read('a.txt')",
        ),
        text("done"),
    ])
    .await;
    let result = rig.run("go").await;
    assert_eq!(result.outcome, Outcome::Completed);
    assert_eq!(
        std::fs::read_to_string(rig.project.path().join("a.txt")).unwrap(),
        "one\n2\n"
    );
    let outer = rig.result("c1");
    assert_eq!(outer.status, ToolStatus::Completed);
    assert_eq!(outer.text, "printed\none\n2");

    // The model was offered the code tool and nothing else.
    let requests = rig.requests();
    assert!(
        requests
            .iter()
            .all(|r| r.tools.len() == 1 && r.tools[0].name == "codemode")
    );
    assert!(requests[0].system.contains("## tools.read(path: str"));
    assert!(requests[0].system.contains("tools.exec(command: str"));

    // Each call the code made is its own record, tied to the code call.
    let calls = rig.entries("tool.call");
    let nested: Vec<ToolCall> = calls
        .iter()
        .map(|e| serde_json::from_value::<ToolCall>(e.content.clone().unwrap()).unwrap())
        .filter(|c| c.started_by == "tool")
        .collect();
    assert_eq!(
        nested.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        ["write", "edit", "read"]
    );
    assert!(nested.iter().all(|c| c.extra["parentCallId"] == "c1"));
    assert_eq!(rig.entries("tool.started").len(), 4);

    // The model's next request holds its own call and that call's result only.
    let second = &requests[1].messages;
    let roles: Vec<&str> = second.iter().map(|m| m.role.as_str()).collect();
    assert_eq!(roles, ["user", "assistant", "tool"]);
    assert!(second[2].text_content().ends_with("printed\none\n2"));
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
    assert_eq!(rig.run("go").await.outcome, Outcome::Completed);
    let first = rig.result("c1");
    assert_eq!(first.status, ToolStatus::Completed);
    assert!(
        first
            .text
            .starts_with("caught read() failed: File not found: nope.txt\n")
    );
    assert!(first.text.contains("\"hi\\n\""));
    let second = rig.result("c2");
    assert_eq!(second.status, ToolStatus::Failed);
    assert!(
        second
            .text
            .contains("TypeError: read(): unexpected argument bogus"),
        "{}",
        second.text
    );
    assert!(second.text.contains("line 1"));
    assert_eq!(rig.result("c3").status, ToolStatus::Failed);
    let fourth = rig.result("c4");
    assert_eq!(fourth.status, ToolStatus::Failed);
    assert!(fourth.text.contains("SyntaxError"), "{}", fourth.text);
}

#[tokio::test]
async fn the_sandbox_reaches_nothing_itself_and_is_bounded() {
    let rig = Rig::new(vec![
        code(
            "fs",
            "from pathlib import Path\nPath('/etc/hostname').read_text()",
        ),
        code("spin", "while True:\n    pass"),
        code("many", "for i in range(9):\n    tools.list()"),
        code("deep", "def f(n):\n    return f(n + 1)\nf(0)"),
        text("done"),
    ])
    .await;
    assert_eq!(rig.run("go").await.outcome, Outcome::Completed);
    let fs = rig.result("fs");
    assert_eq!(fs.status, ToolStatus::Failed);
    assert!(fs.text.contains("no direct access"), "{}", fs.text);
    let spin = rig.result("spin");
    assert_eq!(spin.status, ToolStatus::Failed);
    assert!(
        spin.text.to_lowercase().contains("time limit"),
        "{}",
        spin.text
    );
    let many = rig.result("many");
    assert_eq!(many.status, ToolStatus::Failed);
    assert!(
        many.text.contains("more than 5 function calls"),
        "{}",
        many.text
    );
    let deep = rig.result("deep");
    assert_eq!(deep.status, ToolStatus::Failed);
    assert!(deep.text.contains("RecursionError"), "{}", deep.text);
}

/// A gate that refuses one tool, as an approval or policy plugin would.
struct NoWrites;
impl Plugin for NoWrites {
    fn name(&self) -> &str {
        "test.no-writes"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.on(
            "runtime.before.tool",
            Order::Normal,
            handler(|_, _, value| {
                Box::pin(async move {
                    if value["call"]["name"] == "write" {
                        return Ok(HookResult {
                            refused: Some("writes are not allowed here".into()),
                            ..HookResult::default()
                        });
                    }
                    Ok(answer(value))
                })
            }),
        );
        Ok(())
    }
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
        vec![Arc::new(NoWrites)],
        json!({}),
        |project| std::fs::write(project.join("kept.txt"), "k").unwrap(),
    )
    .await;
    assert_eq!(rig.run("go").await.outcome, Outcome::Completed);
    assert!(!rig.project.path().join("a.txt").exists());
    let outer = rig.result("c1");
    assert_eq!(outer.status, ToolStatus::Completed);
    assert!(outer.text.contains("write() was refused"), "{}", outer.text);
    assert!(outer.text.contains("writes are not allowed here"));
    assert!(outer.text.ends_with("kept.txt"));
    let refused = rig
        .entries("tool.result")
        .iter()
        .filter(|e| e.content.as_ref().unwrap()["status"] == "refused")
        .count();
    assert_eq!(refused, 1);
    // Refused before dispatch: the code call and list started, write did not.
    assert_eq!(rig.entries("tool.started").len(), 2);
}

#[tokio::test]
async fn without_the_setting_the_tools_are_offered_directly_too() {
    let mut call = ToolCall::new("read", json!({"path":"a.txt"}));
    call.id = "direct".into();
    let rig = Rig::with(
        vec![
            Script::response(ModelResponse::calls(vec![call])),
            text("done"),
        ],
        vec![],
        json!({"model_tools": null}),
        |project| std::fs::write(project.join("a.txt"), "direct read").unwrap(),
    )
    .await;
    assert_eq!(rig.run("go").await.outcome, Outcome::Completed);
    let offered: Vec<String> = rig.requests()[0]
        .tools
        .iter()
        .map(|t| t.name.clone())
        .collect();
    for name in ["codemode", "read", "exec", "edit", "write", "find", "list"] {
        assert!(
            offered.iter().any(|n| n == name),
            "{name} missing from {offered:?}"
        );
    }
    assert_eq!(rig.result("direct").text, "direct read");
}

#[tokio::test]
async fn a_direct_call_is_refused_when_only_the_code_tool_is_offered() {
    let mut call = ToolCall::new("write", json!({"path":"a.txt","content":"x"}));
    call.id = "direct".into();
    let rig = Rig::new(vec![
        Script::response(ModelResponse::calls(vec![call])),
        text("done"),
    ])
    .await;
    assert_eq!(rig.run("go").await.outcome, Outcome::Completed);
    assert_eq!(rig.result("direct").status, ToolStatus::Refused);
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
    let system = &requests[0].system;
    assert!(system.starts_with("You are a coding assistant running inside Modular Agent"));
    assert!(system.contains("Always answer in haiku."));
    assert!(system.contains("My own standing rule."));
    assert!(system.contains("<name>release</name>"));
    assert!(system.contains("<description>Cut a release.</description>"));
    let order = [
        "<rules>",
        "# Functions in codemode",
        "<project_context>",
        "<skills>",
        "<cwd>",
    ]
    .map(|part| {
        system
            .find(part)
            .unwrap_or_else(|| panic!("{part} missing"))
    });
    assert!(order.windows(2).all(|pair| pair[0] < pair[1]));
    let loaded = requests[1].messages.last().unwrap().text_content();
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
    let fake = Arc::new(FakePlugin::new(vec![
        code(
            "c1",
            "found = [t['name'] for t in search_tools('offline echo')]\nout = tools.mcp_notes__echo(text='hello')\n[found, out]",
        ),
        text("done"),
    ]));
    let probe = fake.probe.clone();
    let standard = Standard {
        config: root.path().join("config"),
        state: root.path().join("state"),
        durable: false,
        claude: false,
        scripted: Some(fake),
        code: Default::default(),
    };
    let h = standard::compose(
        &standard,
        Arc::new(TerminalPlugin {
            sink: Arc::new(Events::default()),
        }),
        project.path(),
    )
    .await
    .unwrap();
    // The broken server does not stop the session from opening.
    let id = h
        .create(project.path(), json!({"model":"fake"}))
        .await
        .unwrap();
    h.submit(&id, "user", "go", Timing::Now, None)
        .await
        .unwrap();
    assert_eq!(
        h.run_next(&id).await.unwrap().unwrap().outcome,
        Outcome::Completed
    );
    let requests = probe.requests.lock().unwrap().clone();
    assert!(requests[0].tools.iter().all(|t| t.name == "codemode"));
    assert!(
        requests[0]
            .system
            .contains("tools.mcp_notes__echo(text: str = None)")
    );
    let result = requests[1].messages.last().unwrap().text_content();
    assert!(result.contains("mcp_notes__echo"), "{result}");
    assert!(result.contains("noted:hello"), "{result}");
    h.close(&id).await.unwrap();
    h.shutdown().await.unwrap();
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
    let rig = Rig::with(
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
    assert_eq!(rig.run("go").await.outcome, Outcome::Completed);
    let image_in = |request: &ModelRequest| {
        let result = request
            .messages
            .iter()
            .find(|m| m.role == "tool")
            .expect("no tool message");
        assert_eq!(
            result.text_content(),
            "looking\nRead image file [image/png]\n"
        );
        result
            .parts
            .iter()
            .find_map(|part| match part {
                Part::Other { name, data } if name == "image" => Some(data.clone()),
                _ => None,
            })
            .expect("the image did not reach the model")
    };
    let live = image_in(&rig.requests()[1]);
    assert_eq!(live["mimeType"], "image/png");
    assert!(live["data"].as_str().unwrap().starts_with("iVBORw0KGgo"));
    // Through the store and back: the same message, image included.
    rig.h.close(&rig.id).await.unwrap();
    rig.h.open(&rig.id).await.unwrap();
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
                "r = tools.exec(command='echo begun; sleep 20', timeout=0.3)\n[r.get('timed_out'), r['output'], r['wall_time_seconds'] < 10]",
            ),
            text("done"),
        ],
        vec![Arc::new(provider_fake::ConformancePlugin)],
        json!({}),
        |project| std::fs::write(project.join("here.txt"), "x").unwrap(),
    )
    .await;
    assert_eq!(rig.run("go").await.outcome, Outcome::Completed);
    let deep = rig.result("deep");
    assert_eq!(deep.status, ToolStatus::Failed, "{}", deep.text);
    assert!(deep.text.contains("4 deep at most"), "{}", deep.text);
    let shallow = rig.result("shallow");
    assert_eq!(shallow.status, ToolStatus::Completed, "{}", shallow.text);
    assert_eq!(shallow.text, "here.txt");
    let slow = rig.result("slow");
    assert_eq!(slow.status, ToolStatus::Completed, "{}", slow.text);
    let value: Value = serde_json::from_str(&slow.text).unwrap();
    assert_eq!(value, json!([true, "begun\n", true]));
}

#[tokio::test]
async fn the_offer_is_a_portable_setting_and_a_call_from_the_ui_stays_out_of_context() {
    let rig = Rig::with(vec![text("first")], vec![], json!({}), |project| {
        std::fs::write(project.join("a.txt"), "ui read this").unwrap()
    })
    .await;
    // A person runs a tool directly, outside any turn.
    let runtime = session_runtime(rig.h.as_ref(), &rig.h.snapshot(&rig.id).unwrap()).unwrap();
    let api: Api = rig.h.clone();
    let direct = runtime
        .tool(
            api,
            Scope::session(&rig.id),
            ToolCall::new("read", json!({"path":"a.txt"})),
        )
        .await
        .unwrap();
    assert_eq!(direct.text, "ui read this");
    rig.run("hello").await;
    let request = &rig.requests()[0];
    assert_eq!(request.messages.len(), 1, "{:?}", request.messages);
    assert!(!format!("{:?}", request.messages).contains("ui read this"));
    // What another build would read: the standard key, not this build's own.
    let file = rig
        .root
        .path()
        .join("state/sessions")
        .join(format!("{}.json", rig.id));
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
