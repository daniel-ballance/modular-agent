//! Shared subscription catalog and sign-in API.
use crate::{
    ClientIdentity, Code, Error, Result, SubscriptionLogins,
    responses::{ResponsesModel, validate_loopback},
};
use serde_json::{Value, json};
use std::{net::SocketAddr, sync::OnceLock};

pub(crate) fn subscription_models() -> &'static [Value] {
    static TABLE: OnceLock<Vec<Value>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let table: Value = serde_json::from_str(include_str!("subscription-models.json"))
            .expect("valid subscription model table");
        table["models"].as_array().expect("model array").clone()
    })
}

/// An exact model id with limits and input types, but no reasoning controls.
#[derive(Clone, Debug)]
pub struct SubscriptionModel {
    pub id: String,
    pub context_window: u64,
    pub max_output: u64,
    pub input: Vec<String>,
}

pub(crate) fn enroll_models(
    models: &mut Vec<ResponsesModel>,
    enrollments: Vec<SubscriptionModel>,
    provider: &str,
) -> Result<()> {
    for model in enrollments {
        if model.id.is_empty()
            || model.context_window == 0
            || model.max_output == 0
            || model.input.is_empty()
        {
            return Err(Error::new(
                Code::InvalidComposition,
                format!("invalid enrolled {provider} model"),
            ));
        }
        if let Some(listed) = models.iter_mut().find(|listed| listed.id == model.id) {
            listed.context_window = model.context_window;
            listed.max_tokens = model.max_output;
        } else {
            models.push(ResponsesModel {
                name: model.id.clone(),
                id: model.id,
                context_window: model.context_window,
                max_tokens: model.max_output,
                effort: Default::default(),
                extra: [
                    ("input".into(), json!(model.input)),
                    ("reasoning".into(), json!(false)),
                ]
                .into_iter()
                .collect(),
            });
        }
    }
    Ok(())
}

pub(crate) fn responses_catalog(provider: &str) -> Vec<ResponsesModel> {
    subscription_models()
        .iter()
        .filter(|model| model["provider"] == provider)
        .map(|model| {
            let levels = model["levels"].as_object().expect("Responses level map");
            ResponsesModel {
                id: model["id"].as_str().expect("Responses model id").into(),
                name: model["name"].as_str().expect("Responses model name").into(),
                context_window: model["contextWindow"]
                    .as_u64()
                    .expect("Responses context window"),
                max_tokens: model["maxOutput"].as_u64().expect("Responses output limit"),
                effort: levels
                    .iter()
                    .map(|(level, fields)| {
                        (
                            level.clone(),
                            fields["reasoning"]["effort"]
                                .as_str()
                                .expect("Responses effort")
                                .into(),
                        )
                    })
                    .collect(),
                extra: [
                    ("name".into(), model["name"].clone()),
                    ("input".into(), model["input"].clone()),
                    ("reasoning".into(), model["reasoning"].clone()),
                ]
                .into_iter()
                .collect(),
            }
        })
        .collect()
}

/// What a sign-in asks the caller to show. The SDK never opens a browser.
#[derive(Debug)]
pub enum SignInStep<'a> {
    OpenAndPaste { url: &'a str },
    DeviceCode { url: &'a str, code: &'a str },
    Waiting,
}

#[derive(Default)]
pub struct SignInOptions<'a> {
    pub device: bool,
    pub client_identity: Option<String>,
    /// A source of pasted lines. The callback and this channel may be used together.
    pub paste: Option<tokio::sync::mpsc::UnboundedReceiver<String>>,
    pub on_step: Option<&'a (dyn Fn(SignInStep<'_>) + Sync)>,
    /// Reports a rejected paste or an occupied redirect port.
    pub on_notice: Option<&'a (dyn Fn(&str) + Sync)>,
    #[doc(hidden)]
    pub fixture: Option<SignInTestEndpoints>,
}
impl SignInOptions<'_> {
    pub(crate) fn show(&self, step: SignInStep<'_>) {
        if let Some(show) = self.on_step {
            show(step);
        }
    }
    pub(crate) fn notice(&self, message: &str) {
        if let Some(notice) = self.on_notice {
            notice(message);
        }
    }
}

/// Offline fixture endpoints. Every address must be loopback.
#[doc(hidden)]
pub struct SignInTestEndpoints {
    pub(crate) token: String,
    pub(crate) device_code: String,
    pub(crate) device_token: String,
    pub(crate) bind: SocketAddr,
    pub(crate) listener: Option<tokio::net::TcpListener>,
}
impl SignInTestEndpoints {
    pub fn new(
        token: &str,
        device_code: &str,
        device_token: &str,
        bind: SocketAddr,
    ) -> Result<Self> {
        for endpoint in [token, device_code, device_token] {
            validate_loopback(endpoint).map_err(invalid_params)?;
        }
        if !bind.ip().is_loopback() {
            return Err(Error::new(
                Code::InvalidParams,
                "test redirect must be loopback",
            ));
        }
        Ok(Self {
            token: token.into(),
            device_code: device_code.into(),
            device_token: device_token.into(),
            bind,
            listener: None,
        })
    }
    /// Supply a bound loopback listener, avoiding a race on port allocation.
    pub fn with_listener(mut self, listener: tokio::net::TcpListener) -> Result<Self> {
        if !listener.local_addr()?.ip().is_loopback() {
            return Err(Error::new(
                Code::InvalidParams,
                "test redirect must be loopback",
            ));
        }
        self.listener = Some(listener);
        Ok(self)
    }
}

pub(crate) fn invalid_params(e: anyhow::Error) -> Error {
    Error::new(Code::InvalidParams, e.to_string())
}

pub(crate) fn identity(label: Option<&str>, code: Code) -> Result<ClientIdentity> {
    label.map_or_else(
        || Ok(ClientIdentity::default()),
        |label| {
            label
                .parse()
                .map_err(|e: anyhow::Error| Error::new(code, e.to_string()))
        },
    )
}

/// Perform a subscription sign-in and save the resulting login.
pub async fn sign_in(
    provider: &str,
    logins: &SubscriptionLogins,
    options: SignInOptions<'_>,
) -> Result<()> {
    let provider = checked_provider(provider)?;
    let identity = identity(options.client_identity.as_deref(), Code::InvalidParams)?;
    let login = match provider {
        "chatgpt" => crate::chatgpt::oauth::login(&identity, options).await?,
        "grok" => crate::grok::oauth::login(&identity, options).await?,
        _ => unreachable!("checked subscription id"),
    };
    let logins = logins.clone();
    tokio::task::spawn_blocking(move || logins.set_login(provider, Some(login)))
        .await
        .map_err(|e| Error::msg(e.to_string()))??;
    Ok(())
}

/// Remove a subscription sign-in without contacting the service.
pub async fn sign_out(provider: &str, logins: &SubscriptionLogins) -> Result<()> {
    let provider = checked_provider(provider)?;
    let logins = logins.clone();
    tokio::task::spawn_blocking(move || logins.set_login(provider, None))
        .await
        .map_err(|e| Error::msg(e.to_string()))??;
    Ok(())
}

fn checked_provider(provider: &str) -> Result<&'static str> {
    match provider {
        "chatgpt" => Ok("chatgpt"),
        "grok" => Ok("grok"),
        _ => Err(Error::new(
            Code::InvalidParams,
            "only chatgpt and grok support SDK sign-in and sign-out",
        )),
    }
}

#[cfg(test)]
#[test]
fn shipped_subscription_models_are_byte_identical() {
    assert_eq!(
        include_bytes!("subscription-models.json"),
        include_bytes!("../../../../docs/sdk/subscription-models.json")
    );
}
