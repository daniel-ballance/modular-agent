//! Actual HTTP form exchanges and a simulated browser. No external endpoints.
use super::*;
use std::sync::{Arc, Mutex};
use tokio::net::{TcpListener, TcpStream};

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

fn codex_tokens() -> Value {
    let claims =
        b64(br#"{"https://api.openai.com/auth":{"chatgpt_account_id":"fixture-account"}}"#);
    json!({"access_token":format!("h.{claims}.s"),"refresh_token":"fixture-refresh","expires_in":3600})
}
fn account(login: Login) {
    assert!(
        matches!(login, Login::Oauth { account: Some(ref a), ref refresh, .. }
        if a == "fixture-account" && refresh == "fixture-refresh")
    );
}

#[tokio::test]
async fn browser_sign_in_binds_state_and_pkce_to_the_exchange() {
    let fake = server(vec![("/token", 200, codex_tokens())]).await;
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let callback = listener.local_addr().unwrap();
    let challenge = Mutex::new(String::new());
    let show = |step: Step<'_>| {
        let Step::Open(address) = step else {
            panic!("expected browser address")
        };
        let (_, params) = address.split_once('?').unwrap();
        let state = query(params, "state").unwrap();
        *challenge.lock().unwrap() = query(params, "code_challenge").unwrap();
        tokio::spawn(async move {
            let mut browser = TcpStream::connect(callback).await.unwrap();
            browser
                .write_all(
                    format!("GET /auth/callback?state={state}&code=test-code HTTP/1.1\r\n\r\n")
                        .as_bytes(),
                )
                .await
                .unwrap();
            let mut answer = Vec::new();
            browser.read_to_end(&mut answer).await.unwrap();
            assert!(answer.starts_with(b"HTTP/1.1 200"));
        });
    };
    let login = tokio::time::timeout(
        Duration::from_secs(4),
        codex_browser(
            &client(),
            Some(listener),
            None,
            &show,
            &format!("{}/token", fake.base),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    account(login);
    fake.task.await.unwrap();
    let seen = fake.seen.lock().unwrap();
    let form = &seen[0].1;
    assert_eq!(
        query(form, "grant_type").as_deref(),
        Some("authorization_code")
    );
    assert_eq!(query(form, "client_id").as_deref(), Some(CODEX_CLIENT));
    assert_eq!(query(form, "code").as_deref(), Some("test-code"));
    assert_eq!(query(form, "redirect_uri").as_deref(), Some(CODEX_REDIRECT));
    let verifier = query(form, "code_verifier").unwrap();
    assert_eq!(
        *challenge.lock().unwrap(),
        b64(&sha2::Sha256::digest(verifier.as_bytes()))
    );
}

/// Over SSH the browser is on another machine: the person pastes the address it
/// was sent back to. A wrong-state address is refused and the sign-in keeps waiting.
#[tokio::test]
async fn browser_sign_in_finishes_from_a_pasted_redirect_address() {
    let fake = server(vec![("/token", 200, codex_tokens())]).await;
    let (paste, pasted) = tokio::sync::mpsc::unbounded_channel();
    let notes = Mutex::new(Vec::new());
    let show = |step: Step<'_>| match step {
        Step::OpenAndPaste(address) => {
            let (_, params) = address.split_once('?').unwrap();
            let state = query(params, "state").unwrap();
            assert_eq!(
                query(params, "originator").as_deref(),
                Some(CLIENT_IDENTITY)
            );
            paste.send(String::new()).unwrap();
            paste
                .send("http://localhost:1455/auth/callback?code=stale&state=other".into())
                .unwrap();
            paste
                .send(format!(
                    "http://localhost:1455/auth/callback?code=pasted-code&scope=x&state={state}"
                ))
                .unwrap();
        }
        Step::Note(text) => notes.lock().unwrap().push(text.to_owned()),
        _ => panic!("expected the paste prompt"),
    };
    let login = tokio::time::timeout(
        Duration::from_secs(4),
        codex_browser(
            &client(),
            None,
            Some(pasted),
            &show,
            &format!("{}/token", fake.base),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    account(login);
    fake.task.await.unwrap();
    let seen = fake.seen.lock().unwrap();
    assert_eq!(query(&seen[0].1, "code").as_deref(), Some("pasted-code"));
    assert_eq!(
        query(&seen[0].1, "redirect_uri").as_deref(),
        Some(CODEX_REDIRECT)
    );
    let notes = notes.lock().unwrap();
    assert!(
        notes.len() == 1 && notes[0].contains("different sign-in"),
        "{notes:?}"
    );
}

#[test]
fn a_pasted_code_is_read_from_each_form_people_paste() {
    let read = |s: &str| pasted_code(s, "st").map_err(|e| e.to_string());
    assert_eq!(
        read("http://localhost:1455/auth/callback?code=c1&state=st"),
        Ok(Some("c1".into()))
    );
    assert_eq!(read("  code=c2&state=st  "), Ok(Some("c2".into())));
    assert_eq!(read("c3#st"), Ok(Some("c3".into())));
    assert_eq!(read("c4"), Ok(Some("c4".into())));
    assert_eq!(read("   "), Ok(None));
    assert!(
        read("http://localhost:1455/auth/callback?code=c&state=other")
            .unwrap_err()
            .contains("different sign-in")
    );
    assert!(
        read("http://localhost:1455/auth/callback?error=access_denied&state=st")
            .unwrap_err()
            .contains("not completed")
    );
    assert!(
        read("http://localhost:1455/auth/callback?state=st")
            .unwrap_err()
            .contains("no code")
    );
}

#[tokio::test]
async fn codex_device_sign_in_polls_then_exchanges_the_code() {
    let fake = server(vec![
        (
            "/code",
            200,
            json!({"device_auth_id":"device","user_code":"ABCD","interval":"1"}),
        ),
        ("/poll", 403, json!({})),
        (
            "/poll",
            200,
            json!({"authorization_code":"issued","code_verifier":"fixture-verifier"}),
        ),
        ("/token", 200, codex_tokens()),
    ])
    .await;
    let show = |step: Step<'_>| match step {
        Step::Code { address, code } => {
            assert_eq!(address, CODEX_DEVICE_PAGE);
            assert_eq!(code, "ABCD");
        }
        _ => panic!("expected device code"),
    };
    account(
        codex_device(
            &client(),
            &show,
            &format!("{}/code", fake.base),
            &format!("{}/poll", fake.base),
            &format!("{}/token", fake.base),
        )
        .await
        .unwrap(),
    );
    fake.task.await.unwrap();
    let seen = fake.seen.lock().unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&seen[0].1).unwrap(),
        json!({"client_id":CODEX_CLIENT})
    );
    assert_eq!(
        serde_json::from_str::<Value>(&seen[1].1).unwrap(),
        json!({"device_auth_id":"device","user_code":"ABCD"})
    );
    assert_eq!(seen[1], seen[2]);
    assert_eq!(
        query(&seen[3].1, "redirect_uri").as_deref(),
        Some(CODEX_DEVICE_REDIRECT)
    );
    assert_eq!(query(&seen[3].1, "code").as_deref(), Some("issued"));
}

#[tokio::test]
async fn xai_device_sign_in_polls_then_gets_tokens() {
    let fake = server(vec![
        ("/code", 200, json!({"device_code":"fixture","user_code":"X","verification_uri":"https://example.test/device","interval":1})),
        ("/token", 400, json!({"error":"authorization_pending"})),
        ("/token", 200, json!({"access_token":"fake-access","refresh_token":"fake-refresh"})),
    ]).await;
    let show = |step: Step<'_>| match step {
        Step::Code { code, .. } => assert_eq!(code, "X"),
        _ => panic!("expected device code"),
    };
    let login = xai_device(
        &client(),
        &show,
        &format!("{}/code", fake.base),
        &format!("{}/token", fake.base),
    )
    .await
    .unwrap();
    assert!(matches!(login, Login::Oauth { access, account: None, .. } if access == "fake-access"));
    fake.task.await.unwrap();
    let seen = fake.seen.lock().unwrap();
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
async fn both_vendors_refresh_via_loopback_and_keep_unrotated_tokens() {
    for (vendor, expected_id, reply) in [
        (Vendor::Codex, CODEX_CLIENT, codex_tokens()),
        (
            Vendor::Xai,
            XAI_CLIENT,
            json!({"access_token":"fresh","expires_in":3600}),
        ),
    ] {
        let fake = server(vec![("/refresh", 200, reply)]).await;
        let dir = tempfile::tempdir().unwrap();
        let file = credentials_auth::AuthFile::new(dir.path().join("auth.json"), &[vendor.id()]);
        file.set_login(
            vendor.id(),
            Some(Login::Oauth {
                access: "old".into(),
                refresh: "not-rotated".into(),
                expires: 0,
                account: None,
            }),
        )
        .unwrap();
        let url = format!("{}/refresh", fake.base);
        let client = client();
        let fresh = file
            .current(vendor.id(), None, |old| {
                refresh_at(&client, vendor, old, &url)
            })
            .await
            .unwrap();
        assert!(!fresh.expired());
        assert_eq!(file.login(vendor.id()).unwrap(), Some(fresh.clone()));
        match vendor {
            Vendor::Codex => account(fresh),
            Vendor::Xai => {
                assert!(matches!(fresh, Login::Oauth { refresh, .. } if refresh == "not-rotated"))
            }
        }
        fake.task.await.unwrap();
        let seen = fake.seen.lock().unwrap();
        assert_eq!(query(&seen[0].1, "client_id").as_deref(), Some(expected_id));
        assert_eq!(
            query(&seen[0].1, "grant_type").as_deref(),
            Some("refresh_token")
        );
        assert_eq!(
            query(&seen[0].1, "refresh_token").as_deref(),
            Some("not-rotated")
        );
    }
}
