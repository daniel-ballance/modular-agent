mod support;
use agent_api::*;
use agent_client_protocol::v1::schema::{CloseSessionRequest, NewSessionRequest, PromptRequest};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use support::acp::rpc;
use support::{Rig, text};

struct Fixture {
    events: Mutex<Vec<String>>,
    missing: Option<&'static str>,
    fail_restore: bool,
    fail_save: std::sync::atomic::AtomicBool,
    fail_undo: std::sync::atomic::AtomicBool,
    restore_entered: tokio::sync::Notify,
    resume_restore: Option<tokio::sync::Notify>,
}
struct TestEnvironment(Arc<Fixture>);
impl Plugin for TestEnvironment {
    fn name(&self) -> &str {
        "test.environment"
    }
    fn replaces(&self) -> Option<&str> {
        Some("environment.local")
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.provide::<dyn WorkingEnvironment>("environment", self.0.clone())
    }
}
#[async_trait]
impl WorkingEnvironment for Fixture {
    fn declaration(&self) -> Value {
        json!({"rewinding":true})
    }
    async fn check_point(&self, _: &str, _: &Path, point: &str) -> Result<bool> {
        self.events.lock().unwrap().push(format!("check {point}"));
        Ok(self.missing != Some(point))
    }
    async fn save_point(&self, _: &str, _: &Path) -> Result<String> {
        self.events.lock().unwrap().push("save".into());
        ensure!(
            !self.fail_save.load(std::sync::atomic::Ordering::SeqCst),
            "snapshot storage unavailable"
        );
        Ok("undo".into())
    }
    async fn restore_point(&self, _: &str, project: &Path, point: &str) -> Result<()> {
        self.events.lock().unwrap().push(format!("restore {point}"));
        if let Some(resume) = &self.resume_restore {
            self.restore_entered.notify_one();
            resume.notified().await;
        }
        std::fs::write(project.join("file.txt"), point)?;
        if point == "undo" {
            ensure!(
                !self.fail_undo.load(std::sync::atomic::Ordering::SeqCst),
                "undo unavailable"
            );
        } else {
            ensure!(!self.fail_restore, "partial restore");
        }
        Ok(())
    }
    async fn read(&self, project: &Path, path: &str) -> Result<String> {
        Ok(std::fs::read_to_string(project.join(path))?)
    }
    async fn write(&self, project: &Path, path: &str, content: &str) -> Result<()> {
        std::fs::write(project.join(path), content)?;
        Ok(())
    }
    async fn edit(&self, _: &Path, _: &str, _: &str, _: &str) -> Result<()> {
        unreachable!()
    }
    async fn bash(
        &self,
        _: Api,
        _: Scope,
        _: PathBuf,
        _: &str,
        _: CancellationToken,
    ) -> Result<ToolResult> {
        unreachable!()
    }
}

async fn fixture(
    missing: Option<&'static str>,
    fail_restore: bool,
    pause: bool,
) -> (Rig, Arc<Fixture>, String) {
    let env = Arc::new(Fixture {
        events: Mutex::default(),
        missing,
        fail_restore,
        fail_save: Default::default(),
        fail_undo: Default::default(),
        restore_entered: Default::default(),
        resume_restore: pause.then(Default::default),
    });
    let rig = Rig::with(
        vec![text("model ran")],
        vec![Arc::new(TestEnvironment(env.clone()))],
        vec![],
        json!({"approval":"off"}),
    )
    .await;
    let mark = rig.data().position.unwrap();
    for point in ["first", "later"] {
        let scope = Scope {
            turn: Some(id()),
            ..Scope::session(&rig.id)
        };
        rig.h
            .append(
                &scope,
                "test",
                Draft::new(
                    "turn.start",
                    false,
                    json!({"point":point,"model":{"name":"fake"}}),
                ),
            )
            .unwrap();
        rig.h
            .append(
                &scope,
                "test",
                Draft::new("turn.end", false, json!(TurnResult::default())),
            )
            .unwrap();
    }
    std::fs::write(rig.project.path().join("file.txt"), "current").unwrap();
    (rig, env, mark)
}

#[tokio::test]
async fn a_failed_point_save_fails_the_turn_before_model_dispatch() {
    let (rig, env, _) = fixture(None, false, false).await;
    let mark = rig.data().position.unwrap();
    env.fail_save
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let result = rig.run("test").await;
    assert_eq!(result.outcome, Outcome::Failed);
    assert!(
        result
            .error
            .unwrap()
            .contains("snapshot storage unavailable")
    );
    assert_eq!(*env.events.lock().unwrap(), ["save"]);
    assert!(rig.probe.requests.lock().unwrap().is_empty());
    let entries = rig.data().entries;
    let end = entries.last().unwrap();
    assert_eq!(end.kind, "turn.end");
    assert!(
        !entries
            .iter()
            .any(|e| e.kind == "turn.start" && e.scope.turn == end.scope.turn)
    );
    rig.h.rewind(&Scope::session(&rig.id), mark).await.unwrap();
}

#[tokio::test]
async fn a_failed_point_save_blocks_an_out_of_turn_tool() {
    let (rig, env, _) = fixture(None, false, false).await;
    let mark = rig.data().position.unwrap();
    env.fail_save
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let runtime: Arc<dyn Runtime> = capability(rig.h.as_ref(), "runtime").unwrap();
    let result = runtime
        .tool(
            rig.h.clone(),
            Scope::session(&rig.id),
            ToolCall::new("write", json!({"path":"file.txt","content":"changed"})),
        )
        .await
        .unwrap();
    assert_eq!(result.status, ToolStatus::Failed);
    assert!(result.text.contains("snapshot storage unavailable"));
    assert_eq!(*env.events.lock().unwrap(), ["save"]);
    assert!(!rig.data().entries.iter().any(|e| e.kind == "tool.started"));
    assert_eq!(
        std::fs::read_to_string(rig.project.path().join("file.txt")).unwrap(),
        "current"
    );
    rig.h.rewind(&Scope::session(&rig.id), mark).await.unwrap();
}

#[tokio::test]
async fn a_missing_later_point_prevents_any_save_restore_or_history_change() {
    let (rig, env, mark) = fixture(Some("later"), false, false).await;
    let before = rig.data();
    let error = rig
        .h
        .rewind(&Scope::session(&rig.id), mark)
        .await
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<RewindError>(),
        Some(RewindError::Conflict(_))
    ));
    assert_eq!(*env.events.lock().unwrap(), ["check first", "check later"]);
    assert_eq!(rig.data().position, before.position);
    assert_eq!(rig.data().entries.len(), before.entries.len());
    assert_eq!(
        std::fs::read_to_string(rig.project.path().join("file.txt")).unwrap(),
        "current"
    );
}

#[tokio::test]
async fn rewind_reserves_the_project_and_commits_intent_before_restore() {
    let (rig, env, mark) = fixture(None, false, true).await;
    let previous = rig.data().position;
    let scope = Scope::session(&rig.id);
    let h = rig.h.clone();
    let task = tokio::spawn({
        let scope = scope.clone();
        let mark = mark.clone();
        async move { h.rewind(&scope, mark).await }
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        env.restore_entered.notified(),
    )
    .await
    .unwrap();
    let store: Arc<dyn HistoryStore> = capability(rig.h.as_ref(), "history").unwrap();
    let saved = store.load(&rig.id).unwrap();
    let intent = saved.entries.last().unwrap();
    assert_eq!(intent.kind, "position");
    assert_eq!(intent.parent, previous);
    assert_eq!(
        intent.content.as_ref().unwrap(),
        &json!({"to":mark,"restore":{"point":"first","undo":"undo"}})
    );
    assert!(
        rig.h
            .append(&scope, "test", Draft::new("interleave", false, Value::Null))
            .is_err()
    );
    assert!(rig.h.create(rig.project.path(), json!({})).await.is_err());
    assert!(rig.h.begin_environment_work(&rig.id).is_err());
    env.resume_restore.as_ref().unwrap().notify_one();
    task.await.unwrap().unwrap();
    let saved = store.load(&rig.id).unwrap();
    let completion = saved.entries.last().unwrap();
    assert_eq!(completion.kind, "position");
    assert_eq!(completion.parent.as_deref(), Some(mark.as_str()));
    assert_eq!(completion.content.as_ref().unwrap(), &json!({"to":mark}));
    assert_eq!(
        *env.events.lock().unwrap(),
        ["check first", "check later", "save", "restore first"]
    );
    rig.h.close(&rig.id).await.unwrap();
    rig.h.open(&rig.id).await.unwrap();
    assert_eq!(env.events.lock().unwrap().len(), 4);
}

#[tokio::test]
async fn a_partial_restore_is_compensated_and_leaves_the_original_head() {
    let (rig, env, mark) = fixture(None, true, false).await;
    let previous = rig.data().position.unwrap();
    let error = rig
        .h
        .rewind(&Scope::session(&rig.id), mark.clone())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("original files restored"));
    let saved = rig.data();
    let positions = &saved.entries[saved.entries.len() - 3..];
    assert_eq!(
        positions.iter().map(|e| &e.content).collect::<Vec<_>>(),
        [
            &Some(json!({"to":mark,"restore":{"point":"first","undo":"undo"}})),
            &Some(json!({"to":previous,"restore":{"point":"undo","undo":"first"}})),
            &Some(json!({"to":previous})),
        ]
    );
    assert_eq!(saved.position.as_deref(), Some(previous.as_str()));
    assert_eq!(
        std::fs::read_to_string(rig.project.path().join("file.txt")).unwrap(),
        "undo"
    );
    assert_eq!(
        *env.events.lock().unwrap(),
        [
            "check first",
            "check later",
            "save",
            "restore first",
            "restore undo"
        ]
    );
}

#[tokio::test]
async fn reopen_retries_only_the_undo_and_keeps_the_project_blocked_if_it_fails() {
    use std::sync::atomic::Ordering::SeqCst;
    let (rig, env, mark) = fixture(None, true, false).await;
    let previous = rig.data().position.unwrap();
    let scope = Scope::session(&rig.id);
    env.fail_undo.store(true, SeqCst);
    assert!(rig.h.rewind(&scope, mark).await.is_err());
    assert!(rig.h.rewind_pending(&rig.id).unwrap());
    assert!(rig.h.run_next(&rig.id).await.is_err());
    assert!(rig.h.create(rig.project.path(), json!({})).await.is_err());
    let before = env.events.lock().unwrap().len();
    rig.h.close(&rig.id).await.unwrap();
    assert!(rig.h.open(&rig.id).await.is_err());
    assert_eq!(&env.events.lock().unwrap()[before..], ["restore undo"]);
    assert!(rig.h.create(rig.project.path(), json!({})).await.is_err());
    env.fail_undo.store(false, SeqCst);
    rig.h.open(&rig.id).await.unwrap();
    assert_eq!(
        &env.events.lock().unwrap()[before..],
        ["restore undo", "restore undo"]
    );
    assert!(!rig.h.rewind_pending(&rig.id).unwrap());
    assert_eq!(rig.data().position.as_deref(), Some(previous.as_str()));
}

#[tokio::test]
async fn reopening_replays_only_the_unresolved_intent() {
    let rig = Rig::new(vec![text("point")]).await;
    let file = rig.project.path().join("file.txt");
    std::fs::write(&file, "before").unwrap();
    let mark = rig.data().position.unwrap();
    rig.run("save a point").await;
    let mut data = rig.data();
    let point = data
        .entries
        .iter()
        .find(|e| e.kind == "turn.start")
        .unwrap()
        .content
        .as_ref()
        .unwrap()["point"]
        .clone();
    std::fs::write(&file, "current").unwrap();
    let env: Arc<dyn WorkingEnvironment> = capability(rig.h.as_ref(), "environment").unwrap();
    let undo = env.save_point(&rig.id, rig.project.path()).await.unwrap();
    rig.h.close(&rig.id).await.unwrap();
    let store: Arc<dyn HistoryStore> = capability(rig.h.as_ref(), "history").unwrap();
    {
        let _lease = store.acquire(&rig.id).unwrap();
        let mut intent = data.entries.last().unwrap().clone();
        intent.id = id();
        intent.parent = data.position.clone();
        intent.kind = "position".into();
        intent.scope = Scope::session(&rig.id);
        intent.content = Some(json!({"to":mark,"restore":{"point":point,"undo":undo}}));
        data.entries.push(intent);
        data.position = Some(mark.clone());
        store.save(&data).unwrap();
    }
    rig.h.open(&rig.id).await.unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "before");
    assert_eq!(
        rig.data().entries.last().unwrap().content,
        Some(json!({"to":mark}))
    );
    rig.h.close(&rig.id).await.unwrap();
    std::fs::write(&file, "new edits").unwrap();
    rig.h.open(&rig.id).await.unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "new edits");
}

#[tokio::test]
async fn a_served_environment_checks_point_scope_without_restoring() {
    let rig = Rig::new(vec![]).await;
    rig.h.close(&rig.id).await.unwrap();
    let plugin = plugin_stdio::load(
        &rig.h,
        plugin_stdio::Launch {
            command: vec![
                env!("CARGO_BIN_EXE_modular-agent").into(),
                "--serve-plugin".into(),
            ],
            env: [("MODULAR_AGENT_PLUGIN_PARTS".into(), "environment".into())].into(),
            config: json!({}),
        },
        rig.project.path(),
        &rig.root.path().join("environment-plugin"),
        0,
    )
    .await
    .unwrap();
    let project = rig.project.path();
    let file = project.join("point.txt");
    std::fs::write(&file, "before").unwrap();
    let a = rig.h.create(project, json!({})).await.unwrap();
    let b = rig.h.create(project, json!({})).await.unwrap();
    let env: Arc<dyn WorkingEnvironment> = capability(rig.h.as_ref(), "environment").unwrap();
    let point = env.save_point(&a, project).await.unwrap();
    std::fs::write(&file, "after").unwrap();
    assert!(env.check_point(&a, project, &point).await.unwrap());
    assert!(!env.check_point(&b, project, &point).await.unwrap());
    assert!(!env.check_point(&a, project, "unknown").await.unwrap());
    assert!(env.check_point(&a, rig.root.path(), &point).await.is_err());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "after");
    assert!(env.restore_point(&b, project, &point).await.is_err());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "after");
    rig.h.close(&a).await.unwrap();
    rig.h.close(&b).await.unwrap();
    plugin.shutdown().await.unwrap();
}

#[tokio::test]
async fn acp_reports_the_point_save_error_for_the_original_prompt_and_its_retry() {
    let rig = support::acp::Rig::new(json!(["the model should not run"]));
    let project = rig.project.path().to_owned();
    assert!(
        std::process::Command::new("mkfifo")
            .arg(project.join("unsupported-fifo"))
            .status()
            .unwrap()
            .success()
    );
    rig.client(None, false, async move |cx| {
        let session = cx
            .send_request(NewSessionRequest::new(project))
            .block_task()
            .await?
            .session_id;
        let args = json!({
            "sessionId":session,
            "prompt":[{"type":"text","text":"test"}],
            "_meta":{"modular-agent":{"key":"failed-save"}}
        });
        let reply = rpc(&cx, "session/prompt", args.clone()).await?;
        let outcome = &reply["_meta"]["modular-agent"]["outcome"];
        assert_eq!(outcome["kind"], "failed");
        assert!(
            outcome["error"]
                .as_str()
                .unwrap()
                .contains("unsupported-fifo")
        );
        let duplicate = rpc(&cx, "session/prompt", args).await?;
        assert_eq!(duplicate["_meta"]["modular-agent"]["duplicate"], true);
        assert_eq!(&duplicate["_meta"]["modular-agent"]["outcome"], outcome);
        Ok(())
    })
    .await;
}

#[tokio::test]
async fn acp_refuses_rewind_while_another_session_uses_the_same_project() {
    let rig = support::acp::Rig::new(json!(["seed answer"]));
    let project = rig.project.path().to_owned();
    let alias = rig.root.path().join("alias");
    std::os::unix::fs::symlink(&project, &alias).unwrap();
    rig.client(None, false, async move |cx| {
        let a = cx
            .send_request(NewSessionRequest::new(project))
            .block_task()
            .await?
            .session_id;
        cx.send_request(PromptRequest::new(a.clone(), vec!["seed".into()]))
            .block_task()
            .await?;
        let history = rpc(&cx, "_modular-agent/history", json!({"sessionId":a})).await?;
        let target = &history["entries"]
            .as_array()
            .unwrap()
            .iter()
            .rfind(|e| e["kind"] == "turnEnd")
            .unwrap()["id"];
        let b = cx
            .send_request(NewSessionRequest::new(alias))
            .block_task()
            .await?
            .session_id;
        let args = json!({"sessionId":a,"entryId":target,"rewind":true});
        let error = rpc(&cx, "_modular-agent/move", args.clone())
            .await
            .unwrap_err();
        assert_eq!(error.data.as_ref().unwrap()["code"], "conflict");
        assert!(error.message.contains("shared project"));
        cx.send_request(CloseSessionRequest::new(b))
            .block_task()
            .await?;
        rpc(&cx, "_modular-agent/move", args).await?;
        cx.send_request(CloseSessionRequest::new(a))
            .block_task()
            .await?;
        Ok(())
    })
    .await;
}
