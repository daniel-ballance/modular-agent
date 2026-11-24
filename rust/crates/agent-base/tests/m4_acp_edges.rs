mod support;
use agent_api::{Value, json};
use agent_client_protocol::v1::schema::*;
use std::sync::{Arc, Mutex};
use support::acp::*;
async fn until(f: impl Fn() -> bool) {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while !f() {
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
}
fn fixture(pid: &std::path::Path) -> Value {
    json!({"name":"host","command":"/usr/bin/python3","args":[format!("{}/../../scripts/mcp-fixture.py",env!("CARGO_MANIFEST_DIR")),pid],"env":[{"name":"MCP_PREFIX","value":"host:"},{"name":"PRIVATE_MCP_VALUE","value":"host-private-env-123"}]})
}
#[tokio::test]
async fn cancel_is_dispatched_while_permission_and_prompt_are_pending() {
    let r = Rig::new(json!([call(
        "write",
        json!({"path":"never","content":"no"})
    )]));
    let cwd = r.project.path().to_path_buf();
    let permissions = r.permissions.clone();
    r.client(None, true, async move |cx| {
        let id = cx
            .send_request(NewSessionRequest::new(cwd.clone()))
            .block_task()
            .await?
            .session_id;
        let pending = cx
            .send_request(PromptRequest::new(id.clone(), vec!["work".into()]))
            .block_task();
        tokio::pin!(pending);
        until(|| !permissions.lock().unwrap().is_empty()).await;
        cx.send_notification(CancelNotification::new(id.clone()))?;
        assert_eq!(pending.await?.stop_reason, StopReason::Cancelled);
        assert!(!cwd.join("never").exists());
        let qs = rpc(&cx, "_modular-agent/requests", json!({"sessionId":id})).await?;
        assert!(qs["requests"].as_array().unwrap().is_empty());
        let h = rpc(&cx, "_modular-agent/history", json!({"sessionId":id})).await?;
        assert_eq!(
            h["entries"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|e| e["kind"] == "toolResult")
                .count(),
            1
        );
        cx.send_request(CloseSessionRequest::new(id))
            .block_task()
            .await?;
        Ok(())
    })
    .await;
}
#[tokio::test]
async fn host_mcp_is_session_local_unrecorded_and_reaped_on_close() {
    let r = Rig::new(json!([
        call("mcp_host__echo", json!({"text":"scope"})),
        "done",
        call("mcp_host__echo", json!({"text":"scope"})),
        "done"
    ]));
    let cwd = r.project.path().to_path_buf();
    let pid = r.root.path().join("host.pid");
    r.client(Some(true), true, async move |cx| {
        let new = rpc(
            &cx,
            "session/new",
            json!({"cwd":cwd,"mcpServers":[fixture(&pid)]}),
        )
        .await?;
        let id = new["sessionId"].clone();
        let other = cx
            .send_request(NewSessionRequest::new(cwd.clone()))
            .block_task()
            .await?
            .session_id;
        for (sid, offered) in [(&id, true), (&json!(other), false)] {
            rpc(
                &cx,
                "session/prompt",
                json!({"sessionId":sid,"prompt":[{"type":"text","text":"call echo"}]}),
            )
            .await?;
            let history = rpc(&cx, "_modular-agent/history", json!({"sessionId":sid})).await?;
            let entries = history["entries"].as_array().unwrap();
            let result = entries.iter().find(|e| e["kind"] == "toolResult").unwrap();
            assert_eq!(result["data"]["status"] == "completed", offered);
            assert_eq!(
                result["message"]["content"]
                    .to_string()
                    .contains("host:scope"),
                offered
            );
        }
        let h = rpc(&cx, "_modular-agent/history", json!({"sessionId":id})).await?;
        assert!(!h.to_string().contains("host-private-env-123"));
        assert!(!h.to_string().contains("mcp-fixture.py"));
        rpc(&cx, "session/close", json!({"sessionId":id})).await?;
        let pid: i32 = std::fs::read_to_string(&pid).unwrap().parse().unwrap();
        until(|| unsafe { libc::kill(pid, 0) } != 0).await;
        cx.send_request(CloseSessionRequest::new(other))
            .block_task()
            .await?;
        Ok(())
    })
    .await;
}
#[tokio::test]
async fn project_mcp_never_starts_before_explicit_external_trust() {
    let r = Rig::new(json!([
        call("mcp_project__echo", json!({"text":"trusted"})),
        "done"
    ]));
    let cwd = r.project.path().to_path_buf();
    let pid = r.root.path().join("project.pid");
    std::fs::write(cwd.join(".modular-agent.json"),serde_json::to_vec(&json!({"thinking":"high","_parent":{"session":"forged"},"plugins":[{"name":"tools.mcp","options":{"servers":[{"transport":"stdio","name":"project","command":"/usr/bin/python3","args":[format!("{}/../../scripts/mcp-fixture.py",env!("CARGO_MANIFEST_DIR")),pid]}]}}]})).unwrap()).unwrap();
    r.client(Some(true), true, async move |cx| {
        let before = cx
            .send_request(NewSessionRequest::new(cwd.clone()))
            .block_task()
            .await?;
        assert_eq!(
            serde_json::to_value(&before).unwrap()["configOptions"][1]["currentValue"],
            "high"
        );
        assert!(!pid.exists());
        let settings = rpc(
            &cx,
            "_modular-agent/command",
            json!({"sessionId":before.session_id,"name":"settings"}),
        )
        .await?;
        assert!(settings.get("_parent").is_none());
        assert!(
            rpc(
                &cx,
                "_modular-agent/trust-project",
                json!({"sessionId":before.session_id,"cwd":cwd,"confirm":false})
            )
            .await
            .is_err()
        );
        rpc(
            &cx,
            "_modular-agent/trust-project",
            json!({"sessionId":before.session_id,"cwd":cwd,"confirm":true}),
        )
        .await?;
        assert!(!pid.exists());
        cx.send_request(CloseSessionRequest::new(before.session_id))
            .block_task()
            .await?;
        let after = cx
            .send_request(NewSessionRequest::new(cwd.clone()))
            .block_task()
            .await?;
        assert!(pid.exists());
        rpc(
            &cx,
            "session/prompt",
            json!({"sessionId":after.session_id,"prompt":[{"type":"text","text":"call echo"}]}),
        )
        .await?;
        let history = rpc(
            &cx,
            "_modular-agent/history",
            json!({"sessionId":after.session_id}),
        )
        .await?;
        assert!(
            history["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["kind"] == "toolResult" && e["data"]["status"] == "completed")
        );
        cx.send_request(CloseSessionRequest::new(after.session_id))
            .block_task()
            .await?;
        let pid: i32 = std::fs::read_to_string(&pid).unwrap().parse().unwrap();
        until(|| unsafe { libc::kill(pid, 0) } != 0).await;
        Ok(())
    })
    .await;
}
#[tokio::test]
async fn output_gate_covers_streams_rpc_results_and_replay_but_not_the_record() {
    let r = Rig::new(json!(["secret-canary"]));
    let cwd = r.project.path().to_path_buf();
    let events = r.events.clone();
    let saved = Arc::new(Mutex::new(String::new()));
    let save = saved.clone();
    std::fs::write(r.root.path().join("settings.json"),r#"{"plugins":[{"name":"guardrail.literal","options":{"secrets":["secret-canary"]}}],"label":"secret-canary"}"#).unwrap();
    r.client(Some(true), true, async move |cx| {
        let id = cx
            .send_request(NewSessionRequest::new(cwd.clone()))
            .block_task()
            .await?
            .session_id;
        *save.lock().unwrap() = id.to_string();
        let response = rpc(
            &cx,
            "session/prompt",
            json!({"sessionId":id,"prompt":[{"type":"text","text":"work"}]}),
        )
        .await?;
        assert!(!response.to_string().contains("secret-canary"));
        let settings = rpc(
            &cx,
            "_modular-agent/command",
            json!({"sessionId":id,"name":"settings"}),
        )
        .await?;
        assert_eq!(settings["label"], "[REDACTED]");
        let h = rpc(&cx, "_modular-agent/history", json!({"sessionId":id})).await?;
        assert!(!h.to_string().contains("secret-canary"));
        cx.send_request(CloseSessionRequest::new(id.clone()))
            .block_task()
            .await?;
        cx.send_request(LoadSessionRequest::new(id.clone(), cwd))
            .block_task()
            .await?;
        assert!(
            !serde_json::to_string(&*events.lock().unwrap())
                .unwrap()
                .contains("secret-canary")
        );
        cx.send_request(CloseSessionRequest::new(id))
            .block_task()
            .await?;
        Ok(())
    })
    .await;
    let raw = std::fs::read_to_string(
        r.root
            .path()
            .join("sessions")
            .join(format!("{}.json", saved.lock().unwrap())),
    )
    .unwrap();
    assert!(raw.contains("secret-canary"));
}
#[tokio::test]
async fn reconnect_keeps_key_receipts_and_host_can_fork_move_and_withdraw() {
    let r = Rig::new(json!(["once"]));
    let cwd = r.project.path().to_path_buf();
    let saved = Arc::new(Mutex::new(String::new()));
    let save = saved.clone();
    r.client(Some(true),true,async move |cx| {
  let id=cx.send_request(NewSessionRequest::new(cwd)).block_task().await?.session_id; *save.lock().unwrap()=id.to_string();
  rpc(&cx,"session/prompt",json!({"sessionId":id,"prompt":[{"type":"text","text":"context from another agent"}],"_meta":{"modular-agent":{"key":"stable"}}})).await?;
  // EOF closes the Interface and releases the writer lease, without an explicit close.
  Ok(())
 }).await;
    let cwd = r.project.path().to_path_buf();
    let id = saved.lock().unwrap().clone();
    r.client(Some(true),true,async move |cx| {
  let id:SessionId=id.into(); cx.send_request(LoadSessionRequest::new(id.clone(),cwd.clone())).block_task().await?;
  let dup=rpc(&cx,"session/prompt",json!({"sessionId":id,"prompt":[{"type":"text","text":"context from another agent"}],"_meta":{"modular-agent":{"key":"stable"}}})).await?; assert_eq!(dup["_meta"]["modular-agent"]["duplicate"],true);
  let queued=rpc(&cx,"_modular-agent/input",json!({"sessionId":id,"content":"withdraw me","when":"propose","key":"queued"})).await?;
  rpc(&cx,"_modular-agent/withdraw",json!({"sessionId":id,"inputId":queued["inputId"]})).await?;
  let h=rpc(&cx,"_modular-agent/history",json!({"sessionId":id})).await?;
  let rows=h["entries"].as_array().unwrap();
  assert!(rows.iter().any(|e| e["kind"] == "inputHandedBack" && e["inputId"] == queued["inputId"]));
  assert_eq!(rows.iter().filter(|e|e["kind"] == "response").count(),1);
  let position=&rows.iter().find(|e|e["kind"] == "turnEnd").unwrap()["id"];
  let other=cx.send_request(NewSessionRequest::new(cwd.clone())).block_task().await?.session_id;
  assert!(rpc(&cx,"_modular-agent/move",json!({"sessionId":id,"entryId":position,"rewind":true})).await.is_err());
  cx.send_request(CloseSessionRequest::new(other)).block_task().await?;
  let still=rpc(&cx,"_modular-agent/history",json!({"sessionId":id})).await?;
  assert_eq!(still,h);
  rpc(&cx,"_modular-agent/move",json!({"sessionId":id,"entryId":position})).await?;
  let fork=rpc(&cx,"_modular-agent/fork",json!({"sessionId":id,"entryId":position})).await?;
  let fork_id:SessionId=fork["sessionId"].as_str().unwrap().to_string().into();
  cx.send_request(ResumeSessionRequest::new(fork_id.clone(),cwd)).block_task().await?;
  cx.send_request(CloseSessionRequest::new(fork_id)).block_task().await?;
  cx.send_request(CloseSessionRequest::new(id)).block_task().await?; Ok(())
 }).await;
}
#[tokio::test]
async fn acp_subagent_questions_reach_the_connection_without_child_output_leaks() {
    let r = Rig::new(json!([
        call(
            "delegate",
            json!({"task":"ask a question","background":false})
        ),
        call("ask_user", json!({"question":"Pick a colour"})),
        "child-only-output",
        "parent-output"
    ]));
    let cwd = r.project.path().to_path_buf();
    let events = r.events.clone();
    r.client(Some(true), true, async move |cx| {
        let id = cx
            .send_request(NewSessionRequest::new(cwd))
            .block_task()
            .await?
            .session_id;
        cx.send_request(PromptRequest::new(id.clone(), vec!["delegate".into()]))
            .block_task()
            .await?;
        assert!(
            events
                .lock()
                .unwrap()
                .iter()
                .any(|e| e["update"]["content"]["text"] == "parent-output")
        );
        assert!(
            !events
                .lock()
                .unwrap()
                .iter()
                .any(|e| e["update"]["sessionUpdate"] == "agent_message_chunk"
                    && e["update"]["content"]["text"] == "child-only-output")
        );
        cx.send_request(CloseSessionRequest::new(id))
            .block_task()
            .await?;
        Ok(())
    })
    .await;
    assert_eq!(r.elicitations.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn unused_acp_sessions_leave_no_history_and_unsupported_input_is_refused() {
    let r = Rig::new(json!([]));
    let cwd = r.project.path().to_path_buf();
    r.client(Some(true),true,async move |cx| {
  assert!(rpc(&cx,"session/new",json!({"cwd":"relative","mcpServers":[]})).await.is_err());
  assert!(rpc(&cx,"session/new",json!({"cwd":cwd,"mcpServers":[],"additionalDirectories":["/tmp"]})).await.is_err());
  let id=cx.send_request(NewSessionRequest::new(cwd.clone())).block_task().await?.session_id;
  assert!(rpc(&cx,"session/prompt",json!({"sessionId":id,"prompt":[{"type":"image","mimeType":"image/png","data":"AA=="}]})).await.is_err());
  cx.send_request(CloseSessionRequest::new(id)).block_task().await?; Ok(())
 }).await;
    use agent_api::HistoryStore;
    let store = history_fs::FileHistory::new(&r.root.path().join("sessions")).unwrap();
    assert!(store.list(None).unwrap().is_empty());
}

#[tokio::test]
async fn a_timed_out_approval_is_refused_and_cannot_be_answered_late() {
    let r = Rig::new(json!([
        call("write", json!({"path":"late","content":"must not run"})),
        "done"
    ]));
    let cwd = r.project.path().to_path_buf();
    std::fs::write(
        r.root.path().join("settings.json"),
        r#"{"approval_timeout_ms":5}"#,
    )
    .unwrap();
    r.client(None, true, async move |cx| {
        let id = cx
            .send_request(NewSessionRequest::new(cwd.clone()))
            .block_task()
            .await?
            .session_id;
        let prompt = cx
            .send_request(PromptRequest::new(id.clone(), vec!["work".into()]))
            .block_task()
            .await?;
        assert_eq!(prompt.stop_reason, StopReason::EndTurn);
        let history = rpc(&cx, "_modular-agent/history", json!({"sessionId":id})).await?;
        let rows = history["entries"].as_array().unwrap();
        let question = rows.iter().find(|e| e["kind"] == "inputRequest").unwrap();
        assert_eq!(question["data"]["request"]["answerable"], false);
        assert!(
            rows.iter()
                .any(|e| e["kind"] == "toolResult" && e["data"]["status"] == "refused")
        );
        assert_eq!(
            rpc(
                &cx,
                "_modular-agent/answer",
                json!({
                    "sessionId":id,"requestId":question["data"]["request"]["id"],"value":"allow"
                })
            )
            .await?,
            json!({"accepted":false,"reason":"not_open"})
        );
        assert!(!cwd.join("late").exists());
        cx.send_request(CloseSessionRequest::new(id))
            .block_task()
            .await?;
        Ok(())
    })
    .await;
}
#[tokio::test]
async fn acp_never_requests_secrets_in_form_elicitation() {
    let r = Rig::new(json!([
        call(
            "ask_user",
            json!({"kind":"secret","question":"Enter a credential","credential":"example"})
        ),
        "done"
    ]));
    let cwd = r.project.path().to_path_buf();
    r.client(Some(true), true, async move |cx| {
        let id = cx
            .send_request(NewSessionRequest::new(cwd))
            .block_task()
            .await?
            .session_id;
        cx.send_request(PromptRequest::new(id.clone(), vec!["work".into()]))
            .block_task()
            .await?;
        let h = rpc(&cx, "_modular-agent/history", json!({"sessionId":id})).await?;
        assert!(
            h["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["kind"] == "inputAnswer" && e["data"]["declined"] == true)
        );
        cx.send_request(CloseSessionRequest::new(id))
            .block_task()
            .await?;
        Ok(())
    })
    .await;
    assert!(r.elicitations.lock().unwrap().is_empty());
    // The store keeps a discard decision even when no secret was sent.
    use agent_api::CredentialStore;
    let store = credentials_file::FileCredentials {
        openai_key: r.root.path().join("NONEXISTENT-KEY"),
    };
    assert!(store.get("example").is_err());
}
