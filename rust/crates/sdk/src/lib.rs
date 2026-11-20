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
mod acp;
mod agent;
mod api_key;
mod configuration;
mod core;
mod credentials;
mod error;
mod events;
mod history;
mod hooks;
mod parts;
mod plugin;
mod provider;
mod serve;
mod session;
pub mod testing;
mod tool;

pub use acp::{AcpComposition, AcpOptions};
pub use agent::{Agent, AgentBuilder, Approval, Durability, ProcessPlugin, SessionOptions};
pub use api_key::{ApiKeyProvider, anthropic, openai};
pub use async_trait::async_trait;
pub use configuration::FilesConfiguration;
pub use credentials::{
    Activation, CredentialStore, SecretJournal, SecretRequest, StagingReceipt,
    environment_credentials, file_credentials,
};
pub use error::{Code, Error, Result};
pub use events::{Event, Question, QuestionKind, QuestionReply};
pub use history::{
    ErasedEntry, ErasureReport, History, ServeHistoryOptions, SessionInfo, file_history,
    http_history, http_history_from_env, memory_history, serve_history,
};
pub use hooks::*;
pub use parts::{Environment, Runtime, durable_runtime, local_environment, transient_runtime};
pub use plugin::{Command, CommandContext, Plugin, Registrar, SessionPrepare, ToolSource};
pub use provider::*;
pub use serve::{ServeOptions, serve, serve_websocket};
pub use session::{
    Actor, Disposition, EventStream, HandedBack, InputReceipt, MoveOptions, Outcome, PromptOptions,
    PromptResult, Rights, Session, Timing, ToolResult,
};
pub use tool::{
    Answer, Ask, CommandOutput, NestedTools, Tool, ToolBuilder, ToolContext, ToolEnvironment,
    ToolOutput, ToolStatus,
};
pub use transport_websocket::{Server as WebSocketServer, TlsOptions};
