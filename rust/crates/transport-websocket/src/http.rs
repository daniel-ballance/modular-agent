//! HTTP/1 on the agent listener. HTTP requests and WebSocket upgrades use the same token table.
use super::*;
pub use axum_core::body::Body;
use hyper::{body::Incoming, server::conn::http1, service::service_fn};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::convert::Infallible;
use tokio_util::task::TaskTracker;

pub type Request = hyper::Request<Body>;
pub type Response = hyper::Response<Body>;

#[derive(Clone)]
pub struct Upgrade {
    tasks: TaskTracker,
    stop: CancellationToken,
}
impl Upgrade {
    /// The caller has authenticated the request and checked the path and Origin.
    pub fn acp<F, Fut>(&self, mut request: Request, handler: F) -> Option<Response>
    where
        F: FnOnce(Connection) -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        use tokio_tungstenite::tungstenite::{
            handshake::server::create_response_with_body, protocol::Role,
        };
        if !request
            .headers()
            .get_all(header::SEC_WEBSOCKET_PROTOCOL)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(','))
            .any(|v| v.trim() == ACP)
        {
            return None;
        }
        let mut response = create_response_with_body(&request, Body::empty).ok()?;
        response.headers_mut().insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_static(ACP),
        );
        let upgrade = hyper::upgrade::on(&mut request);
        let stop = self.stop.clone();
        self.tasks.spawn(async move {
            if let Some(Ok(io)) = stop.run_until_cancelled(upgrade).await {
                let ws = WebSocketStream::from_raw_socket(
                    TokioIo::new(io),
                    Role::Server,
                    Some(framing()),
                )
                .await;
                run(ws, stop, handler).await;
            }
        });
        Some(response)
    }
}

async fn http_connection<T, F, Fut, S>(io: S, entries: Arc<Tokens<T>>, handler: Arc<F>, up: Upgrade)
where
    T: Clone + Send + Sync + 'static,
    F: Fn(Option<T>, Request, Upgrade) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Response> + Send + 'static,
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let stop = up.stop.clone();
    let service = service_fn(move |req: hyper::Request<Incoming>| {
        let mut actor = None;
        let mut auth = req.headers().get_all(header::AUTHORIZATION).iter();
        if let Some(token) = auth
            .next()
            .and_then(|v| v.as_bytes().strip_prefix(b"Bearer "))
            && auth.next().is_none()
        {
            let hash = Sha256::digest(token);
            for (expected, value) in entries.iter() {
                if bool::from(expected.ct_eq(&hash)) {
                    actor = Some(value.clone());
                }
            }
        }
        let response = handler(actor, req.map(Body::new), up.clone());
        async move { Ok::<_, Infallible>(response.await) }
    });
    let conn = http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(CONTROL)
        .serve_connection(TokioIo::new(io), service)
        .with_upgrades();
    let _ = stop.run_until_cancelled(conn).await;
}

pub async fn serve<T, F, Fut>(
    listen: &str,
    tls: Option<TlsOptions>,
    client_ca: Option<&Path>,
    entries: Vec<(PathBuf, T)>,
    handler: F,
) -> Result<Server>
where
    T: Clone + Send + Sync + 'static,
    F: Fn(Option<T>, Request, Upgrade) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Response> + Send + 'static,
{
    let entries = Arc::new(read_tokens(entries).await?);
    let tls = acceptor(tls, client_ca)?;
    let address = listen
        .replacen("https://", "wss://", 1)
        .replacen("http://", "ws://", 1);
    let (listener, url) = bind(&address, tls.is_some()).await?;
    ensure!(
        Url::parse(&url)?.path() == "/",
        "HTTP listener requires an origin"
    );
    let url = url
        .replacen("ws", "http", 1)
        .trim_end_matches('/')
        .to_owned();
    let stop = CancellationToken::new();
    let closing = stop.clone();
    let handler = Arc::new(handler);
    let task = tokio::spawn(async move {
        let tasks = TaskTracker::new();
        while let Some(Ok((tcp, _))) = closing.run_until_cancelled(listener.accept()).await {
            let (tls, entries, handler) = (tls.clone(), entries.clone(), handler.clone());
            let up = Upgrade {
                tasks: tasks.clone(),
                stop: closing.clone(),
            };
            tasks.spawn(async move {
                if let Some(tls) = tls {
                    if let Some(Ok(Ok(io))) = up
                        .stop
                        .run_until_cancelled(timeout(CONTROL, tls.accept(tcp)))
                        .await
                    {
                        http_connection(io, entries, handler, up).await;
                    }
                } else {
                    http_connection(tcp, entries, handler, up).await;
                }
            });
        }
        closing.cancel();
        tasks.close();
        tasks.wait().await;
    });
    Ok(Server {
        url,
        stop,
        task: Some(task),
    })
}
