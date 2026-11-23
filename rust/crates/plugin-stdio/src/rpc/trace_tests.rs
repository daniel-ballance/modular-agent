use super::*;

fn peer(agreed: bool, serves: bool) -> Arc<Peer> {
    let (tx, _) = mpsc::unbounded_channel();
    let peer = Arc::new(Peer {
        tx,
        plugin: OnceLock::new(),
        trace_agreed: false.into(),
        serves_plugin: false.into(),
        jobs: Mutex::default(),
        next: 1.into(),
        pending: Mutex::default(),
        activity: tokio::sync::Notify::new(),
        incoming: Mutex::default(),
        closed: CancellationToken::new(),
        finished: CancellationToken::new(),
    });
    peer.configure_trace("fixture", agreed, serves);
    peer
}

#[test]
fn carriers_require_agreement_in_both_directions() {
    let trace = "00-aabbccddaabbccddaabbccddaabbccdd-1122334455667788-01";
    let cx = telemetry::extract(&json!({"traceparent":trace})).unwrap();
    for (offer, accept) in [(false, false), (true, false), (true, true)] {
        let host = peer(offer && accept, false);
        let plugin = peer(offer && accept, true);
        let mut work = json!({"sessionId":"s", "traceContext":{"baggage":"ignored"}});
        host.inject("tools/call", &mut work, &cx);
        assert_eq!(
            work["traceContext"]
                .get("traceparent")
                .and_then(Value::as_str),
            (offer && accept).then_some(trace)
        );
        assert!(work["traceContext"].get("baggage").is_none());
        assert_eq!(
            telemetry::traceparent(&plugin.incoming_context("tools/call", &work).0).as_deref(),
            (offer && accept).then_some(trace)
        );
        let mut callback = json!({"parentRequestId":"r1"});
        plugin.inject("host/tools/call", &mut callback, &cx);
        assert_eq!(callback.get("traceContext").is_some(), offer && accept);
        // A wire carrier does not authorize an untracked callback.
        assert!(
            telemetry::traceparent(&host.incoming_context("host/tools/call", &callback).0)
                .is_none()
        );
        let mut credentials = json!({});
        plugin.inject("host/credentials/read", &mut credentials, &cx);
        assert!(credentials.get("traceContext").is_none());
        let mut initialized = json!({});
        host.inject("plugin/shutdown", &mut initialized, &cx);
        assert!(initialized.get("traceContext").is_none());
    }
}
