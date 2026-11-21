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
#[test]
fn vendored_model_table_is_byte_identical() {
    assert_eq!(
        include_bytes!("../api-key-models.json").as_slice(),
        include_bytes!("../../../../docs/sdk/api-key-models.json").as_slice(),
    );
}

async fn mapped_body(
    vendor: &str,
    id: &str,
    level: Option<&str>,
    output: u64,
    enrolled: bool,
) -> Result<Value> {
    let response = if vendor == "openai" {
        json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]})
    } else {
        json!({"stop_reason":"end_turn","content":[{"type":"text","text":"ok"}]})
    };
    let (url, server) = fake("200 OK", "application/json", response.to_string()).await;
    let mut provider = if vendor == "openai" {
        openai()
    } else {
        anthropic()
    };
    if enrolled {
        provider = provider.model_with_input(id, 10_000, output, ["text", "image"]);
    }
    let mut builder = Agent::builder()
        .provider(provider.with_test_endpoint(&url)?)
        .model(format!("{vendor}/{id}"))
        .setting("maxOutput", json!(output));
    if let Some(level) = level {
        builder = builder.setting("reasoning", json!(level));
    }
    let agent = builder.build().await?;
    if enrolled {
        let model = agent
            .models()?
            .into_iter()
            .find(|m| m.model.id == id)
            .unwrap();
        assert!(model.thinking.is_empty());
        assert_eq!(model.extra["input"], json!(["text", "image"]));
    }
    let turn = agent.session().await?.prompt("check mapping").await?;
    assert_eq!(
        turn.text, "ok",
        "{vendor}/{id} {level:?}: {:?}",
        turn.outcome
    );
    let (_, body) = server.await.unwrap();
    agent.close().await?;
    Ok(body)
}

fn controls(body: &Value) -> Value {
    Value::Object(
        ["reasoning", "thinking", "output_config"]
            .into_iter()
            .filter_map(|field| body.get(field).map(|v| (field.into(), v.clone())))
            .collect(),
    )
}

#[tokio::test]
async fn sends_every_verified_mapping_to_the_vendor() -> Result<()> {
    use modular_agent::Provider;
    let table: Value = serde_json::from_slice(include_bytes!("../api-key-models.json")).unwrap();
    for row in table["models"].as_array().unwrap() {
        let vendor = row["provider"].as_str().unwrap();
        let id = row["id"].as_str().unwrap();
        let catalog = if vendor == "openai" {
            openai()
        } else {
            anthropic()
        }
        .models();
        let entry = catalog.iter().find(|m| m.model.id == id).unwrap();
        let mapping = row["levels"].as_object().unwrap();
        let expected = ["off", "minimal", "low", "medium", "high", "xhigh"]
            .into_iter()
            .filter(|level| mapping.contains_key(*level))
            .collect::<Vec<_>>();
        assert_eq!(entry.thinking, expected);
        assert_eq!(entry.extra["input"], row["input"]);
        assert_eq!(entry.context_window, row["contextWindow"].as_u64().unwrap());
        assert_eq!(entry.max_output, row["maxOutput"].as_u64().unwrap());
        for (level, fields) in mapping {
            let body = mapped_body(vendor, id, Some(level), 9000, false).await?;
            assert_eq!(controls(&body), *fields, "{id}: {level}");
        }
    }
    Ok(())
}

#[tokio::test]
async fn falls_back_without_guessing_or_exceeding_the_manual_budget() -> Result<()> {
    for (vendor, id, level, max, enrolled, expected) in [
        ("openai", "gpt-5", "off", 2000, false, json!({})),
        (
            "openai",
            "gpt-5",
            "xhigh",
            2000,
            false,
            json!({"reasoning":{"effort":"high"}}),
        ),
        (
            "anthropic",
            "claude-opus-5-5",
            "off",
            2000,
            false,
            json!({}),
        ),
        (
            "anthropic",
            "claude-sonnet-4-6",
            "minimal",
            2000,
            false,
            json!({"thinking":{"type":"disabled"}}),
        ),
        (
            "anthropic",
            "claude-opus-4-5",
            "high",
            2049,
            false,
            json!({"thinking":{"type":"enabled","budget_tokens":2048},"output_config":{"effort":"high"}}),
        ),
        (
            "anthropic",
            "claude-opus-4-5",
            "high",
            1024,
            false,
            json!({"thinking":{"type":"disabled"}}),
        ),
        (
            "openai",
            "gpt-6-luna-unlisted",
            "high",
            2000,
            true,
            json!({}),
        ),
        (
            "anthropic",
            "claude-opus-4-5-unlisted",
            "high",
            2000,
            true,
            json!({}),
        ),
    ] {
        let body = mapped_body(vendor, id, Some(level), max, enrolled).await?;
        assert_eq!(controls(&body), expected, "{id} {level} {max}");
    }
    Ok(())
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
        .model("openai/gpt-6-luna")
        .build()
        .await?;
    let result = agent.session().await?.prompt("say hello").await?;
    assert_eq!(result.text, "hello");
    let (headers, body) = server.await.unwrap();
    assert!(headers.contains("authorization: bearer offline-fixture"));
    assert!(body.get("reasoning").is_none(), "{body}");
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
        .model("anthropic/claude-sonnet-4-6")
        .build()
        .await?;
    let result = agent.session().await?.prompt("say hello").await?;
    assert_eq!(result.text, "hello");
    let (headers, body) = server.await.unwrap();
    assert!(headers.contains("x-api-key: offline-fixture"));
    assert!(headers.contains("anthropic-version: 2023-06-01"));
    assert!(body.get("thinking").is_none(), "{body}");
    assert!(body.get("output_config").is_none(), "{body}");
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
            .model(if anthropic_vendor {
                "anthropic/claude-sonnet-4-6"
            } else {
                "openai/gpt-6-luna"
            })
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
