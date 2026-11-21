use modular_agent::{
    Code, InterruptedTurn, Outcome, Plugin, Result, RuntimeCall, RuntimeContext,
    RuntimeDeclaration, RuntimeOutcome, RuntimePart, RuntimeSupport, RuntimeTurn, Usage,
    async_trait, testing::test_agent,
};
use serde_json::json;
use tokio::sync::mpsc;

struct OneStep(mpsc::UnboundedSender<RuntimeContext>);
#[async_trait]
impl RuntimePart for OneStep {
    fn declaration(&self) -> RuntimeDeclaration {
        RuntimeDeclaration {
            id: "one-step".into(),
            supports: RuntimeSupport::default(),
        }
    }
    async fn run_turn(&self, turn: RuntimeTurn, cx: RuntimeContext) -> Result<RuntimeOutcome> {
        assert_eq!(turn.turn_id, cx.turn_id);
        assert_eq!(turn.model.model.provider, "scripted");
        let history = cx.history(None).await?;
        assert!(
            history
                .entries
                .iter()
                .any(|e| e["kind"] == "turnStart" && e["turnId"] == turn.turn_id)
        );
        let step = cx.new_id().await?;
        let request = cx.prepare_step(&step, Usage::default()).await?;
        let response = cx.model(&step, request).await?;
        let entry = cx
            .record(json!({"kind":"response","stepId":step,"visible":true,"message":response}))
            .await?;
        let usage: Usage = serde_json::from_value(response.0["usage"].clone())?;
        let text = response.0["content"][0]["text"].as_str().unwrap();
        cx.hook("step.after", json!({"stepId":step,"response":response}))
            .await?;
        self.0.send(cx).ok().unwrap();
        Ok(RuntimeOutcome {
            outcome: Outcome::Completed,
            result: json!({"text":text,"openToolCalls":[]}),
            entries: vec![entry["id"].as_str().unwrap().into()],
            usage,
        })
    }
    async fn resume_turn(
        &self,
        _: RuntimeTurn,
        _: InterruptedTurn,
        _: RuntimeContext,
    ) -> Result<RuntimeOutcome> {
        unreachable!()
    }
    async fn continue_open_calls(
        &self,
        _: RuntimeTurn,
        _: Vec<RuntimeCall>,
        _: RuntimeContext,
    ) -> Result<RuntimeOutcome> {
        unreachable!()
    }
}

#[tokio::test]
async fn the_same_sdk_runtime_requests_and_records_a_step_in_both_placements() -> Result<()> {
    for served in [false, true] {
        let (send, mut contexts) = mpsc::unbounded_channel();
        let plugin = Plugin::new("custom-runtime")
            .replaces("runtime")
            .setup(move |r| r.runtime(OneStep(send.clone())));
        let builder = test_agent()
            .script(json!([{"text":"Hello from a custom Runtime","usage":{"input":3,"output":6}}]));
        let agent = if served {
            builder.over_wire(plugin)
        } else {
            builder.plugin(plugin)
        }
        .build()
        .await?;
        let session = agent.session().await?;
        let answer = session.prompt("Hello").await?;
        assert!(
            matches!(answer.outcome, Some(Outcome::Completed)),
            "served={served}: {answer:?}"
        );
        assert_eq!(answer.text, "Hello from a custom Runtime");
        assert_eq!(
            contexts
                .try_recv()
                .unwrap()
                .new_id()
                .await
                .unwrap_err()
                .code(),
            Code::InvalidRequest
        );
        agent.close().await?;
    }
    Ok(())
}
