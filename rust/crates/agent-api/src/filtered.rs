use crate::*;
use std::sync::Arc;
pub(crate) struct FilteredSource {
    pub inner: Arc<dyn ToolSource>,
    pub excluded: String,
}
#[async_trait]
impl ToolSource for FilteredSource {
    fn tools(&self, session: &SessionData) -> Vec<ToolDefinition> {
        self.inner
            .tools(session)
            .into_iter()
            .filter(|t| t.name != self.excluded)
            .collect()
    }
    async fn run(
        &self,
        api: Api,
        scope: Scope,
        call: ToolCall,
        cancel: CancellationToken,
    ) -> ToolResult {
        if call.name == self.excluded {
            ToolResult::new(&call, ToolStatus::NotStarted, "local tool was replaced")
        } else {
            self.inner.run(api, scope, call, cancel).await
        }
    }
}
