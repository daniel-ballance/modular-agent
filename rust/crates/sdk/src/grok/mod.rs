//! Grok subscription Provider.
pub(crate) mod oauth;

use crate::{
    Code, Error, Result, SubscriptionLogins, SubscriptionModel,
    responses::{ResponsesFormat, ResponsesOptions, ResponsesProvider},
    subscription::{enroll_models, identity, responses_catalog},
};

use std::sync::Arc;

pub struct GrokOptions {
    pub logins: SubscriptionLogins,
    pub client_identity: Option<String>,
    pub models: Vec<SubscriptionModel>,
}
impl GrokOptions {
    pub fn new(logins: SubscriptionLogins) -> Self {
        Self {
            logins,
            client_identity: None,
            models: Vec::new(),
        }
    }
}

pub type GrokProvider = ResponsesProvider;

pub fn grok(options: GrokOptions) -> Result<GrokProvider> {
    let identity = identity(options.client_identity.as_deref(), Code::InvalidComposition)?;
    let mut models = responses_catalog("grok");
    enroll_models(&mut models, options.models, "Grok")?;
    ResponsesProvider::new(
        ResponsesOptions {
            id: "grok",
            label: "Grok subscription",
            endpoint: "https://api.x.ai/v1/responses",
            format: ResponsesFormat::SystemMessage,
            refresh: Arc::new(|client, old| {
                Box::pin(async move { oauth::refresh(&client, old, oauth::XAI_TOKEN).await })
            }),
        },
        models,
        options.logins,
        identity,
    )
    .map_err(|e| Error::new(Code::InvalidComposition, e.to_string()))
}
