use modular_agent::{
    Code, Command, Job, JobOutcome, JobOwner, Plugin, Result, Tool, ToolContext, async_trait,
    testing::{restart, test_agent},
};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

#[derive(Clone, Default)]
struct Owner {
    cancelled: Arc<AtomicUsize>,
    resumed: Arc<AtomicUsize>,
}

#[async_trait]
impl JobOwner for Owner {
    async fn cancel(&self, job: Job, context: modular_agent::HookContext) -> Result<()> {
        assert!(job.cancelled.is_cancelled());
        assert_eq!(job.session_id, context.session_id);
        assert!(!context.history(None).await?.entries.is_empty());
        self.cancelled.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    fn can_resume(&self) -> bool {
        true
    }
    async fn resume(&self, job: Job, context: modular_agent::HookContext) -> Result<()> {
        assert_eq!(context.session_id, job.session_id);
        assert_eq!(job.detail, json!({"place":"quay"}));
        self.resumed.fetch_add(1, Ordering::SeqCst);
        job.end(
            JobOutcome::Completed,
            Some(vec![json!({"type":"text","text":"finished"})]),
            false,
        )
        .await
    }
}

#[tokio::test]
async fn tool_jobs_retain_their_handle_until_cancelled_in_both_placements() -> Result<()> {
    for wire in [false, true] {
        let owner = Owner::default();
        let register = owner.clone();
        let started = Arc::new(Mutex::new(None::<Job>));
        let handle = started.clone();
        let plugin = Plugin::new("harbour-jobs")
            .setup(move |r| r.jobs(register.clone()))
            .tool(
                Tool::new("start", "Start a job").run(move |_: Value, cx: ToolContext| {
                    let handle = handle.clone();
                    async move {
                        let job = cx.start_job("check", json!({}), Some("unique")).await?;
                        if let Some(job) = job.job {
                            *handle.lock().unwrap() = Some(job);
                        }
                        Ok(job.id)
                    }
                }),
            );
        let builder = test_agent();
        let agent = if wire {
            builder.over_wire(plugin)
        } else {
            builder.plugin(plugin)
        }
        .build()
        .await?;
        let session = agent.session().await?;
        let first = session.call_tool("start", json!({})).await?;
        let second = session.call_tool("start", json!({})).await?;
        assert_eq!(
            first.status,
            modular_agent::ToolStatus::Completed,
            "{}",
            first.text()
        );
        let job = started.lock().unwrap().take().expect("job handle");
        assert_eq!(first.text(), job.id);
        assert_eq!(second.text(), job.id);
        assert!(!job.history(None).await?.entries.is_empty());
        job.progress(vec![json!({"type":"text","text":"still active"})])
            .await?;
        session.close().await?;
        assert_eq!(owner.cancelled.load(Ordering::SeqCst), 1);
        assert_eq!(
            job.history(None).await.unwrap_err().code(),
            Code::InvalidRequest
        );
        agent.close().await?;
    }
    Ok(())
}

#[tokio::test]
async fn reopening_resumes_registered_command_job_before_returning() -> Result<()> {
    let owner = Owner::default();
    let register = owner.clone();
    let plugin = Plugin::new("harbour-jobs")
        .setup(move |r| r.jobs(register.clone()))
        .command(Command::new("start", "Start a job", |_, cx| async move {
            Ok(Some(
                cx.start_job("check", json!({"place":"quay"}), None)
                    .await?
                    .id,
            ))
        }));
    let agent = test_agent().plugin(plugin).build().await?;
    let original = agent.session().await?;
    let id = original.id().to_owned();
    assert!(original.run_command("start").await?.is_some());
    assert_eq!(owner.resumed.load(Ordering::SeqCst), 0);
    drop(original);
    let agent = restart(agent).await?;
    let session = agent.open_session(&id).await?;
    assert_eq!(owner.resumed.load(Ordering::SeqCst), 1);
    assert!(
        session
            .history()
            .await?
            .iter()
            .any(|e| e["kind"] == "jobEnded")
    );
    agent.close().await
}

#[tokio::test]
async fn unconfirmed_job_cleanup_fences_late_callbacks_and_resume() -> Result<()> {
    struct Unconfirmed;
    #[async_trait]
    impl JobOwner for Unconfirmed {
        fn can_resume(&self) -> bool {
            true
        }
        async fn cancel(&self, _: Job, _: modular_agent::HookContext) -> Result<()> {
            Err(modular_agent::Error::msg("cannot confirm cleanup"))
        }
        async fn resume(&self, _: Job, _: modular_agent::HookContext) -> Result<()> {
            panic!("an unconfirmed execution must not be resumed");
        }
    }
    for served in [false, true] {
        let (handle, mut handles) = tokio::sync::mpsc::unbounded_channel();
        let (seen, mut observed) = tokio::sync::mpsc::unbounded_channel();
        let plugin = Plugin::new("unconfirmed-jobs")
            .setup(|r| r.jobs(Unconfirmed))
            .command(Command::new(
                "start",
                "Start an unfinished job",
                move |_, cx| {
                    let handle = handle.clone();
                    async move {
                        let job = cx.start_job("test", json!({}), None).await?.job.unwrap();
                        handle.send(job).ok().unwrap();
                        Ok(None)
                    }
                },
            ))
            .on_session_start(move |start| {
                let seen = seen.clone();
                async move {
                    if start.resumed {
                        let jobs = start.context.jobs().unfinished().await?;
                        assert_eq!(jobs.len(), 1);
                        assert!(jobs[0].cleanup_unconfirmed);
                        assert_eq!(
                            start
                                .context
                                .jobs()
                                .resume(&jobs[0])
                                .await
                                .unwrap_err()
                                .code(),
                            Code::InvalidRequest
                        );
                        seen.send(()).unwrap();
                    }
                    Ok(())
                }
            });
        let directory = tempfile::tempdir()?;
        let builder = test_agent()
            .data_dir(directory.path())
            .durability(modular_agent::Durability::Kept);
        let agent = if served {
            builder.over_wire(plugin)
        } else {
            builder.plugin(plugin)
        }
        .build()
        .await?;
        let session = agent.session().await?;
        let id = session.id().to_owned();
        session.prompt("Keep this session").await?;
        session.run_command("start").await?;
        let job = handles.try_recv().unwrap();
        session.close().await?;
        let reopened = agent.open_session(&id).await?;
        observed.try_recv().expect("owner saw the unconfirmed job");
        assert_eq!(
            job.end(JobOutcome::Completed, None, false)
                .await
                .unwrap_err()
                .code(),
            Code::InvalidRequest
        );
        let history = reopened.history().await?;
        assert!(history.iter().any(|e| e["kind"] == "jobCleanupUnconfirmed"));
        assert!(!history.iter().any(|e| e["kind"] == "jobEnded"));
        agent.close().await?;
    }
    Ok(())
}
