mod support;
use agent_api::json;
use agent_client_protocol::v1::schema::*;
use support::acp::*;
#[tokio::test]
async fn acp_official_client_lifecycle_configuration_replay_and_keyed_input() {
    let r = Rig::new(json!(["hello"]));
    let cwd = r.project.path().to_path_buf();
    let events = r.events.clone();
    r.client(Some(true),true,async move |cx| {
  let session=cx.send_request(NewSessionRequest::new(cwd.clone())).block_task().await?;
  let id=session.session_id.clone(); let initial=serde_json::to_value(session).unwrap();
  assert_eq!(initial["configOptions"][0]["id"],"model"); assert_eq!(initial["configOptions"][1]["id"],"thinking");
  let config=rpc(&cx,"session/set_config_option",json!({"sessionId":id,"configId":"thinking","value":"high"})).await?; assert_eq!(config["configOptions"][1]["currentValue"],"high");
  assert!(rpc(&cx,"session/set_config_option",json!({"sessionId":id,"configId":"model","value":"not-allowed"})).await.is_err());
  let prompt=json!({"sessionId":id,"prompt":[{"type":"text","text":"hi"}],"_meta":{"modular-agent":{"key":"one"}}});
  let _:PromptResponse=serde_json::from_value(rpc(&cx,"session/prompt",prompt.clone()).await?).unwrap();
  let duplicate=rpc(&cx,"session/prompt",prompt).await?; assert_eq!(duplicate["_meta"]["modular-agent"]["duplicate"],true);
  let history=rpc(&cx,"_modular-agent/history",json!({"sessionId":id})).await?;
  assert_eq!(history["entries"].as_array().unwrap().iter().filter(|e|e["kind"] == "response").count(),1);
  let point=history["entries"].as_array().unwrap().last().unwrap()["id"].clone();
  let tail=rpc(&cx,"_modular-agent/history",json!({"sessionId":id,"after":point})).await?; assert!(tail["entries"].as_array().unwrap().is_empty());
  assert!(history["entries"].as_array().unwrap().iter().any(|e|e["kind"] == "actorJoined" && e["data"]["actor"]["kind"] == "host" && e["data"]["actor"]["id"] == agent_api::ACP_HOST_ACTOR));
  let list=cx.send_request(ListSessionsRequest::new()).block_task().await?; assert_eq!(list.sessions.len(),1);
  let declaration=rpc(&cx,"_modular-agent/declaration",json!({"sessionId":id})).await?; assert_eq!(declaration["keepsStateAtProvider"],false); assert_eq!(declaration["rewinding"],true);
  let count=events.lock().unwrap().len();
  cx.send_request(CloseSessionRequest::new(id.clone())).block_task().await?;
  cx.send_request(ResumeSessionRequest::new(id.clone(),cwd.clone())).block_task().await?;
  assert_eq!(events.lock().unwrap().len(),count);
  cx.send_request(CloseSessionRequest::new(id.clone())).block_task().await?;
  cx.send_request(LoadSessionRequest::new(id.clone(),cwd.clone())).block_task().await?;
  assert!(events.lock().unwrap()[count..].iter().any(|e|e["update"]["sessionUpdate"] == "user_message_chunk"));
  assert!(events.lock().unwrap()[count..].iter().any(|e|e["update"]["content"]["text"] == "hello"));
  cx.send_request(CloseSessionRequest::new(id)).block_task().await?;
  Ok(())
 }).await;
}
#[tokio::test]
async fn acp_permissions_and_form_elicitation_are_recorded_answers() {
    let r = Rig::new(json!([
        call("write", json!({"path":"receipt","content":"ok"})),
        call("ask_user", json!({"question":"Pick a colour"})),
        "done"
    ]));
    let cwd = r.project.path().to_path_buf();
    r.client(Some(true), true, async move |cx| {
        let id = cx
            .send_request(NewSessionRequest::new(cwd.clone()))
            .block_task()
            .await?
            .session_id;
        cx.send_request(PromptRequest::new(id.clone(), vec!["work".into()]))
            .block_task()
            .await?;
        let history = rpc(&cx, "_modular-agent/history", json!({"sessionId":id})).await?;
        let entries = history["entries"].as_array().unwrap();
        assert!(
            entries
                .iter()
                .any(|e| e["kind"] == "inputAnswer" && e["data"]["value"] == "allow")
        );
        assert!(
            entries
                .iter()
                .any(|e| e["kind"] == "inputAnswer" && e["data"]["value"] == "blue")
        );
        assert_eq!(std::fs::read_to_string(cwd.join("receipt")).unwrap(), "ok");
        cx.send_request(CloseSessionRequest::new(id))
            .block_task()
            .await?;
        Ok(())
    })
    .await;
    assert_eq!(r.permissions.lock().unwrap().len(), 1);
    assert_eq!(r.elicitations.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn acp_permission_refusal_and_missing_forms_use_extension_answers() {
    let r = Rig::new(json!([
        call("write", json!({"path":"denied","content":"no"})),
        call("ask_user", json!({"question":"unsupported"})),
        "done"
    ]));
    let cwd = r.project.path().to_path_buf();
    r.client(Some(false), false, async move |cx| {
        let id = cx
            .send_request(NewSessionRequest::new(cwd.clone()))
            .block_task()
            .await?
            .session_id;
        let pending = cx
            .send_request(PromptRequest::new(id.clone(), vec!["work".into()]))
            .block_task();
        tokio::pin!(pending);
        let question = loop {
            let open = rpc(&cx, "_modular-agent/requests", json!({"sessionId":id})).await?;
            if let Some(q) = open["requests"]
                .as_array()
                .unwrap()
                .iter()
                .find(|q| q["kind"] == "text")
            {
                break q.clone();
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        };
        let answer = rpc(
            &cx,
            "_modular-agent/answer",
            json!({"sessionId":id,"requestId":question["id"],"declined":true}),
        )
        .await?;
        assert_eq!(answer["accepted"], true);
        pending.await?;
        assert!(!cwd.join("denied").exists());
        let history = rpc(&cx, "_modular-agent/history", json!({"sessionId":id})).await?;
        assert!(
            history["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["kind"] == "toolResult" && e["data"]["status"] == "refused")
        );
        cx.send_request(CloseSessionRequest::new(id))
            .block_task()
            .await?;
        Ok(())
    })
    .await;
    assert!(r.elicitations.lock().unwrap().is_empty());
}
