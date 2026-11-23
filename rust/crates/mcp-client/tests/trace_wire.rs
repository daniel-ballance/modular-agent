use mcp_client::{Connection, Server};
use opentelemetry::{
    Context,
    baggage::BaggageExt,
    trace::{FutureExt, SpanContext, SpanId, TraceContextExt, TraceFlags, TraceId, TraceState},
};
use serde_json::{Map, Value};
use std::{collections::BTreeMap, path::Path};

#[tokio::test]
async fn carries_only_current_traceparent_on_catalog_pages_and_calls() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    let wire = dir.path().join("wire.ndjson");
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/mcp-fixture.py");
    let context = |span: u64| {
        Context::new()
            .with_baggage([opentelemetry::KeyValue::new("test", "not-on-wire")])
            .with_remote_span_context(SpanContext::new(
                TraceId::from(1),
                SpanId::from(span),
                TraceFlags::SAMPLED,
                true,
                TraceState::from_key_value([("vendor", "not-on-wire")]).unwrap(),
            ))
    };
    let connection = Connection::open(
        Server::Stdio {
            name: "fixture".into(),
            command: "python3".into(),
            args: vec![script.display().to_string()],
            env: BTreeMap::from([("MCP_FIXTURE_WIRE".into(), wire.display().to_string())]),
        },
        dir.path(),
    )
    .with_context(context(2))
    .await?;
    assert_eq!(connection.tools().len(), 4);
    connection.refresh().await?;
    connection
        .call("mutate".into(), Map::new())
        .with_context(context(3))
        .await?;
    connection.close().await;

    let raw = std::fs::read_to_string(wire)?;
    assert!(!raw.contains("not-on-wire"));
    let requests = raw
        .lines()
        .map(serde_json::from_str::<Value>)
        .collect::<Result<Vec<_>, _>>()?;
    let parent = |span| format!("00-00000000000000000000000000000001-{span:016x}-01");
    assert_eq!(
        requests
            .iter()
            .find(|r| r["method"] == "initialize")
            .unwrap()["params"]["_meta"]["traceparent"],
        parent(2)
    );
    let lists: Vec<_> = requests
        .iter()
        .filter(|r| r["method"] == "tools/list")
        .collect();
    assert_eq!(lists.len(), 4);
    assert_eq!(lists[1]["params"]["cursor"], "next");
    for list in &lists[..2] {
        assert_eq!(list["params"]["_meta"]["traceparent"], parent(2));
    }
    for list in &lists[2..] {
        // rmcp can add a progress token independently of trace context.
        assert!(list["params"]["_meta"].get("traceparent").is_none());
    }
    let call = requests
        .iter()
        .find(|r| r["method"] == "tools/call")
        .unwrap();
    assert_eq!(call["params"]["_meta"]["traceparent"], parent(3));
    Ok(())
}
