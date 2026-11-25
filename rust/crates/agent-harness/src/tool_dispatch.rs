use super::Harness;
use agent_api::telemetry::{self, KeyValue, Operation, SpanKind};
use agent_api::*;

impl Harness {
    pub(super) fn stage_response_calls(
        &self,
        scope: &Scope,
        response: &ModelResponse,
    ) -> Result<()> {
        let sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get(&scope.session)
            .ok_or_else(|| anyhow!("session not open"))?;
        self.reservations().stage_response(
            &open.data,
            (scope.turn.clone(), scope.step.clone()),
            response,
        )
    }

    pub(super) async fn run_registered_tool(
        &self,
        scope: &Scope,
        call: ToolCall,
        cancel: CancellationToken,
        cover: Option<ApprovalCover>,
    ) -> ToolResult {
        if let Some(status) = self
            .approval_dispatch(scope, &call, cover.as_ref(), true)
            .await
            .unwrap_or(Some(ToolStatus::Refused))
        {
            telemetry::disposition(scope, &call, &status);
            return ToolResult::new(&call, status, "approval no longer permits dispatch");
        }
        let data = match self.snapshot(&scope.session) {
            Ok(s) => s,
            Err(e) => return ToolResult::new(&call, ToolStatus::Failed, e.to_string()),
        };
        for name in self.capability_names("tools.") {
            if let Ok(source) = capability::<dyn ToolSource>(self, &name)
                && source.tools(&data).iter().any(|t| t.name == call.name)
            {
                if let Err(error) = self.check_writer(&scope.session) {
                    return ToolResult::new(&call, ToolStatus::NotStarted, error.to_string());
                }
                let mut attrs = telemetry::tool_attributes(&call);
                if let Some(agent) = self.agent_name.get() {
                    attrs.push(KeyValue::new("gen_ai.agent.name", agent.clone()));
                }
                let name = telemetry::name(&call.name)
                    .map_or_else(|| "execute_tool".into(), |n| format!("execute_tool {n}"));
                let op = Operation::new(name, SpanKind::Internal, Some(scope), attrs);
                let _dispatch = match cover {
                    Some(cover) => match self.live_covers.begin(scope, &call, cover) {
                        Ok(guard) => Some(guard),
                        Err(error) => {
                            return ToolResult::new(&call, ToolStatus::Refused, error.to_string());
                        }
                    },
                    None => None,
                };
                let result = op
                    .run(source.run(self.api(), scope.clone(), call, cancel))
                    .await;
                op.attr("modular_agent.tool.status", wire::status(&result.status));
                if result.status == ToolStatus::Failed {
                    op.error("tool_failed");
                }
                return result;
            }
        }
        ToolResult::new(
            &call,
            ToolStatus::Failed,
            format!("unknown tool {}", call.name),
        )
    }
}
