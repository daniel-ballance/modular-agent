//! Disposable files and a scripted HTTP server for subscription checks.
use modular_agent::SignInTestEndpoints;
use std::{io::Write, os::unix::fs::OpenOptionsExt, path::Path};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

pub struct Request {
    pub target: String,
    pub head: String,
    pub body: String,
}
impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.head
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find_map(|(k, v)| k.eq_ignore_ascii_case(name).then_some(v.trim()))
    }
}
pub struct Http {
    base: String,
    pub done: tokio::task::JoinHandle<Vec<Request>>,
}
impl Http {
    pub async fn start(replies: Vec<(&'static str, u16, String)>) -> Self {
        Self::start_observing(replies, |_| {}).await
    }

    pub async fn start_observing(
        replies: Vec<(&'static str, u16, String)>,
        mut observe: impl FnMut(&Request) + Send + 'static,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let done = tokio::spawn(async move {
            let mut seen = vec![];
            for (path, status, body) in replies {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buf = vec![];
                let start = loop {
                    let n = stream.read_buf(&mut buf).await.unwrap();
                    assert_ne!(n, 0);
                    if let Some(at) = buf.windows(4).position(|b| b == b"\r\n\r\n") {
                        break at + 4;
                    }
                };
                let head = String::from_utf8(buf[..start].to_vec()).unwrap();
                assert_eq!(head.split_whitespace().next(), Some("POST"));
                let target = head.split_whitespace().nth(1).unwrap().to_owned();
                assert_eq!(target, path);
                let mut request = Request {
                    target,
                    head,
                    body: String::new(),
                };
                let length = request
                    .header("content-length")
                    .unwrap()
                    .parse::<usize>()
                    .unwrap();
                while buf.len() < start + length {
                    assert_ne!(stream.read_buf(&mut buf).await.unwrap(), 0);
                }
                request.body = String::from_utf8(buf[start..start + length].to_vec()).unwrap();
                observe(&request);
                seen.push(request);
                let kind = if path == "/responses" {
                    "text/event-stream"
                } else {
                    "application/json"
                };
                stream.write_all(format!("HTTP/1.1 {status} Fixture\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
            seen
        });
        Self { base, done }
    }
    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }
    pub fn sign_in(&self, bind: std::net::SocketAddr) -> SignInTestEndpoints {
        SignInTestEndpoints::new(
            &self.url("/token"),
            &self.url("/code"),
            &self.url("/poll"),
            bind,
        )
        .unwrap()
    }
}

pub fn form(body: &str) -> std::collections::BTreeMap<String, String> {
    reqwest::Url::parse(&format!("http://localhost/?{body}"))
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect()
}
pub fn private_file(path: &Path, value: &[u8]) {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap()
        .write_all(value)
        .unwrap();
}
