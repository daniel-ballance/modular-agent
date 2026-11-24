//! Explicit live demonstration. Never run as an automated test.
//! The driver never reads a key. Only the agent's credential plugin does.
use acp::{
    AcpAgent, AcpAgentConfig, Agent, UntypedMessage,
    v1::{ConnectionTo, schema::*},
};
use agent_api::{Value, json};
use agent_client_protocol as acp;
use std::sync::{Arc, Mutex};
fn agent(root: &std::path::Path) -> AcpAgent {
    AcpAgent::new(
        AcpAgentConfig::new(
            std::env::current_dir()
                .unwrap()
                .join("target/debug/modular-agent"),
        )
        .args([
            "--acp",
            "--runtime",
            "durable",
            "--approval",
            "ask_always",
            "--data-dir",
            root.to_str().unwrap(),
            "--global-config",
            root.join("settings.json").to_str().unwrap(),
        ]),
    )
}
async fn rpc(cx: &ConnectionTo<Agent>, method: &str, params: Value) -> acp::Result<Value> {
    cx.send_request(UntypedMessage::new(method, params)?)
        .block_task()
        .await
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let root = tempfile::tempdir()?;
    let project = root.path().join("project");
    std::fs::create_dir(&project)?;
    std::fs::write(
        project.join("proof.txt"),
        "The proof token is cedar-lantern-73.\n",
    )?;
    std::fs::write(
        root.path().join("settings.json"),
        r#"{"output_limit":512,"step_limit":4}"#,
    )?;
    let updates: Arc<Mutex<Vec<Value>>> = Arc::default();
    let permissions: Arc<Mutex<Vec<Value>>> = Arc::default();
    let history: Arc<Mutex<Value>> = Arc::new(Mutex::new(Value::Null));
    let saved: Arc<Mutex<String>> = Arc::default();
    let u = updates.clone();
    let p = permissions.clone();
    let h = history.clone();
    let s = saved.clone();
    let cwd = project.clone();
    let first_run = acp::Client.v1()
        .on_receive_notification(async move |n:SessionNotification,_cx| { u.lock().unwrap().push(serde_json::to_value(n).unwrap()); Ok(()) },acp::on_receive_notification!())
        .on_receive_request(async move |r:RequestPermissionRequest,responder,_cx| {
            let option=r.options.iter().find(|o|o.kind == PermissionOptionKind::AllowOnce).ok_or_else(acp::Error::invalid_params)?;
            p.lock().unwrap().push(json!({"toolCall":r.tool_call,"selected":"allow_once"}));
            responder.respond(RequestPermissionResponse::new(RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option.option_id.clone()))))
        },acp::on_receive_request!())
        .connect_with(agent(root.path()),async move |cx:ConnectionTo<Agent>| {
            cx.send_request(InitializeRequest::new(acp::schema::ProtocolVersion::V1)).block_task().await?;
            let session=cx.send_request(NewSessionRequest::new(cwd)).block_task().await?;
            let id=session.session_id;
            *s.lock().unwrap()=id.to_string();
            rpc(&cx,"session/set_config_option",json!({"sessionId":id,"configId":"model","value":"gpt-6-luna"})).await?;
            rpc(&cx,"session/set_config_option",json!({"sessionId":id,"configId":"thinking","value":"low"})).await?;
            let response=cx.send_request(PromptRequest::new(id.clone(),vec!["Use the read tool to read proof.txt. Then answer in one short sentence containing the filename and the exact proof token in that file. Do not use any other tool.".into()])).block_task().await;
            *h.lock().unwrap()=rpc(&cx,"_modular-agent/history",json!({"sessionId":id})).await?;
            cx.send_request(CloseSessionRequest::new(id)).block_task().await?;
            if response?.stop_reason != StopReason::EndTurn { return Err(acp::Error::new(-32000,"live turn did not finish")); }
            Ok(())
        }).await;
    if first_run.is_err() {
        let h = history.lock().unwrap();
        let kinds = h["entries"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|e| e["kind"].clone())
            .collect::<Vec<_>>();
        std::fs::create_dir_all("evidence")?;
        std::fs::write(
            "evidence/m4-failed-attempt.json",
            serde_json::to_vec_pretty(
                &json!({"milestone":4,"model":"gpt-6-luna","completed":false,"entry_kinds":kinds,"permission_count":permissions.lock().unwrap().len()}),
            )?,
        )?;
        anyhow::bail!(
            "ACP demonstration failed; diagnostic kinds saved without provider error values"
        );
    }
    let original = history.lock().unwrap().clone();
    let records = original["entries"].as_array().unwrap();
    let calls: Vec<_> = records
        .iter()
        .filter(|e| e["kind"] == "toolStarted")
        .map(|e| e["data"]["call"].clone())
        .collect();
    anyhow::ensure!(
        !calls.is_empty() && calls.iter().all(|c| c["name"] == "read"),
        "model did not use only read"
    );
    anyhow::ensure!(
        !permissions.lock().unwrap().is_empty(),
        "no ACP permission request"
    );
    let text = updates
        .lock()
        .unwrap()
        .iter()
        .filter(|u| u["update"]["sessionUpdate"] == "agent_message_chunk")
        .filter_map(|u| u["update"]["content"]["text"].as_str())
        .collect::<String>();
    anyhow::ensure!(
        text.contains("cedar-lantern-73") && text.contains("proof.txt"),
        "answer did not use the file"
    );
    let replay: Arc<Mutex<Vec<Value>>> = Arc::default();
    let replayed = replay.clone();
    let id = saved.lock().unwrap().clone();
    acp::Client
        .v1()
        .on_receive_notification(
            async move |n: SessionNotification, _cx| {
                replayed
                    .lock()
                    .unwrap()
                    .push(serde_json::to_value(n).unwrap());
                Ok(())
            },
            acp::on_receive_notification!(),
        )
        .connect_with(agent(root.path()), async move |cx: ConnectionTo<Agent>| {
            cx.send_request(InitializeRequest::new(acp::schema::ProtocolVersion::V1))
                .block_task()
                .await?;
            let id: SessionId = id.into();
            cx.send_request(LoadSessionRequest::new(id.clone(), project))
                .block_task()
                .await?;
            let sessions = cx
                .send_request(ListSessionsRequest::new())
                .block_task()
                .await?;
            if !sessions.sessions.iter().any(|s| s.session_id == id) {
                return Err(acp::Error::new(-32000, "session not listed"));
            }
            cx.send_request(CloseSessionRequest::new(id))
                .block_task()
                .await?;
            Ok(())
        })
        .await?;
    let replay_text = serde_json::to_string(&*replay.lock().unwrap())?;
    anyhow::ensure!(
        replay_text.contains("cedar-lantern-73"),
        "new process did not replay the answer"
    );
    let usage = &records
        .iter()
        .find(|e| e["kind"] == "turnEnd")
        .ok_or_else(|| anyhow::anyhow!("missing turnEnd"))?["data"]["usage"];
    let evidence = json!({"milestone":4,"timestamp_ms":agent_api::now(),"model":"gpt-6-luna","provider":"OpenAI Responses API","provider_keeps_state":false,"runtime":"durable","interface":"ACP v1 stdio","client_library":"agent-client-protocol 5.3.0","model_requests":records.iter().filter(|e|e["kind"] == "modelRequest").count(),"usage":usage,"tool_calls":calls,"permission_requests":*permissions.lock().unwrap(),"answer":text,"new_agent_process_replayed_and_listed_session":true,"new_agent_process_model_requests":0,"session":*saved.lock().unwrap()});
    std::fs::create_dir_all("evidence")?;
    std::fs::write(
        "evidence/m4-real-run.json",
        serde_json::to_vec_pretty(&evidence)?,
    )?;
    println!(
        "ACP demonstration passed: file read, permission approved, answer replayed in a new agent process. Evidence: evidence/m4-real-run.json"
    );
    Ok(())
}
