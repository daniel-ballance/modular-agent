use agent_api::*;
use plugin_stdio::{rpc::*, wire};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
struct TestEndpoint;
#[async_trait]
impl Endpoint for TestEndpoint {
    async fn request(
        &self,
        peer: Arc<Peer>,
        _: Value,
        method: &str,
        _: Value,
        cancel: CancellationToken,
    ) -> Reply {
        match method {
            "nested" => peer.call("$/ping", json!({}), None, cancel).await,
            "wait" => {
                cancel.cancelled().await;
                Err(Fault::new("cancelled", "stopped"))
            }
            "large" => Ok(json!("x".repeat(MAX_FRAME))),
            "panic" => panic!("deliberate boundary panic"),
            _ => Err(Fault::unknown(method)),
        }
    }
}
fn peers() -> (Arc<Peer>, Arc<Peer>) {
    let (a, b) = tokio::io::duplex(1024 * 1024);
    let (ar, aw) = tokio::io::split(a);
    let (br, bw) = tokio::io::split(b);
    (
        Peer::start(ar, aw, Arc::new(TestEndpoint)),
        Peer::start(br, bw, Arc::new(TestEndpoint)),
    )
}
#[tokio::test]
async fn rpc_is_bidirectional_and_nested_requests_do_not_deadlock() {
    let (a, b) = peers();
    let (x, y) = tokio::join!(
        a.call("nested", json!({}), None, CancellationToken::new()),
        b.call("nested", json!({}), None, CancellationToken::new())
    );
    assert_eq!(x.unwrap(), json!({}));
    assert_eq!(y.unwrap(), json!({}));
    assert_eq!(
        a.call("no/method", json!({}), None, CancellationToken::new())
            .await
            .unwrap_err()
            .number,
        -32601
    );
    a.close();
    a.finished.cancelled().await;
    b.finished.cancelled().await;
}
#[tokio::test]
async fn serving_exec_treats_zero_null_and_absent_timeout_as_no_limit() {
    let project = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let (a, b) = tokio::io::duplex(1024 * 1024);
    let (ar, aw) = tokio::io::split(a);
    let (br, bw) = tokio::io::split(b);
    let client = Peer::start(ar, aw, Arc::new(TestEndpoint));
    let server = Peer::start(
        br,
        bw,
        Arc::new(plugin_stdio::server::Conformance::from_env().unwrap()),
    );
    client
        .call(
            "plugin/initialize",
            json!({
                "binding":"modular-agent-plugin/1",
                "host":{"name":"test","version":"1"},
                "project":project.path(), "home":home.path(), "config":{}
            }),
            None,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let mut results = Vec::new();
    for timeout in [None, Some(Value::Null), Some(json!(0)), Some(json!(1000))] {
        let mut params = json!({"sessionId":"timeout-test","cwd":project.path(), "command":"sleep 0.05; printf no-limit"});
        if let Some(ms) = &timeout {
            params["timeoutMs"] = ms.clone();
        }
        results.push((
            timeout,
            client
                .call("env/exec", params, None, CancellationToken::new())
                .await,
        ));
    }
    client.close();
    client.finished.cancelled().await;
    server.finished.cancelled().await;
    for (timeout, result) in results {
        assert_eq!(
            result.unwrap(),
            json!({"exitCode":0,"output":"no-limit","timedOut":false}),
            "timeoutMs={timeout:?}"
        );
    }
}
#[tokio::test]
async fn cancelling_settles_and_eof_fails_all_waiters_as_lost() {
    let (a, b) = peers();
    let token = CancellationToken::new();
    token.cancel();
    assert_eq!(
        a.call("wait", json!({}), None, token)
            .await
            .unwrap_err()
            .code,
        "cancelled"
    );
    let p = a.clone();
    let waiter = tokio::spawn(async move {
        p.call("wait", json!({}), None, CancellationToken::new())
            .await
    });
    tokio::task::yield_now().await;
    b.close();
    assert_eq!(waiter.await.unwrap().unwrap_err().code, "lost");
    a.finished.cancelled().await;
    b.finished.cancelled().await;
}
#[tokio::test]
async fn dropping_a_call_sends_cancel_for_the_in_flight_request() {
    let (local, remote) = tokio::io::duplex(4096);
    let (reader, writer) = tokio::io::split(local);
    let caller = Peer::start(reader, writer, Arc::new(TestEndpoint));
    let mut lines = tokio::io::BufReader::new(remote).lines();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        let request: Value = {
            let call = caller.call("hook/handle", json!({}), None, CancellationToken::new());
            tokio::pin!(call);
            tokio::select! {
                frame = lines.next_line() => serde_json::from_str(&frame.unwrap().unwrap()).unwrap(),
                reply = &mut call => panic!("unexpected early reply: {reply:?}"),
            }
        };
        let cancel: Value = serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(request["method"], "hook/handle");
        assert_eq!(
            cancel,
            json!({"jsonrpc":"2.0","method":"$/cancel","params":{"id":request["id"]}})
        );
    })
    .await
    .expect("dropping the call must send cancellation before the connection closes");
    caller.close();
    caller.finished.cancelled().await;
}

#[tokio::test]
async fn oversized_results_and_panics_become_structured_errors() {
    let (a, b) = peers();
    assert_eq!(
        a.call("large", json!({}), None, CancellationToken::new())
            .await
            .unwrap_err()
            .code,
        "result_too_large"
    );
    assert_eq!(
        a.call("panic", json!({}), None, CancellationToken::new())
            .await
            .unwrap_err()
            .code,
        "internal"
    );
    assert_eq!(
        a.call("$/ping", json!({}), None, CancellationToken::new())
            .await
            .unwrap(),
        json!({})
    );
    a.close();
    a.finished.cancelled().await;
    b.finished.cancelled().await;
}
#[tokio::test]
async fn oversized_input_without_a_newline_is_bounded_and_closes() {
    let (mut a, b) = tokio::io::duplex(1024 * 1024);
    let (br, bw) = tokio::io::split(b);
    let p = Peer::start(br, bw, Arc::new(TestEndpoint));
    let writer = tokio::spawn(async move {
        let chunk = [b'x'; 65536];
        for _ in 0..(MAX_FRAME / 65536 + 2) {
            if a.write_all(&chunk).await.is_err() {
                break;
            }
        }
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), p.finished.cancelled())
        .await
        .unwrap();
    writer.await.unwrap();
}
#[tokio::test]
async fn duplicate_inbound_ids_close_the_connection() {
    let (a, b) = tokio::io::duplex(4096);
    let (ar, mut aw) = tokio::io::split(a);
    let (br, bw) = tokio::io::split(b);
    let p = Peer::start(br, bw, Arc::new(TestEndpoint));
    aw.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"wait\"}\n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"wait\"}\n{\"jsonrpc\":\"2.0\",\"method\":\"$/cancel\",\"params\":{\"id\":1}}\n").await.unwrap();
    let mut lines = tokio::io::BufReader::new(ar).lines();
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(1), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .is_none_or(|line| {
                let first: Value = serde_json::from_str(&line).unwrap();
                first["id"] == 1 && first["error"]["data"]["code"] == "cancelled"
            })
    );
    assert!(lines.next_line().await.unwrap().is_none());
    tokio::time::timeout(std::time::Duration::from_secs(1), p.finished.cancelled())
        .await
        .expect("peer should finish after write half closes");
}
#[test]
fn shared_data_unknown_fields_content_and_all_usage_survive_round_trips() {
    let response = json!({"role":"assistant","futureMessage":{"x":1},"model":{"provider":"p","id":"m"},"content":[{"type":"text","text":"hello","futureText":true},{"type":"reasoning","text":"readable","providerData":{"secret":"opaque"}},{"type":"image","data":"AA==","mimeType":"image/png","futureImage":3},{"type":"newType","value":42},{"type":"toolCall","id":"c","name":"t","arguments":{},"futureCall":4}],"stop":"toolUse","usage":{"input":2,"output":3,"cacheRead":4,"cacheWrite":5,"cost":0.125,"futureUsage":6}});
    let r = wire::parse_response(response.clone()).unwrap();
    assert_eq!(r.text_content(), "hello");
    assert_eq!(wire::response(&r), response);
    let mut usage = Usage::default();
    usage.add(&r.usage);
    usage.add(&r.usage);
    assert_eq!(usage.cache_write_tokens, 10);
    assert_eq!(usage.cost, 0.25);
    let call = wire::call(&r.tool_calls()[0], &Scope::session("s"));
    assert_eq!(call["futureCall"], 4);
    let def = json!({"name":"t","description":"x","parameters":{"type":"object"},"returns":{"type":"number"},"parallel":false,"hints":{"readOnly":true,"safeToRepeat":false,"futureHint":true},"futureTool":7,"callers":["ui"]});
    let d = wire::parse_definition(&def).unwrap();
    assert_eq!(wire::definition(&d), def);
    assert!(!d.allows("model"));
    assert!(d.allows("ui"));
    let model = json!({"provider":"p","id":"m","contextWindow":10,"maxOutput":5,"input":["text","image"],"reasoning":true,"thinking":["off","low"],"futureModel":8});
    assert_eq!(
        wire::model_value(&wire::model(&model, &json!({})).unwrap()),
        model
    );
    let request = json!({"systemPrompt":"system","messages":[response],"tools":[def],"settings":{"reasoning":"low","maxOutput":9,"futureSetting":10},"futureRequest":11});
    let parsed = wire::parse_request(&request, "s").unwrap();
    assert_eq!(wire::request(&parsed, None), request);
    let result = json!({"callId":"c","status":"completed","content":[{"type":"text","text":"ok","futurePart":12},{"type":"unknown","x":9}],"value":{"structured":true},"futureResult":13});
    assert_eq!(
        wire::result(&wire::parse_result(result.clone(), "c").unwrap()),
        result
    );
}
