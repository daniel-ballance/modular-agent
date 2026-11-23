//! Protocol-neutral executor connections for tools registered by the app.
use crate::Result;
use serde_json::Value;

pub use agent_harness::{InterfaceReportDisposition, InterfaceToolSource};

/// One authenticated executor connection. Dropping it clears advertisement,
/// but does not cancel a handed-off tool or settle its result.
pub struct InterfaceConnection(pub(crate) agent_harness::InterfaceConnection);

impl InterfaceConnection {
    /// Replace this connection's availability with an exact subset of the
    /// shared definitions installed at composition.
    pub fn advertise(&self, tools: &[Value]) -> Result<()> {
        Ok(self.0.advertise(tools)?)
    }

    /// Receive a gated executable ToolCall. This method never replays calls.
    pub async fn next_call(&mut self) -> Result<Option<Value>> {
        Ok(self.0.next_call().await?)
    }

    /// Report a completed or failed ToolResult after the originating turn ends.
    /// No dispatch is performed by this operation.
    pub async fn report_tool_result(&self, report: Value) -> Result<InterfaceReportDisposition> {
        Ok(self.0.report_tool_result(report).await?)
    }
}
