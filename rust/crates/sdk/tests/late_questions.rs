use modular_agent::{Answer, Ask, AskWait, Plugin, Result, Tool, ToolContext, testing::test_agent};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::mpsc;

#[tokio::test]
async fn timed_question_resumes_the_same_call_with_the_recorded_answer() -> Result<()> {
    tokio::time::timeout(Duration::from_secs(5), async {
        for served in [false, true] {
            let (show, mut questions) = mpsc::unbounded_channel();
            let attempts = Arc::new(AtomicUsize::new(0));
            let suspensions = Arc::new(AtomicUsize::new(0));
            let plugin =
                Plugin::new("palette-tool").tool(Tool::new("palette", "Choose a palette").run({
                    let (attempts, suspensions) = (attempts.clone(), suspensions.clone());
                    move |_: Value, cx: ToolContext| {
                        let (attempts, suspensions) = (attempts.clone(), suspensions.clone());
                        async move {
                            attempts.fetch_add(1, Ordering::SeqCst);
                            let answer = cx
                                .ask_with(
                                    Ask::text("Which palette?"),
                                    AskWait {
                                        wait: Duration::from_millis(10),
                                    },
                                )
                                .await
                                .inspect_err(|error| {
                                    if error.is_left_open() {
                                        suspensions.fetch_add(1, Ordering::SeqCst);
                                    }
                                })?;
                            assert!(matches!(&answer, Answer::Value(value) if value == "blue"));
                            Ok("blue palette")
                        }
                    }
                }));
            let builder = test_agent()
                .on_question(move |question| {
                    let (reply, answer) = tokio::sync::oneshot::channel();
                    show.send((question, reply)).unwrap();
                    async move { answer.await.unwrap() }
                })
                .script(json!([{"toolCalls":[{"name":"palette","input":{}}]}, {"text":"Done."}]));
            let agent = if served {
                builder.over_wire(plugin)
            } else {
                builder.plugin(plugin)
            }
            .build()
            .await?;
            let session = agent.session().await?;
            let mut events = session.events(None)?;
            let turn = session.prompt("Choose a palette").await?;
            assert_eq!(turn.open_tool_calls.len(), 1, "served={served}: {turn:?}");
            assert_eq!(suspensions.load(Ordering::SeqCst), 1);
            let (question, reply) = questions.recv().await.unwrap();
            assert_eq!(session.questions()?[0].id, question.id);
            reply.send(Answer::Value("blue".into())).unwrap();
            use futures_util::StreamExt;
            loop {
                let event = events.next().await.unwrap()?;
                if event.event_type == "toolResult" {
                    assert_eq!(event.data["status"], "completed");
                    assert_eq!(event.data["content"][0]["text"], "blue palette");
                    break;
                }
            }
            session.wait_idle().await?;
            assert_eq!(attempts.load(Ordering::SeqCst), 2);
            assert!(questions.try_recv().is_err());
            agent.close().await?;
        }
        Ok(())
    })
    .await
    .expect("late question did not continue")
}

#[tokio::test]
async fn timed_pending_recovery() -> Result<()> {
    use modular_agent::{Agent, Durability, testing::scripted_provider};
    use std::{fs, path::Path, process::Command};

    async fn agent(root: &Path, boundary: String) -> Result<Agent> {
        let calls = root.join("calls");
        let before = boundary == "before-pending";
        let plugin = Plugin::new("timed-recovery")
            .tool(
                Tool::new("palette", "Choose a palette")
                    .safe_to_repeat()
                    .run(move |_: Value, cx: ToolContext| {
                        let calls = calls.clone();
                        async move {
                            use std::io::Write;
                            writeln!(
                                fs::OpenOptions::new()
                                    .create(true)
                                    .append(true)
                                    .open(calls)?,
                                "call"
                            )?;
                            let answer = cx
                                .ask_with(
                                    Ask::text("Palette?"),
                                    AskWait {
                                        wait: Duration::from_millis(10),
                                    },
                                )
                                .await;
                            if before && answer.as_ref().is_err_and(|e| e.is_left_open()) {
                                std::process::exit(71);
                            }
                            assert!(matches!(answer?, Answer::Value(value) if value == "blue"));
                            Ok("blue palette")
                        }
                    }),
            )
            .setup(move |r| {
                if boundary == "after-pending" {
                    r.on_turn_end(|_| async { std::process::exit(71) });
                }
                Ok(())
            });
        Agent::builder()
            .project(root)
            .data_dir(root.join("data"))
            .durability(Durability::Durable)
            .provider(scripted_provider(
                json!([{"toolCalls":[{"name":"palette","input":{}}]}, {"text":"Done."}]),
            ))
            .plugin(plugin)
            .build()
            .await
    }
    if let Some(root) = std::env::var_os("SDK_TIMED_CRASH_ROOT") {
        let root = std::path::PathBuf::from(root);
        let agent = agent(&root, std::env::var("SDK_TIMED_CRASH_BOUNDARY").unwrap()).await?;
        let session = agent.session().await?;
        fs::write(root.join("session"), session.id())?;
        session.prompt("Choose a palette").await?;
        panic!("missed crash boundary");
    }
    for boundary in ["before-pending", "after-pending"] {
        let root = tempfile::tempdir()?;
        let status = Command::new(std::env::current_exe()?)
            .args(["--exact", "timed_pending_recovery"])
            .env("SDK_TIMED_CRASH_ROOT", root.path())
            .env("SDK_TIMED_CRASH_BOUNDARY", boundary)
            .status()?;
        assert_eq!(status.code(), Some(71), "{boundary}");
        let agent = agent(root.path(), String::new()).await?;
        let session = agent
            .open_session(&fs::read_to_string(root.path().join("session"))?)
            .await?;
        assert_eq!(fs::read_to_string(root.path().join("calls"))?, "call\n");
        let turn = session.last_turn().await?.unwrap();
        if boundary == "before-pending" {
            assert!(turn.open_tool_calls.is_empty());
            assert!(session.questions()?.is_empty());
            assert_eq!(
                turn.tool_results()[0].status,
                modular_agent::ToolStatus::OutcomeUnknown
            );
        } else {
            assert_eq!(turn.open_tool_calls.len(), 1);
            let question = session
                .questions()?
                .pop()
                .expect("pending question remains open");
            use futures_util::StreamExt;
            let mut events = session.events(None)?;
            session
                .answer(&question.id, Answer::Value("blue".into()))
                .await?;
            tokio::time::timeout(Duration::from_secs(5), async {
                while let Some(event) = events.next().await {
                    let event = event?;
                    if event.event_type == "toolResult" {
                        assert_eq!(event.data["status"], "completed");
                        assert_eq!(event.data["toolCallId"], turn.open_tool_calls[0]);
                        return Ok::<_, modular_agent::Error>(());
                    }
                }
                panic!("stream ended before the call continued");
            })
            .await
            .expect("late answer did not continue")?;
            assert_eq!(
                fs::read_to_string(root.path().join("calls"))?,
                "call\ncall\n"
            );
        }
        agent.close().await?;
    }
    Ok(())
}
