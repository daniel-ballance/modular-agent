//! The scripted test tool that asks a secret question.
use serde_json::json;
use std::fs;

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
