//! The line terminal shows a question only once it can be answered.
use serde_json::json;
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
};

#[test]
fn an_answer_sent_as_soon_as_the_question_is_shown_is_accepted() {
    let code = "tools.write(path='answer', content=str(tools.ask_user(question='Colour?', kind='choice', options=['teal', 'red'])))";
    for _ in 0..5 {
        let dir = tempfile::tempdir().unwrap();
        let dir = dir.path();
        let project = dir.join("project");
        fs::create_dir_all(&project).unwrap();
        let script = dir.join("script");
        fs::write(
            &script,
            json!([{"toolCalls":[{"name":"codemode","input":{"code":code}}]}, {"text":"done"}])
                .to_string(),
        )
        .unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_ma"))
            .env("MODULAR_AGENT_SCRIPT", script)
            .env("MODULAR_AGENT_DATA_DIR", dir)
            .env_remove("MODULAR_AGENT_CONFORMANCE")
            .env_remove("MODULAR_AGENT_HISTORY_URL")
            .arg("--project")
            .arg(&project)
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take();
        writeln!(stdin.as_mut().unwrap(), "Run").unwrap();
        let mut shown = Vec::new();
        for line in BufReader::new(child.stderr.take().unwrap()).lines() {
            let line = line.unwrap();
            if let Some(id) = line
                .strip_prefix("Question ")
                .and_then(|rest| rest.split_once(':'))
                .map(|(id, _)| id.to_owned())
            {
                writeln!(stdin.take().unwrap(), "/answer {id} teal").unwrap();
            }
            shown.push(line);
        }
        assert!(child.wait().unwrap().success());
        let shown = shown.join("\n");
        assert!(shown.contains("Colour? [\"teal\",\"red\"]"), "{shown}");
        assert!(!shown.contains("no question named"), "{shown}");
        assert!(
            fs::read_to_string(project.join("answer")).is_ok_and(|answer| answer.contains("teal")),
            "{shown}"
        );
    }
}

#[tokio::test]
async fn test_ask_secret_is_unreachable_without_modular_agent_script() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let worker = dir.path().join("sandbox-worker");
    std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_ma"), &worker).unwrap();
    let make = |scripted: bool| {
        let mut standard = standard::Standard {
            approval: None,
            approval_wait_max_ms: None,
            limits: standard::policy::Bounds::default().counts(),
            byte_limits: standard::policy::Bounds::default().bytes(),
            tenant_scopes: false,
            config: dir.path().join("config"),
            state: dir.path().join("state"),
            durable: false,
            claude: false,
            client_identity: Default::default(),
            scripted: scripted
                .then(|| standard::script::Script::new(json!([{"text": "ok"}]), None)),
            conformance: false,
            code: tools_code::CodeTool::default(),
        };
        standard.code.worker = Some(worker.clone());
        standard
    };

    let mcp = modular_agent_mcp::Mcp::default();
    let scripted = standard::builder(&make(true), &project, &mcp, vec![])
        .unwrap()
        .on_question(|_| async {
            modular_agent::Answer::Declined {
                reason: Some("test".into()),
            }
        })
        .build()
        .await
        .unwrap();
    let session = scripted.session().await.unwrap();
    session.prompt("init").await.unwrap();
    let session_id = session.id().to_owned();
    let direct = session
        .call_tool(
            "test_ask_secret",
            json!({"question": "Key?", "credential": "deploy"}),
        )
        .await
        .unwrap();
    assert_eq!(direct.status, modular_agent::ToolStatus::Completed);
    assert_eq!(direct.text(), "declined");
    scripted.close().await.unwrap();

    let unscripted = standard::builder(&make(false), &project, &mcp, vec![])
        .unwrap()
        .build()
        .await
        .unwrap();
    let session = unscripted.open_session(&session_id).await.unwrap();
    let direct = session
        .call_tool(
            "test_ask_secret",
            json!({"question": "Key?", "credential": "deploy"}),
        )
        .await
        .unwrap();
    assert_eq!(
        direct.status,
        modular_agent::ToolStatus::Refused,
        "{direct:?}"
    );
    assert!(direct.text().contains("tool was not offered"), "{direct:?}");
    let nested = session
        .call_tool(
            "codemode",
            json!({"code": "tools.test_ask_secret(question='Key?', credential='deploy')"}),
        )
        .await
        .unwrap();
    assert_eq!(nested.status, modular_agent::ToolStatus::Failed);
    assert!(
        nested.text().contains("AttributeError"),
        "{}",
        nested.text()
    );
    unscripted.close().await.unwrap();
}
