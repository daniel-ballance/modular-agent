//! Sign-in and token refresh for the two subscriptions. The flows, client ids
//! and endpoints are the ones Pi uses (pi-ai 1.5.2, `auth/oauth/openai-codex`
//! and `auth/oauth/xai`).
use crate::Vendor;
use agent_api::*;
use base64::Engine;
use credentials_auth::{Login, now_ms};
use sha2::Digest;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const CODEX_CLIENT: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTHORIZE: &str = "https://auth.openai.com/oauth/authorize";
const CODEX_TOKEN: &str = "https://auth.openai.com/oauth/token";
const CODEX_REDIRECT: &str = "http://localhost:1455/auth/callback";
const CODEX_DEVICE_CODE: &str = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const CODEX_DEVICE_TOKEN: &str = "https://auth.openai.com/api/accounts/deviceauth/token";
const CODEX_DEVICE_PAGE: &str = "https://auth.openai.com/codex/device";
const CODEX_DEVICE_REDIRECT: &str = "https://auth.openai.com/deviceauth/callback";
const CODEX_SCOPE: &str = "openid profile email offline_access";

const XAI_CLIENT: &str = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_SCOPE: &str = "openid profile email offline_access grok-cli:access api:access";
const XAI_DEVICE_CODE: &str = "https://auth.x.ai/oauth2/device/code";
const XAI_TOKEN: &str = "https://auth.x.ai/oauth2/token";

/// Refresh this long before the stated expiry, so a token does not die mid-request.
const MARGIN_MS: u64 = 5 * 60 * 1000;
const DEVICE_WAIT: Duration = Duration::from_secs(15 * 60);

/// What a sign-in asks of the person. The caller shows it.
pub enum Step<'a> {
    /// Open this address in a browser.
    Open(&'a str),
    /// Open the address and enter the code.
    Code {
        address: &'a str,
        code: &'a str,
    },
    Note(&'a str),
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}
fn random(bytes: usize) -> Result<String> {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).map_err(|e| anyhow!("no random source: {e}"))?;
    Ok(b64(&buffer))
}
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
fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = vec![];
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'%' => match text
                .get(at + 1..at + 3)
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
            {
                Some(byte) => {
                    out.push(byte);
                    at += 3;
                }
                None => {
                    out.push(b'%');
                    at += 1;
                }
            },
            b'+' => {
                out.push(b' ');
                at += 1;
            }
            byte => {
                out.push(byte);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}
fn query(text: &str, name: &str) -> Option<String> {
    text.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == name).then(|| decode(value))
    })
}

/// The ChatGPT account a token belongs to, from the token's own claims.
pub fn chatgpt_account(access: &str) -> Result<String> {
    let payload = access
        .split('.')
        .nth(1)
        .ok_or_else(|| anyhow!("the ChatGPT token is not in the expected form"))?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .map_err(|_| anyhow!("the ChatGPT token is not in the expected form"))?;
    let claims: Value = serde_json::from_slice(&bytes)?;
    claims["https://api.openai.com/auth"]["chatgpt_account_id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("the ChatGPT token names no account; sign in again"))
}

async fn form(
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
fn oauth_error(action: &str, status: u16, body: &Value) -> anyhow::Error {
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
/// A token set from a token endpoint's answer. A vendor that does not rotate
/// the refresh token may leave it out; the old one stays.
fn tokens(vendor: Vendor, body: &Value, previous: Option<&str>) -> Result<Login> {
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
        expires: (now_ms() + seconds * 1000).saturating_sub(MARGIN_MS),
        account: match vendor {
            Vendor::Codex => Some(chatgpt_account(access)?),
            Vendor::Xai => None,
        },
    })
}

pub async fn refresh(client: &reqwest::Client, vendor: Vendor, old: Login) -> Result<Login> {
    let Login::Oauth { refresh, .. } = old else {
        return Ok(old);
    };
    let (url, id) = match vendor {
        Vendor::Codex => (CODEX_TOKEN, CODEX_CLIENT),
        Vendor::Xai => (XAI_TOKEN, XAI_CLIENT),
    };
    let (status, body) = form(
        client,
        url,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", &refresh),
            ("client_id", id),
        ],
    )
    .await
    .map_err(|e| {
        anyhow!(
            "could not reach {} to refresh the sign-in: {e}",
            vendor.label()
        )
    })?;
    if !(200..300).contains(&status) {
        return Err(oauth_error(
            &format!(
                "refreshing the {} sign-in (run `ma login {}`)",
                vendor.label(),
                vendor.id()
            ),
            status,
            &body,
        ));
    }
    tokens(vendor, &body, Some(&refresh))
}

async fn poll<F, Fut, T>(mut interval: Duration, limit: Duration, mut attempt: F) -> Result<T>
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
enum Poll<T> {
    Done(T),
    Pending,
    Slower,
}

async fn xai_device(client: &reqwest::Client, show: &(dyn Fn(Step<'_>) + Sync)) -> Result<Login> {
    let (status, device) = form(
        client,
        XAI_DEVICE_CODE,
        &[
            ("client_id", XAI_CLIENT),
            ("scope", XAI_SCOPE),
            ("referrer", "pi"),
        ],
    )
    .await?;
    if !(200..300).contains(&status) {
        return Err(oauth_error("starting the Grok sign-in", status, &device));
    }
    let field = |name: &str| {
        device[name]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow!("the Grok sign-in answer has no {name}"))
    };
    let address = device["verification_uri_complete"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map_or_else(|| field("verification_uri"), Ok)?;
    // The address is opened in a browser: accept nothing but https.
    ensure!(
        address.starts_with("https://"),
        "the Grok sign-in gave an address that is not https"
    );
    let code = field("user_code")?;
    let device_code = field("device_code")?.to_owned();
    show(Step::Code { address, code });
    let interval = Duration::from_secs(device["interval"].as_u64().filter(|n| *n > 0).unwrap_or(5));
    let limit = Duration::from_secs(device["expires_in"].as_u64().unwrap_or(900));
    poll(interval, limit, || async {
        let (status, body) = form(
            client,
            XAI_TOKEN,
            &[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("client_id", XAI_CLIENT),
                ("device_code", &device_code),
            ],
        )
        .await?;
        if (200..300).contains(&status) {
            return Ok(Poll::Done(tokens(Vendor::Xai, &body, None)?));
        }
        match body["error"].as_str() {
            Some("authorization_pending") => Ok(Poll::Pending),
            Some("slow_down") => Ok(Poll::Slower),
            Some("access_denied" | "authorization_denied") => bail!("the Grok sign-in was denied"),
            Some("expired_token") => bail!("the Grok sign-in code expired"),
            _ => Err(oauth_error("the Grok sign-in", status, &body)),
        }
    })
    .await
}

async fn codex_exchange(
    client: &reqwest::Client,
    code: &str,
    verifier: &str,
    redirect: &str,
) -> Result<Login> {
    let (status, body) = form(
        client,
        CODEX_TOKEN,
        &[
            ("grant_type", "authorization_code"),
            ("client_id", CODEX_CLIENT),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", redirect),
        ],
    )
    .await?;
    if !(200..300).contains(&status) {
        return Err(oauth_error("the ChatGPT sign-in", status, &body));
    }
    tokens(Vendor::Codex, &body, None)
}

async fn codex_device(client: &reqwest::Client, show: &(dyn Fn(Step<'_>) + Sync)) -> Result<Login> {
    let response = client
        .post(CODEX_DEVICE_CODE)
        .json(&json!({"client_id": CODEX_CLIENT}))
        .send()
        .await?;
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    ensure!(
        (200..300).contains(&status),
        "ChatGPT device sign-in is not available (HTTP {status}); use the browser sign-in"
    );
    let device = body["device_auth_id"]
        .as_str()
        .ok_or_else(|| anyhow!("the ChatGPT sign-in answer has no device id"))?
        .to_owned();
    let code = body["user_code"]
        .as_str()
        .ok_or_else(|| anyhow!("the ChatGPT sign-in answer has no code"))?
        .to_owned();
    let interval = body["interval"]
        .as_u64()
        .or_else(|| {
            body["interval"]
                .as_str()
                .and_then(|s| s.trim().parse().ok())
        })
        .unwrap_or(5)
        .max(1);
    show(Step::Code {
        address: CODEX_DEVICE_PAGE,
        code: &code,
    });
    let (authorization, verifier) = poll(Duration::from_secs(interval), DEVICE_WAIT, || async {
        let response = client
            .post(CODEX_DEVICE_TOKEN)
            .json(&json!({"device_auth_id": device, "user_code": code}))
            .send()
            .await?;
        let status = response.status().as_u16();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if (200..300).contains(&status) {
            return match (
                body["authorization_code"].as_str(),
                body["code_verifier"].as_str(),
            ) {
                (Some(code), Some(verifier)) => {
                    Ok(Poll::Done((code.to_owned(), verifier.to_owned())))
                }
                _ => bail!("the ChatGPT sign-in answer is incomplete"),
            };
        }
        let error = body["error"]["code"].as_str().or(body["error"].as_str());
        match (status, error) {
            (403 | 404, _) | (_, Some("deviceauth_authorization_pending")) => Ok(Poll::Pending),
            (_, Some("slow_down")) => Ok(Poll::Slower),
            _ => bail!("the ChatGPT sign-in failed (HTTP {status})"),
        }
    })
    .await?;
    codex_exchange(client, &authorization, &verifier, CODEX_DEVICE_REDIRECT).await
}

/// Wait for the browser to come back to the local address with the code.
async fn callback(listener: tokio::net::TcpListener, state: &str) -> Result<String> {
    loop {
        let (mut stream, _) = listener.accept().await?;
        let mut buffer = vec![0u8; 8192];
        let read = stream.read(&mut buffer).await.unwrap_or(0);
        let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
        let target = request.split_whitespace().nth(1).unwrap_or("");
        let (path, params) = target.split_once('?').unwrap_or((target, ""));
        let outcome = if path != "/auth/callback" {
            None
        } else if query(params, "state").as_deref() != Some(state) {
            Some(Err(anyhow!("the sign-in came back with the wrong state")))
        } else if let Some(code) = query(params, "code") {
            Some(Ok(code))
        } else {
            Some(Err(anyhow!(
                "the sign-in was not completed: {}",
                query(params, "error_description")
                    .or_else(|| query(params, "error"))
                    .unwrap_or_else(|| "no code returned".into())
            )))
        };
        let (status, text) = match &outcome {
            Some(Ok(_)) => (
                "200 OK",
                "Signed in. You can close this tab and return to the terminal.",
            ),
            Some(Err(_)) => (
                "400 Bad Request",
                "The sign-in did not complete. Return to the terminal.",
            ),
            None => ("404 Not Found", "Not found."),
        };
        let _ = stream
            .write_all(
                format!(
                    "HTTP/1.1 {status}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
                    text.len()
                )
                .as_bytes(),
            )
            .await;
        let _ = stream.shutdown().await;
        if let Some(outcome) = outcome {
            return outcome;
        }
    }
}

async fn codex_browser(
    client: &reqwest::Client,
    listener: tokio::net::TcpListener,
    show: &(dyn Fn(Step<'_>) + Sync),
) -> Result<Login> {
    let verifier = random(32)?;
    let challenge = b64(&sha2::Sha256::digest(verifier.as_bytes()));
    let state = random(16)?;
    let address = format!(
        "{CODEX_AUTHORIZE}?response_type=code&client_id={CODEX_CLIENT}&redirect_uri={}&scope={}&code_challenge={challenge}&code_challenge_method=S256&state={state}&id_token_add_organizations=true&codex_cli_simplified_flow=true&originator=pi",
        encode(CODEX_REDIRECT),
        encode(CODEX_SCOPE)
    );
    show(Step::Open(&address));
    let code = tokio::time::timeout(DEVICE_WAIT, callback(listener, &state))
        .await
        .map_err(|_| anyhow!("the sign-in was not completed in time"))??;
    codex_exchange(client, &code, &verifier, CODEX_REDIRECT).await
}

/// Sign in to a subscription. `device` asks for a code typed on another
/// machine instead of a browser on this one.
pub async fn login(
    vendor: Vendor,
    device: bool,
    show: &(dyn Fn(Step<'_>) + Sync),
) -> Result<Login> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()?;
    match vendor {
        Vendor::Xai => xai_device(&client, show).await,
        Vendor::Codex if device => codex_device(&client, show).await,
        Vendor::Codex => match tokio::net::TcpListener::bind(("127.0.0.1", 1455)).await {
            Ok(listener) => codex_browser(&client, listener, show).await,
            Err(_) => {
                show(Step::Note(
                    "Port 1455 is in use, so the browser sign-in cannot return here. Using a code instead.",
                ));
                codex_device(&client, show).await
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_values_are_decoded() {
        assert_eq!(
            query("code=a%2Fb+c&state=xyz", "code").as_deref(),
            Some("a/b c")
        );
        assert_eq!(query("code=a&state=xyz", "state").as_deref(), Some("xyz"));
        assert_eq!(query("code=100%", "code").as_deref(), Some("100%"));
        assert_eq!(query("state=xyz", "code"), None);
        assert_eq!(
            encode("http://localhost:1455/a b"),
            "http%3A%2F%2Flocalhost%3A1455%2Fa%20b"
        );
    }

    #[test]
    fn the_account_comes_from_the_token_claims() {
        let claims = b64(br#"{"https://api.openai.com/auth":{"chatgpt_account_id":"acct-7"}}"#);
        assert_eq!(chatgpt_account(&format!("h.{claims}.s")).unwrap(), "acct-7");
        assert!(chatgpt_account("not-a-token").is_err());
        let body = json!({"access_token": format!("h.{claims}.s"), "expires_in": 3600});
        let Login::Oauth {
            refresh,
            account,
            expires,
            ..
        } = tokens(Vendor::Codex, &body, Some("kept")).unwrap()
        else {
            unreachable!()
        };
        assert_eq!(
            (refresh.as_str(), account.as_deref()),
            ("kept", Some("acct-7"))
        );
        assert!(expires > now_ms() && expires < now_ms() + 3_600_000);
        assert!(tokens(Vendor::Xai, &json!({"access_token":"a"}), None).is_err());
    }

    #[tokio::test]
    async fn the_callback_takes_only_the_matching_state() {
        async fn visit(port: u16, target: &str) -> String {
            let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap();
            stream
                .write_all(format!("GET {target} HTTP/1.1\r\nhost: localhost\r\n\r\n").as_bytes())
                .await
                .unwrap();
            let mut text = String::new();
            stream.read_to_string(&mut text).await.unwrap();
            text
        }
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let waiting = tokio::spawn(async move { callback(listener, "good").await });
        assert!(
            visit(port, "/favicon.ico")
                .await
                .starts_with("HTTP/1.1 404")
        );
        assert!(
            visit(port, "/auth/callback?code=c1&state=good")
                .await
                .starts_with("HTTP/1.1 200")
        );
        assert_eq!(waiting.await.unwrap().unwrap(), "c1");
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let waiting = tokio::spawn(async move { callback(listener, "good").await });
        assert!(
            visit(port, "/auth/callback?code=c1&state=bad")
                .await
                .starts_with("HTTP/1.1 400")
        );
        assert!(waiting.await.unwrap().is_err());
    }
}
