//! Interface tool sources, the live routes that deliver their calls, and the checkpoints that settle them.
use super::*;
use std::collections::BTreeSet;
use tokio::sync::mpsc;

mod registration;
mod settlement;

pub(super) use settlement::{Continuation, next_interface_continuation, same_authority_record};

#[derive(Clone, Debug)]
pub struct InterfaceToolSource {
    pub source_id: String,
    pub actor_id: String,
    pub route_id: String,
    pub result_timeout_ms: u64,
    pub tools: Vec<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InterfaceReportDisposition {
    Accepted,
    AlreadySettled,
    Refused { reason: Option<&'static str> },
}

struct Source {
    config: InterfaceToolSource,
    tools: Vec<ToolDefinition>,
}

type Wake = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Default)]
pub(super) struct InterfaceTools {
    configuration: std::sync::OnceLock<registration::Configuration>,
    traces: Mutex<BTreeMap<String, Context>>,
    connections: Mutex<BTreeMap<String, Presence>>,
    reports: tokio::sync::Mutex<()>,
    wake: std::sync::OnceLock<Wake>,
}

struct Presence {
    session: String,
    route: String,
    authority: Authority,
    tools: BTreeSet<String>,
    generation: CancellationToken,
    sender: mpsc::Sender<(String, String)>,
}

/// An operator-authenticated executor slot, scoped to one session. Disconnect
/// is dropping this handle; reports never require an availability advertisement.
pub struct InterfaceConnection {
    harness: Weak<Harness>,
    session: String,
    route: String,
    id: String,
    generation: CancellationToken,
    receiver: mpsc::Receiver<(String, String)>,
    staged: std::collections::VecDeque<(String, String)>,
}
