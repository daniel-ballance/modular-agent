//! Public SDK checks against disposable logins and loopback HTTP only.
use modular_agent::{
    Agent, ChatGptOptions, Code, ModelErrorKind, Outcome, Plugin, Provider, Result, ServeOptions,
    ServicePlugin, SignInOptions, SignInStep, SubscriptionModel, chatgpt, serve_websocket, sign_in,
    sign_out, subscription_logins,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

mod subscription_support;
use subscription_support::{Http, private_file};

fn form(body: &str, key: &str) -> String {
    subscription_support::form(body).remove(key).unwrap()
}

fn tokens() -> String {
    // A JWT-shaped fixture with just an account claim; not a real login.
    json!({"access_token":"h.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiZml4dHVyZS1hY2NvdW50In19.s", "refresh_token":"new-refresh", "expires_in":3600}).to_string()
}
#[tokio::test]
async fn browser_sign_in_checks_state_and_binds_pkce_to_the_exchange() -> Result<()> {
    use base64_oauth::Engine;
    use sha2::Digest;
    let dir = tempfile::tempdir()?;
    let logins = subscription_logins(dir.path().join("auth.json"));
    let http = Http::start(vec![("/token", 200, tokens())]).await;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let (send, mut receive) = tokio::sync::mpsc::unbounded_channel::<String>();
    let show = |step: SignInStep<'_>| {
        if let SignInStep::OpenAndPaste { url } = step {
            send.send(url.to_owned()).unwrap();
        }
    };
    let sign_in = sign_in(
        "chatgpt",
        &logins,
        SignInOptions {
            on_step: Some(&show),
            fixture: Some(http.sign_in(address).with_listener(listener)?),
            ..Default::default()
        },
    );
    let browser = async move {
        let url = reqwest::Url::parse(&receive.recv().await.unwrap()).unwrap();
        assert_eq!(
            url.as_str().split('?').next(),
            Some("https://auth.openai.com/oauth/authorize")
        );
        let query = url.query().unwrap();
        for (k, v) in [
            ("response_type", "code"),
            ("client_id", "app_EMoamEEZ73f0CkXaXp7hrann"),
            ("redirect_uri", "http://localhost:1455/auth/callback"),
            ("scope", "openid profile email offline_access"),
            ("code_challenge_method", "S256"),
            ("id_token_add_organizations", "true"),
            ("codex_cli_simplified_flow", "true"),
            ("originator", "modular-agent"),
        ] {
            assert_eq!(form(query, k), v);
        }
        async fn visit(address: std::net::SocketAddr, query: &str) -> String {
            let mut socket = TcpStream::connect(address).await.unwrap();
            socket
                .write_all(format!("GET /auth/callback?{query} HTTP/1.1\r\n").as_bytes())
                .await
                .unwrap();
            socket.write_all(b"Host: localhost\r\n\r\n").await.unwrap();
            let mut reply = String::new();
            socket.read_to_string(&mut reply).await.unwrap();
            reply
        }
        assert!(
            visit(address, "code=bad&state=wrong")
                .await
                .starts_with("HTTP/1.1 400")
        );
        assert!(
            visit(
                address,
                &format!("code=fixture&state={}", form(query, "state"))
            )
            .await
            .starts_with("HTTP/1.1 200")
        );
        form(query, "code_challenge")
    };
    let (result, challenge) = tokio::join!(sign_in, browser);
    result?;
    let req = http.done.await.unwrap().remove(0);
    assert_eq!(form(&req.body, "code"), "fixture");
    let verifier = form(&req.body, "code_verifier");
    assert_eq!(
        challenge,
        base64_oauth::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(sha2::Sha256::digest(verifier))
    );
    let provider = chatgpt(ChatGptOptions::new(logins.clone()))?;
    assert!(provider.available());
    sign_out("chatgpt", &logins).await?;
    assert!(!provider.available());
    Ok(())
}

#[tokio::test]
async fn occupied_redirect_uses_paste_when_present_and_device_when_absent() -> Result<()> {
    let occupied = TcpListener::bind("127.0.0.1:0").await?;
    let dir = tempfile::tempdir()?;
    let logins = subscription_logins(dir.path().join("auth.json"));
    let http = Http::start((0..4).map(|_| ("/token", 200, tokens())).collect()).await;
    for variant in 0..4 {
        let (send, paste) = tokio::sync::mpsc::unbounded_channel();
        let notices = Mutex::new(Vec::<String>::new());
        let show = |step: SignInStep<'_>| {
            let SignInStep::OpenAndPaste { url } = step else {
                panic!("expected browser step");
            };
            let query = url.split_once('?').unwrap().1;
            assert_eq!(form(query, "originator"), "Other_agent-2.0");
            let state = form(query, "state");
            send.send("code=wrong&state=wrong".into()).unwrap();
            send.send("error=access_denied".into()).unwrap();
            send.send(match variant {
                0 => format!("http://localhost:1455/auth/callback?code=a%2Fb&state={state}"),
                1 => format!("code=a%2Fb&state={state}"),
                2 => format!("a/b#{state}"),
                _ => "a/b".into(),
            })
            .unwrap();
        };
        sign_in(
            "chatgpt",
            &logins,
            SignInOptions {
                on_step: Some(&show),
                on_notice: Some(&|s| notices.lock().unwrap().push(s.to_owned())),
                paste: Some(paste),
                client_identity: Some("Other_agent-2.0".into()),
                fixture: Some(http.sign_in(occupied.local_addr()?)),
                ..Default::default()
            },
        )
        .await?;
        let notices = notices.into_inner().unwrap();
        assert!(notices[0].contains("in use"));
        assert!(notices[1].contains("different sign-in"));
        assert!(notices[2].contains("returned an error"));
    }
    for req in http.done.await.unwrap() {
        assert_eq!(form(&req.body, "code"), "a/b");
    }

    for device in [false, true] {
        let http = Http::start(vec![
            (
                "/code",
                200,
                json!({"device_auth_id":"device", "user_code":"very-fake", "interval":"1"})
                    .to_string(),
            ),
            ("/poll", 404, "{}".into()),
            (
                "/poll",
                200,
                json!({"authorization_code":"issued", "code_verifier":"verifier"}).to_string(),
            ),
            ("/token", 200, tokens()),
        ])
        .await;
        let steps = Mutex::new(Vec::new());
        let show = |step: SignInStep<'_>| {
            steps.lock().unwrap().push(match step {
                SignInStep::DeviceCode { url, code } => {
                    assert_eq!(
                        (url, code),
                        ("https://auth.openai.com/codex/device", "very-fake")
                    );
                    "device"
                }
                SignInStep::Waiting => "waiting",
                _ => panic!("expected device flow"),
            })
        };
        sign_in(
            "chatgpt",
            &logins,
            SignInOptions {
                device,
                on_step: Some(&show),
                fixture: Some(http.sign_in(occupied.local_addr()?)),
                ..Default::default()
            },
        )
        .await?;
        let req = http.done.await.unwrap();
        let code: Value = serde_json::from_str(&req[0].body)?;
        assert_eq!(code["client_id"], "app_EMoamEEZ73f0CkXaXp7hrann");
        let poll: Value = serde_json::from_str(&req[1].body)?;
        assert_eq!(
            poll,
            json!({"device_auth_id":"device","user_code":"very-fake"})
        );
        assert_eq!(form(&req[3].body, "code"), "issued");
        assert_eq!(
            form(&req[3].body, "redirect_uri"),
            "https://auth.openai.com/deviceauth/callback"
        );
        assert_eq!(steps.into_inner().unwrap(), ["device", "waiting"]);
    }
    Ok(())
}

fn stream() -> String {
    [
        json!({"type":"response.output_text.delta","delta":"Hello"}),
        json!({"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Hello"}]},{"type":"reasoning","encrypted_content":"opaque"}]}}),
    ].map(|event| format!("data: {event}\n\n")).join("")
}
fn login(expires: u64) -> Vec<u8> {
    serde_json::to_vec(&json!({"logins":{"chatgpt":{"type":"oauth","access":"old-access","refresh":"one-use-refresh","expires":expires,"account":"fixture-account"}},"answers":{"fixture":"kept"}})).unwrap()
}

#[tokio::test]
async fn requests_and_locked_refresh_work_locally_and_over_the_binding() -> Result<()> {
    use futures_util::StreamExt;
    for served in [false, true] {
        let dir = tempfile::tempdir()?;
        let auth = dir.path().join("auth.json");
        private_file(&auth, &login(0));
        let http = Http::start(vec![
            ("/token", 200, tokens()),
            ("/responses", 200, stream()),
            ("/responses", 200, stream()),
        ])
        .await;
        let provider = |configured: bool| {
            let mut opts = ChatGptOptions::new(subscription_logins(&auth));
            opts.client_identity = configured.then(|| "Other_agent-2.0".into());
            opts.models.push(SubscriptionModel {
                id: "enrolled".into(),
                context_window: 32_000,
                max_output: 5000,
                input: vec!["text".into()],
            });
            chatgpt(opts)?.with_test_endpoints(&http.url("/responses"), &http.url("/token"))
        };
        let bearer = dir.path().join("service-token");
        private_file(&bearer, b"af712a1174815937db47ebb99cc64e83\n");
        let mut service = None;
        let builder = |model: &str| {
            Agent::builder()
                .model(format!("chatgpt/{model}"))
                .setting("reasoning", json!("minimal"))
        };
        let first = builder("gpt-6.1-sol")
            .provider(provider(false)?)
            .build()
            .await?;
        let second = if served {
            let listening = serve_websocket(
                Plugin::new("subscription-test").provider(provider(true)?),
                ServeOptions {
                    listen: "127.0.0.1:0".into(),
                    token_file: bearer.clone(),
                    tls: None,
                    projects: vec![],
                },
            )
            .await?;
            let launch = ServicePlugin::new(&listening.url, &bearer);
            service = Some(listening);
            builder("enrolled").service_plugin(launch).build().await?
        } else {
            builder("enrolled")
                .provider(provider(true)?)
                .build()
                .await?
        };
        let model = second
            .models()?
            .into_iter()
            .find(|m| m.model.id == "enrolled")
            .unwrap();
        assert_eq!(model.context_window, 32_000);
        assert!(model.thinking.is_empty());
        let one = first.session().await?;
        let two = second.session().await?;
        let collected = async {
            let mut events = two.prompt_stream("hi").await?;
            let mut text = String::new();
            while let Some(event) = events.next().await.transpose()? {
                if event.event_type == "text" {
                    text.push_str(event.data["delta"].as_str().unwrap());
                }
            }
            assert_eq!(text, "Hello");
            assert_eq!(
                two.last_turn().await?.unwrap().outcome,
                Some(Outcome::Completed)
            );
            Ok::<_, modular_agent::Error>(())
        };
        let (a, b) = tokio::join!(one.prompt("hi"), collected);
        assert_eq!(a?.outcome, Some(Outcome::Completed));
        b?;
        let requests = http.done.await.unwrap();
        assert_eq!(
            requests.iter().filter(|req| req.target == "/token").count(),
            1
        );
        assert_eq!(form(&requests[0].body, "refresh_token"), "one-use-refresh");
        for req in &requests[1..] {
            let body: Value = serde_json::from_str(&req.body)?;
            let (session, identity, effort) = if body["model"] == "enrolled" {
                (two.id(), "Other_agent-2.0", Value::Null)
            } else {
                (one.id(), "modular-agent", json!("low"))
            };
            for (name, value) in [
                ("chatgpt-account-id", "fixture-account"),
                ("openai-beta", "responses=experimental"),
                ("originator", identity),
                ("session-id", session),
                ("x-client-request-id", session),
                ("accept", "text/event-stream"),
            ] {
                assert_eq!(req.header(name), Some(value));
            }
            assert!(
                req.header("authorization")
                    .unwrap()
                    .starts_with("Bearer h.")
            );
            assert_eq!(body["store"], false);
            assert_eq!(body["stream"], true);
            assert_eq!(body["include"], json!(["reasoning.encrypted_content"]));
            assert_eq!(body["reasoning"]["effort"], effort);
        }
        let file: Value = serde_json::from_slice(&std::fs::read(&auth)?)?;
        assert_eq!(file["answers"]["fixture"], "kept");
        for session in [&one, &two] {
            assert!(
                !json!(session.history().await?)
                    .to_string()
                    .contains("opaque")
            );
        }
        first.close().await?;
        second.close().await?;
        if let Some(service) = service {
            service.close().await;
        }
    }
    Ok(())
}

#[tokio::test]
async fn invalid_grant_is_a_credentials_failure_and_changes_no_bytes() -> Result<()> {
    for served in [false, true] {
        let dir = tempfile::tempdir()?;
        let auth = dir.path().join("auth.json");
        let before = login(0);
        private_file(&auth, &before);
        let http = Http::start(vec![(
            "/token",
            400,
            json!({"error":"invalid_grant", "error_description":"one-use-refresh"}).to_string(),
        )])
        .await;
        let provider = chatgpt(ChatGptOptions::new(subscription_logins(&auth)))?
            .with_test_endpoints(&http.url("/responses"), &http.url("/token"))?;
        let seen = Arc::new(Mutex::new(None));
        let capture = seen.clone();
        let builder = Agent::builder().model("chatgpt/gpt-6.1-sol").plugin(
            Plugin::new("capture").on_model_failed(move |p| {
                *capture.lock().unwrap() = Some(p.error);
                async { Ok(modular_agent::ModelDecision::Stop) }
            }),
        );
        let mut service = None;
        let agent = if served {
            let bearer = dir.path().join("service-token");
            private_file(&bearer, b"af712a1174815937db47ebb99cc64e83\n");
            let listening = serve_websocket(
                Plugin::new("subscription-test").provider(provider),
                ServeOptions {
                    listen: "127.0.0.1:0".into(),
                    token_file: bearer.clone(),
                    tls: None,
                    projects: vec![],
                },
            )
            .await?;
            let launch = ServicePlugin::new(&listening.url, &bearer);
            service = Some(listening);
            builder.service_plugin(launch).build().await?
        } else {
            builder.provider(provider).build().await?
        };
        let turn = agent.session().await?.prompt("hi").await?;
        assert!(matches!(turn.outcome, Some(Outcome::Failed { .. })));
        let error = seen.lock().unwrap().take().unwrap();
        assert_eq!(error.kind, ModelErrorKind::Credentials);
        assert!(error.message.contains("sign in again"));
        assert!(!error.message.contains("one-use-refresh"));
        assert_eq!(std::fs::read(auth)?, before);
        http.done.await.unwrap();
        agent.close().await?;
        if let Some(service) = service {
            service.close().await;
        }
    }
    Ok(())
}

#[tokio::test]
async fn invalid_identity_and_modes_are_refused_without_contacting_the_service() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let auth = dir.path().join("auth.json");
    private_file(&auth, &login(u64::MAX));
    let logins = subscription_logins(&auth);
    let mut opts = ChatGptOptions::new(logins.clone());
    opts.client_identity = Some("invalid label".into());
    assert_eq!(
        chatgpt(opts).err().unwrap().code(),
        Code::InvalidComposition
    );
    let error = sign_in(
        "chatgpt",
        &logins,
        SignInOptions {
            client_identity: Some("invalid label".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code(), Code::InvalidParams);
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&auth, std::fs::Permissions::from_mode(0o644))?;
    assert!(!chatgpt(ChatGptOptions::new(logins.clone()))?.available());
    let error = sign_out("chatgpt", &logins).await.unwrap_err();
    assert!(error.message().contains("readable by others"));
    Ok(())
}
