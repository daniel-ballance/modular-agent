use modular_agent::{
    Command, Durability, HookContext, Job, JobOutcome, JobOwner, Plugin, ProcessPlugin, Result,
    async_trait, testing::test_agent,
};
use serde_json::json;

struct Owner;
#[async_trait]
impl JobOwner for Owner {
    fn can_resume(&self) -> bool {
        true
    }
    async fn cancel(&self, _job: Job, _cx: HookContext) -> Result<()> {
        Ok(())
    }
    async fn resume(&self, job: Job, cx: HookContext) -> Result<()> {
        assert_eq!(cx.job_id.as_deref(), Some(job.id.as_str()));
        job.end(JobOutcome::Completed, None, false).await
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    if args[1] == "plugin" {
        return modular_agent::serve(
            Plugin::new("crash-jobs")
                .setup(|r| r.jobs(Owner))
                .on_session_start(|start| async move {
                    if start.resumed {
                        for job in start.context.jobs().unfinished().await? {
                            assert_eq!(job.detail, json!({"test":"crash"}));
                            start.context.jobs().resume(&job).await?;
                        }
                    }
                    Ok(())
                })
                .command(Command::new(
                    "start",
                    "Start an unfinished job",
                    |_, cx| async move {
                        let started = cx
                            .start_job("crash", json!({"test":"crash"}), Some("once"))
                            .await?;
                        assert!(started.job.is_some());
                        Ok(Some(started.id))
                    },
                )),
        )
        .await;
    }
    let agent = test_agent()
        .project(&args[2])
        .data_dir(&args[2])
        .durability(Durability::Kept)
        .process_plugin(ProcessPlugin::new([&args[0], &"plugin".to_owned()]))
        .build()
        .await?;
    if args[1] == "crash" {
        let session = agent.session().await?;
        session.prompt("Keep this session").await?;
        session.run_command("start").await?;
        println!("{}", session.id());
        std::future::pending::<()>().await;
    } else {
        let session = agent.open_session(&args[3]).await?;
        let history = session.history().await?;
        assert_eq!(
            history.iter().filter(|e| e["kind"] == "jobStarted").count(),
            1
        );
        assert_eq!(
            history.iter().filter(|e| e["kind"] == "jobEnded").count(),
            1
        );
        agent.close().await?;
    }
    Ok(())
}
