use super::*;

fn peer(serves: bool) -> Arc<Peer> {
    let (tx, _) = mpsc::channel(OUTBOUND_FRAMES);
    let peer = Arc::new(Peer {
        tx,
        outbound_bytes: Arc::new(Semaphore::new(OUTBOUND_BYTES)),
        overflowed: CancellationToken::new(),
        plugin: OnceLock::new(),
        serves_plugin: false.into(),
        jobs: Mutex::default(),
        next: 1.into(),
        pending: Mutex::default(),
        activity: tokio::sync::Notify::new(),
        incoming: Mutex::default(),
        closed: CancellationToken::new(),
        finished: CancellationToken::new(),
    });
    peer.configure_trace("fixture", serves);
    peer
}

#[test]
fn only_scoped_work_carries_trace_context() {
    let trace = "00-aabbccddaabbccddaabbccddaabbccdd-1122334455667788-01";
    let cx = telemetry::extract(&json!({"traceparent":trace})).unwrap();
    let host = peer(false);
    let plugin = peer(true);
    let mut work = json!({"sessionId":"s", "traceContext":{"baggage":"ignored"}});
    host.inject("tools/call", &mut work, &cx);
    assert_eq!(
        work["traceContext"]
            .get("traceparent")
            .and_then(Value::as_str),
        Some(trace)
    );
    assert!(work["traceContext"].get("baggage").is_none());
    assert_eq!(
        telemetry::traceparent(&plugin.incoming_context("tools/call", &work).0).as_deref(),
        Some(trace)
    );
    let mut callback = json!({"parentRequestId":"r1"});
    plugin.inject("host/tools/call", &mut callback, &cx);
    assert!(callback.get("traceContext").is_some());
    // A wire carrier does not authorize an untracked callback.
    assert!(
        telemetry::traceparent(&host.incoming_context("host/tools/call", &callback).0).is_none()
    );
    let mut credentials = json!({});
    plugin.inject("host/credentials/read", &mut credentials, &cx);
    assert!(credentials.get("traceContext").is_none());
    let mut initialized = json!({});
    host.inject("plugin/shutdown", &mut initialized, &cx);
    assert!(initialized.get("traceContext").is_none());
}
