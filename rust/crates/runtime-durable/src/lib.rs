//! Durable Runtime, interchangeable with runtime-transient.
use agent_api::*;
pub struct DurablePlugin;
impl Plugin for DurablePlugin {
    fn name(&self) -> &str {
        "runtime.durable"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        runtime_engine::install(r, true)
    }
}
