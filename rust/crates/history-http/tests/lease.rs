use agent_api::*;
use history_http::HttpHistory;
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

// This fixture speaks only the binding. It refuses a held lease until the
// advertised delay and can revoke a live lease between saves.
#[test]
fn reopen_waits_for_the_old_lease_and_late_renewal_cannot_restore_authority() {
    let socket = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", socket.local_addr().unwrap());
    let renewed = Arc::new(AtomicUsize::new(0));
    let delay = Arc::new(AtomicBool::new(false));
    let renew_count = renewed.clone();
    let delay_reply = delay.clone();
    let worker = std::thread::spawn(move || {
        let mut expiry = None;
        let mut acquired = false;
        for stream in socket.incoming() {
            let mut stream = stream.unwrap();
            let mut reader = BufReader::new(&stream);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let request = line.trim_end().to_owned();
            let mut length = 0;
            let mut authorized = false;
            loop {
                line.clear();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                let lower = line.to_ascii_lowercase();
                if let Some(v) = lower.strip_prefix("content-length:") {
                    length = v.trim().parse().unwrap();
                }
                authorized |= line
                    .trim_end()
                    .eq_ignore_ascii_case("authorization: Bearer offline-history-token");
            }
            assert!(authorized);
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let (status, body) = match request.as_str() {
                "GET /v1 HTTP/1.1" => (
                    "200 OK",
                    json!({"binding":"modular-agent-history/1","ttlMs":300}),
                ),
                "POST /v1/sessions/foreign/lease HTTP/1.1" => {
                    assert!(
                        !acquired,
                        "a writer must not take another lease after losing one"
                    );
                    let now = Instant::now();
                    let expiry = *expiry.get_or_insert(now + Duration::from_millis(80));
                    if now < expiry {
                        (
                            "409 Conflict",
                            json!({"code":"held","error":"previous writer","retryAfterMs":expiry.duration_since(now).as_millis() as u64+1}),
                        )
                    } else {
                        acquired = true;
                        ("200 OK", json!({"lease":"held-by-test","ttlMs":300}))
                    }
                }
                "GET /v1/sessions/foreign HTTP/1.1" => {
                    assert!(acquired);
                    (
                        "200 OK",
                        json!({"session":{"id":"foreign","project":"/tmp","created":0},"entries":[]}),
                    )
                }
                "POST /v1/sessions/foreign/lease/held-by-test/renew HTTP/1.1" => {
                    renew_count.fetch_add(1, Ordering::SeqCst);
                    if delay_reply.load(Ordering::SeqCst) {
                        std::thread::sleep(Duration::from_millis(120));
                    }
                    ("200 OK", json!({"ttlMs":300}))
                }
                "DELETE /v1/sessions/foreign/lease/held-by-test HTTP/1.1" => {
                    stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                        )
                        .unwrap();
                    break;
                }
                other => panic!("unexpected history request: {other}"),
            };
            let body = body.to_string();
            let sent = write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            if !request.contains("/renew ") {
                sent.unwrap();
            }
        }
    });
    let store = HttpHistory::new(&url, "offline-history-token").unwrap();
    let start = Instant::now();
    let lease = store.acquire("foreign").unwrap();
    let mut data = store.load("foreign").unwrap();
    assert!(start.elapsed() >= Duration::from_millis(80));
    for target in [1, 2] {
        let until = Instant::now() + Duration::from_secs(3);
        while renewed.load(Ordering::SeqCst) < target {
            assert!(Instant::now() < until, "writer did not renew");
            std::thread::sleep(Duration::from_millis(5));
        }
        delay.store(true, Ordering::SeqCst);
    }
    // The first reply renewed on time; the second cannot restore authority.
    std::thread::sleep(Duration::from_millis(155));
    assert!(
        lease
            .check()
            .unwrap_err()
            .to_string()
            .contains("lease was lost")
    );
    data.entries.push(Entry {
        id: "new".into(),
        parent: None,
        input_id: None,
        scope: Scope::session("foreign"),
        writer: "test".into(),
        at: 1,
        kind: "test.record".into(),
        visible: false,
        copies: vec![],
        content: Some(json!({})),
    });
    assert!(
        store
            .save(&data)
            .unwrap_err()
            .to_string()
            .contains("lease was lost")
    );
    drop(lease);
    worker.join().unwrap();
}
