use modular_agent::{
    Agent, Answer, Code, Durability, Gate, Plugin, Result, ServeHistoryOptions, file_history,
    memory_history, serve_history,
    testing::{answers, fixtures, scripted_provider, test_agent},
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

struct OpaqueProvider(&'static str, Arc<Mutex<Vec<Value>>>);

#[modular_agent::async_trait]
impl modular_agent::Provider for OpaqueProvider {
    fn id(&self) -> &str {
        self.0
    }

    fn models(&self) -> Vec<modular_agent::ModelInfo> {
        vec![modular_agent::ModelInfo {
            model: modular_agent::ModelRef {
                provider: self.0.into(),
                id: "test".into(),
            },
            context_window: 65_536,
            max_output: 1024,
            thinking: vec![],
            extra: Default::default(),
        }]
    }

    async fn request(
        &self,
        _: modular_agent::ModelRef,
        request: modular_agent::ModelRequest,
        _: modular_agent::ProviderContext,
    ) -> Result<modular_agent::AssistantMessage> {
        self.1.lock().unwrap().push(request.0);
        Ok(modular_agent::AssistantMessage(json!({
            "role":"assistant", "stop":"finished", "providerData":["private", self.0],
            "content":[{"type":"reasoning","text":"visible","providerData":"sealed"},{"type":"text","text":"hello"}]
        })))
    }
}

#[tokio::test]
async fn stored_sessions_and_provider_data_survive_reopen_but_stay_scoped() -> Result<()> {
    let data = tempfile::tempdir()?;
    let a = Arc::new(Mutex::new(vec![]));
    let b = Arc::new(Mutex::new(vec![]));
    let build = || {
        Agent::builder()
            .data_dir(data.path())
            .durability(Durability::Durable)
            .provider(OpaqueProvider("first", a.clone()))
            .provider(OpaqueProvider("second", b.clone()))
            .model("first/test")
            .build()
    };
    let agent = build().await?;
    let session = agent.session().await?;
    let id = session.id().to_owned();
    session.send("once", modular_agent::Timing::Now).await?;
    session.wait_idle().await?;
    assert_eq!(a.lock().unwrap().len(), 1);
    session.close().await?;
    agent.close().await?;

    let agent = build().await?;
    assert_eq!(agent.sessions(None)?.len(), 1);
    let saved = agent.session_info(&id)?;
    assert_eq!(
        saved.settings["model"],
        json!({"provider":"first","id":"test"})
    );
    assert!(saved.created_at > 0 && saved.last_active >= saved.created_at);
    assert_eq!(a.lock().unwrap().len(), 1); // Listing did not run the Provider.
    let session = agent.open_session(&id).await?;
    session.prompt("again").await?;
    assert!(
        a.lock()
            .unwrap()
            .last()
            .unwrap()
            .to_string()
            .contains("sealed")
    );
    assert!(
        a.lock()
            .unwrap()
            .last()
            .unwrap()
            .to_string()
            .contains("private")
    );
    session.set_setting("model", json!("second/test"))?;
    session.prompt("different Provider").await?;
    let requests = b.lock().unwrap()[0].to_string();
    assert!(requests.contains("visible"));
    assert!(!requests.contains("providerData"));
    assert!(!serde_json::to_string(&session.history().await?)?.contains("providerData"));
    agent.close().await
}

#[tokio::test]
async fn persistent_history_and_local_recovery_need_different_storage() -> Result<()> {
    let data = tempfile::tempdir()?;
    for durability in [Durability::Kept, Durability::Durable] {
        let err = test_agent()
            .durability(durability)
            .build()
            .await
            .err()
            .unwrap();
        assert_eq!(err.code(), Code::InvalidComposition);
        assert!(err.message().contains("persistent history"));
        let err = Agent::builder()
            .durability(durability)
            .history(file_history(data.path())?)
            .build()
            .await
            .err()
            .unwrap();
        assert_eq!(err.code(), Code::InvalidComposition);
        assert!(err.message().contains("local working environment"));
    }
    Ok(())
}

#[tokio::test]
async fn store_capabilities_control_erasure_and_service_eligibility() -> Result<()> {
    let data = tempfile::tempdir()?;
    let memory = serve_history(
        memory_history(),
        ServeHistoryOptions::new(
            "127.0.0.1:0".parse().unwrap(),
            data.path().join("not-opened"),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(memory.code(), Code::NotSupported);
    assert!(memory.message().contains("memory"));

    let agent = test_agent()
        .durability(Durability::Kept)
        .data_dir(data.path())
        .script(json!([{"text":"kept"}]))
        .build()
        .await?;
    let decl = agent.declaration()?;
    assert_eq!(decl["erasure"], true);
    assert_eq!(decl["queuedInputAfterRestart"], "handedBack");
    assert_eq!(decl["queuedJobReportsAfterRestart"], "run");
    let session = agent.session().await?;
    session.prompt("Erase my answer").await?;
    let response = session
        .history()
        .await?
        .into_iter()
        .find(|e| e["kind"] == "response")
        .unwrap();
    let id = response["id"].as_str().unwrap();
    let report = session.erase(vec![id.into(), id.into()]).await?;
    assert!(report.erased.iter().any(|entry| entry.id == id));
    assert!(
        session
            .history()
            .await?
            .iter()
            .any(|e| e["id"] == id && e["message"].is_null())
    );
    agent.close().await
}

#[tokio::test]
async fn unknown_model_is_refused_before_admission() -> Result<()> {
    let agent = Agent::builder()
        .provider(scripted_provider(json!([])))
        .model("scripted/missing")
        .build()
        .await;
    assert_eq!(agent.err().unwrap().code(), Code::InvalidRequest);
    let agent = test_agent().build().await?;
    let session = agent.session().await?;
    assert_eq!(
        session
            .set_setting("model", json!("scripted/missing"))
            .unwrap_err()
            .code(),
        Code::InvalidRequest
    );
    assert_eq!(
        session.settings()?["model"],
        json!({"provider":"scripted","id":"script"})
    );
    agent.close().await
}

#[tokio::test]
async fn step_after_refusal_fails_turn_with_its_reason_in_both_placements() -> Result<()> {
    for wire in [false, true] {
        let hook =
            Plugin::new("gate").on_step_after(|_| async { Ok(Gate::Refuse("stop here".into())) });
        let builder = test_agent().script(json!([{"text":"not accepted"}]));
        let agent = if wire {
            builder.over_wire(hook)
        } else {
            builder.plugin(hook)
        }
        .build()
        .await?;
        let turn = agent.session().await?.prompt("Go").await?;
        assert!(
            matches!(turn.outcome, Some(modular_agent::Outcome::Failed { error }) if error.contains("stop here"))
        );
        agent.close().await?;
    }
    Ok(())
}

#[tokio::test]
async fn built_in_parts_can_be_selected_explicitly() -> Result<()> {
    use modular_agent::{Agent, Durability, durable_runtime, local_environment, transient_runtime};
    let project = tempfile::tempdir()?;
    let agent = Agent::builder()
        .runtime(transient_runtime())
        .environment(local_environment(Some(project.path().into())))
        .build()
        .await?;
    assert!(
        !agent.declaration()?["continuesAfterRestart"]
            .as_bool()
            .unwrap()
    );
    assert_eq!(agent.declaration()?["confinesFiles"], false);
    let session = agent.session().await?;
    assert!(!session.id().is_empty());
    agent.close().await?;
    let data = tempfile::tempdir()?;
    let mismatched = Agent::builder()
        .data_dir(data.path())
        .durability(Durability::Kept)
        .runtime(durable_runtime())
        .build()
        .await;
    assert!(matches!(mismatched, Err(e) if e.code() == Code::InvalidComposition));
    Ok(())
}

#[tokio::test]
async fn answer_queue_distinguishes_unused_and_unexpected_questions() -> Result<()> {
    let answer = Answer::Value("yes".into());
    assert!(
        answers([answer.clone()])
            .assert_done()
            .unwrap_err()
            .message()
            .contains("1 unused")
    );
    let queue = answers([answer]);
    let agent = test_agent()
        .answers(queue.clone())
        .plugin(fixtures::fixture("confirm").unwrap())
        .script(json!([
            {"toolCalls":[{"name":"confirm","input":{"question":"Expected?"}}]},
            {"toolCalls":[{"name":"confirm","input":{"question":"Extra question?"}}]},
            {"text":"done"}
        ]))
        .build()
        .await?;
    let turn = agent.session().await?.prompt("Go").await?;
    assert_eq!(turn.tool_results()[0].text(), "yes");
    assert_eq!(turn.tool_results()[1].text(), "declined");
    let error = queue.assert_done().unwrap_err();
    assert!(error.message().contains("Extra question?"));
    agent.close().await
}
