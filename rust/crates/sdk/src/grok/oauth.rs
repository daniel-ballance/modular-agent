//! Grok device sign-in and token refresh.
use crate::{
    ClientIdentity, Login, SignInOptions, SignInStep,
    subscription_oauth::{Poll, device_poll, form, sign_in_client, tokens},
};
use anyhow::{Result, anyhow, bail, ensure};

const XAI_CLIENT: &str = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_SCOPE: &str = "openid profile email offline_access grok-cli:access api:access";
const XAI_DEVICE_CODE: &str = "https://auth.x.ai/oauth2/device/code";
pub(super) const XAI_TOKEN: &str = "https://auth.x.ai/oauth2/token";

pub(super) async fn refresh(client: &reqwest::Client, old: Login, url: &str) -> Result<Login> {
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
    .map_err(|_| anyhow!("could not reach Grok to refresh the sign-in"))?;
    if !(200..300).contains(&status) {
        if body["error"] == "invalid_grant" {
            bail!("Grok refused the refresh (invalid_grant); sign in again");
        }
        bail!("Grok could not refresh the sign-in (HTTP {status}); sign in again");
    }
    tokens(&body, Some(&refresh), |_| Ok(None))
}

pub(crate) async fn login(
    client_identity: &ClientIdentity,
    options: SignInOptions<'_>,
) -> Result<Login> {
    let fixture = options.fixture.as_ref();
    let (code_url, token_url) = fixture.map_or((XAI_DEVICE_CODE, XAI_TOKEN), |fixture| {
        (fixture.device_code.as_str(), fixture.device_token.as_str())
    });
    let client = sign_in_client(fixture.is_some())?;
    let (status, device) = form(
        &client,
        code_url,
        &[
            ("client_id", XAI_CLIENT),
            ("scope", XAI_SCOPE),
            ("referrer", client_identity.as_str()),
        ],
    )
    .await?;
    if !(200..300).contains(&status) {
        bail!("starting the Grok sign-in failed (HTTP {status})");
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
        reqwest::Url::parse(address).is_ok_and(|url| url.scheme() == "https"),
        "the Grok sign-in gave an address that is not https"
    );
    let code = field("user_code")?;
    let device_code = field("device_code")?.to_owned();
    options.show(SignInStep::DeviceCode { url: address, code });
    options.show(SignInStep::Waiting);
    let interval = device["interval"].as_u64().filter(|n| *n > 0).unwrap_or(5);
    let limit = device["expires_in"].as_u64().unwrap_or(900);
    device_poll(interval, limit, fixture.is_some(), || async {
        let (status, body) = form(
            &client,
            token_url,
            &[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("client_id", XAI_CLIENT),
                ("device_code", &device_code),
            ],
        )
        .await?;
        if (200..300).contains(&status) {
            return Ok(Poll::Done(tokens(&body, None, |_| Ok(None))?));
        }
        match body["error"].as_str() {
            Some("authorization_pending") => Ok(Poll::Pending),
            Some("slow_down") => Ok(Poll::Slower),
            Some("access_denied" | "authorization_denied") => bail!("the Grok sign-in was denied"),
            Some("expired_token") => bail!("the Grok sign-in code expired"),
            _ => bail!("the Grok sign-in failed (HTTP {status})"),
        }
    })
    .await
}
