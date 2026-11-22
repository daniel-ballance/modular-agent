//! OAuth form and polling helpers used by subscription sign-ins.
use anyhow::{Result, anyhow, ensure};
use serde_json::{Value, json};
use std::time::Duration;
fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}
pub async fn form(
    client: &reqwest::Client,
    url: &str,
    fields: &[(&str, &str)],
) -> Result<(u16, Value)> {
    let body = fields
        .iter()
        .map(|(k, v)| format!("{}={}", encode(k), encode(v)))
        .collect::<Vec<_>>()
        .join("&");
    let response = client
        .post(url)
        .header("content-type", "application/x-www-form-urlencoded")
        .header("accept", "application/json")
        .body(body)
        .send()
        .await?;
    let status = response.status().as_u16();
    let text = response.text().await?;
    Ok((
        status,
        serde_json::from_str(&text).unwrap_or(json!({"error": text})),
    ))
}
pub fn oauth_error(action: &str, status: u16, body: &Value) -> anyhow::Error {
    let detail = [&body["error"], &body["error_description"]]
        .iter()
        .filter_map(|v| v.as_str())
        .collect::<Vec<_>>()
        .join(": ");
    anyhow!(
        "{action} failed (HTTP {status}){}{detail}",
        if detail.is_empty() { "" } else { ": " }
    )
}
pub async fn poll<F, Fut, T>(mut interval: Duration, limit: Duration, mut attempt: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<Poll<T>>>,
{
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        tokio::time::sleep(interval).await;
        ensure!(
            tokio::time::Instant::now() < deadline,
            "the sign-in was not completed in time"
        );
        match attempt().await? {
            Poll::Done(value) => return Ok(value),
            Poll::Pending => (),
            Poll::Slower => interval += Duration::from_secs(5),
        }
    }
}
pub enum Poll<T> {
    Done(T),
    Pending,
    Slower,
}
