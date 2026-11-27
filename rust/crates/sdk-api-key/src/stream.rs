//! HTTP server-sent event framing, independent of the vendor's event format.
use crate::{StreamDecoder, failure, other};
use futures_util::StreamExt;
use modular_agent::{ModelError, ModelErrorKind as Kind, ProviderContext};
use serde_json::Value;

pub(crate) async fn read(
    response: reqwest::Response,
    decoder: &mut dyn StreamDecoder,
    cx: &ProviderContext,
) -> std::result::Result<Value, ModelError> {
    let mut bytes = response.bytes_stream();
    let mut buffer = Vec::new();
    let mut data = String::new();
    while let Some(chunk) = bytes.next().await {
        buffer.extend(chunk.map_err(|_| ModelError::new(Kind::Temporary, "model stream lost"))?);
        if buffer.len() + data.len() > 16 * 1024 * 1024 {
            return Err(other("model stream event is too large"));
        }
        let mut consumed = 0;
        while let Some(end) = buffer[consumed..].iter().position(|b| *b == b'\n') {
            let end = consumed + end;
            let line = std::str::from_utf8(&buffer[consumed..end])
                .map_err(other)?
                .trim_end_matches('\r');
            consumed = end + 1;
            if let Some(p) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(p.trim_start());
            } else if line.is_empty() && !data.is_empty() {
                if data == "[DONE]" {
                    data.clear();
                    continue;
                }
                let e: Value = serde_json::from_str(&data).map_err(other)?;
                data.clear();
                if e["type"] == "error" {
                    return Err(failure(0, &e["error"]));
                }
                if let Some(reply) = decoder.event(e, cx).await? {
                    return Ok(reply);
                }
            }
        }
        buffer.drain(..consumed);
    }
    Err(ModelError::new(
        Kind::Temporary,
        "model stream ended without a response",
    ))
}
