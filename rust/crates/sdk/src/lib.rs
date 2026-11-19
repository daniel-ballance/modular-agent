//! Modular Agent: build agents from interchangeable parts.
//!
//! This crate is the Rust SDK described in `docs/sdk/`. It is built on the Rust base build
//! (`agent-api`, `agent-harness` and the plugin crates), which it keeps out of its API.
//!
//! ```no_run
//! # async fn run() -> modular_agent::Result<()> {
//! use modular_agent::{Agent, testing::scripted_provider};
//! let agent = Agent::builder()
//!     .provider(scripted_provider(serde_json::json!([{ "text": "Hello." }])))
//!     .build()
//!     .await?;
//! let turn = agent.session().await?.prompt("Say hello.").await?;
//! assert_eq!(turn.text, "Hello.");
//! # Ok(()) }
//! ```
mod agent;
mod core;
mod error;
mod events;
mod hooks;
mod plugin;
mod serve;
mod session;
pub mod testing;
mod tool;

pub use agent::{Agent, AgentBuilder, Approval, Durability, ProcessPlugin, Provider};
pub use error::{Code, Error, Result};
pub use events::{Event, Question, QuestionKind};
pub use hooks::*;
pub use plugin::{Command, CommandContext, Plugin, Registrar};
pub use serve::serve;
pub use session::{
    Disposition, EventStream, HandedBack, InputReceipt, Outcome, PromptResult, Session, Timing,
    ToolResult,
};
pub use tool::{Answer, Ask, NestedTools, Tool, ToolBuilder, ToolContext, ToolOutput, ToolStatus};
