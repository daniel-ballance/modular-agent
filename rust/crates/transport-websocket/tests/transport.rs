use futures_util::{SinkExt, StreamExt};
use std::path::PathBuf;
use tempfile::TempDir;
use tokio::{io::AsyncWriteExt, net::TcpStream};
use tokio_rustls::rustls::{self, ClientConfig, RootCertStore};
use tokio_tungstenite::{
    Connector, client_async_tls_with_config,
    tungstenite::{
        Message, client::IntoClientRequest, http::header, protocol::frame::coding::CloseCode,
    },
};
use transport_websocket::{Connection, LIMIT, PLUGIN, TlsOptions, connect, serve};

const TOKEN: &str = "c4f048f99ca343908a0e2a28875f8e38";

fn token(dir: &TempDir) -> PathBuf {
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let path = dir.path().join("token");
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    writeln!(options.open(&path).unwrap(), "{TOKEN}").unwrap();
    path
}

async fn echo(_: (), mut connection: Connection) {
    while let Some(text) = connection.incoming.recv().await {
        if connection.outgoing.send(text).await.is_err() {
            break;
        }
    }
}

#[tokio::test]
async fn loopback_message_cap_and_close() {
    let dir = tempfile::tempdir().unwrap();
    let path = token(&dir);
    assert!(
        serve("0.0.0.0:0", None, PLUGIN, vec![(path.clone(), ())], echo)
            .await
            .is_err()
    );
    let server = serve("127.0.0.1:0", None, PLUGIN, vec![(path.clone(), ())], echo)
        .await
        .unwrap();
    let mut client = connect(&server.url, &path, PLUGIN).await.unwrap();
    // A masked text frame announces its length before the payload arrives.
    let mut header = vec![0x81, 0xff];
    header.extend_from_slice(&((LIMIT + 1) as u64).to_be_bytes());
    header.extend_from_slice(&[0; 4]);
    client.get_mut().write_all(&header).await.unwrap();
    assert!(
        matches!(client.next().await, Some(Ok(Message::Close(Some(c)))) if c.code == CloseCode::Size)
    );
    let mut client = connect(&server.url, &path, PLUGIN).await.unwrap();
    server.close().await;
    assert!(
        matches!(client.next().await, Some(Ok(Message::Close(Some(c)))) if c.code == CloseCode::Normal)
    );
}

#[tokio::test]
async fn tls_requires_a_trusted_certificate() {
    let dir = tempfile::tempdir().unwrap();
    let path = token(&dir);
    let rcgen::CertifiedKey { cert, signing_key } =
        rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let cert_file = dir.path().join("cert.pem");
    let key_file = dir.path().join("key.pem");
    std::fs::write(&cert_file, cert.pem()).unwrap();
    std::fs::write(&key_file, signing_key.serialize_pem()).unwrap();
    let server = serve(
        "localhost:0",
        Some(TlsOptions {
            cert_file,
            key_file,
        }),
        PLUGIN,
        vec![(path.clone(), ())],
        echo,
    )
    .await
    .unwrap();
    assert!(server.url.starts_with("wss://localhost:"));
    assert!(connect(&server.url, &path, PLUGIN).await.is_err());
    let mut roots = RootCertStore::empty();
    roots.add(cert.der().clone()).unwrap();
    let tls = ClientConfig::builder_with_provider(rustls::crypto::ring::default_provider().into())
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let parsed = url::Url::parse(&server.url).unwrap();
    let tcp = TcpStream::connect(("localhost", parsed.port().unwrap()))
        .await
        .unwrap();
    let mut request = server.url.as_str().into_client_request().unwrap();
    request.headers_mut().insert(
        header::AUTHORIZATION,
        format!("Bearer {TOKEN}").parse().unwrap(),
    );
    request
        .headers_mut()
        .insert(header::SEC_WEBSOCKET_PROTOCOL, PLUGIN.parse().unwrap());
    let (mut client, _) =
        client_async_tls_with_config(request, tcp, None, Some(Connector::Rustls(tls.into())))
            .await
            .unwrap();
    client.send(Message::Text("{}".into())).await.unwrap();
    assert_eq!(
        client.next().await.unwrap().unwrap(),
        Message::Text("{}".into())
    );
    server.close().await;
}
