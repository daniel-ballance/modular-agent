mod support;
use agent_api::{Value, json};
use agent_client_protocol::v1::schema::*;
use support::acp::*;

#[test]
fn shared_acp_conformance_kit() {
    let kit = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/acp");
    assert!(
        kit.join("node_modules/@agentclientprotocol/sdk").exists(),
        "Install the pinned kit dependency first: cd conformance/acp && npm ci"
    );
    let home = tempfile::tempdir().unwrap();
    // No real key or user configuration is available, even if mode defaults change.
    let output = std::process::Command::new("node")
        .current_dir(kit)
        .env("HOME", home.path())
        .args([
            "run.mjs",
            "--",
            env!("CARGO_BIN_EXE_modular-agent"),
            "--acp",
        ])
        .output()
        .expect("Node.js is required for the ACP conformance kit");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(stdout.contains("146/146 checks passed"), "{stdout}");
}

#[tokio::test]
async fn a_withheld_reply_does_not_undo_the_request() {
    let mut rig = Rig::new(json!([]));
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/plugin-fixture.py")
        .canonicalize()
        .unwrap();
    rig.plugins = json!([{"command":["python3",fixture],"config":{"withholdMethod":"_modular-agent/limit","registration":{"hooks":[{"hook":"output","handlerId":1}]}}}]);
    let cwd = rig.project.path().to_path_buf();
    rig.client(None, false, async move |cx| {
        let session = rpc(&cx, "session/new", json!({"cwd":cwd,"mcpServers":[]})).await?;
        let id = session["sessionId"].clone();
        let error = rpc(
            &cx,
            "_modular-agent/limit",
            json!({"sessionId":id,"rights":["watch","administer"]}),
        )
        .await
        .unwrap_err();
        assert_eq!(json!(error.code), -32000);
        assert_eq!(error.data.as_ref().unwrap()["code"], "withheld");
        let h = rpc(&cx, "_modular-agent/history", json!({"sessionId":id})).await?;
        assert_eq!(
            h["entries"].as_array().unwrap().last().unwrap()["data"]["rights"],
            json!(["watch", "administer"])
        );
        let denied = rpc(
            &cx,
            "_modular-agent/join",
            json!({"sessionId":id,"actor":{"id":"guest","kind":"user","rights":["watch"]}}),
        )
        .await
        .unwrap_err();
        assert_eq!(json!(denied.code), -32602);
        Ok(())
    })
    .await;
}

#[tokio::test]
async fn proposals_are_listed_as_content_and_can_be_withdrawn_declined_or_released() {
    let mut rig = Rig::new(json!(["done"]));
    rig.represents.push("guest".into());
    let cwd = rig.project.path().to_path_buf();
    rig.client(None, false, async move |cx| {
        let s = rpc(&cx, "session/new", json!({"cwd":cwd,"mcpServers":[]})).await?;
        let id = s["sessionId"].clone();
        rpc(&cx, "_modular-agent/join", json!({"sessionId":id,"actor":{"id":"guest","kind":"user","rights":["watch","propose"]},"present":false})).await?;
        let actors = rpc(&cx, "_modular-agent/actors", json!({"sessionId":id})).await?;
        assert!(actors["actors"].as_array().unwrap().iter().any(|a| a["id"] == "guest"));
        assert!(!actors["present"].as_array().unwrap().contains(&json!("guest")));
        let proposal = rpc(&cx, "_modular-agent/input", json!({"sessionId":id,"actorId":"guest","when":"propose","content":"one"})).await?;
        let p2 = rpc(&cx, "_modular-agent/input", json!({"sessionId":id,"actorId":"guest","when":"propose","content":"two"})).await?;
        let listed = rpc(&cx, "_modular-agent/proposals", json!({"sessionId":id})).await?;
        assert_eq!(listed["proposals"][0]["inputId"], proposal["inputId"]);
        assert_eq!(listed["proposals"][1]["inputId"], p2["inputId"]);
        for (proposal, text) in listed["proposals"].as_array().unwrap().iter().zip(["one", "two"]) {
            assert_eq!(proposal["content"], json!([{"type":"text","text":text}]));
        }
        rpc(&cx, "_modular-agent/withdraw", json!({"sessionId":id,"actorId":"guest","inputId":proposal["inputId"]})).await?;
        let declined = rpc(&cx, "_modular-agent/release", json!({"sessionId":id,"inputId":p2["inputId"],"when":"now","declined":true})).await?;
        assert_eq!(declined["taken"], "handedBack");
        let listed = rpc(&cx, "_modular-agent/proposals", json!({"sessionId":id})).await?;
        assert_eq!(listed["proposals"], json!([]));

        let p3 = rpc(&cx, "_modular-agent/input", json!({"sessionId":id,"actorId":"guest","when":"propose","content":"three"})).await?;
        rpc(&cx, "_modular-agent/release", json!({"sessionId":id,"inputId":p3["inputId"],"when":"now"})).await?;
        let history = rpc(&cx, "_modular-agent/history", json!({"sessionId":id})).await?;
        let receipts: Vec<_> = history["entries"].as_array().unwrap().iter()
            .filter(|e| e["kind"] == "inputAccepted" && e["data"]["inputId"] == p3["inputId"])
            .map(|e| &e["data"])
            .collect();
        assert_eq!(receipts.len(), 2);
        assert_eq!(receipts[0]["when"], "propose");
        assert_eq!(receipts[1]["when"], "now");
        for receipt in receipts {
            assert_eq!(receipt["content"], json!([{"type":"text","text":"three"}]));
        }
        Ok(())
    }).await;
}

#[tokio::test]
async fn conformance_read_zero_usage_and_authoritative_data_directory() {
    let mut r = Rig::new(json!([]));
    r.conformance = true;
    let data = r.root.path().join("isolated");
    r.isolated_data = Some(data.clone());
    // This explicit --global-config file must be ignored when the binding's
    // environment directory is set. No user HOME or credentials are available.
    std::fs::write(r.root.path().join("settings.json"), "invalid JSON").unwrap();
    let payload = "λ".repeat(250);
    std::fs::write(r.project.path().join("long.txt"), &payload).unwrap();
    let cwd = r.project.path().to_path_buf();
    let events = r.events.clone();
    r.client(Some(true),false,async move |cx| {
        let session = rpc(&cx,"session/new",json!({"cwd":cwd,"mcpServers":[]})).await?;
        assert_eq!(session["_meta"]["modular-agent"]["declaration"]["keepsStateAtProvider"],true);
        assert_eq!(session["configOptions"][0]["currentValue"],"openai/gpt-6-luna");
        let id = session["sessionId"].clone();
        let config = rpc(&cx,"session/set_config_option",json!({"sessionId":id,"configId":"model","value":"conformance/echo"})).await?;
        assert_eq!(config["configOptions"][0]["currentValue"],"conformance/echo");
        assert_eq!(config["_meta"]["modular-agent"]["declaration"]["keepsStateAtProvider"],false);
        rpc(&cx,"session/set_config_option",json!({"sessionId":id,"configId":"thinking","value":"off"})).await?;
        let result = rpc(&cx,"session/prompt",json!({"sessionId":id,"prompt":[{"type":"text","text":"tool:read {\"path\":\"long.txt\"}"}],"_meta":{"modular-agent":{"actor":{"id":"forged"}}}})).await?;
        assert_eq!(result["stopReason"],"end_turn");
        assert!(events.lock().unwrap().iter().any(|u| u["update"]["content"]["text"] == format!("done: {}","λ".repeat(200))));
        let h = rpc(&cx,"_modular-agent/history",json!({"sessionId":id})).await?;
        let entries = h["entries"].as_array().unwrap();
        assert!(entries.iter().filter(|e|e["kind"] == "input").all(|e|e["actorId"] == agent_api::ACP_HOST_ACTOR));
        for e in entries.iter().filter(|e|e["kind"] == "response") {
            assert_eq!(e["message"]["usage"],json!({"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":0.0}));
        }
        rpc(&cx,"session/close",json!({"sessionId":id})).await?;
        let resumed = rpc(&cx,"session/resume",json!({"sessionId":id,"cwd":cwd,"mcpServers":[]})).await?;
        assert_eq!(resumed["configOptions"][0]["currentValue"],"conformance/echo");
        rpc(&cx,"session/close",json!({"sessionId":id})).await?;
        Ok(())
    }).await;
    assert!(data.join("sessions").is_dir());
    assert!(data.join("commands").is_dir());
    for path in ["sessions", "commands", "trusted-projects.json", "openai"] {
        assert!(
            !r.root.path().join(path).exists(),
            "state escaped isolation: {path}"
        );
    }
}

#[tokio::test]
async fn acp_keeps_and_accepts_shared_off_when_reopening_an_openai_session() {
    let mut rig = Rig::new(json!([]));
    // This exposes the OpenAI catalog but the test sends no model requests.
    rig.conformance = true;
    let sessions = rig.root.path().join("sessions");
    std::fs::create_dir(&sessions).unwrap();
    let cwd = rig.project.path().to_path_buf();
    let recorded = json!({"id":"settings","parentId":null,"sessionId":"imported","kind":"setting",
        "time":0,"writer":"another-agent","modelVisible":false,
        "data":{"key":"settings","value":{"model":{"provider":"openai","id":"gpt-6-luna"},"reasoning":"off"}}});
    std::fs::write(
        sessions.join("imported.json"),
        json!({"historyBinding":"modular-agent-data/1","id":"imported","project":cwd,
            "plugins":[],"entries":[recorded]})
        .to_string(),
    )
    .unwrap();

    rig.client(None, false, async move |cx| {
        let id = "imported";
        let resumed = rpc(&cx, "session/resume", json!({"sessionId":id,"cwd":cwd})).await?;
        assert_eq!(
            resumed["configOptions"][0]["currentValue"],
            "openai/gpt-6-luna"
        );
        let thinking = &resumed["configOptions"][1];
        assert_eq!(thinking["id"], "thinking");
        assert_eq!(thinking["currentValue"], "off");
        assert_eq!(
            thinking["options"]
                .as_array()
                .unwrap()
                .iter()
                .map(|option| option["value"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["off", "minimal", "low", "medium", "high", "xhigh"]
        );
        for (option, value) in [
            ("model", "conformance/echo"),
            ("model", "openai/gpt-6-luna"),
            ("thinking", "high"),
            ("thinking", "off"),
        ] {
            let config = rpc(
                &cx,
                "session/set_config_option",
                json!({"sessionId":id,"configId":option,"value":value}),
            )
            .await?;
            assert_eq!(
                config["configOptions"][1]["currentValue"],
                if option == "model" { "off" } else { value }
            );
        }
        rpc(&cx, "session/close", json!({"sessionId":id})).await?;
        Ok(())
    })
    .await;
    let history: Value =
        serde_json::from_slice(&std::fs::read(sessions.join("imported.json")).unwrap()).unwrap();
    let entries = history["entries"].as_array().unwrap();
    assert_eq!(entries[0]["data"], recorded["data"]);
    let last_setting = entries
        .iter()
        .rev()
        .find(|e| e["kind"] == "setting")
        .unwrap();
    assert_eq!(last_setting["data"]["value"]["reasoning"], "off");
}

#[tokio::test]
async fn acp_joins_before_input_and_preserves_foreign_actors_on_load_and_resume() {
    let r = Rig::new(json!(["new text"]));
    let sessions = r.root.path().join("sessions");
    std::fs::create_dir(&sessions).unwrap();
    let cwd = r.project.path().to_path_buf();
    let foreign = json!({"id":"foreign","parentId":null,"sessionId":"imported","kind":"actorJoined","time":0,
        "writer":"another-agent","modelVisible":false,"actorId":"user","data":{"actor":{"id":"user","kind":"user","rights":["watch"]}}});
    let path = sessions.join("imported.json");
    std::fs::write(
        &path,
        json!({"historyBinding":"modular-agent-data/1","id":"imported","project":cwd,
        "defaults":{"model":"fake","thinking":"low"},"plugins":[],"entries":[foreign]})
        .to_string(),
    )
    .unwrap();

    r.client(Some(true), false, async move |cx| {
        let actor = agent_api::ACP_HOST_ACTOR;
        let joined = |history: &Value| {
            history["entries"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|e| e["kind"] == "actorJoined" && e["data"]["actor"]["id"] == actor)
                .cloned()
                .collect::<Vec<_>>()
        };
        let new = rpc(&cx, "session/new", json!({"cwd":cwd,"mcpServers":null})).await?;
        let id = &new["sessionId"];
        let entry = joined(&rpc(&cx, "_modular-agent/history", json!({"sessionId":id})).await?);
        assert_eq!(entry.len(), 1);
        assert_eq!(
            entry[0]["data"]["actor"],
            json!({"id":actor,"kind":"host","rights":agent_api::Authority::full()})
        );
        rpc(&cx, "session/close", json!({"sessionId":id})).await?;
        let listed = rpc(&cx, "session/list", json!({"cwd":cwd})).await?;
        assert_eq!(listed["sessions"].as_array().unwrap().len(), 1);

        for method in ["session/load", "session/resume"] {
            rpc(
                &cx,
                method,
                json!({"sessionId":"imported","cwd":cwd,"mcpServers":[]}),
            )
            .await?;
            let h = rpc(
                &cx,
                "_modular-agent/history",
                json!({"sessionId":"imported","all":true}),
            )
            .await?;
            assert_eq!(joined(&h).len(), 1);
            let foreign = h["entries"]
                .as_array()
                .unwrap()
                .iter()
                .find(|e| e["id"] == "foreign")
                .unwrap();
            assert_eq!(
                foreign["data"]["actor"],
                json!({"id":"user","kind":"user","rights":["watch"]})
            );
            if method == "session/resume" {
                let p = rpc(
                    &cx,
                    "session/prompt",
                    json!({"sessionId":"imported","prompt":[{"type":"text","text":"new prompt"}]}),
                )
                .await?;
                assert_eq!(p["stopReason"], "end_turn");
                let h = rpc(
                    &cx,
                    "_modular-agent/history",
                    json!({"sessionId":"imported"}),
                )
                .await?;
                assert!(
                    h["entries"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|e| e["kind"] == "input" && e["actorId"] == actor)
                );
            }
            rpc(&cx, "session/close", json!({"sessionId":"imported"})).await?;
        }
        Ok(())
    })
    .await;
    let saved: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(
        saved["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["kind"] == "actorJoined")
            .count(),
        2
    );
}

#[tokio::test]
async fn history_tool_call_blocks_use_arguments() {
    let call = agent_api::ToolCall::new("read", json!({"path":"proof.txt"}));
    let call_id = call.id.clone();
    let r = Rig::new(json!([agent_api::ModelResponse::calls(vec![call]), "done"]));
    std::fs::write(r.project.path().join("proof.txt"), "history proof").unwrap();
    let cwd = r.project.path().to_path_buf();
    r.client(Some(true), false, async move |cx| {
        let id = cx
            .send_request(NewSessionRequest::new(cwd))
            .block_task()
            .await?
            .session_id;
        rpc(
            &cx,
            "session/prompt",
            json!({"sessionId":id,"prompt":[{"type":"text","text":"read proof"}]}),
        )
        .await?;
        let history = rpc(&cx, "_modular-agent/history", json!({"sessionId":id})).await?;
        let block = history["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["kind"] == "response")
            .flat_map(|e| e["message"]["content"].as_array().unwrap())
            .find(|b| b["type"] == "toolCall")
            .unwrap();
        assert_eq!(block["id"], call_id);
        assert_eq!(block["name"], "read");
        assert_eq!(block["arguments"], json!({"path":"proof.txt"}));
        assert!(block.get("input").is_none());
        assert!(
            rpc(&cx, "_modular/history", json!({"sessionId":id}))
                .await
                .is_err()
        );
        rpc(&cx, "session/close", json!({"sessionId":id})).await?;
        Ok(())
    })
    .await;
}

#[tokio::test]
async fn binding_output_limit_failure_and_duplicate_outcomes() {
    let mut limit = agent_api::ModelResponse::text("truncated");
    limit.stop = "limit".into();
    let r = Rig::new(json!([limit]));
    let cwd = r.project.path().to_path_buf();
    r.client(Some(true),false,async move |cx| {
        let id = cx.send_request(NewSessionRequest::new(cwd)).block_task().await?.session_id;
        let result = rpc(&cx,"session/prompt",json!({"sessionId":id,"prompt":[{"type":"text","text":"limit"}]})).await?;
        assert_eq!(result["stopReason"],"max_tokens");
        assert_eq!(result["_meta"]["modular-agent"]["outcome"],json!({"kind":"limit","limit":"output"}));
        let prompt = json!({"sessionId":id,"prompt":[{"type":"text","text":"no more script"}],"_meta":{"modular-agent":{"key":"failed"}}});
        let failed = rpc(&cx,"session/prompt",prompt.clone()).await?;
        assert_eq!(failed["stopReason"],"refusal");
        assert_eq!(failed["_meta"]["modular-agent"]["outcome"]["kind"],"failed");
        assert!(failed["_meta"]["modular-agent"]["outcome"]["error"].is_string());
        let retry = rpc(&cx,"session/prompt",prompt).await?;
        assert_eq!(retry["stopReason"],"refusal");
        assert_eq!(retry["_meta"]["modular-agent"]["outcome"],failed["_meta"]["modular-agent"]["outcome"]);
        assert_eq!(retry["_meta"]["modular-agent"]["duplicate"],true);
        rpc(&cx,"session/close",json!({"sessionId":id})).await?;
        Ok(())
    }).await;
}

#[tokio::test]
async fn binding_step_limit_is_not_an_output_limit() {
    let r = Rig::new(json!([call("read", json!({"path":"missing"}))]));
    std::fs::write(r.root.path().join("settings.json"), r#"{"step_limit":1}"#).unwrap();
    let cwd = r.project.path().to_path_buf();
    r.client(Some(true), false, async move |cx| {
        let id = cx
            .send_request(NewSessionRequest::new(cwd))
            .block_task()
            .await?
            .session_id;
        let result = rpc(
            &cx,
            "session/prompt",
            json!({"sessionId":id,"prompt":[{"type":"text","text":"one step"}]}),
        )
        .await?;
        assert_eq!(result["stopReason"], "max_turn_requests");
        assert_eq!(
            result["_meta"]["modular-agent"]["outcome"],
            json!({"kind":"limit","limit":"steps"})
        );
        rpc(&cx, "session/close", json!({"sessionId":id})).await?;
        Ok(())
    })
    .await;
}

#[tokio::test]
async fn input_is_acknowledged_before_permission_and_duplicate_prompt_waits_for_original() {
    let r = Rig::new(json!([
        call("write", json!({"path":"once","content":"ok"})),
        "done"
    ]));
    let cwd = r.project.path().to_path_buf();
    r.client(None,false,async move |cx| {
        let id = cx.send_request(NewSessionRequest::new(cwd.clone())).block_task().await?.session_id;
        let input = rpc(&cx,"_modular-agent/input",json!({"sessionId":id,"content":"start","when":"now","key":"in-flight"})).await?;
        let q = question(&cx,&json!(id)).await?;
        let retry = rpc(&cx,"_modular-agent/input",json!({"sessionId":id,"content":"start","when":"now","key":"in-flight"})).await?;
        assert_eq!(retry["inputId"],input["inputId"]);
        assert_eq!(retry["taken"],input["taken"]);
        assert_eq!(retry["duplicate"],true);
        let pending = cx.send_request(agent_client_protocol::UntypedMessage::new("session/prompt",json!({"sessionId":id,"prompt":[{"type":"text","text":"start"}],"_meta":{"modular-agent":{"key":"in-flight"}}}))?).block_task();
        tokio::pin!(pending);
        assert_eq!(rpc(&cx,"_modular-agent/answer",json!({"sessionId":id,"requestId":q["id"],"value":"allow"})).await?["accepted"],true);
        let response: Value = pending.await?;
        assert_eq!(response["_meta"]["modular-agent"]["inputId"],input["inputId"]);
        assert_eq!(response["_meta"]["modular-agent"]["duplicate"],true);
        assert_eq!(response["_meta"]["modular-agent"]["outcome"]["kind"],"completed");
        let h = rpc(&cx,"_modular-agent/history",json!({"sessionId":id})).await?;
        assert_eq!(h["entries"].as_array().unwrap().iter().filter(|e|e["kind"] == "turnEnd").count(),1);
        assert_eq!(std::fs::read_to_string(cwd.join("once")).unwrap(),"ok");
        rpc(&cx,"session/close",json!({"sessionId":id})).await?;
        Ok(())
    }).await;
}

#[tokio::test]
async fn readable_reasoning_uses_thought_chunks_and_the_output_gate_including_replay() {
    let mut response = agent_api::ModelResponse::text("answer");
    response.parts.insert(0,agent_api::Part::Reasoning {data:json!({"summary":[{"text":"private-thought"}],"encrypted_content":"opaque-not-for-display"})});
    let r = Rig::new(json!([response]));
    std::fs::write(
        r.root.path().join("settings.json"),
        r#"{"plugins":[{"name":"guardrail.literal","options":{"secrets":["private-thought"]}}]}"#,
    )
    .unwrap();
    let cwd = r.project.path().to_path_buf();
    let events = r.events.clone();
    r.client(Some(true), false, async move |cx| {
        let new = rpc(&cx, "session/new", json!({"cwd":cwd,"mcpServers":[]})).await?;
        assert_eq!(
            new["_meta"]["modular-agent"]["declaration"]["holdsOutput"],
            true
        );
        let id = new["sessionId"].clone();
        rpc(
            &cx,
            "session/prompt",
            json!({"sessionId":id,"prompt":[{"type":"text","text":"reason"}]}),
        )
        .await?;
        rpc(&cx, "session/close", json!({"sessionId":id})).await?;
        rpc(
            &cx,
            "session/load",
            json!({"sessionId":id,"cwd":cwd,"mcpServers":[]}),
        )
        .await?;
        let updates = events.lock().unwrap().clone();
        assert_eq!(
            updates
                .iter()
                .filter(|u| u["update"]["sessionUpdate"] == "agent_thought_chunk"
                    && u["update"]["content"]["text"] == "[REDACTED]")
                .count(),
            2
        );
        assert!(
            !json!(updates)
                .to_string()
                .contains("opaque-not-for-display")
        );
        assert!(!json!(updates).to_string().contains("private-thought"));
        rpc(&cx, "session/close", json!({"sessionId":id})).await?;
        Ok(())
    })
    .await;
}

async fn question(
    cx: &agent_client_protocol::v1::ConnectionTo<agent_client_protocol::Agent>,
    id: &Value,
) -> agent_client_protocol::Result<Value> {
    loop {
        let r = rpc(cx, "_modular-agent/requests", json!({"sessionId":id})).await?;
        if let Some(q) = r["requests"].as_array().unwrap().first() {
            return Ok(q.clone());
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
}

#[tokio::test]
async fn binding_cancel_hands_back_queued_content_and_duplicate_keeps_cancelled_outcome() {
    let r = Rig::new(json!([call(
        "write",
        json!({"path":"never","content":"no"})
    )]));
    let cwd = r.project.path().to_path_buf();
    r.client(None,false,async move |cx| {
        let new = rpc(&cx,"session/new",json!({"cwd":cwd,"mcpServers":[]})).await?;
        let id = new["sessionId"].clone();
        let prompt = json!({"sessionId":id,"prompt":[{"type":"text","text":"work"}],"_meta":{"modular-agent":{"key":"cancel-key"}}});
        let pending = cx.send_request(agent_client_protocol::UntypedMessage::new("session/prompt",prompt.clone())?).block_task();
        tokio::pin!(pending);
        question(&cx,&id).await?;
        assert!(rpc(&cx,"session/set_config_option",json!({"sessionId":id,"configId":"approval","value":"off"})).await.is_err());
        let queued = rpc(&cx,"_modular-agent/input",json!({"sessionId":id,"content":[{"type":"text","text":"must be handed back"}],"when":"after","key":"queued"})).await?;
        assert_eq!(queued["taken"],"after");
        cx.send_notification(CancelNotification::new(id.as_str().unwrap().to_string()))?;
        let result: Value = pending.await?;
        let meta = &result["_meta"]["modular-agent"];
        assert_eq!(meta["outcome"]["kind"],"cancelled");
        assert_eq!(meta["handedBack"],json!([{"inputId":queued["inputId"],"content":"must be handed back"}]));
        let retry = rpc(&cx,"session/prompt",prompt).await?;
        assert_eq!(retry["stopReason"],"cancelled");
        assert_eq!(retry["_meta"]["modular-agent"]["duplicate"],true);
        assert_eq!(retry["_meta"]["modular-agent"]["handedBack"],meta["handedBack"]);
        let h = rpc(&cx,"_modular-agent/history",json!({"sessionId":id})).await?;
        assert_eq!(h["entries"].as_array().unwrap().iter().filter(|e|e["kind"] == "turnEnd").count(),1);
        assert!(!cwd.join("never").exists());
        rpc(&cx,"session/close",json!({"sessionId":id})).await?;
        Ok(())
    }).await;
}

#[tokio::test]
async fn erase_during_a_turn_returns_busy_and_preserves_the_approval() {
    let rig = Rig::new(json!([
        call("bash", json!({"command":"printf x >> count"})),
        "done"
    ]));
    let cwd = rig.project.path().to_owned();
    rig.client(None, false, async move |cx| {
        let new = rpc(&cx, "session/new", json!({"cwd":cwd,"mcpServers":[]})).await?;
        let id = &new["sessionId"];
        assert_eq!(
            new["_meta"]["modular-agent"]["declaration"]["erasureDuringTurn"],
            "refused"
        );
        let pending = cx
            .send_request(PromptRequest::new(
                id.as_str().unwrap().to_owned(),
                vec!["work".into()],
            ))
            .block_task();
        let q = question(&cx, id).await?;
        let all = json!({"sessionId":id,"all":true});
        let before = rpc(&cx, "_modular-agent/history", all.clone()).await?;
        let request = before["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["kind"] == "inputRequest" && e["requestId"] == q["id"])
            .unwrap();
        let error = rpc(
            &cx,
            "_modular-agent/erase",
            json!({"sessionId":id,"entryIds":[request["id"]]}),
        )
        .await
        .unwrap_err();
        assert_eq!(json!(error.code), -32602);
        assert_eq!(
            error.data,
            Some(json!({"code":"busy"})),
            "{}",
            error.message
        );
        assert_eq!(rpc(&cx, "_modular-agent/history", all).await?, before);
        assert_eq!(
            rpc(
                &cx,
                "_modular-agent/answer",
                json!({"sessionId":id,"requestId":q["id"],"value":"allow"})
            )
            .await?,
            json!({"accepted":true})
        );
        assert_eq!(pending.await?.stop_reason, StopReason::EndTurn);
        assert_eq!(std::fs::read(cwd.join("count")).unwrap(), b"x");
        Ok(())
    })
    .await;
}

#[tokio::test]
async fn invalid_history_changes_leave_the_record_intact() {
    let rig = Rig::new(json!(["done"]));
    let cwd = rig.project.path().to_owned();
    rig.client(None, false, async move |cx| {
        let id = cx
            .send_request(NewSessionRequest::new(cwd))
            .block_task()
            .await?
            .session_id;
        cx.send_request(PromptRequest::new(id.clone(), vec!["first".into()]))
            .block_task()
            .await?;
        let all = json!({"sessionId":id,"all":true});
        let before = rpc(&cx, "_modular-agent/history", all.clone()).await?;
        let rows = before["entries"].as_array().unwrap();
        let entry = |kind| &rows.iter().find(|e| e["kind"] == kind).unwrap()["id"];
        let target = entry("turnEnd");
        for (method, args, code) in [
            ("erase", json!({"entryIds":[]}), "invalid_params"),
            (
                "erase",
                json!({"entryIds":[target, "missing"]}),
                "not_found",
            ),
            (
                "erase",
                json!({"entryIds":[target, entry("actorJoined")]}),
                "forbidden",
            ),
            (
                "move",
                json!({"entryId":target,"rewind":"yes"}),
                "invalid_params",
            ),
            ("move", json!({"entryId":entry("response")}), "conflict"),
            ("move", json!({"entryId":"missing"}), "not_found"),
            ("fork", json!({"entryId":""}), "invalid_params"),
            ("fork", json!({"entryId":"missing"}), "not_found"),
        ] {
            let mut params = args;
            params["sessionId"] = json!(id);
            let error = rpc(&cx, &format!("_modular-agent/{method}"), params)
                .await
                .unwrap_err();
            assert_eq!(json!(error.code), -32602);
            assert_eq!(
                error.data,
                Some(json!({"code":code})),
                "{method}: {}",
                error.message
            );
        }
        assert_eq!(rpc(&cx, "_modular-agent/history", all).await?, before);
        Ok(())
    })
    .await;
}

#[tokio::test]
async fn binding_optional_methods_branch_history_and_erasure_shapes() {
    let r = Rig::new(json!(["one", "two"]));
    let cwd = r.project.path().to_path_buf();
    r.client(Some(true), false, async move |cx| {
        let id = cx
            .send_request(NewSessionRequest::new(cwd))
            .block_task()
            .await?
            .session_id;
        cx.send_request(PromptRequest::new(id.clone(), vec!["first".into()]))
            .block_task()
            .await?;
        let history = rpc(&cx, "_modular-agent/history", json!({"sessionId":id})).await?;
        let point = history["entries"].as_array().unwrap().last().unwrap()["id"].clone();
        let response = history["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["kind"] == "response")
            .unwrap();
        assert_eq!(response["message"]["role"], "assistant");
        assert_eq!(response["message"]["content"][0]["text"], "one");
        assert!(response["time"].as_u64().unwrap() > 1_000_000_000_000);
        cx.send_request(PromptRequest::new(id.clone(), vec!["second".into()]))
            .block_task()
            .await?;
        assert_eq!(
            rpc(
                &cx,
                "_modular-agent/move",
                json!({"sessionId":id,"entryId":point})
            )
            .await?,
            json!({})
        );
        let branch = rpc(&cx, "_modular-agent/history", json!({"sessionId":id})).await?;
        let all = rpc(
            &cx,
            "_modular-agent/history",
            json!({"sessionId":id,"all":true}),
        )
        .await?;
        assert!(
            all["entries"].as_array().unwrap().len() > branch["entries"].as_array().unwrap().len()
        );
        let fork = rpc(
            &cx,
            "_modular-agent/fork",
            json!({"sessionId":id,"entryId":point}),
        )
        .await?;
        assert!(fork["sessionId"].is_string());
        assert_eq!(
            rpc(&cx, "_modular-agent/jobs", json!({"sessionId":id})).await?,
            json!({"jobs":[]})
        );
        let erased = rpc(
            &cx,
            "_modular-agent/erase",
            json!({"sessionId":id,"entryIds":[response["id"]]}),
        )
        .await?;
        assert!(
            erased["erased"]
                .as_array()
                .unwrap()
                .contains(&json!({"sessionId":id,"id":response["id"]}))
        );
        assert_eq!(erased["pending"], json!([]));
        assert!(erased["outOfReach"].is_array());
        rpc(&cx, "session/close", json!({"sessionId":id})).await?;
        Ok(())
    })
    .await;
}
