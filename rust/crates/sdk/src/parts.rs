//! Constructors for the built-in Runtime and working environment.
use crate::{Agent, Result};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Settings and project trust supplied by the app.
pub trait Configuration: Send + Sync + 'static {
    fn settings(&self, project: &Path) -> Result<Value>;
    fn trusted(&self, _project: &Path) -> Result<bool> {
        Ok(false)
    }
}
pub(crate) struct ConfigurationAdapter(pub Arc<dyn Configuration>);
impl agent_api::Configuration for ConfigurationAdapter {
    fn settings(&self, project: &Path) -> agent_api::Result<Value> {
        Ok(agent_api::portable::settings_from_wire(
            &self.0.settings(project)?,
        ))
    }
}

/// A trusted consumer of the Agent. Start returns when the Interface is ready.
#[crate::async_trait]
pub trait Interface: Send + Sync + 'static {
    async fn start(&self, agent: Agent) -> Result<()>;
    async fn stop(&self) -> Result<()> {
        Ok(())
    }
}

/// Advanced native ports for parts that run in this process.
pub mod native {
    pub use agent_api::{
        Api as RuntimeHost, Entry, Lease, ModelRequest, ModelResponse, Runtime as RuntimePart,
        Scope, SessionData, ToolCall, ToolResult, TurnInput, TurnResult, WorkingEnvironment,
    };
}

pub(crate) struct RuntimeAdapter(pub Arc<dyn agent_api::Runtime>);
impl agent_api::Plugin for RuntimeAdapter {
    fn name(&self) -> &str {
        "sdk.runtime"
    }
    fn install(&self, r: &mut agent_api::Registrar<'_>) -> agent_api::Result<()> {
        r.provide::<dyn agent_api::Runtime>("runtime", self.0.clone())
    }
}

/// A default Configuration for projects without an external source.
impl Configuration for crate::FilesConfiguration {
    fn settings(&self, project: &Path) -> Result<Value> {
        let settings = crate::FilesConfiguration::settings(self, project)?;
        Ok(agent_api::portable::settings_to_wire(&settings))
    }
    fn trusted(&self, project: &Path) -> Result<bool> {
        crate::FilesConfiguration::trusted(self, project)
    }
}

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
