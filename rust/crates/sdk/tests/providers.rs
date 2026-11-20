use modular_agent::{Agent, Result, anthropic, openai};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};

async fn fake(
    status: &str,
    kind: &str,
    response: String,
) -> (String, tokio::task::JoinHandle<(String, Value)>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/model", listener.local_addr().unwrap());
    let status = status.to_owned();
    let kind = kind.to_owned();
    let task = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = BufReader::new(socket);
        let mut headers = String::new();
        loop {
            let mut line = String::new();
            assert!(socket.read_line(&mut line).await.unwrap() > 0);
            if line == "\r\n" {
                break;
            }
            headers.push_str(&line);
        }
        let lower = headers.to_ascii_lowercase();
        let length = lower
            .lines()
            .find_map(|line| {
                line.strip_prefix("content-length: ")
                    .and_then(|n| n.parse().ok())
            })
            .unwrap();
        let mut body = vec![0; length];
        socket.read_exact(&mut body).await.unwrap();
        let output = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
            response.len()
        );
        socket.get_mut().write_all(output.as_bytes()).await.unwrap();
        (lower, serde_json::from_slice(&body).unwrap())
    });
    (url, task)
}
fn sse(events: &[Value]) -> String {
    events.iter().map(|e| format!("data: {e}\n\n")).collect()
}

#[tokio::test]
async fn openai_responses_stream_offline() -> Result<()> {
    let response = sse(&[
        json!({"type":"response.output_text.delta","delta":"hello"}),
        json!({"type":"response.completed","response":{"status":"completed","output":[
            {"type":"message","content":[{"type":"output_text","text":"hello"}]}
        ],"usage":{"input_tokens":3,"output_tokens":1}}}),
    ]);
    let (url, server) = fake("200 OK", "text/event-stream", response).await;
    let agent = Agent::builder()
        .provider(openai().with_test_endpoint(&url)?)
        .build()
        .await?;
    let result = agent.session().await?.prompt("say hello").await?;
    assert_eq!(result.text, "hello");
    let (headers, body) = server.await.unwrap();
    assert!(headers.contains("authorization: bearer offline-fixture"));
    assert_eq!(body["store"], false);
    assert_eq!(body["input"][0]["content"], "say hello");
    agent.close().await
}

#[tokio::test]
async fn anthropic_messages_stream_offline() -> Result<()> {
    let response = sse(&[
        json!({"type":"message_start","message":{"usage":{"input_tokens":3}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}),
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}),
        json!({"type":"message_stop"}),
    ]);
    let (url, server) = fake("200 OK", "text/event-stream", response).await;
    let agent = Agent::builder()
        .provider(anthropic().with_test_endpoint(&url)?)
        .build()
        .await?;
    let result = agent.session().await?.prompt("say hello").await?;
    assert_eq!(result.text, "hello");
    let (headers, body) = server.await.unwrap();
    assert!(headers.contains("x-api-key: offline-fixture"));
    assert!(headers.contains("anthropic-version: 2023-06-01"));
    assert_eq!(body["messages"][0]["content"][0]["text"], "say hello");
    agent.close().await
}

#[tokio::test]
async fn credentials_rejected_is_a_failed_model_attempt() -> Result<()> {
    for anthropic_vendor in [false, true] {
        let (url, server) = fake(
            "401 Unauthorized",
            "application/json",
            json!({
                "error":{"message":"fixture rejected its key","type":"authentication_error"}
            })
            .to_string(),
        )
        .await;
        let provider = if anthropic_vendor {
            anthropic()
        } else {
            openai()
        };
        let agent = Agent::builder()
            .provider(provider.with_test_endpoint(&url)?)
            .build()
            .await?;
        let session = agent.session().await?;
        assert_eq!(
            session.prompt("try").await?.outcome.unwrap().kind(),
            "failed"
        );
        let history = session.history().await?;
        assert!(
            history.iter().any(|e| e["message"]["stop"] == "failed"
                && e["message"]["error"]["kind"] == "credentials"),
            "{history:#?}"
        );
        server.await.unwrap();
        agent.close().await?;
    }
    Ok(())
}
