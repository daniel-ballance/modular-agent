//! The standard configuration's offline scripted Provider and request log.
use modular_agent::{
    AssistantMessage, ModelInfo, ModelRef, ModelRequest, Provider, ProviderContext,
    ProviderSupport, Result, async_trait,
};
use serde_json::{Value, json};
use std::{
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[derive(Clone)]
pub struct Script {
    pub responses: Value,
    pub log: Option<PathBuf>,
    lock: Arc<Mutex<()>>,
}
impl Script {
    pub fn new(responses: Value, log: Option<PathBuf>) -> Self {
        Self {
            responses,
            log,
            lock: Arc::default(),
        }
    }

    pub fn provider(&self) -> impl Provider {
        Logged {
            provider: modular_agent::testing::scripted_provider(self.responses.clone()),
            options: self.clone(),
        }
    }
}

struct Logged<P> {
    provider: P,
    options: Script,
}

#[async_trait]
impl<P: Provider> Provider for Logged<P> {
    fn id(&self) -> &str {
        self.provider.id()
    }
    fn models(&self) -> Vec<ModelInfo> {
        self.provider.models()
    }
    fn supports(&self) -> ProviderSupport {
        self.provider.supports()
    }
    async fn request(
        &self,
        model: ModelRef,
        request: ModelRequest,
        cx: ProviderContext,
    ) -> Result<AssistantMessage> {
        if let Some(path) = &self.options.log {
            let _lock = self.options.lock.lock().unwrap();
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)?;
            let mut bytes = serde_json::to_vec(&log_line(&request.0))?;
            bytes.push(b'\n');
            file.write_all(&bytes)?;
        }
        self.provider.request(model, request, cx).await
    }
}
fn log_line(request: &Value) -> Value {
    let messages = request["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|m| {
            let parts = || m["content"].as_array().into_iter().flatten();
            let text = parts()
                .filter(|p| p["type"] == "text")
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("");
            let role = &m["role"];
            let mut item = json!({"role":role,"text":text});
            if role == "assistant" {
                item["toolCalls"] = json!(
                    parts()
                        .filter(|p| p["type"] == "toolCall")
                        .map(|p| json!({"name":p["name"],"input":p["arguments"]}))
                        .collect::<Vec<_>>()
                );
            }
            if role == "toolResult" {
                item["name"] = m["toolName"].clone();
            }
            item
        })
        .collect::<Vec<_>>();
    json!({"system":request["systemPrompt"].as_str().unwrap_or_default(),
        "tools":request["tools"].as_array().into_iter().flatten().map(|t| &t["name"]).collect::<Vec<_>>(),
        "messages":messages})
}
