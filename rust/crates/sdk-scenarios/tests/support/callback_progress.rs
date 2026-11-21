use modular_agent::{
    HookContext, Job, JobOutcome, JobOwner, OutputDecision, Plugin, Result, Tool, ToolContext,
    async_trait,
};
use serde_json::{Value, json};

pub fn preview(text: &str) -> Vec<Value> {
    vec![
        json!({"type":"text","text":text}),
        json!({"type":"image","mimeType":"image/png","data":"aW1hZ2U="}),
    ]
}

struct PreviewOwner;

#[async_trait]
impl JobOwner for PreviewOwner {
    async fn cancel(&self, _: Job, _: HookContext) -> Result<()> {
        Ok(())
    }
}

pub fn progress_plugin() -> Plugin {
    Plugin::new("preview")
        .setup(|r| r.jobs(PreviewOwner))
        .tool(
            Tool::new("preview", "Report images").run(|_: Value, cx: ToolContext| async move {
                let job = cx.start_job("preview", json!({}), None).await?.job.unwrap();
                for text in ["first", "second"] {
                    job.progress(preview(text)).await?;
                }
                job.end(JobOutcome::Completed, None, false).await?;
                Ok(job.id)
            }),
        )
        .on_output(|output| async move {
            let mut value = output.value;
            if value["type"] != "job.progress" {
                return Ok(OutputDecision::Allow);
            }
            let content = value["data"].as_array_mut().unwrap();
            let text = content[0]["text"].as_str().unwrap();
            assert_eq!(*content, preview(text));
            if text == "first" {
                // A callback during the first gate must not let the second update
                // or the job's terminal event overtake it.
                assert!(!output.context.history(None).await?.entries.is_empty());
            }
            content[0]["text"] = json!(format!("gated {text}"));
            Ok(OutputDecision::Redact(value))
        })
}
