//! The Providers against a loopback fixture: what is sent, and what a
//! streamed answer becomes. No network and no real sign-in.
use modular_agent::{Agent, ClientIdentity, Outcome, Plugin, Session, subscription_logins};
use provider_responses::provider;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Fixture {
    endpoint: String,
    requests: Arc<Mutex<Vec<(String, Value)>>>,
}

fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines()
        .filter_map(|line| line.split_once(':'))
        .find_map(|(key, value)| key.eq_ignore_ascii_case(name).then_some(value.trim()))
}

/// Answers each POST with the next scripted reply: a status and a body.
async fn fixture(replies: Vec<(u16, String)>) -> Fixture {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let endpoint = format!(
        "http://127.0.0.1:{}/responses",
        listener.local_addr().unwrap().port()
    );
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
                    let head = String::from_utf8_lossy(&buffer[..at]).into_owned();
                    let length: usize = header(&head, "content-length")
                        .map(|v| v.parse().unwrap())
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
            let kind = if status == 200 {
                "text/event-stream"
            } else {
                "application/json"
            };
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

async fn agent(
    model: &str,
    endpoint: &str,
    client_identity: ClientIdentity,
    plugins: Vec<Plugin>,
) -> (Agent, Session) {
    let provider = provider(
        subscription_logins("unused-auth.json"),
        client_identity,
        vec![],
    )
    .unwrap()
    .with_test_endpoint(endpoint)
    .unwrap();
    let mut builder = Agent::builder()
        .provider(provider)
        .model(model)
        .default_prompt(false)
        .setting("maxOutput", json!(1000))
        .setting("maxSteps", json!(1))
        .setting("reasoning", json!("low"))
        .plugin(Plugin::new("system").on_turn_before(|_| async {
            Ok(modular_agent::TurnAddition {
                system: Some("Be brief.".into()),
                ..Default::default()
            })
        }));
    for plugin in plugins {
        builder = builder.plugin(plugin);
    }
    let agent = builder.build().await.unwrap();
    let session = agent.session().await.unwrap();
    (agent, session)
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
    let seen = Arc::new(Mutex::new(vec![]));
    let capture = seen.clone();
    let plugin =
        Plugin::new("failures").on_model_failed_with(modular_agent::Order::First, move |p| {
            capture.lock().unwrap().push(p.error);
            async { Ok(modular_agent::ModelDecision::Stop) }
        });
    let (_agent, session) = agent(
        "grok/grok-4.7",
        &server.endpoint,
        ClientIdentity::default(),
        vec![plugin],
    )
    .await;
    for _ in 0..5 {
        assert!(matches!(
            session.prompt("hi").await.unwrap().outcome,
            Some(Outcome::Failed { .. })
        ));
    }
    let kinds: Vec<_> = seen
        .lock()
        .unwrap()
        .iter()
        .map(|e| (e.kind, e.message.clone()))
        .collect();
    use modular_agent::ModelErrorKind::{ContextTooLarge, Other, Temporary};
    assert_eq!(kinds[0].0, Other);
    assert!(kinds[0].1.contains("usage limit"));
    assert_eq!(kinds[1].0, ContextTooLarge);
    assert_eq!(kinds[2].0, Temporary);
    assert!(kinds[2].1.contains("503"));
    assert_eq!(kinds[3].0, Temporary);
    assert_eq!(kinds[4].0, Temporary);
    assert!(kinds[4].1.contains("ended before a complete response"));
    // xAI takes the system prompt as the first input item, with no extra headers.
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests[0].1["input"][0]["role"], "system");
    assert_eq!(header(&requests[0].0, "chatgpt-account-id"), None);
    assert_eq!(header(&requests[0].0, "originator"), None);
    assert_eq!(requests[0].1["max_output_tokens"], 1000);
}

#[tokio::test]
async fn cancelling_stops_waiting_on_the_stream() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let endpoint = format!(
        "http://127.0.0.1:{}/responses",
        listener.local_addr().unwrap().port()
    );
    // Wait for the request to connect before cancelling it.
    let (connected, received) = tokio::sync::oneshot::channel();
    let held = tokio::spawn(async move {
        let (_stream, _) = listener.accept().await.unwrap();
        connected.send(()).unwrap();
        std::future::pending::<()>().await;
    });
    let (_agent, session) = agent(
        "grok/grok-4.7",
        &endpoint,
        ClientIdentity::default(),
        vec![],
    )
    .await;
    let prompt = session.prompt("hi");
    let cancel = async {
        received.await.unwrap();
        session.cancel().await.unwrap();
    };
    let (answer, ()) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(prompt, cancel)
    })
    .await
    .expect("cancel was not prompt");
    assert_eq!(answer.unwrap().outcome, Some(Outcome::Cancelled));
    held.abort();
}
