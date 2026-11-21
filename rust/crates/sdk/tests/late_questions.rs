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
