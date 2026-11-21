use modular_agent::{Code, Command, ModelRequest, Plugin, Result, Tool, testing::test_agent};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[tokio::test]
async fn auxiliary_requests_use_the_command_step_without_running_tools() -> Result<()> {
    let retained = Arc::new(Mutex::new(None));
    let keep = retained.clone();
    let plugin = Plugin::new("inference").command(
        Command::new("summarize", "Describe the term.", move |_, cx| {
            let keep = keep.clone();
            async move {
                let request = ModelRequest(json!({"systemPrompt":"Use one word.", "messages":[]}));
                for _ in 0..2 {
                    let reply = cx.request_model(request.clone()).await?;
                    assert_eq!(reply.0["stop"], "toolUse");
                }
                *keep.lock().unwrap() = Some(cx);
                Ok(Some("ready".into()))
            }
        })
        .uses_model(),
    );
    let agent = test_agent().tool(Tool::new("forbidden", "Never called").run(|_: Value, _| async {
        panic!("auxiliary call dispatched");
        #[allow(unreachable_code)]
        Ok("")
    })).script(json!([{"toolCalls":[{"name":"forbidden","input":{}}], "usage":{"input":3,"output":2}}]))
        .plugin(plugin.clone()).build().await?;
    let session = agent.session().await?;
    assert_eq!(
        session.run_command("/summarize").await?.as_deref(),
        Some("ready")
    );
    assert!(session.last_turn()?.is_none());
    let history = session.history().await?;
    let requests: Vec<_> = history
        .iter()
        .filter(|e| e["kind"] == "modelRequest")
        .collect();
    let responses: Vec<_> = history.iter().filter(|e| e["kind"] == "response").collect();
    assert_eq!(requests.len(), 2, "{history:#?}");
    assert_eq!(responses.len(), 2);
    assert!(requests[0]["stepId"].is_string());
    assert_eq!(requests[0]["stepId"], requests[1]["stepId"]);
    for (request, response) in requests.into_iter().zip(responses) {
        assert!(request.get("turnId").is_none());
        assert!(response.get("turnId").is_none());
        assert_eq!(response["stepId"], request["stepId"]);
        assert_eq!(response["sources"], json!([request["id"]]));
        assert_eq!(response["message"]["usage"]["input"], 3);
    }
    let cx = retained.lock().unwrap().take().unwrap();
    assert_eq!(
        cx.request_model(ModelRequest(json!({})))
            .await
            .unwrap_err()
            .code(),
        Code::InvalidRequest
    );
    agent.close().await?;
    let refused = test_agent().over_wire(plugin).build().await;
    assert_eq!(refused.err().unwrap().code(), Code::NotSupported);
    Ok(())
}
