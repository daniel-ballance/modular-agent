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
mod context;
mod core;
mod credentials;
mod error;
mod events;
mod history;
mod hooks;
mod jobs;
mod parts;
mod plugin;
mod provider;
mod serve;
mod session;
pub mod testing;
mod tool;

pub use acp::{AcpActor, AcpComposition, AcpOptions, AcpServiceOptions};
pub use agent::{
    Agent, AgentBuilder, Approval, Durability, ProcessPlugin, ServicePlugin, SessionOptions,
};
pub use api_key::{ApiKeyProvider, anthropic, openai};
pub use async_trait::async_trait;
pub use configuration::FilesConfiguration;
pub use context::{HistoryPage, HookContext};
pub use credentials::{
    Activation, CredentialStore, SecretJournal, SecretRequest, StagingReceipt,
    environment_credentials, file_credentials,
};
pub use error::{Code, Error, Result};
pub use events::{Event, EventData, Question, QuestionKind, QuestionReply};
pub use history::{
    ErasedEntry, ErasureReport, History, HistoryServer, HistoryStore, ServeHistoryOptions,
    SessionInfo, file_history, http_history, http_history_from_env, listen_history, memory_history,
    serve_history,
};
pub use hooks::*;
pub use jobs::{Job, JobOutcome, JobOwner, JobStart};
pub use parts::{
    Configuration, Environment, Interface, Runtime, durable_runtime, local_environment, native,
    transient_runtime,
};
pub use plugin::{
    Command, CommandContext, Plugin, Registrar, SessionPrepare, ToolSource, ToolsChanged,
};
pub use provider::*;
pub use serve::{ServeOptions, serve, serve_websocket, serve_websocket_factory};
pub use session::{
    Actor, Content, Disposition, EventStream, HandedBack, InputReceipt, MoveOptions, Outcome,
    PromptInput, PromptOptions, PromptResult, Proposal, Rights, Session, Timing, ToolResult,
};
pub use tool::{
    Answer, Ask, AskWait, CommandOutput, NestedTools, Tool, ToolBuilder, ToolContext,
    ToolEnvironment, ToolOutput, ToolStatus,
};
pub use transport_websocket::{Server as WebSocketServer, TlsOptions};
