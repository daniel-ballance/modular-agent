//! A stateless Provider for the OpenAI Responses API.
use agent_api as base;
use modular_agent::{ModelError, Piece, ProviderContext, async_trait};
pub use sdk_api_key::ApiKeyProvider;
use sdk_api_key::failure;
use sdk_api_key::{Protocol, StreamDecoder, other};
use serde_json::Value;

/// Use the OpenAI Responses API with `OPENAI_API_KEY` from the default credential store.
pub fn openai() -> ApiKeyProvider {
    ApiKeyProvider::new("openai", "https://api.openai.com/v1/responses", Responses)
}

struct Responses;

impl Protocol for Responses {
    fn encode(&self, request: &base::ModelRequest) -> Result<Value, ModelError> {
        let mut body = provider_openai::request_body(request).map_err(other)?;
        // Use the shared API-key model table instead of the base adapter's defaults.
        body.as_object_mut().unwrap().remove("reasoning");
        Ok(body)
    }

    fn authenticate(&self, request: reqwest::RequestBuilder, key: &str) -> reqwest::RequestBuilder {
        request.bearer_auth(key)
    }

    fn decode(
        &self,
        request: &base::ModelRequest,
        response: Value,
    ) -> Result<base::ModelResponse, ModelError> {
        provider_openai::normalize_for(request, &response).map_err(other)
    }

    fn stream_decoder(&self) -> Box<dyn StreamDecoder> {
        Box::new(Responses)
    }
}

#[async_trait]
impl StreamDecoder for Responses {
    async fn event(
        &mut self,
        event: Value,
        cx: &ProviderContext,
    ) -> Result<Option<Value>, ModelError> {
        match event["type"].as_str() {
            Some("response.output_text.delta") => cx
                .piece(
                    Piece::Text,
                    event["delta"].as_str().unwrap_or_default(),
                    None,
                )
                .await
                .map_err(other)?,
            Some("response.reasoning_summary_text.delta") => cx
                .piece(
                    Piece::Reasoning,
                    event["delta"].as_str().unwrap_or_default(),
                    None,
                )
                .await
                .map_err(other)?,
            Some("response.completed" | "response.incomplete") => {
                return Ok(Some(event["response"].clone()));
            }
            Some("response.failed") => return Err(failure(0, &event["response"]["error"])),
            _ => (),
        }
        Ok(None)
    }
}
