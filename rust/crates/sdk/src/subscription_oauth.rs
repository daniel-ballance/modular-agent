//! OAuth form and polling helpers used by subscription sign-ins.
use crate::{Login, now_ms};
use anyhow::{Result, anyhow, ensure};
use serde_json::{Value, json};
use std::time::Duration;
pub(crate) fn encode(text: &str) -> String {
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
pub(crate) fn sign_in_client(fixture: bool) -> Result<reqwest::Client> {
    let mut client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30));
    if fixture {
        client = client.no_proxy();
    }
    Ok(client.build()?)
}

pub(crate) fn tokens(
    body: &Value,
    previous: Option<&str>,
    account: impl FnOnce(&str) -> Result<Option<String>>,
) -> Result<Login> {
    let access = body["access_token"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("the sign-in answer has no access token"))?;
    let refresh = body["refresh_token"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or(previous)
        .ok_or_else(|| anyhow!("the sign-in answer has no refresh token"))?;
    let seconds = body["expires_in"].as_u64().unwrap_or(3600);
    Ok(Login::Oauth {
        access: access.into(),
        refresh: refresh.into(),
        expires: now_ms()
            .saturating_add(seconds.saturating_mul(1000))
            .saturating_sub(5 * 60 * 1000),
        account: account(access)?,
    })
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
pub async fn poll<F, Fut, T>(interval: Duration, limit: Duration, attempt: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<Poll<T>>>,
{
    poll_for(interval, limit, Duration::from_secs(5), attempt).await
}

pub(crate) async fn device_poll<F, Fut, T>(
    interval: u64,
    limit: u64,
    fixture: bool,
    attempt: F,
) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<Poll<T>>>,
{
    // Scale loopback sign-ins so protocol checks need no seconds-long waits.
    let unit = if fixture {
        Duration::from_millis(10)
    } else {
        Duration::from_secs(1)
    };
    let duration = |seconds: u64| unit.saturating_mul(seconds.min(u32::MAX.into()) as u32);
    if fixture {
        poll_for(duration(interval), duration(limit), duration(5), attempt).await
    } else {
        poll(duration(interval), duration(limit), attempt).await
    }
}

async fn poll_for<F, Fut, T>(
    mut interval: Duration,
    limit: Duration,
    slowdown: Duration,
    mut attempt: F,
) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<Poll<T>>>,
{
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        tokio::time::sleep_until(deadline.min(tokio::time::Instant::now() + interval)).await;
        ensure!(
            tokio::time::Instant::now() < deadline,
            "the sign-in was not completed in time"
        );
        match attempt().await? {
            Poll::Done(value) => return Ok(value),
            Poll::Pending => (),
            Poll::Slower => interval += slowdown,
        }
    }
}
pub enum Poll<T> {
    Done(T),
    Pending,
    Slower,
}
