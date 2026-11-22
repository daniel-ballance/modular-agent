//! The Grok subscription adapter used by ma. This is not an SDK Provider
//! constructor: the Grok subscription protocol is not yet specified.
pub mod oauth;

use anyhow::Result;
use modular_agent::{
    ClientIdentity, SubscriptionLogins,
    responses::{ResponsesFormat, ResponsesModel, ResponsesOptions, ResponsesProvider},
};
use serde_json::Value;
use std::sync::Arc;

pub const ID: &str = "grok";
pub const LABEL: &str = "Grok subscription";

pub fn provider(
    logins: SubscriptionLogins,
    client_identity: ClientIdentity,
    overrides: Vec<ResponsesModel>,
) -> Result<ResponsesProvider> {
    let models: Vec<ResponsesModel> = serde_json::from_str(include_str!("models.json"))?;
    let provider = ResponsesProvider::new(
        ResponsesOptions {
            id: ID,
            label: LABEL,
            endpoint: "https://api.x.ai/v1/responses",
            format: ResponsesFormat::SystemMessage,
            refresh: Arc::new(|client, old| {
                Box::pin(async move { oauth::refresh(&client, old).await })
            }),
        },
        models,
        logins,
        client_identity,
    )?;
    Ok(provider.with_catalog_overrides(overrides))
}

pub fn model_overrides(catalog: &Value, provider: &str) -> Result<Vec<ResponsesModel>> {
    let models = &catalog[provider];
    if models.is_null() {
        return Ok(vec![]);
    }
    serde_json::from_value(models.clone())
        .map_err(|e| anyhow::anyhow!("models for {provider}: {e}"))
}
