//! Authenticated, message-framed transport shared by the plugin and ACP bindings.
use anyhow::{Context, Result, anyhow, ensure};
use futures_util::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};

/// A stable opaque identifier for an operator-defined route scope. Only
/// non-secret configuration belongs in the descriptor, never bearer tokens.
pub fn scope_fingerprint(descriptor: &[u8]) -> String {
    format!("{:x}", Sha256::digest(descriptor))
}
use std::{
    future::Future,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::{TcpListener, TcpStream, lookup_host},
    sync::mpsc,
    task::{JoinHandle, JoinSet},
    time::timeout,
};
use tokio_rustls::{
    TlsAcceptor,
    rustls::{
        ClientConfig, RootCertStore, ServerConfig,
        crypto::ring,
        pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject},
    },
};
use tokio_tungstenite::{
    Connector, MaybeTlsStream, WebSocketStream,
    tungstenite::{
        Error, Message,
        client::IntoClientRequest,
        handshake::server::{ErrorResponse, Request, Response},
        http::{HeaderValue, StatusCode, header},
        protocol::{CloseFrame, WebSocketConfig, frame::coding::CloseCode},
    },
};
use tokio_util::sync::CancellationToken;
use url::Url;

#[cfg(feature = "http")]
pub mod http;

pub const LIMIT: usize = 64 * 1024 * 1024;
pub const PLUGIN: &str = "modular-agent-plugin-1";
pub const ACP: &str = "modular-agent-acp-1";
const CONTROL: Duration = Duration::from_secs(5);

#[derive(Clone, Debug)]
pub struct TlsOptions {
    pub cert_file: PathBuf,
    pub key_file: PathBuf,
}

pub struct Server {
    pub url: String,
    stop: CancellationToken,
    task: Option<JoinHandle<()>>,
}
impl Server {
    /// Stop accepting, close the sockets, and join all connection handlers.
    pub async fn close(mut self) {
        self.stop.cancel();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

pub struct Connection {
    pub incoming: mpsc::Receiver<String>,
    pub outgoing: mpsc::Sender<String>,
}

pub async fn read_token_file(path: &Path) -> Result<String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .context("open token file")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = file.metadata().await?;
        ensure!(
            meta.is_file() && meta.mode() & 0o077 == 0,
            "token file must be readable only by its owner"
        );
    }
    use tokio::io::AsyncReadExt;
    let mut value = String::new();
    (&mut file)
        .take(8193)
        .read_to_string(&mut value)
        .await
        .context("read token file")?;
    let value = value.trim();
    ensure!(
        (16..=8192).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_graphic()),
        "invalid bearer token file"
    );
    Ok(value.into())
}

fn framing() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(LIMIT))
        .max_frame_size(Some(LIMIT))
}

fn parse_url(value: &str) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| anyhow!("invalid WebSocket URL"))?;
    ensure!(
        matches!(url.scheme(), "ws" | "wss")
            && url.host().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none(),
        "invalid WebSocket URL"
    );
    Ok(url)
}

async fn addresses(host: &str, port: u16, tls: bool) -> Result<Vec<SocketAddr>> {
    let addresses: Vec<_> = lookup_host((host.trim_matches(['[', ']']), port))
        .await?
        .collect();
    ensure!(!addresses.is_empty(), "WebSocket address did not resolve");
    ensure!(
        tls || addresses.iter().all(|addr| addr.ip().is_loopback()),
        "plain WebSocket requires a loopback address"
    );
    Ok(addresses)
}

pub async fn connect(
    url: &str,
    token_file: &Path,
    protocol: &'static str,
) -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>> {
    let url = parse_url(url)?;
    let token = read_token_file(token_file).await?;
    let mut request = url.as_str().into_client_request()?;
    let mut auth = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| anyhow!("invalid bearer token"))?;
    auth.set_sensitive(true);
    request.headers_mut().insert(header::AUTHORIZATION, auth);
    request.headers_mut().insert(
        header::SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_static(protocol),
    );
    timeout(CONTROL, async {
        let addrs = addresses(
            url.host_str().unwrap(),
            url.port_or_known_default().unwrap(),
            url.scheme() == "wss",
        )
        .await?;
        let tcp = TcpStream::connect(addrs.as_slice()).await?;
        let connector = if url.scheme() == "wss" {
            Some(tokio::task::spawn_blocking(tls_client).await??)
        } else {
            None
        };
        let (socket, reply) = tokio_tungstenite::client_async_tls_with_config(
            request,
            tcp,
            Some(framing()),
            connector,
        )
        .await
        .map_err(|_| anyhow!("WebSocket connection or upgrade failed"))?;
        ensure!(
            reply
                .headers()
                .get(header::SEC_WEBSOCKET_PROTOCOL)
                .is_some_and(|s| s == protocol),
            "server did not select the required WebSocket subprotocol"
        );
        Ok(socket)
    })
    .await
    .context("WebSocket connection timed out")?
}

fn tls_client() -> Result<Connector> {
    let mut roots = RootCertStore::empty();
    let (loaded, _) =
        roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
    ensure!(loaded != 0, "no native root certificates available");
    // Workspace feature unification can enable both ring and aws-lc-rs.
    // Select a provider locally rather than requiring a process-wide default.
    // https://docs.rs/rustls/0.23.46/rustls/struct.ConfigBuilder.html#crypto-provider
    let config = ClientConfig::builder_with_provider(Arc::new(ring::default_provider()))
        .with_safe_default_protocol_versions()?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Connector::Rustls(Arc::new(config)))
}

fn refuse(status: StatusCode) -> ErrorResponse {
    let mut response = ErrorResponse::new(None);
    *response.status_mut() = status;
    response
}

type Tokens<T> = Vec<(sha2::digest::Output<Sha256>, T)>;

#[derive(Debug)]
pub struct InvalidTokenTable;
impl std::fmt::Display for InvalidTokenTable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("invalid WebSocket token table")
    }
}
impl std::error::Error for InvalidTokenTable {}
async fn read_tokens<T>(entries: Vec<(PathBuf, T)>) -> Result<Tokens<T>> {
    ensure!(!entries.is_empty(), "no WebSocket tokens configured");
    let mut tokens = Vec::new();
    for (path, value) in entries {
        let hash = Sha256::digest(read_token_file(&path).await?);
        ensure!(
            !tokens.iter().any(|(other, _)| *other == hash),
            "duplicate WebSocket token"
        );
        tokens.push((hash, value));
    }
    Ok(tokens)
}

fn acceptor(tls: Option<TlsOptions>, client_ca: Option<&Path>) -> Result<Option<TlsAcceptor>> {
    ensure!(
        tls.is_some() || client_ca.is_none(),
        "client authentication requires TLS"
    );
    tls.map(|tls| -> Result<_> {
        let certs = CertificateDer::pem_file_iter(tls.cert_file)?.collect::<Result<Vec<_>, _>>()?;
        let key = PrivateKeyDer::from_pem_file(tls.key_file)?;
        let config = ServerConfig::builder_with_provider(Arc::new(ring::default_provider()))
            .with_safe_default_protocol_versions()?;
        let config = if let Some(ca) = client_ca {
            let mut roots = RootCertStore::empty();
            for cert in CertificateDer::pem_file_iter(ca)? {
                roots.add(cert?)?;
            }
            let verifier =
                tokio_rustls::rustls::server::WebPkiClientVerifier::builder_with_provider(
                    Arc::new(roots),
                    Arc::new(ring::default_provider()),
                )
                .build()?;
            config.with_client_cert_verifier(verifier)
        } else {
            config.with_no_client_auth()
        }
        .with_single_cert(certs, key)?;
        Ok(TlsAcceptor::from(Arc::new(config)))
    })
    .transpose()
}

async fn bind(listen: &str, tls: bool) -> Result<(TcpListener, String)> {
    let (host, port, path) = if listen.contains("://") {
        let url = parse_url(listen)?;
        ensure!(
            (url.scheme() == "wss") == tls,
            "WebSocket listen URL scheme must match TLS configuration"
        );
        ensure!(
            url.query().is_none(),
            "WebSocket listen URL cannot contain a query"
        );
        (
            url.host_str().unwrap().to_owned(),
            url.port_or_known_default().unwrap(),
            url.path().to_owned(),
        )
    } else {
        let (host, port) = listen
            .rsplit_once(':')
            .context("WebSocket listen address must be HOST:PORT")?;
        (host.to_owned(), port.parse()?, "/".into())
    };
    let addrs = addresses(&host, port, tls).await?;
    let listener = TcpListener::bind(addrs.as_slice()).await?;
    let addr = listener.local_addr()?;
    // Retain the configured TLS name for certificate verification, but publish the
    // actual socket for plain listeners (a name can resolve to more than one IP).
    let authority = if tls {
        format!("{host}:{}", addr.port())
    } else {
        addr.to_string()
    };
    let url = format!("{}://{authority}{path}", if tls { "wss" } else { "ws" });
    Ok((listener, url))
}

pub async fn serve<T, F, Fut>(
    listen: &str,
    tls: Option<TlsOptions>,
    protocol: &'static str,
    entries: Vec<(PathBuf, T)>,
    handler: F,
) -> Result<Server>
where
    T: Clone + Send + Sync + 'static,
    F: Fn(T, Connection) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    let tokens = read_tokens(entries).await.context(InvalidTokenTable)?;
    let tls = acceptor(tls, None)?;
    let (listener, url) = bind(listen, tls.is_some()).await?;
    let stop = CancellationToken::new();
    let closing = stop.clone();
    let entries = Arc::new(tokens);
    let handler = Arc::new(handler);
    let task = tokio::spawn(async move {
        let mut clients = JoinSet::new();
        loop {
            tokio::select! {
                biased;
                _ = closing.cancelled() => break,
                _ = clients.join_next(), if !clients.is_empty() => (),
                accepted = listener.accept() => {
                    let Ok((tcp, _)) = accepted else { break };
                    let (entries, tls, closing, handler) = (entries.clone(), tls.clone(), closing.clone(), handler.clone());
                    clients.spawn(async move {
                        if let Some(tls) = tls {
                            let Some(Ok(Ok(io))) = closing.run_until_cancelled(timeout(CONTROL, tls.accept(tcp))).await else { return };
                            accept(io, &entries, protocol, closing, handler).await;
                        } else {
                            accept(tcp, &entries, protocol, closing, handler).await;
                        }
                    });
                }
            }
        }
        drop(listener);
        closing.cancel();
        while clients.join_next().await.is_some() {}
    });
    Ok(Server {
        url,
        stop,
        task: Some(task),
    })
}

async fn accept<T, F, Fut>(
    io: impl AsyncRead + AsyncWrite + Unpin,
    entries: &[(sha2::digest::Output<Sha256>, T)],
    protocol: &'static str,
    stop: CancellationToken,
    handler: Arc<F>,
) where
    T: Clone,
    F: Fn(T, Connection) -> Fut,
    Fut: Future<Output = ()>,
{
    let mut selected = None;
    // Tungstenite's callback signature fixes the HTTP error response type.
    #[allow(clippy::result_large_err)]
    let upgrade = tokio_tungstenite::accept_hdr_async_with_config(
        io,
        |req: &Request, mut reply: Response| {
            let presented = req
                .headers()
                .get(header::AUTHORIZATION)
                .and_then(|v| v.as_bytes().strip_prefix(b"Bearer "));
            let Some(presented) = presented else {
                return Err(refuse(StatusCode::UNAUTHORIZED));
            };
            let digest = Sha256::digest(presented);
            for (expected, value) in entries {
                if bool::from(digest.ct_eq(expected)) {
                    selected = Some(value);
                }
            }
            if selected.is_none() {
                return Err(refuse(StatusCode::UNAUTHORIZED));
            }
            let offered = req
                .headers()
                .get_all(header::SEC_WEBSOCKET_PROTOCOL)
                .iter()
                .filter_map(|v| v.to_str().ok())
                .flat_map(|s| s.split(','));
            if !offered.into_iter().any(|s| s.trim() == protocol) {
                return Err(refuse(StatusCode::BAD_REQUEST));
            }
            reply.headers_mut().insert(
                header::SEC_WEBSOCKET_PROTOCOL,
                HeaderValue::from_static(protocol),
            );
            Ok(reply)
        },
        Some(framing()),
    );
    if let Some(Ok(Ok(socket))) = stop.run_until_cancelled(timeout(CONTROL, upgrade)).await {
        let value = selected.expect("authenticated upgrade").clone();
        run(socket, stop, |conn| handler(value, conn)).await;
    }
}

/// Run the wire in parallel with its binding, delivering EOF on loss or shutdown.
pub async fn run<S, F, Fut>(socket: WebSocketStream<S>, stop: CancellationToken, handler: F)
where
    S: AsyncRead + AsyncWrite + Unpin,
    F: FnOnce(Connection) -> Fut,
    Fut: Future<Output = ()>,
{
    let (tx, incoming) = mpsc::channel(1);
    let (outgoing, mut rx) = mpsc::channel::<String>(1);
    let (mut sink, mut source) = socket.split();
    let (pong, mut flush) = mpsc::channel(1);
    let binding = handler(Connection { incoming, outgoing });
    tokio::pin!(binding);
    let (code, done) = {
        let read = async move {
            while let Some(frame) = source.next().await {
                match frame {
                    Ok(Message::Text(text)) => {
                        if tx.send(text.to_string()).await.is_err() {
                            return None;
                        }
                    }
                    Ok(Message::Binary(_)) => return Some(CloseCode::Unsupported),
                    Ok(Message::Close(_)) => return None,
                    Ok(Message::Ping(_)) => {
                        let _ = pong.try_send(());
                    }
                    Err(Error::Capacity(_)) => return Some(CloseCode::Size),
                    Err(Error::Utf8(_)) => return Some(CloseCode::Invalid),
                    Err(_) => return None,
                    _ => (),
                }
            }
            None
        };
        let write = async {
            loop {
                tokio::select! {
                    Some(()) = flush.recv() => sink.flush().await?,
                    Some(text) = rx.recv() => sink.send(Message::Text(text.into())).await?,
                    else => return Ok::<(), Error>(()),
                }
            }
        };
        tokio::select! {
            biased;
            _ = stop.cancelled() => (Some(CloseCode::Normal), false),
            _ = &mut binding => (Some(CloseCode::Normal), true),
            code = read => (code, false),
            _ = write => (None, false),
        }
    };
    let close = async {
        if done {
            while let Ok(text) = rx.try_recv() {
                sink.send(Message::Text(text.into())).await?;
            }
        }
        drop(rx);
        if let Some(code) = code {
            sink.send(Message::Close(Some(CloseFrame {
                code,
                reason: "".into(),
            })))
            .await?;
        }
        sink.flush().await
    };
    if done {
        let _ = timeout(CONTROL, close).await;
    } else {
        // Keep cleanup independent of a stalled close frame or peer.
        let _ = tokio::join!(binding, timeout(CONTROL, close));
    }
}
