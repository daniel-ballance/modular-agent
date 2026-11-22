//! Actual HTTP form exchanges and a simulated browser. No external endpoints.
use super::*;
use serde_json::json;

fn query(form: &str, key: &str) -> Option<String> {
    reqwest::Url::parse(&format!("http://localhost/?{form}"))
        .unwrap()
        .query_pairs()
        .find_map(|(name, value)| (name == key).then(|| value.into_owned()))
}
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

struct Server {
    base: String,
    seen: Arc<Mutex<Vec<(String, String)>>>,
    task: tokio::task::JoinHandle<()>,
}

async fn server(replies: Vec<(&'static str, u16, Value)>) -> Server {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(vec![]));
    let observed = seen.clone();
    let task = tokio::spawn(async move {
        for (path, status, reply) in replies {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let start = loop {
                if let Some(at) = buf.windows(4).position(|b| b == b"\r\n\r\n") {
                    break at + 4;
                }
                assert_ne!(stream.read_buf(&mut buf).await.unwrap(), 0);
            };
            let head = std::str::from_utf8(&buf[..start]).unwrap();
            let target = head.split_whitespace().nth(1).unwrap().to_owned();
            let length = head
                .lines()
                .find_map(|l| {
                    l.split_once(':')
                        .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                })
                .map(|(_, v)| v.trim().parse::<usize>().unwrap())
                .unwrap_or(0);
            while buf.len() < start + length {
                assert_ne!(stream.read_buf(&mut buf).await.unwrap(), 0);
            }
            assert_eq!(target, path);
            let body = std::str::from_utf8(&buf[start..start + length])
                .unwrap()
                .to_owned();
            observed.lock().unwrap().push((target, body));
            let reply = reply.to_string();
            let response = format!(
                "HTTP/1.1 {status} Fixture\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                reply.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });
    Server { base, seen, task }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap()
}

#[tokio::test]
async fn xai_device_sign_in_polls_then_gets_tokens() {
    let fake = server(vec![
        ("/code", 200, json!({"device_code":"fixture","user_code":"X","verification_uri":"https://example.test/device","interval":1})),
        ("/token", 400, json!({"error":"authorization_pending"})),
        ("/token", 200, json!({"access_token":"fake-access","refresh_token":"fake-refresh"})),
    ]).await;
    let show = |step: DeviceCode<'_>| assert_eq!(step.code, "X");
    let login = xai_device(
        &client(),
        &ClientIdentity::default(),
        &show,
        &format!("{}/code", fake.base),
        &format!("{}/token", fake.base),
    )
    .await
    .unwrap();
    assert!(matches!(login, Login::Oauth { access, account: None, .. } if access == "fake-access"));
    fake.task.await.unwrap();
    let seen = fake.seen.lock().unwrap();
    assert_eq!(
        query(&seen[0].1, "referrer").as_deref(),
        Some("modular-agent")
    );
    assert_eq!(query(&seen[0].1, "scope").as_deref(), Some(XAI_SCOPE));
    assert_eq!(query(&seen[1].1, "client_id").as_deref(), Some(XAI_CLIENT));
    assert_eq!(
        query(&seen[1].1, "grant_type").as_deref(),
        Some("urn:ietf:params:oauth:grant-type:device_code")
    );
    assert_eq!(query(&seen[1].1, "device_code").as_deref(), Some("fixture"));
    assert_eq!(seen[1], seen[2]);
}

#[tokio::test]
async fn xai_device_sign_in_sends_the_configured_referrer() {
    let fake = server(vec![("/code", 400, json!({"error":"fixture"}))]).await;
    assert!(
        xai_device(
            &client(),
            &"My-agent_2.0".parse().unwrap(),
            &|_| panic!("the fixture refuses the initial request"),
            &format!("{}/code", fake.base),
            &format!("{}/token", fake.base),
        )
        .await
        .is_err()
    );
    fake.task.await.unwrap();
    assert_eq!(
        query(&fake.seen.lock().unwrap()[0].1, "referrer").as_deref(),
        Some("My-agent_2.0")
    );
}

#[tokio::test]
async fn grok_refresh_keeps_the_previous_token_when_it_is_not_rotated() {
    let server = server(vec![(
        "/token",
        200,
        json!({"access_token":"new","expires_in":3600}),
    )])
    .await;
    let old = Login::Oauth {
        access: "old".into(),
        refresh: "kept".into(),
        expires: 0,
        account: None,
    };
    let fresh = refresh_at(&client(), old, &format!("{}/token", server.base))
        .await
        .unwrap();
    assert!(matches!(fresh, Login::Oauth { refresh, account: None, .. } if refresh == "kept"));
    server.task.await.unwrap();
}
