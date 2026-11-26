use super::connect_history;
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use modular_agent::{
    Agent, Code, Result, ServeHistoryOptions, Session, file_history, listen_history,
};
use std::{
    io::Write,
    os::unix::fs::OpenOptionsExt,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{net::TcpListener, sync::Notify, task::JoinSet};

#[derive(Default)]
struct Faults {
    registry_unavailable: AtomicBool,
    stall_renewal: AtomicBool,
    renewal_requested: Notify,
    release_renewal: Notify,
}

struct Proxy {
    upstream: String,
    client: reqwest::Client,
    faults: Arc<Faults>,
}

async fn proxy(State(proxy): State<Arc<Proxy>>, request: Request) -> Response {
    let path = request.uri().path();
    if path.ends_with("/pending-erasure")
        && proxy.faults.registry_unavailable.load(Ordering::SeqCst)
    {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::CONTENT_TYPE, "application/json")],
            r#"{"code":"unavailable","error":"test freshness check unavailable"}"#,
        )
            .into_response();
    }
    if path.ends_with("/renew") && proxy.faults.stall_renewal.load(Ordering::SeqCst) {
        proxy.faults.renewal_requested.notify_one();
        proxy.faults.release_renewal.notified().await;
    }
    let (mut parts, body) = request.into_parts();
    let body = to_bytes(body, 64 * 1024 * 1024).await.unwrap();
    parts.headers.remove(header::HOST);
    let reply = proxy
        .client
        .request(parts.method, format!("{}{}", proxy.upstream, parts.uri))
        .headers(parts.headers)
        .body(body)
        .send()
        .await
        .unwrap();
    let status = reply.status();
    let content_type = reply.headers().get(header::CONTENT_TYPE).unwrap().clone();
    (
        status,
        [(header::CONTENT_TYPE, content_type)],
        Body::from(reply.bytes().await.unwrap()),
    )
        .into_response()
}

async fn after_handoff(
    lease_ttl: Duration,
    check: impl AsyncFnOnce(&Agent, &Session, &Faults) -> Result<()>,
) -> Result<()> {
    let tmp = tempfile::tempdir()?;
    let project = tempfile::tempdir_in(tmp.path())?;
    let token_file = tmp.path().join("token");
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&token_file)?
        .write_all(b"guide09-fault-test-token-not-for-deployment\n")?;
    let mut options = ServeHistoryOptions::new("127.0.0.1:0".parse().unwrap(), &token_file);
    options.lease_ttl = lease_ttl;
    let server = listen_history(file_history(tmp.path().join("history"))?, options).await?;
    let faults = Arc::new(Faults::default());
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    let routes = Router::new().fallback(proxy).with_state(Arc::new(Proxy {
        upstream: server.url.clone(),
        client: reqwest::Client::builder().no_proxy().build().unwrap(),
        faults: faults.clone(),
    }));
    let mut task = JoinSet::new();
    task.spawn(async move { axum::serve(listener, routes).await.unwrap() });

    let writer = connect_history(
        project.path(),
        &tmp.path().join("writer"),
        &url,
        &token_file,
    )
    .await?;
    let first = writer.session().await?;
    assert_eq!(first.prompt("Name a harbour.").await?.text, "Whitby.");
    writer.close().await?;
    let reader = connect_history(
        project.path(),
        &tmp.path().join("reader"),
        &url,
        &token_file,
    )
    .await?;
    let reopened = reader.open_session(first.id()).await?;

    let result = check(&reader, &reopened, &faults).await;
    reader.close().await?;
    task.shutdown().await;
    server.close().await;
    result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handoff_reports_unavailable_freshness_check() -> Result<()> {
    after_handoff(Duration::from_secs(15), async |_, reopened, faults| {
        faults.registry_unavailable.store(true, Ordering::SeqCst);
        let error = reopened.last_turn().await.unwrap_err();
        faults.registry_unavailable.store(false, Ordering::SeqCst);
        assert_eq!(reopened.last_turn().await?.unwrap().text, "Whitby.");
        assert_eq!(error.code(), Code::Unavailable, "{error:?}");
        reopened.close().await?;
        let error = reopened.last_turn().await.unwrap_err();
        assert_eq!(error.code(), Code::NotOpen, "{error:?}");
        Ok(())
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handoff_distinguishes_writer_loss_from_unavailable_history() -> Result<()> {
    after_handoff(Duration::from_secs(6), async |reader, reopened, faults| {
        let mut events = reader.events();
        faults.stall_renewal.store(true, Ordering::SeqCst);
        tokio::time::timeout(Duration::from_secs(15), async {
            faults.renewal_requested.notified().await;
            while let Some(event) = events.next().await {
                let event = event?;
                if event.session_id == reopened.id() && event.event_type == "sessionInterrupted" {
                    assert_eq!(event.data["reason"], "writerLost");
                    return Ok::<(), modular_agent::Error>(());
                }
            }
            panic!("event stream ended before writer loss");
        })
        .await
        .expect("withheld renewal did not interrupt the session")?;
        faults.release_renewal.notify_one();
        assert_eq!(reopened.last_turn().await?.unwrap().text, "Whitby.");
        let error = reopened
            .prompt("Can this writer still admit input?")
            .await
            .unwrap_err();
        assert_eq!(error.code(), Code::Lost, "{error:?}");
        faults.registry_unavailable.store(true, Ordering::SeqCst);
        let error = reopened.last_turn().await.unwrap_err();
        faults.registry_unavailable.store(false, Ordering::SeqCst);
        assert_eq!(error.code(), Code::Unavailable, "{error:?}");
        Ok(())
    })
    .await
}
