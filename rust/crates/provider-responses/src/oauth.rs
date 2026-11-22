//! Grok device sign-in and token refresh, used only by ma.
use crate::{ID, LABEL};
use anyhow::{Result, anyhow, bail, ensure};
use credentials_auth::{Login, now_ms};
use modular_agent::ClientIdentity;
use modular_agent::subscription_oauth::{Poll, form, oauth_error, poll};
use serde_json::Value;
use std::time::Duration;

const XAI_CLIENT: &str = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_SCOPE: &str = "openid profile email offline_access grok-cli:access api:access";
const XAI_DEVICE_CODE: &str = "https://auth.x.ai/oauth2/device/code";
const XAI_TOKEN: &str = "https://auth.x.ai/oauth2/token";

const MARGIN_MS: u64 = 5 * 60 * 1000;
/// The device code to show to the person signing in.
pub struct DeviceCode<'a> {
    pub address: &'a str,
    pub code: &'a str,
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
        expires: (now_ms() + seconds * 1000).saturating_sub(MARGIN_MS),
        account: None,
    })
}

pub async fn refresh(client: &reqwest::Client, old: Login) -> Result<Login> {
    refresh_at(client, old, XAI_TOKEN).await
}

async fn refresh_at(client: &reqwest::Client, old: Login, url: &str) -> Result<Login> {
    let Login::Oauth { refresh, .. } = old else {
        return Ok(old);
    };

    let (status, body) = form(
        client,
        url,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", &refresh),
            ("client_id", XAI_CLIENT),
        ],
    )
    .await
    .map_err(|e| anyhow!("could not reach {} to refresh the sign-in: {e}", LABEL))?;
    if !(200..300).contains(&status) {
        return Err(oauth_error(
            &format!("refreshing the {} sign-in (run `ma login {}`)", LABEL, ID),
            status,
            &body,
        ));
    }
    tokens(&body, Some(&refresh))
}

async fn xai_device(
    client: &reqwest::Client,
    client_identity: &ClientIdentity,
    show: &(dyn Fn(DeviceCode<'_>) + Sync),
    code_url: &str,
    token_url: &str,
) -> Result<Login> {
    let (status, device) = form(
        client,
        code_url,
        &[
            ("client_id", XAI_CLIENT),
            ("scope", XAI_SCOPE),
            ("referrer", client_identity.as_str()),
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
    show(DeviceCode { address, code });
    let interval = Duration::from_secs(device["interval"].as_u64().filter(|n| *n > 0).unwrap_or(5));
    let limit = Duration::from_secs(device["expires_in"].as_u64().unwrap_or(900));
    poll(interval, limit, || async {
        let (status, body) = form(
            client,
            token_url,
            &[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("client_id", XAI_CLIENT),
                ("device_code", &device_code),
            ],
        )
        .await?;
        if (200..300).contains(&status) {
            return Ok(Poll::Done(tokens(&body, None)?));
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

pub async fn login(
    client_identity: &ClientIdentity,
    show: &(dyn Fn(DeviceCode<'_>) + Sync),
) -> Result<Login> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()?;
    xai_device(&client, client_identity, show, XAI_DEVICE_CODE, XAI_TOKEN).await
}

#[cfg(test)]
#[path = "oauth_loopback.rs"]
mod loopback;
