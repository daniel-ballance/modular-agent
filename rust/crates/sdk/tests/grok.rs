//! Public Grok checks with disposable logins and loopback endpoints.
use modular_agent::{
    Agent, AgentBuilder, Code, GrokOptions, ModelDecision, ModelErrorKind, Outcome, Plugin,
    Provider, Result, ServeOptions, ServicePlugin, SignInOptions, SignInStep, SubscriptionModel,
    TurnAddition, WebSocketServer, grok, serve_websocket, sign_in, sign_out, subscription_logins,
};
use serde_json::{Value, json};
use std::{path::Path, sync::Mutex, time::SystemTime};

#[path = "fixtures/git_project.rs"]
mod git_project;
use git_project::git_project;

mod subscription_support;
use subscription_support::{Http, Request, private_file};

const CLIENT: &str = "b1a00492-073a-47ea-816f-4c329264a828";
const VERIFY: &str = "https://accounts.x.ai/oauth2/device";
const ENCRYPTED: &str = "sealed-reasoning-fixture";

fn device() -> Value {
    json!({"verification_uri":VERIFY,"user_code":"TEST-ONLY","device_code":"test/code"})
}

fn form(req: &Request) -> std::collections::BTreeMap<String, String> {
    assert_eq!(
        req.header("content-type"),
        Some("application/x-www-form-urlencoded")
    );
    assert_eq!(req.header("accept"), Some("application/json"));
    assert_eq!(req.header("authorization"), None);
    subscription_support::form(&req.body)
}

fn fields<const N: usize>(values: [(&str, &str); N]) -> std::collections::BTreeMap<String, String> {
    values
        .into_iter()
        .map(|(key, value)| (key.into(), value.into()))
        .collect()
}

#[tokio::test]
async fn device_sign_in_uses_forms_and_reports_only_device_and_waiting() -> Result<()> {
    for configured in [false, true] {
        let dir = tempfile::tempdir()?;
        let auth = dir.path().join("auth.json");
        let logins = subscription_logins(&auth);
        let provider = grok(GrokOptions::new(logins.clone()))?;
        assert_eq!(provider.id(), "grok");
        assert!(!provider.availability().await.is_available());
        let mut device = device();
        let complete = format!("{VERIFY}?code=TEST-ONLY");
        let expected_url = if configured {
            device["verification_uri_complete"] = json!(complete);
            device["interval"] = json!(1);
            device["expires_in"] = json!(900);
            &complete
        } else {
            VERIFY
        };
        let http = Http::start(vec![
            ("/code", 200, device.to_string()),
            (
                "/poll",
                400,
                json!({"error":"authorization_pending"}).to_string(),
            ),
            ("/poll", 400, json!({"error":"slow_down"}).to_string()),
            (
                "/poll",
                200,
                json!({"access_token":"fixture-access","refresh_token":"fixture-refresh"})
                    .to_string(),
            ),
        ])
        .await;
        let steps = Mutex::new(Vec::new());
        let on_step = |step: SignInStep<'_>| {
            steps.lock().unwrap().push(match step {
                SignInStep::DeviceCode { url, code } => {
                    assert_eq!((url, code), (expected_url, "TEST-ONLY"));
                    "deviceCode"
                }
                SignInStep::Waiting => "waiting",
                SignInStep::OpenAndPaste { .. } => panic!("Grok must not ask for a paste"),
            })
        };
        let (send, paste) = tokio::sync::mpsc::unbounded_channel();
        send.send("code=not-a-device-code".into()).unwrap();
        sign_in(
            "grok",
            &logins,
            SignInOptions {
                device: configured,
                paste: Some(paste),
                on_step: Some(&on_step),
                client_identity: configured.then(|| "Other_agent-2.0".into()),
                fixture: Some(http.sign_in(([127, 0, 0, 1], 0).into())),
                ..Default::default()
            },
        )
        .await?;
        assert_eq!(steps.into_inner().unwrap(), ["deviceCode", "waiting"]);
        let requests = http.done.await.unwrap();
        assert_eq!(
            form(&requests[0]),
            fields([
                ("client_id", CLIENT),
                (
                    "scope",
                    "openid profile email offline_access grok-cli:access api:access"
                ),
                (
                    "referrer",
                    if configured {
                        "Other_agent-2.0"
                    } else {
                        "modular-agent"
                    }
                ),
            ])
        );
        for poll in &requests[1..] {
            assert_eq!(
                form(poll),
                fields([
                    ("client_id", CLIENT),
                    ("device_code", "test/code"),
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ])
            );
        }
        assert!(provider.availability().await.is_available());
        let file: Value = serde_json::from_slice(&std::fs::read(&auth)?)?;
        let stored = file["logins"]["grok"].as_object().unwrap();
        assert_eq!(stored["access"], "fixture-access");
        assert_eq!(stored["refresh"], "fixture-refresh");
        assert!(!stored.contains_key("account"));
        sign_out("grok", &logins).await?;
        assert!(!provider.availability().await.is_available());
    }
    Ok(())
}

#[tokio::test]
async fn device_denial_and_expiry_stop_without_a_login() -> Result<()> {
    for (answer, reason) in [
        ("access_denied", "was denied"),
        ("authorization_denied", "was denied"),
        ("expired_token", "code expired"),
        ("deadline", "not completed in time"),
    ] {
        let dir = tempfile::tempdir()?;
        let auth = dir.path().join("auth.json");
        let mut device = device();
        device["interval"] = json!(1);
        let mut replies = vec![];
        if answer == "deadline" {
            device["expires_in"] = json!(1);
        } else {
            replies.push(("/poll", 400, json!({"error":answer}).to_string()));
        }
        replies.insert(0, ("/code", 200, device.to_string()));
        let http = Http::start(replies).await;
        let error = sign_in(
            "grok",
            &subscription_logins(&auth),
            SignInOptions {
                fixture: Some(http.sign_in(([127, 0, 0, 1], 0).into())),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert!(error.message().contains(reason), "{error}");
        assert!(!auth.exists());
        http.done.await.unwrap();
    }
    Ok(())
}

#[tokio::test]
async fn rejects_insecure_verification_addresses_and_invalid_identity() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let auth = dir.path().join("auth.json");
    let logins = subscription_logins(&auth);
    for member in ["verification_uri", "verification_uri_complete"] {
        let mut device = device();
        device[member] = json!("http://accounts.x.ai/oauth2/device");
        let http = Http::start(vec![("/code", 200, device.to_string())]).await;
        let error = sign_in(
            "grok",
            &logins,
            SignInOptions {
                fixture: Some(http.sign_in(([127, 0, 0, 1], 0).into())),
                on_step: Some(&|_| panic!("must not report a non-HTTPS address")),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert!(error.message().contains("not https"));
        assert!(!auth.exists());
        http.done.await.unwrap();
    }
    let mut options = GrokOptions::new(logins.clone());
    options.client_identity = Some("invalid label".into());
    assert_eq!(
        grok(options).err().unwrap().code(),
        Code::InvalidComposition
    );
    assert_eq!(
        sign_in(
            "grok",
            &logins,
            SignInOptions {
                client_identity: Some("invalid label".into()),
                ..Default::default()
            }
        )
        .await
        .unwrap_err()
        .code(),
        Code::InvalidParams
    );
    Ok(())
}

fn stream() -> String {
    [
        json!({"type":"response.output_text.delta","delta":"Hello"}),
        json!({"type":"response.output_item.done","item":{"type":"reasoning","encrypted_content":ENCRYPTED}}),
        json!({"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"Hello"}]}}),
        json!({"type":"response.completed","response":{"status":"completed","output":[]}}),
    ].map(|event| format!("data: {event}\n\n")).join("")
}

fn expired_login() -> Vec<u8> {
    serde_json::to_vec(&json!({"logins":{"grok":{"type":"oauth","access":"old-access","refresh":"one-use-refresh","expires":0}},"answers":{"fixture":"kept"}})).unwrap()
}

fn time_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

async fn agent(
    builder: AgentBuilder,
    provider: modular_agent::GrokProvider,
    served: bool,
    dir: &Path,
) -> Result<(Agent, Option<WebSocketServer>)> {
    if !served {
        return Ok((builder.provider(provider).build().await?, None));
    }
    let bearer = dir.join("service-token");
    private_file(&bearer, b"af712a1174815937db47ebb99cc64e83\n");
    let server = serve_websocket(
        Plugin::new("grok-fixture").provider(provider),
        ServeOptions {
            listen: "127.0.0.1:0".into(),
            token_file: bearer.clone(),
            tls: None,
            projects: vec![],
        },
    )
    .await?;
    let agent = builder
        .service_plugin(ServicePlugin::new(&server.url, bearer))
        .build()
        .await?;
    Ok((agent, Some(server)))
}

#[tokio::test]
async fn requests_use_one_locked_refresh_and_replay_encrypted_reasoning() -> Result<()> {
    for served in [false, true] {
        let dir = tempfile::tempdir()?;
        let auth = dir.path().join("auth.json");
        private_file(&auth, &expired_login());
        let lock = auth.with_extension("lock");
        let before = time_ms();
        let http = Http::start_observing(
            vec![
                (
                    "/token",
                    200,
                    json!({"access_token":"fresh-access"}).to_string(),
                ),
                ("/responses", 200, stream()),
                ("/responses", 200, stream()),
                ("/responses", 200, stream()),
            ],
            move |req| {
                if req.target == "/token" {
                    let lock = std::fs::File::open(&lock).unwrap();
                    let error = fs2::FileExt::try_lock_exclusive(&lock)
                        .expect_err("refresh must hold the file lock");
                    assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
                }
            },
        )
        .await;
        let provider = |configured: bool| {
            let mut options = GrokOptions::new(subscription_logins(&auth));
            options.client_identity = configured.then(|| "Other_agent-2.0".into());
            options.models.push(SubscriptionModel {
                id: "enrolled".into(),
                context_window: 32_000,
                max_output: 42,
                input: vec!["text".into()],
            });
            grok(options)?.with_test_endpoints(&http.url("/responses"), &http.url("/token"))
        };
        let project = git_project();
        let builder = |model| {
            Agent::builder()
                .project(project.path())
                .model(model)
                .default_prompt(false)
                .setting("maxOutput", json!(50_000))
                .setting("reasoning", json!("minimal"))
                .plugin(Plugin::new("system").on_turn_before(|_| async {
                    Ok(TurnAddition {
                        system: Some("Be brief.".into()),
                        ..Default::default()
                    })
                }))
        };
        let (first, _) = agent(
            builder("grok/enrolled"),
            provider(false)?,
            false,
            dir.path(),
        )
        .await?;
        let (second, service) = agent(
            builder("grok/grok-4.3"),
            provider(true)?,
            served,
            dir.path(),
        )
        .await?;
        let models = second.models()?;
        let builtin = models.iter().find(|m| m.model.id == "grok-4.3").unwrap();
        assert_eq!(
            (builtin.context_window, builtin.max_output),
            (1_000_000, 30_000)
        );
        assert_eq!(builtin.thinking, ["off", "low", "medium", "high", "xhigh"]);
        assert_eq!(builtin.extra["input"], json!(["text", "image"]));
        let enrolled = models.iter().find(|m| m.model.id == "enrolled").unwrap();
        assert_eq!((enrolled.context_window, enrolled.max_output), (32_000, 42));
        assert!(enrolled.thinking.is_empty());
        let one = first.session().await?;
        let two = second.session().await?;
        let (a, b) = tokio::join!(one.prompt("hi"), two.prompt("hi"));
        for reply in [a?, b?, two.prompt("again").await?] {
            assert_eq!(reply.outcome, Some(Outcome::Completed));
            assert_eq!(reply.text, "Hello");
        }
        let requests = http.done.await.unwrap();
        assert_eq!(
            form(&requests[0]),
            fields([
                ("grant_type", "refresh_token"),
                ("refresh_token", "one-use-refresh"),
                ("client_id", CLIENT),
            ])
        );
        for req in &requests[1..] {
            for (name, value) in [
                ("authorization", "Bearer fresh-access"),
                ("accept", "text/event-stream"),
                ("content-type", "application/json"),
                (
                    "user-agent",
                    concat!("modular-agent/", env!("CARGO_PKG_VERSION")),
                ),
            ] {
                assert_eq!(req.header(name), Some(value));
            }
            let mut header_names: Vec<_> = req
                .head
                .lines()
                .skip(1)
                .filter_map(|line| line.split_once(':'))
                .map(|(name, _)| name.to_ascii_lowercase())
                .collect();
            header_names.sort();
            assert_eq!(
                header_names,
                [
                    "accept",
                    "authorization",
                    "content-length",
                    "content-type",
                    "host",
                    "user-agent"
                ]
            );
            let body: Value = serde_json::from_str(&req.body)?;
            let is_enrolled = body["model"] == "enrolled";
            assert_eq!(
                body["input"][0],
                json!({"role":"system","content":"Be brief."})
            );
            assert_eq!(body["input"][1], json!({"role":"user","content":"hi"}));
            assert!(body.get("instructions").is_none());
            assert_eq!(body["stream"], true);
            assert_eq!(body["store"], false);
            assert_eq!(body["include"], json!(["reasoning.encrypted_content"]));
            assert_eq!(
                body["max_output_tokens"],
                if is_enrolled { 42 } else { 30_000 }
            );
            assert_eq!(
                body["reasoning"]["effort"],
                if is_enrolled {
                    Value::Null
                } else {
                    json!("none")
                }
            );
        }
        let last: Value = serde_json::from_str(&requests[3].body)?;
        assert_eq!(
            last["input"][2],
            json!({"type":"reasoning","encrypted_content":ENCRYPTED})
        );
        assert_eq!(last["input"][4], json!({"role":"user","content":"again"}));
        assert!(!json!(two.history().await?).to_string().contains(ENCRYPTED));
        let file: Value = serde_json::from_slice(&std::fs::read(&auth)?)?;
        assert_eq!(file["answers"], json!({"fixture":"kept"}));
        let login = &file["logins"]["grok"];
        assert_eq!(login["refresh"], "one-use-refresh");
        assert_eq!(login["access"], "fresh-access");
        let margin_adjusted = (3600 - 300) * 1000;
        assert!(
            (before + margin_adjusted..=time_ms() + margin_adjusted)
                .contains(&login["expires"].as_u64().unwrap())
        );
        first.close().await?;
        second.close().await?;
        if let Some(service) = service {
            service.close().await;
        }
    }
    Ok(())
}

#[tokio::test]
async fn invalid_grant_leaves_the_login_and_reports_credentials() -> Result<()> {
    for served in [false, true] {
        let dir = tempfile::tempdir()?;
        let auth = dir.path().join("auth.json");
        let before = expired_login();
        private_file(&auth, &before);
        let http = Http::start(vec![(
            "/token",
            400,
            json!({"error":"invalid_grant","error_description":"one-use-refresh"}).to_string(),
        )])
        .await;
        let provider = grok(GrokOptions::new(subscription_logins(&auth)))?
            .with_test_endpoints(&http.url("/responses"), &http.url("/token"))?;
        let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
        let project = git_project();
        let builder = Agent::builder()
            .project(project.path())
            .model("grok/grok-4.3")
            .plugin(Plugin::new("capture").on_model_failed(move |p| {
                send.send(p.error).unwrap();
                async { Ok(ModelDecision::Stop) }
            }));
        let (agent, server) = agent(builder, provider, served, dir.path()).await?;
        let outcome = agent.session().await?.prompt("hi").await?.outcome;
        assert!(matches!(outcome, Some(Outcome::Failed { .. })));
        let error = receive
            .try_recv()
            .unwrap_or_else(|_| panic!("missing model failure (served={served}): {outcome:?}"));
        assert_eq!(error.kind, ModelErrorKind::Credentials);
        assert!(error.message.contains("sign in again"));
        assert!(!error.message.contains("one-use-refresh"));
        assert_eq!(std::fs::read(auth)?, before);
        http.done.await.unwrap();
        agent.close().await?;
        if let Some(server) = server {
            server.close().await;
        }
    }
    Ok(())
}

#[tokio::test]
async fn distinguishes_service_errors_and_an_incomplete_stream() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let auth = dir.path().join("auth.json");
    private_file(&auth, &valid_login());
    let http = Http::start(vec![
        ("/responses", 429, json!({"error":{"type":"usage_limit_reached","message":"You have hit your usage limit."}}).to_string()),
        ("/responses", 400, json!({"error":{"code":"context_length_exceeded","message":"too long"}}).to_string()),
        ("/responses", 503, "upstream unavailable".into()),
        ("/responses", 200, format!("data: {}\n\n", json!({"type":"response.failed","response":{"error":{"code":"server_error","message":"boom"}}}))),
        ("/responses", 200, format!("data: {}\n\n", json!({"type":"response.output_text.delta","delta":"cut"}))),
    ]).await;
    let provider = grok(GrokOptions::new(subscription_logins(auth)))?
        .with_test_endpoints(&http.url("/responses"), &http.url("/token"))?;
    let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
    let project = git_project();
    let agent = Agent::builder()
        .project(project.path())
        .provider(provider)
        .model("grok/grok-4.3")
        .plugin(Plugin::new("capture").on_model_failed_with(
            modular_agent::Order::First,
            move |p| {
                send.send(p.error).unwrap();
                async { Ok(ModelDecision::Stop) }
            },
        ))
        .build()
        .await?;
    let session = agent.session().await?;
    use ModelErrorKind::{ContextTooLarge, Other, Temporary};
    for (kind, message) in [
        (Other, "usage limit"),
        (ContextTooLarge, "too long"),
        (Temporary, "503"),
        (Temporary, "boom"),
        (Temporary, "ended before a complete response"),
    ] {
        assert!(matches!(
            session.prompt("hi").await?.outcome,
            Some(Outcome::Failed { .. })
        ));
        let error = receive.try_recv().unwrap();
        assert_eq!(error.kind, kind);
        assert!(error.message.contains(message));
    }
    http.done.await.unwrap();
    agent.close().await
}

#[tokio::test]
async fn cancelling_does_not_wait_for_the_stream() -> Result<()> {
    use std::time::Duration;
    let dir = tempfile::tempdir()?;
    let auth = dir.path().join("auth.json");
    private_file(&auth, &valid_login());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}", listener.local_addr()?);
    let (connected, received) = tokio::sync::oneshot::channel();
    let held = tokio::spawn(async move {
        let (_stream, _) = listener.accept().await.unwrap();
        connected.send(()).unwrap();
        std::future::pending::<()>().await;
    });
    let provider = grok(GrokOptions::new(subscription_logins(auth)))?
        .with_test_endpoints(&format!("{base}/responses"), &format!("{base}/token"))?;
    let project = git_project();
    let agent = Agent::builder()
        .project(project.path())
        .provider(provider)
        .model("grok/grok-4.3")
        .build()
        .await?;
    let session = agent.session().await?;
    let (answer, cancel) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(session.prompt("hi"), async {
            received.await.unwrap();
            session.cancel().await
        })
    })
    .await
    .expect("cancel did not settle the turn");
    cancel?;
    assert_eq!(answer?.outcome, Some(Outcome::Cancelled));
    held.abort();
    agent.close().await
}

fn valid_login() -> Vec<u8> {
    let mut file: Value = serde_json::from_slice(&expired_login()).unwrap();
    file["logins"]["grok"]["expires"] = json!(u64::MAX);
    serde_json::to_vec(&file).unwrap()
}
