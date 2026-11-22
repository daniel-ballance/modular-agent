//! ChatGPT subscription Provider.
pub(crate) mod oauth;

use crate::{
    Code, Error, Result, SubscriptionLogins, SubscriptionModel,
    responses::{ResponsesFormat, ResponsesOptions, ResponsesProvider},
    subscription::{enroll_models, identity, responses_catalog},
};

use std::sync::Arc;

pub struct ChatGptOptions {
    pub logins: SubscriptionLogins,
    pub client_identity: Option<String>,
    pub models: Vec<SubscriptionModel>,
}
impl ChatGptOptions {
    pub fn new(logins: SubscriptionLogins) -> Self {
        Self {
            logins,
            client_identity: None,
            models: Vec::new(),
        }
    }
}

pub type ChatGptProvider = ResponsesProvider;

pub fn chatgpt(options: ChatGptOptions) -> Result<ChatGptProvider> {
    let identity = identity(options.client_identity.as_deref(), Code::InvalidComposition)?;
    let mut models = responses_catalog("chatgpt");
    enroll_models(&mut models, options.models, "ChatGPT")?;
    ResponsesProvider::new(
        ResponsesOptions {
            id: "chatgpt",
            label: "ChatGPT subscription",
            endpoint: "https://chatgpt.com/backend-api/codex/responses",
            format: ResponsesFormat::ChatGpt,
            refresh: Arc::new(|client, old| {
                Box::pin(async move { oauth::refresh(&client, old, oauth::CODEX_TOKEN).await })
            }),
        },
        models,
        options.logins,
        identity,
    )
    .map_err(|e| Error::new(Code::InvalidComposition, e.to_string()))
}
