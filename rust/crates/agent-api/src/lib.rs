//! Shared in-process plugin API. No concrete plugins live here.
mod interface_tools;
mod listing;
pub use listing::*;
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
// A fixture advances work deadlines, not network or lease timers.
static TEST_CLOCK: std::sync::OnceLock<tokio::sync::watch::Sender<u64>> =
    std::sync::OnceLock::new();
#[doc(hidden)]
pub fn advance_clock_for_test(ms: u64) {
    TEST_CLOCK
        .get_or_init(|| tokio::sync::watch::channel(wall_time()).0)
        .send_modify(|t| *t = t.saturating_add(ms));
}
pub fn now() -> u64 {
    TEST_CLOCK.get().map_or_else(wall_time, |t| *t.borrow())
}
pub async fn wait_until(deadline: u64) {
    if let Some(clock) = TEST_CLOCK.get() {
        let mut clock = clock.subscribe();
        let _ = clock.wait_for(|now| *now >= deadline).await;
    } else {
        tokio::time::sleep(std::time::Duration::from_millis(
            deadline.saturating_sub(now()),
        ))
        .await;
    }
}
fn wall_time() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
