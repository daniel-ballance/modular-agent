use agent_api::*;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
pub struct LiteralGuardrail {
    pub secrets: Vec<String>,
}
fn redact(value: &mut Value, secrets: &[String]) {
    match value {
        Value::String(text) => {
            for secret in secrets {
                if !secret.is_empty() {
                    *text = text.replace(secret, "[REDACTED]");
                }
            }
        }
        Value::Array(array) => {
            for v in array {
                redact(v, secrets)
            }
        }
        Value::Object(object) => {
            for v in object.values_mut() {
                redact(v, secrets)
            }
        }
        _ => (),
    }
}
impl Plugin for LiteralGuardrail {
    fn name(&self) -> &str {
        "guardrail.literal"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        let secrets = self.secrets.clone();
        let streams: Arc<Mutex<BTreeMap<(String, String), Value>>> = Arc::default();
        r.declare(json!({"holds_output":!secrets.is_empty()}));
        r.on(
            "output",
            Order::Last,
            handler(move |_, _, value| {
                let secrets = secrets.clone();
                let streams = streams.clone();
                Box::pin(async move {
                    let mut output: Output = serde_json::from_value(value)?;
                    if secrets.is_empty() {
                        return Ok(answer(json!(output)));
                    }
                    if let Some(stream) = &output.stream {
                        let key = (output.recipient.clone(), stream.clone());
                        let mut pending = streams.lock().unwrap();
                        if !output.end {
                            let entry = pending.entry(key).or_insert_with(|| {
                                let mut event = output.value.clone();
                                event["content"] = json!("");
                                event
                            });
                            let piece = output.value["content"].as_str().unwrap_or("");
                            let mut text = entry["content"].as_str().unwrap_or("").to_string();
                            text.push_str(piece);
                            entry["content"] = json!(text);
                            return Ok(HookResult {
                                stopped: true,
                                ..answer(Value::Null)
                            });
                        }
                        if let Some(mut event) = pending.remove(&key) {
                            redact(&mut event, &secrets);
                            // The held piece carries the authoritative stream-end marker.
                            event["end"] = json!(true);
                            output.value = event;
                        }
                    }
                    redact(&mut output.value, &secrets);
                    Ok(answer(json!(output)))
                })
            }),
        );
        Ok(())
    }
}
