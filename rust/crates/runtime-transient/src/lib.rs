//! Transient Runtime plugin. Standard turn semantics live in the shared engine.
use agent_api::*;
pub struct TransientPlugin;
impl Plugin for TransientPlugin {
    fn name(&self) -> &str {
        "runtime.transient"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        runtime_engine::install(r, false)
    }
}
