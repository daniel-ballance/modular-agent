//! modular-agent-plugin/1 adapters. No Runtime or turn loop lives here.
mod host;
mod jobs;
mod output;
mod relay;
pub mod rpc;
mod runtime_host;
mod runtime_server;
pub mod server;
pub use agent_api::wire;
pub use host::{Launch, Remote, hook_name, hook_payload, hook_result, load};
