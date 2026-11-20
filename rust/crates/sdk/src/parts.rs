//! Constructors for the built-in Runtime and working environment.
use std::path::PathBuf;
use std::sync::Arc;

/// A built-in Runtime choice.
#[derive(Clone, Copy, Debug)]
pub struct Runtime(pub(crate) bool);

/// Interrupted turns fail on reopen.
pub fn transient_runtime() -> Runtime {
    Runtime(false)
}

/// Interrupted turns recover from their last committed checkpoint.
pub fn durable_runtime() -> Runtime {
    Runtime(true)
}

impl Runtime {
    pub(crate) fn plugin(self) -> Arc<dyn agent_api::Plugin> {
        if self.0 {
            Arc::new(runtime_durable::DurablePlugin)
        } else {
            Arc::new(runtime_transient::TransientPlugin)
        }
    }
}

/// A built-in working environment.
#[derive(Clone)]
pub struct Environment(pub(crate) EnvironmentKind);

#[derive(Clone)]
pub(crate) enum EnvironmentKind {
    Local(Option<PathBuf>),
    Memory(crate::testing::MemoryEnvironment),
}

/// The host filesystem and command supervisor. With no root, use the Agent's project.
/// An explicit root identifies the same project for session and command bookkeeping.
pub fn local_environment(root: Option<PathBuf>) -> Environment {
    Environment(EnvironmentKind::Local(root))
}

impl From<crate::testing::MemoryEnvironment> for Environment {
    fn from(env: crate::testing::MemoryEnvironment) -> Self {
        Environment(EnvironmentKind::Memory(env))
    }
}
