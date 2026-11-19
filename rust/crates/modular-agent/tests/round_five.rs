mod support;
use agent_api::*;
use support::{Rig, text};

#[tokio::test]
async fn a_tool_outside_a_turn_records_a_point_and_rewind_restores_it() {
    let rig = Rig::with(vec![], vec![], vec![], json!({"approval":"off"})).await;
    let scope = Scope::session(&rig.id);
    let mark = rig.data().position.unwrap();
    let runtime: std::sync::Arc<dyn Runtime> = capability(rig.h.as_ref(), "runtime").unwrap();
    let file = rig.project.path().join("change.txt");
    std::fs::write(&file, "before").unwrap();
    let result = runtime
        .tool(
            rig.h.clone(),
            scope.clone(),
            ToolCall::new("write", json!({"path":"change.txt","content":"after"})),
        )
        .await
        .unwrap();
    assert_eq!(result.status, ToolStatus::Completed);
    let data = rig.data();
    let started = data
        .entries
        .iter()
        .find(|e| e.kind == "tool.started")
        .unwrap();
    assert!(started.scope.turn.is_none());
    assert!(portable::entry(started, &data).unwrap()["data"]["point"].is_string());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "after");
    rig.h.rewind(&scope, mark.clone()).await.unwrap();
    assert_eq!(rig.data().position.as_deref(), Some(mark.as_str()));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "before");
}

#[tokio::test]
async fn reopening_an_unavailable_model_does_not_substitute_and_can_be_repaired() {
    let rig = Rig::new(vec![text("model chosen")]).await;
    let scope = Scope::session(&rig.id);
    rig.h
        .settings(
            &scope,
            json!({"model":"foreign/missing","approval":"never_ask"}),
        )
        .unwrap();
    rig.h.close(&rig.id).await.unwrap();
    rig.h.open(&rig.id).await.unwrap();
    let result = rig.run("do not substitute").await;
    assert_eq!(result.outcome, Outcome::Failed);
    assert!(result.error.unwrap().contains("foreign/missing"));
    assert!(rig.probe.requests.lock().unwrap().is_empty());
    let data = rig.data();
    let failure = data
        .entries
        .iter()
        .find(|e| e.kind == "model.failure")
        .unwrap();
    assert_eq!(failure.content.as_ref().unwrap()["kind"], "other");
    let settings = data.entries.iter().find(|e| e.kind == "settings").unwrap();
    assert_eq!(
        portable::entry(settings, &data).unwrap()["data"]["value"]["approval"],
        "never"
    );
    assert_eq!(data.settings["approval"], "never_ask");
    rig.h.settings(&scope, json!({"model":"fake"})).unwrap();
    assert_eq!(rig.run("try again").await.text, "model chosen");
}

#[tokio::test]
async fn a_handed_back_key_keeps_its_first_receipt_after_restart() {
    let rig = Rig::new(vec![]).await;
    let first = rig
        .h
        .submit(
            &rig.id,
            "user",
            "queued",
            Timing::After,
            Some("same".into()),
        )
        .await
        .unwrap();
    rig.h.close(&rig.id).await.unwrap();
    rig.h.open(&rig.id).await.unwrap();
    let data = rig.data();
    let receipt = data
        .entries
        .iter()
        .find(|e| e.kind == "input.accepted")
        .unwrap();
    let returned = data
        .entries
        .iter()
        .find(|e| e.kind == "input.returned")
        .unwrap();
    let receipt = portable::entry(receipt, &data).unwrap();
    assert_eq!(receipt["inputId"], first.input);
    assert_eq!(
        receipt["data"],
        json!({"inputId":first.input,"when":"after","content":[{"type":"text","text":"queued"}],"key":"same","taken":"after","rust.taken":"after","rust.authority":Authority::full()})
    );
    assert_eq!(
        portable::entry(returned, &data).unwrap()["data"]["inputIds"],
        json!([first.input])
    );
    let retry = rig
        .h
        .submit(
            &rig.id,
            "user",
            "not taken",
            Timing::Now,
            Some("same".into()),
        )
        .await
        .unwrap();
    assert_eq!(retry.input, first.input);
    assert!(retry.duplicate);
    assert!(rig.h.run_next(&rig.id).await.unwrap().is_none());
}

#[test]
fn a_service_tombstone_retains_the_original_identity_and_nothing_else() {
    let row = json!({"id":"settled","parentId":null,"kind":"toolResult","erased":true,"turnId":"t","stepId":"s","toolCallId":"c","jobId":"j"});
    let data = portable::session(
        &json!({"id":"sample","project":"/tmp"}),
        std::slice::from_ref(&row),
    )
    .unwrap();
    assert_eq!(data.entries[0].kind, "tool.result");
    assert_eq!(portable::entry(&data.entries[0], &data).unwrap(), row);
}
