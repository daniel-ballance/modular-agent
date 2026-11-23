//! Shared in-process plugin API. No concrete plugins live here.
mod interface_tools;
pub mod portable;
pub mod recovery;
pub mod schema;
pub use interface_tools::*;
mod secrets;
pub mod telemetry;
pub mod wire;
mod work;
pub use secrets::*;
pub use work::*;
mod context;
mod model_attempt;
pub use model_attempt::*;
mod data;
pub use context::*;
mod filtered;
use filtered::FilteredSource;
mod plugins;
mod ports;
pub use anyhow::{Result, anyhow, bail, ensure};
pub use async_trait::async_trait;
pub use data::*;
pub use plugins::*;
pub use ports::*;
pub use serde_json::{Value, json};
pub use tokio_util::sync::CancellationToken;
pub type Api = std::sync::Arc<dyn AgentApi>;
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
