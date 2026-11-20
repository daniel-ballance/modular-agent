use std::time::Duration;

use modular_agent::{
    Answer, Approval, Ask, Question, QuestionKind, Result, Tool, ToolContext, ToolStatus,
    testing::test_agent,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::{mpsc, oneshot};

#[derive(Deserialize, JsonSchema)]
struct Empty {}

#[tokio::test]
async fn checks_approval_policy() -> Result<()> {
    use ToolStatus::{Completed, Refused};
    for (policy, read_only, has_handler, status, asks) in [
        (Approval::Off, false, true, Completed, 0),
        (Approval::Ask, true, false, Completed, 0),
        (Approval::Ask, false, false, Refused, 0),
        (Approval::Ask, false, true, Completed, 1),
        (Approval::All, true, true, Completed, 1),
        (Approval::Never, false, true, Refused, 0),
    ] {
        let tool = Tool::new("preview", "Preview a palette.");
        let tool = if read_only { tool.read_only() } else { tool };
        let mut builder = test_agent()
            .approval(policy)
            .tool(tool.run(|_: Empty, _| async { Ok("Preview ready.") }))
            .script(json!([
                {"toolCalls": [{"name": "preview", "input": {}}]},
                {"text": "Done."}
            ]));
        let (seen, mut questions) = mpsc::unbounded_channel::<Question>();
        if has_handler {
            builder = builder.on_question(move |question| {
                let _ = seen.send(question);
                std::future::ready(Answer::Allow)
            });
        }
        let agent = builder.build().await?;
        let turn = agent.session().await?.prompt("Preview a palette.").await?;
        assert_eq!(turn.tool_results()[0].status, status);
        let mut count = 0;
        while let Ok(question) = questions.try_recv() {
            assert_eq!(question.kind, QuestionKind::Approval);
            let call = question.call.unwrap();
            assert_eq!(call["name"], "preview");
            assert_eq!(call["input"], json!({}));
            count += 1;
        }
        assert_eq!(count, asks);
        agent.close().await?;
    }
    Ok(())
}

fn choose_palette() -> Tool {
    Tool::new("choose_palette", "Ask which palette to preview.")
        .read_only()
        .run(|_: Empty, cx: ToolContext| async move {
            match cx
                .ask(Ask::choice("Which palette?", &["light", "dark"]))
                .await?
            {
                Answer::Value(value) => Ok(format!("Selected {value}.")),
                _ => Err(cx.refuse("No palette selected.")),
            }
        })
}

#[tokio::test]
async fn answers_a_choice_from_the_ui() -> Result<()> {
    let (show, mut ui) = mpsc::unbounded_channel();
    let agent = test_agent()
        .approval(Approval::Ask)
        .tool(choose_palette())
        .on_question(move |question| {
            let (reply, answer) = oneshot::channel();
            let _ = show.send((question, reply));
            async move { answer.await.unwrap_or(Answer::Declined { reason: None }) }
        })
        .script(json!([
            {"toolCalls": [{"name": "choose_palette", "input": {}}]},
            {"text": "Done."}
        ]))
        .build()
        .await?;
    let session = agent.session().await?;
    let click = async {
        let (question, reply) = ui.recv().await.unwrap();
        assert_eq!(question.session_id, session.id());
        assert_eq!(question.kind, QuestionKind::Choice);
        assert_eq!(question.options, ["light", "dark"]);
        reply.send(Answer::Value("dark".into())).unwrap();
    };
    let (turn, ()) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(session.prompt("Choose a palette."), click)
    })
    .await
    .expect("the question did not settle");
    assert_eq!(turn?.tool_results()[0].text(), "Selected dark.");
    agent.close().await
}
