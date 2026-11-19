//! The Providers against a loopback fixture: what is sent, and what a
//! streamed answer becomes. No network and no real sign-in.
use agent_api::*;
use agent_harness::Harness;
use provider_responses::{ResponsesPlugin, Vendor, catalog};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Fixture {
    endpoint: String,
    requests: Arc<Mutex<Vec<(String, Value)>>>,
}
/// Answers each POST with the next scripted reply: a status and a body.
async fn fixture(replies: Vec<(u16, String)>) -> Fixture {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let endpoint = format!("http://127.0.0.1:{}/responses", listener.local_addr().unwrap().port());
    let requests = Arc::new(Mutex::new(vec![]));
    let seen = requests.clone();
    tokio::spawn(async move {
        for (status, body) in replies {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = vec![];
            let (head, length) = loop {
                let mut chunk = [0u8; 4096];
                let n = stream.read(&mut chunk).await.unwrap();
                buffer.extend_from_slice(&chunk[..n]);
                if let Some(at) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buffer[..at]).to_lowercase();
                    let length: usize = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .map(|v| v.trim().parse().unwrap())
                        .unwrap_or(0);
                    while buffer.len() < at + 4 + length {
                        let n = stream.read(&mut chunk).await.unwrap();
                        buffer.extend_from_slice(&chunk[..n]);
                    }
                    break (head, at + 4);
                }
            };
            let sent: Value = serde_json::from_slice(&buffer[length..]).unwrap();
            seen.lock().unwrap().push((head, sent));
            let kind = if status == 200 { "text/event-stream" } else { "application/json" };
            let reply = format!(
                "HTTP/1.1 {status} X\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(reply.as_bytes()).await.unwrap();
            stream.shutdown().await.unwrap();
        }
    });
    Fixture { endpoint, requests }
}
fn sse(events: &[Value]) -> String {
    events
        .iter()
        .map(|e| format!("event: {}\ndata: {e}\n\n", e["type"].as_str().unwrap()))
        .collect()
}
async fn bound(vendor: Vendor, model: &str, endpoint: &str) -> (Api, Arc<dyn ModelAccess>) {
    let harness = Harness::new();
    let plugin = ResponsesPlugin::new(vendor, catalog(vendor, &Value::Null).unwrap())
        .with_test_endpoint(endpoint)
        .unwrap();
    let key = plugin.name().to_owned();
    harness.load(Arc::new(plugin)).await.unwrap();
    let api: Api = harness;
    let provider: Arc<dyn Provider> = capability(api.as_ref(), &key).unwrap();
    assert!(provider.bind("other/model").is_err());
    let model = provider.bind(model).unwrap();
    (api, model)
}
fn ask() -> ModelRequest {
    ModelRequest {
        session: "s1".into(),
        system: "Be brief.".into(),
        messages: vec![Message::text("user", "hi")],
        thinking: "low".into(),
        output_limit: 1000,
        ..ModelRequest::default()
    }
}

#[tokio::test]
async fn a_streamed_answer_becomes_text_calls_and_usage() {
    // The Codex backend leaves `output` empty on the last event.
    let stream = sse(&[
        json!({"type":"response.created","response":{"id":"r1"}}),
        json!({"type":"response.output_text.delta","delta":"Hel"}),
        json!({"type":"response.output_text.delta","delta":"lo"}),
        json!({"type":"response.output_item.done","item":{"type":"reasoning","id":"rs1","encrypted_content":"enc"}}),
        json!({"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"Hello"}]}}),
        json!({"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"codemode","arguments":"{\"code\":\"1+1\"}"}}),
        json!({"type":"response.completed","response":{"id":"r1","status":"completed","output":[],"usage":{"input_tokens":12,"output_tokens":5}}}),
    ]);
    let server = fixture(vec![(200, stream)]).await;
    let (api, model) = bound(Vendor::Codex, "openai-codex/gpt-6.1-sol", &server.endpoint).await;
    assert_eq!(model.info().name, "openai-codex/gpt-6.1-sol");
    assert!(!model.info().keeps_state && !model.info().runs_tools);
    let answer = model
        .generate(api, Scope::session("s1"), ask(), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(answer.text_content(), "Hello");
    assert_eq!(answer.stop, "tools");
    assert_eq!(answer.tool_calls()[0].input, json!({"code":"1+1"}));
    assert_eq!((answer.usage.input_tokens, answer.usage.output_tokens), (12, 5));
    assert_eq!(answer.opaque["provider"], "openai-codex");
    assert_eq!(answer.opaque["output"].as_array().unwrap().len(), 3);

    let requests = server.requests.lock().unwrap();
    let (head, body) = &requests[0];
    for header in [
        "authorization: bearer test-credential",
        "chatgpt-account-id: test-account",
        "openai-beta: responses=experimental",
        "originator: pi",
        "session-id: s1",
        "accept: text/event-stream",
    ] {
        assert!(head.contains(header), "missing {header} in {head}");
    }
    assert_eq!(body["model"], "gpt-6.1-sol");
    assert_eq!(body["instructions"], "Be brief.");
    assert_eq!(body["store"], false);
    assert_eq!(body["reasoning"]["effort"], "low");
}

#[tokio::test]
async fn service_errors_are_told_apart() {
    let server = fixture(vec![
        (429, json!({"error":{"type":"usage_limit_reached","message":"You have hit your usage limit."}}).to_string()),
        (400, json!({"error":{"code":"context_length_exceeded","message":"too long"}}).to_string()),
        (503, "upstream unavailable".into()),
        (200, sse(&[json!({"type":"response.failed","response":{"error":{"code":"server_error","message":"boom"}}})])),
        (200, sse(&[json!({"type":"response.output_text.delta","delta":"cut"})])),
    ])
    .await;
    let (api, model) = bound(Vendor::Xai, "xai/grok-4.7", &server.endpoint).await;
    let mut kinds = vec![];
    for _ in 0..5 {
        let failure = model
            .generate(api.clone(), Scope::session("s1"), ask(), CancellationToken::new())
            .await
            .unwrap_err();
        kinds.push((format!("{:?}", failure.kind), failure.message));
    }
    assert_eq!(kinds[0].0, "Other");
    assert!(kinds[0].1.contains("usage limit"));
    assert_eq!(kinds[1].0, "ContextTooLarge");
    assert_eq!(kinds[2].0, "Temporary");
    assert!(kinds[2].1.contains("503"));
    assert_eq!(kinds[3].0, "Temporary");
    assert_eq!(kinds[4].0, "Temporary");
    assert!(kinds[4].1.contains("ended before a complete response"));
    // xAI takes the system prompt as the first input item, with no extra headers.
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests[0].1["input"][0]["role"], "system");
    assert!(!requests[0].0.contains("chatgpt-account-id"));
    assert_eq!(requests[0].1["max_output_tokens"], 1000);
}

#[tokio::test]
async fn cancelling_stops_waiting_on_the_stream() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let endpoint = format!("http://127.0.0.1:{}/responses", listener.local_addr().unwrap().port());
    // Accepts and then says nothing.
    let held = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        drop(stream);
    });
    let (api, model) = bound(Vendor::Xai, "xai/grok-4.7", &endpoint).await;
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        stop.cancel();
    });
    let failure = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        model.generate(api, Scope::session("s1"), ask(), cancel),
    )
    .await
    .expect("cancel was not prompt")
    .unwrap_err();
    assert_eq!(format!("{:?}", failure.kind), "Cancelled");
    held.abort();
}
