mod support;
use agent_api::*;
use std::{sync::Arc, time::Duration};
use support::*;

fn job(rig: &Rig) -> Job {
    jobs(&rig.data()).unwrap().pop().unwrap()
}
#[tokio::test]
async fn background_subagent_has_only_its_task_and_report_starts_a_parent_turn() {
    let mut child = calls(vec![ToolCall::new(
        "bash",
        json!({"command":"printf child-work > child.txt"}),
    )])
    .for_task("child-task");
    child.delay_ms = 20;
    let mut child_done = ModelResponse::text("wrote child.txt");
    child_done.usage = Usage {
        input_tokens: 23,
        output_tokens: 5,
        ..Usage::default()
    };
    let rig = Rig::new(vec![
        calls(vec![ToolCall::new(
            "delegate",
            json!({"task":"child-task"}),
        )])
        .for_task("start"),
        text("parent is free").for_task("start"),
        child,
        provider_fake::Script::response(child_done).for_task("child-task"),
        text("The subagent wrote child.txt using bash.").for_task("start"),
    ])
    .await;
    assert_eq!(rig.run("start").await.text, "parent is free");
    let started = job(&rig);
    let ended = job_service(rig.h.as_ref())
        .unwrap()
        .wait(rig.h.clone(), &rig.id, &started.id)
        .await
        .unwrap();
    assert_eq!(ended.state, JobState::Completed);
    assert_eq!(session_usage(&rig.data()).unwrap().input_tokens, 23);
    assert_eq!(
        std::fs::read_to_string(rig.project.path().join("child.txt")).unwrap(),
        "child-work"
    );
    let child_id = ended.detail["child"].as_str().unwrap();
    let child_requests: Vec<_> = rig
        .probe
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.session == child_id)
        .cloned()
        .collect();
    assert_eq!(child_requests[0].messages.len(), 1);
    assert_eq!(child_requests[0].messages[0].text_content(), "child-task");
    assert!(
        !serde_json::to_string(&child_requests)
            .unwrap()
            .contains("parent is free")
    );
    let report = rig
        .data()
        .entries
        .into_iter()
        .find(|e| e.kind == "input.accepted" && e.scope.job.as_ref() == Some(&ended.id))
        .unwrap();
    assert_eq!(report.scope.actor, format!("job:{}", ended.id));
    assert!(
        report.content.unwrap()["text"]
            .as_str()
            .unwrap()
            .contains("wrote child.txt")
    );
    assert_eq!(
        rig.h.run_next(&rig.id).await.unwrap().unwrap().text,
        "The subagent wrote child.txt using bash."
    );
    let starts: Vec<_> = rig
        .data()
        .entries
        .into_iter()
        .filter(|e| e.kind == "turn.start")
        .collect();
    assert_eq!(starts.len(), 2);
    assert_eq!(starts[1].scope.job.as_ref(), Some(&ended.id));
    assert_eq!(starts[1].scope.actor, format!("job:{}", ended.id));
    rig.h.close(&rig.id).await.unwrap();
    assert!(rig.h.snapshot(child_id).is_err());
}
#[tokio::test]
async fn waiting_subagent_returns_result_once_without_a_report_input() {
    let rig = Rig::new(vec![
        calls(vec![ToolCall::new(
            "delegate",
            json!({"task":"child-task","background":false}),
        )])
        .for_task("start"),
        text("child answer").for_task("child-task"),
        text("parent done").for_task("start"),
    ])
    .await;
    assert_eq!(rig.run("start").await.text, "parent done");
    assert!(rig.results()[0].text.contains("child answer"));
    assert_eq!(job(&rig).state, JobState::Completed);
    assert!(
        !rig.data()
            .entries
            .iter()
            .any(|e| e.kind == "input.accepted" && e.scope.job.is_some())
    );
    assert!(rig.h.run_next(&rig.id).await.unwrap().is_none());
    rig.h.close(&rig.id).await.unwrap();
}
#[tokio::test]
async fn message_a_finished_child_keeps_its_history_and_creates_a_new_job() {
    let rig = Rig::new(vec![
        text("remembered apple").for_task("remember apple"),
        text("I remember apple").for_task("remember apple"),
    ])
    .await;
    let rt: Arc<dyn Runtime> = capability(rig.h.as_ref(), "runtime").unwrap();
    let first = rt
        .tool(
            rig.h.clone(),
            Scope::session(&rig.id),
            ToolCall::new(
                "delegate",
                json!({"task":"remember apple","background":false}),
            ),
        )
        .await
        .unwrap();
    let child = first.value.unwrap()["session"]
        .as_str()
        .unwrap()
        .to_string();
    let second = rt
        .tool(
            rig.h.clone(),
            Scope::session(&rig.id),
            ToolCall::new(
                "delegate",
                json!({"task":"What did you remember?","session":child,"background":false}),
            ),
        )
        .await
        .unwrap();
    assert_eq!(second.status, ToolStatus::Completed);
    assert!(second.text.contains("I remember apple"));
    assert_eq!(jobs(&rig.data()).unwrap().len(), 2);
    let reqs = rig.probe.requests.lock().unwrap().clone();
    assert!(
        reqs[1]
            .messages
            .iter()
            .any(|m| m.text_content() == "remembered apple")
    );
    assert!(
        reqs[1]
            .messages
            .iter()
            .any(|m| m.text_content() == "What did you remember?")
    );
    drop(reqs);
    rig.h.close(&rig.id).await.unwrap();
}
#[tokio::test]
async fn nested_child_questions_reach_the_top_user_through_every_level() {
    let mut grand_done = ModelResponse::text("grand done");
    grand_done.usage = Usage {
        input_tokens: 7,
        output_tokens: 2,
        ..Usage::default()
    };
    let rig = Rig::new(vec![
        calls(vec![ToolCall::new(
            "delegate",
            json!({"task":"grand-task","background":false}),
        )])
        .for_task("middle-task"),
        calls(vec![ToolCall::new(
            "ask_user",
            json!({"question":"Top user's choice?"}),
        )])
        .for_task("grand-task"),
        provider_fake::Script::response(grand_done).for_task("grand-task"),
        text("middle done").for_task("middle-task"),
    ])
    .await;
    let rt: Arc<dyn Runtime> = capability(rig.h.as_ref(), "runtime").unwrap();
    let h = rig.h.clone();
    let scope = Scope::session(&rig.id);
    let task = tokio::spawn(async move {
        rt.tool(
            h,
            scope,
            ToolCall::new("delegate", json!({"task":"middle-task","background":false})),
        )
        .await
    });
    rig.events.wait("request.opened").await;
    let svc = requests(rig.h.as_ref()).unwrap();
    let q = svc
        .visible(rig.h.as_ref(), &rig.id, "user")
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(q.route.len(), 3);
    assert_eq!(q.route.last(), Some(&rig.id));
    svc.answer(
        rig.h.clone(),
        &rig.id,
        "user",
        &q.id,
        json!("from top"),
        false,
    )
    .await
    .unwrap();
    let result = tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(result.status, ToolStatus::Completed);
    assert!(result.text.contains("middle done"));
    assert_eq!(session_usage(&rig.data()).unwrap().input_tokens, 7);
    let grand = rig.h.snapshot(&q.scope.session).unwrap();
    assert!(grand.entries.iter().any(|e| e.kind == "request.answer" && e.content.as_ref().unwrap()["session"] == rig.id));
    rig.h.close(&rig.id).await.unwrap();
}
#[tokio::test]
async fn child_authority_is_narrowed_and_depth_limit_is_enforced() {
    let rig = Rig::new(vec![
        calls(vec![ToolCall::new(
            "write",
            json!({"path":"forbidden-child","content":"bad"}),
        )])
        .for_task("narrow-task"),
        text("refused").for_task("narrow-task"),
    ])
    .await;
    let rt: Arc<dyn Runtime> = capability(rig.h.as_ref(), "runtime").unwrap();
    let result = rt.tool(rig.h.clone(), Scope::session(&rig.id), ToolCall::new("delegate", json!({"task":"narrow-task","background":false,"authority":["watch","input","answer"]}))).await.unwrap();
    let child = result.value.unwrap()["session"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(!rig.h.authority(&child, "user").unwrap().has("tools"));
    assert!(!rig.project.path().join("forbidden-child").exists());
    assert!(
        rig.h
            .grant(&Scope::session(&child), "other", Authority::full())
            .is_err()
    );
    rig.h
        .settings(&Scope::session(&rig.id), json!({"subagent_depth_limit":0}))
        .unwrap();
    let limited = rt
        .tool(
            rig.h.clone(),
            Scope::session(&rig.id),
            ToolCall::new("delegate", json!({"task":"too deep","background":false})),
        )
        .await
        .unwrap();
    assert_eq!(limited.status, ToolStatus::Failed);
    assert!(limited.text.contains("depth limit"));
    rig.h.close(&rig.id).await.unwrap();
}
struct Timer;
impl Plugin for Timer {
    fn name(&self) -> &str {
        "test.timer"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.provide::<dyn JobRunner>("job.runner.timer", Arc::new(Self))
    }
}
#[async_trait]
impl JobRunner for Timer {
    async fn run(&self, _: Api, _: Job, _: bool, cancel: CancellationToken) -> Result<TurnResult> {
        cancel.cancelled().await;
        Ok(TurnResult {
            outcome: Outcome::Cancelled,
            ..TurnResult::default()
        })
    }
}
#[tokio::test]
async fn jobs_outlive_turn_cancellation_can_be_cancelled_and_close_stops_them() {
    let mut delayed = text("late");
    delayed.delay_ms = 60_000;
    let rig = Rig::with(vec![delayed], vec![Arc::new(Timer)], vec![], json!({})).await;
    let service = job_service(rig.h.as_ref()).unwrap();
    let first = service
        .start(
            rig.h.clone(),
            Scope::session(&rig.id),
            "timer",
            "timer",
            json!({}),
            true,
        )
        .await
        .unwrap();
    rig.h
        .submit(&rig.id, "user", "start", Timing::Now, None)
        .await
        .unwrap();
    let h = rig.h.clone();
    let id = rig.id.clone();
    let turn = tokio::spawn(async move { h.run_next(&id).await });
    rig.events.wait("step.start").await;
    rig.h.cancel(&rig.id).await.unwrap();
    assert_eq!(
        turn.await.unwrap().unwrap().unwrap().outcome,
        Outcome::Cancelled
    );
    assert_eq!(job(&rig).state, JobState::Running);
    assert_eq!(
        service
            .cancel(rig.h.clone(), &rig.id, "user", &first.id)
            .await
            .unwrap()
            .state,
        JobState::Cancelled
    );
    service
        .start(
            rig.h.clone(),
            Scope::session(&rig.id),
            "timer",
            "timer",
            json!({}),
            true,
        )
        .await
        .unwrap();
    rig.h.close(&rig.id).await.unwrap();
    let store: Arc<dyn HistoryStore> = capability(rig.h.as_ref(), "history").unwrap();
    assert!(
        jobs(&store.load(&rig.id).unwrap())
            .unwrap()
            .iter()
            .all(|j| j.state == JobState::Cancelled)
    );
}
