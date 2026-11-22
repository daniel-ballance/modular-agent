//! Grok's existing device flow and Responses configuration for ma.
pub mod oauth;

use anyhow::{Result, anyhow};
use credentials_auth::AuthFile;
pub use modular_agent::{ClientIdentity, responses::ResponsesModel as Model};
use modular_agent::{
    build_chatgpt, chatgpt_catalog,
    responses::{ResponsesFormat, ResponsesOptions, ResponsesProvider},
};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Vendor {
    /// A ChatGPT subscription, through the Codex backend.
    Codex,
    /// A SuperGrok or X Premium subscription, through the xAI API.
    Xai,
}
impl Vendor {
    pub fn id(self) -> &'static str {
        match self {
            Self::Codex => "openai-codex",
            Self::Xai => "xai",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Codex => "ChatGPT subscription",
            Self::Xai => "Grok subscription",
        }
    }
    pub fn parse(id: &str) -> Option<Self> {
        [Self::Codex, Self::Xai].into_iter().find(|v| v.id() == id)
    }
}

pub fn catalog(vendor: Vendor, overrides: &Value) -> Result<Vec<Model>> {
    let mut models = match vendor {
        Vendor::Codex => chatgpt_catalog(),
        Vendor::Xai => {
            let builtin: Value = serde_json::from_str(include_str!("models.json"))?;
            serde_json::from_value(builtin[vendor.id()].clone())?
        }
    };
    if let Some(extra) = overrides.get(vendor.id()).filter(|v| !v.is_null()) {
        for model in serde_json::from_value::<Vec<Model>>(extra.clone())
            .map_err(|e| anyhow!("models for {}: {e}", vendor.id()))?
        {
            models.retain(|m| m.id != model.id);
            models.push(model);
        }
    }
    Ok(models)
}

pub fn provider(
    vendor: Vendor,
    models: Vec<Model>,
    auth: AuthFile,
    client_identity: ClientIdentity,
) -> Result<ResponsesProvider> {
    let logins = auth.subscription_logins();
    if vendor == Vendor::Codex {
        return build_chatgpt(vendor.id(), models, logins, client_identity);
    }
    ResponsesProvider::new(
        ResponsesOptions {
            id: vendor.id(),
            label: vendor.label(),
            endpoint: "https://api.x.ai/v1/responses",
            format: ResponsesFormat::SystemMessage,
            refresh: Box::new(|client, old| {
                Box::pin(async move { oauth::refresh(&client, old).await })
            }),
        },
        models,
        logins,
        client_identity,
    )
}
