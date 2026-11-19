use acp::{
    AcpAgent, AcpAgentConfig, Agent, UntypedMessage,
    v1::{ConnectionTo, schema::*},
};
use agent_api::{Value, json};
use agent_client_protocol as acp;
use std::{
    future::Future,
    sync::{Arc, Mutex},
};
pub struct Rig {
    pub root: tempfile::TempDir,
    pub project: tempfile::TempDir,
    pub events: Arc<Mutex<Vec<Value>>>,
    pub permissions: Arc<Mutex<Vec<Value>>>,
    pub elicitations: Arc<Mutex<Vec<Value>>>,
    pub conformance: bool,
    pub plugins: Value,
    pub launch_in_project: bool,
    pub represents: Vec<String>,
    pub isolated_data: Option<std::path::PathBuf>,
}
impl Rig {
    pub fn new(scripts: Value) -> Self {
        let root = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("fake.json"),
            serde_json::to_vec(&scripts).unwrap(),
        )
        .unwrap();
        Self {
            root,
            project,
            events: Arc::default(),
            permissions: Arc::default(),
            elicitations: Arc::default(),
            conformance: false,
            plugins: json!([]),
            launch_in_project: false,
            represents: vec![],
            isolated_data: None,
        }
    }
    fn agent(&self) -> AcpAgent {
        let executable = env!("CARGO_BIN_EXE_modular-agent");
        let launch = if self.launch_in_project {
            AcpAgentConfig::new("/bin/sh").args([
                "-c",
                r#"cd "$1" || exit; shift; exec "$@""#,
                "launch",
                self.project.path().to_str().unwrap(),
                executable,
            ])
        } else {
            AcpAgentConfig::new(executable)
        };
        AcpAgent::new(
            launch
                .env(
                    "MODULAR_AGENT_CONFORMANCE",
                    if self.conformance { "1" } else { "0" },
                )
                .env(
                    "MODULAR_AGENT_DATA_DIR",
                    self.isolated_data
                        .as_deref()
                        .unwrap_or(self.root.path())
                        .to_str()
                        .unwrap(),
                )
                .env("MODULAR_AGENT_PLUGINS", self.plugins.to_string())
                .env(
                    "MODULAR_AGENT_ACP_REPRESENTS",
                    json!(self.represents).to_string(),
                )
                .env("HOME", self.root.path().to_str().unwrap())
                .args([
                    "--acp",
                    "--data-dir",
                    self.root.path().to_str().unwrap(),
                    "--global-config",
                    self.root.path().join("settings.json").to_str().unwrap(),
                    "--credential-file",
                    self.root.path().join("NONEXISTENT-KEY").to_str().unwrap(),
                    "--approval",
                    "ask_unless_read_only",
                ])
                .args(if self.conformance {
                    vec!["--provider-mode".to_string(), "stateful".to_string()]
                } else {
                    vec![
                        "--fake-script".to_string(),
                        self.root
                            .path()
                            .join("fake.json")
                            .to_str()
                            .unwrap()
                            .to_string(),
                    ]
                }),
        )
    }
    pub async fn client<F, Fut>(&self, allow: Option<bool>, form: bool, f: F)
    where
        F: FnOnce(ConnectionTo<Agent>) -> Fut + Send + 'static,
        Fut: Future<Output = acp::Result<()>> + Send + 'static,
    {
        let events = self.events.clone();
        let permissions = self.permissions.clone();
        let elicitations = self.elicitations.clone();
        tokio::time::timeout(
            std::time::Duration::from_secs(15),
            acp::Client
                .v1()
                .on_receive_notification(
                    async move |n: SessionNotification, _cx| {
                        events
                            .lock()
                            .unwrap()
                            .push(serde_json::to_value(n).unwrap());
                        Ok(())
                    },
                    acp::on_receive_notification!(),
                )
                .on_receive_request(
                    async move |r: RequestPermissionRequest, responder, cx: ConnectionTo<Agent>| {
                        permissions
                            .lock()
                            .unwrap()
                            .push(serde_json::to_value(&r).unwrap());
                        let Some(allow) = allow else {
                            cx.spawn(async move {
                                std::future::pending::<()>().await;
                                drop(responder);
                                Ok(())
                            })?;
                            return Ok(());
                        };
                        let option = r
                            .options
                            .iter()
                            .find(|o| {
                                o.kind
                                    == if allow {
                                        PermissionOptionKind::AllowOnce
                                    } else {
                                        PermissionOptionKind::RejectOnce
                                    }
                            })
                            .unwrap();
                        responder.respond(RequestPermissionResponse::new(
                            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                                option.option_id.clone(),
                            )),
                        ))
                    },
                    acp::on_receive_request!(),
                )
                .on_receive_request(
                    async move |r: CreateElicitationRequest, responder, _cx| {
                        elicitations
                            .lock()
                            .unwrap()
                            .push(serde_json::to_value(&r).unwrap());
                        let response: CreateElicitationResponse = serde_json::from_value(
                            json!({"action":"accept","content":{"answer":"blue"}}),
                        )
                        .unwrap();
                        responder.respond(response)
                    },
                    acp::on_receive_request!(),
                )
                .connect_with(self.agent(), async move |cx: ConnectionTo<Agent>| {
                    let capabilities = if form {
                        json!({"elicitation":{"form":{}}})
                    } else {
                        json!({})
                    };
                    let init: InitializeRequest = serde_json::from_value(
                        json!({"protocolVersion":1,"clientCapabilities":capabilities}),
                    )
                    .unwrap();
                    let response = cx.send_request(init).block_task().await?;
                    let value = serde_json::to_value(response).unwrap();
                    assert_eq!(value["agentCapabilities"]["loadSession"], true);
                    assert_eq!(
                        value["_meta"]["modular-agent"]["actor"]["id"],
                        agent_api::ACP_HOST_ACTOR
                    );
                    assert!(value["agentCapabilities"]["sessionCapabilities"]["close"].is_object());
                    f(cx).await
                }),
        )
        .await
        .expect("ACP client timed out")
        .expect("ACP client failed");
    }
}
pub async fn rpc(cx: &ConnectionTo<Agent>, method: &str, p: Value) -> acp::Result<Value> {
    cx.send_request(UntypedMessage::new(method, p)?)
        .block_task()
        .await
}
pub fn call(name: &str, input: Value) -> Value {
    json!(agent_api::ModelResponse::calls(vec![
        agent_api::ToolCall::new(name, input)
    ]))
}
