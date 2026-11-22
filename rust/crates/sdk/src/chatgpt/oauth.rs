//! ChatGPT's PKCE browser and device flows, with no browser or terminal I/O.
use super::{SignInOptions, SignInStep};
use crate::{
    ClientIdentity, Login, now_ms,
    subscription_oauth::{Poll, form, poll},
};
use anyhow::{Result, anyhow, bail, ensure};
use base64::Engine;
use base64_oauth as base64;
use serde_json::{Value, json};
use sha2::Digest;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const CODEX_CLIENT: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTHORIZE: &str = "https://auth.openai.com/oauth/authorize";
pub(super) const CODEX_TOKEN: &str = "https://auth.openai.com/oauth/token";
const CODEX_REDIRECT: &str = "http://localhost:1455/auth/callback";
const CODEX_DEVICE_CODE: &str = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const CODEX_DEVICE_TOKEN: &str = "https://auth.openai.com/api/accounts/deviceauth/token";
const CODEX_DEVICE_PAGE: &str = "https://auth.openai.com/codex/device";
const CODEX_DEVICE_REDIRECT: &str = "https://auth.openai.com/deviceauth/callback";
const CODEX_SCOPE: &str = "openid profile email offline_access";

/// Refresh this long before the stated expiry, so a token does not die mid-request.
const MARGIN_MS: u64 = 5 * 60 * 1000;
const DEVICE_WAIT: Duration = Duration::from_secs(15 * 60);

fn pasted_code(input: &str, state: &str) -> Result<Option<String>> {
    let input = input.trim();
    if input.is_empty() {
        return Ok(None);
    }
    let query_text = input
        .split_once('?')
        .map(|(_, query)| query.split('#').next().unwrap_or(""));
    let (code, found) = if let Some(params) = query_text.or_else(|| {
        let params = input.strip_prefix('?').unwrap_or(input);
        (query(params, "code").is_some()
            || query(params, "error").is_some()
            || query(params, "state").is_some())
        .then_some(params)
    }) {
        ensure!(
            query(params, "error").is_none(),
            "the sign-in returned an error"
        );
        (query(params, "code"), query(params, "state"))
    } else if let Some((code, found)) = input.split_once('#') {
        (Some(code.to_owned()), Some(found.to_owned()))
    } else {
        (Some(input.to_owned()), None)
    };
    if let Some(found) = found {
        ensure!(
            found == state,
            "that address is from a different sign-in; paste the one from this sign-in"
        );
    }
    let code = code
        .filter(|c| !c.is_empty())
        .ok_or_else(|| anyhow!("no code found in what was pasted"))?;
    Ok(Some(code))
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
pub(crate) fn chatgpt_account(access: &str) -> Result<String> {
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

fn tokens(body: &Value, previous: Option<&str>) -> Result<Login> {
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
            .saturating_sub(MARGIN_MS),
        account: Some(chatgpt_account(access)?),
    })
}

pub(crate) async fn refresh(client: &reqwest::Client, old: Login, url: &str) -> Result<Login> {
    let Login::Oauth { refresh, .. } = old else {
        bail!("ChatGPT needs a subscription sign-in");
    };
    let (status, body) = form(
        client,
        url,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", &refresh),
            ("client_id", CODEX_CLIENT),
        ],
    )
    .await
    .map_err(|_| anyhow!("could not reach ChatGPT to refresh the sign-in"))?;
    if !(200..300).contains(&status) {
        if body["error"] == "invalid_grant" {
            bail!("ChatGPT refused the refresh (invalid_grant); sign in again");
        }
        bail!("ChatGPT could not refresh the sign-in (HTTP {status}); sign in again");
    }
    tokens(&body, Some(&refresh))
}
async fn codex_exchange(
    client: &reqwest::Client,
    code: &str,
    verifier: &str,
    redirect: &str,
    token_url: &str,
) -> Result<Login> {
    let (status, body) = form(
        client,
        token_url,
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
        return Err(anyhow!("ChatGPT sign-in failed (HTTP {status})"));
    }
    tokens(&body, None)
}

async fn codex_device(
    client: &reqwest::Client,
    options: &SignInOptions<'_>,
    code_url: &str,
    poll_url: &str,
    token_url: &str,
) -> Result<Login> {
    let response = client
        .post(code_url)
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
    options.show(SignInStep::DeviceCode {
        url: CODEX_DEVICE_PAGE,
        code: &code,
    });
    options.show(SignInStep::Waiting);
    let (authorization, verifier) = poll(Duration::from_secs(interval), DEVICE_WAIT, || async {
        let response = client
            .post(poll_url)
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
    codex_exchange(
        client,
        &authorization,
        &verifier,
        CODEX_DEVICE_REDIRECT,
        token_url,
    )
    .await
}

/// Wait for the browser to come back to the local address with the code.
async fn callback(listener: tokio::net::TcpListener, state: &str) -> Result<String> {
    loop {
        let (mut stream, _) = listener.accept().await?;
        let mut buffer = Vec::with_capacity(1024);
        while buffer.len() < 8192 && !buffer.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            let mut chunk = [0u8; 1024];
            let read = stream.read(&mut chunk).await.unwrap_or(0);
            if read == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..read]);
        }
        let request = String::from_utf8_lossy(&buffer);
        let target = request.split_whitespace().nth(1).unwrap_or("");
        let (path, params) = target.split_once('?').unwrap_or((target, ""));
        let outcome = if path != "/auth/callback" {
            None
        } else if query(params, "state").as_deref() != Some(state) {
            Some(Err(anyhow!("the sign-in came back with the wrong state")))
        } else if query(params, "error").is_none()
            && let Some(code) = query(params, "code").filter(|code| !code.is_empty())
        {
            Some(Ok(code))
        } else {
            Some(Err(anyhow!(
                "the sign-in was not completed: no code returned"
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
        if let Some(Ok(code)) = outcome {
            return Ok(code);
        }
    }
}

/// The browser sign-in. The browser comes back to `localhost:1455`. If that is
/// this machine, the local listener finishes the sign-in. If not, as over SSH, the
/// person pastes the address the browser shows, even when the page fails to load.
async fn codex_browser(
    client: &reqwest::Client,
    client_identity: &ClientIdentity,
    listener: Option<tokio::net::TcpListener>,
    options: &mut SignInOptions<'_>,
    token_url: &str,
) -> Result<Login> {
    ensure!(
        listener.is_some() || options.paste.is_some(),
        "the browser sign-in needs port 1455 or a terminal to paste into"
    );
    let verifier = random(32)?;
    let challenge = b64(&sha2::Sha256::digest(verifier.as_bytes()));
    let state = random(16)?;
    let address = format!(
        "{CODEX_AUTHORIZE}?response_type=code&client_id={CODEX_CLIENT}&redirect_uri={}&scope={}&code_challenge={challenge}&code_challenge_method=S256&state={state}&id_token_add_organizations=true&codex_cli_simplified_flow=true&originator={}",
        encode(CODEX_REDIRECT),
        encode(CODEX_SCOPE),
        encode(client_identity.as_str())
    );
    options.show(SignInStep::OpenAndPaste { url: &address });
    let has_listener = listener.is_some();
    let wait = async {
        let returned = async {
            match listener {
                Some(listener) => callback(listener, &state).await,
                None => std::future::pending().await,
            }
        };
        tokio::pin!(returned);
        loop {
            let line = async {
                match options.paste.as_mut() {
                    Some(lines) => lines.recv().await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                code = &mut returned => return code,
                line = line => match line {
                    // The terminal closed: only the browser can finish now.
                    None => {
                        options.paste = None;
                        ensure!(has_listener, "the paste input closed before sign-in completed");
                    }
                    Some(line) => match pasted_code(&line, &state) {
                        Ok(Some(code)) => return Ok(code),
                        Ok(None) => (),
                        Err(error) => options.notice(&format!("{error}. Paste it again.")),
                    },
                },
            }
        }
    };
    let code = tokio::time::timeout(DEVICE_WAIT, wait)
        .await
        .map_err(|_| anyhow!("the sign-in was not completed in time"))??;
    codex_exchange(client, &code, &verifier, CODEX_REDIRECT, token_url).await
}

pub(crate) async fn login(
    client_identity: &ClientIdentity,
    mut options: SignInOptions<'_>,
) -> Result<Login> {
    let fixture_listener = options
        .fixture
        .as_mut()
        .and_then(|fixture| fixture.listener.take());
    let (token, device_code, device_token, bind) = options.fixture.as_ref().map_or(
        (
            CODEX_TOKEN,
            CODEX_DEVICE_CODE,
            CODEX_DEVICE_TOKEN,
            ([127, 0, 0, 1], 1455).into(),
        ),
        |fixture| {
            (
                fixture.token.as_str(),
                fixture.device_code.as_str(),
                fixture.device_token.as_str(),
                fixture.bind,
            )
        },
    );
    let token = token.to_owned();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30));
    let client = if options.fixture.is_some() {
        client.no_proxy()
    } else {
        client
    }
    .build()?;
    if options.device {
        return codex_device(&client, &options, device_code, device_token, &token).await;
    }
    let listener = match fixture_listener {
        Some(listener) => Some(listener),
        None => tokio::net::TcpListener::bind(bind).await.ok(),
    };
    if listener.is_none() && options.paste.is_none() {
        options.notice("The sign-in port is in use. Using a device code instead.");
        return codex_device(&client, &options, device_code, device_token, &token).await;
    }
    if listener.is_none() {
        options.notice("The sign-in port is in use. Paste the address the browser comes back to.");
    }
    codex_browser(&client, client_identity, listener, &mut options, &token).await
}
