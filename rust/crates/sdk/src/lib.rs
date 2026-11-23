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
#[cfg(feature = "agui")]
mod agui;
#[cfg(feature = "agui")]
pub use agui::{AguiActor, AguiOptions, AguiServer, AguiState};
mod agent;
mod api_key;
mod chatgpt;
mod claude;
mod client_identity;
mod configuration;
mod context;
mod core;
mod credentials;
mod data;
mod environment;
mod error;
mod events;
mod grok;
mod history;
mod hooks;
mod interface_tools;
pub use interface_tools::{InterfaceConnection, InterfaceReportDisposition, InterfaceToolSource};
mod jobs;
mod parts;
mod plugin;
mod provider;
#[doc(hidden)]
pub mod responses;
mod runtime;
mod serve;
mod session;
mod subscription;
mod subscription_logins;
mod subscription_oauth;
pub mod testing;
mod tool;

pub use acp::{AcpActor, AcpComposition, AcpOptions, AcpServiceOptions, validate_acp_token_files};
pub use agent::{
    Agent, AgentBuilder, Approval, ByteCapacity, ByteLimits, Capacity, Durability, ProcessPlugin,
    ResourceLimits, ServicePlugin, SessionOptions,
};
pub use api_key::{ApiKeyProvider, anthropic, openai};
pub use async_trait::async_trait;
pub use chatgpt::{ChatGptOptions, ChatGptProvider, chatgpt};
pub use claude::{ClaudeOptions, ClaudeProvider, claude};
pub use client_identity::ClientIdentity;
pub use configuration::FilesConfiguration;
pub use context::{HistoryPage, HookContext};
pub use credentials::{
    Activation, CredentialStore, SecretJournal, SecretRequest, StagingReceipt,
    environment_credentials, file_credentials,
};
pub use data::{HistoryEntry, ToolCall, ToolDefinition, ToolHints, ToolSettlement, TurnOutput};
pub use environment::{
    Containment, DirEntry, DirEntryKind, EnvironmentContext, EnvironmentDeclaration,
    EnvironmentPart, ExecResult,
};
pub use error::{Code, Error, Result};
pub use events::{
    ActorEvent, AudioData, ErasureEvent, Event, EventData, EventPayload, HistoryEvent, InputEvent,
    Interruption, InterruptionReason, JobEndedData, JobStartedData, PluginEvent, PositionEvent,
    Question, QuestionKind, QuestionReply, QuestionResponse, SessionEvent, SettingEvent, StepEvent,
    ToolCallData, ToolInputData, ToolOutputData, TurnEndedData, TurnStartedData,
};
pub use grok::{GrokOptions, GrokProvider, grok};
pub use history::{
    EntryPage, ErasedEntry, ErasureReport, History, HistoryFault, HistoryResult, HistoryServer,
    HistoryStore, LeaseGrant, PortableHistoryStore, ServeHistoryOptions, SessionInfo, SessionPage,
    file_history, http_history, http_history_from_env, listen_history, memory_history,
    portable_file_history, serve_history,
};
pub use hooks::*;
pub use jobs::{Job, JobOutcome, JobOwner, JobStart, StartJobs};
pub use parts::{
    Configuration, Environment, Interface, Runtime, durable_runtime, local_environment, native,
    transient_runtime,
};
pub use plugin::{
    Command, CommandContext, Plugin, Registrar, SessionPrepare, ToolSource, ToolsChanged,
};
pub use provider::*;
pub use runtime::{
    InterruptedTurn, ResumedStep, RuntimeCall, RuntimeContext, RuntimeDeclaration, RuntimeOutcome,
    RuntimePart, RuntimeSupport, RuntimeTurn,
};
pub use serve::{ServeOptions, serve, serve_websocket, serve_websocket_factory};
pub use session::{
    Actor, Content, Disposition, EventStream, HandedBack, InputReceipt, MoveOptions, Outcome,
    PromptInput, PromptOptions, PromptResult, Proposal, ReleaseOptions, Rights, Session, Timing,
    ToolResult,
};
pub use subscription::{
    SignInOptions, SignInStep, SignInTestEndpoints, SubscriptionModel, sign_in, sign_out,
};
pub use subscription_logins::*;
pub use tool::{
    Answer, Ask, AskWait, CommandOutput, NestedTools, Tool, ToolBuilder, ToolContext,
    ToolEnvironment, ToolOutput, ToolStatus,
};
pub use transport_websocket::{Server as WebSocketServer, TlsOptions};
