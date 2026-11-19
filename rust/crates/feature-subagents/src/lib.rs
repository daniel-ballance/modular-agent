//! Subagents are job runners with independent Harness sessions, not new processes.
use agent_api::*;
use std::{sync::Arc, time::Duration};
pub struct SubagentsPlugin {
    pub durable: bool,
    pub replacement: bool,
}
impl Default for SubagentsPlugin {
    fn default() -> Self {
        Self {
            durable: true,
            replacement: false,
        }
    }
}
impl Plugin for SubagentsPlugin {
    fn name(&self) -> &str {
        if self.replacement {
            "feature.subagents.replacement"
        } else {
            "feature.subagents"
        }
    }
    fn replaces(&self) -> Option<&str> {
        if self.replacement {
            Some("feature.subagents")
        } else {
            None
        }
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        let source = Arc::new(Subagents {
            durable: self.durable,
            owner: self.name().into(),
        });
        r.provide::<dyn ToolSource>("tools.subagents", source.clone())?;
        r.provide::<dyn JobRunner>(&format!("job.runner.{}", self.name()), source)?;
        r.declare(json!({"subagents":{"durable":self.durable,"default_depth_limit":3,"questions_route_to_user":true}}));
        Ok(())
    }
}
struct Subagents {
    durable: bool,
    owner: String,
}
fn accounted(
    api: &dyn AgentApi,
    child: &str,
    job: &str,
    mut result: TurnResult,
) -> Result<TurnResult> {
    result.usage = job_usage(&api.snapshot(child)?, job)?;
    Ok(result)
}
#[async_trait]
impl ToolSource for Subagents {
    fn tools(&self, _: &SessionData) -> Vec<ToolDefinition> {
        vec![ToolDefinition { name:"delegate".into(), description:"Start a subagent with only its task. Background reports arrive as parent input. Set background=false to wait. Supply session to message a finished subagent again. Leave authority null/omitted to inherit; otherwise supply only the named rights listed in its enum, never task prose.".into(), input:json!({"type":"object","properties":{"task":{"type":"string"},"background":{"type":"boolean"},"session":{"type":"string"},"model":{"type":"string"},"authority":{"type":"array","items":{"type":"string","enum":Authority::full().0}}},"required":["task"]}), read_only:false, safe_to_repeat:true, parallel:false, hints: json!({}), }]
    }
    async fn run(
        &self,
        api: Api,
        scope: Scope,
        call: ToolCall,
        cancel: CancellationToken,
    ) -> ToolResult {
        let run: Result<ToolResult> = async {
            require(api.as_ref(), &scope, "delegate")?;
            require(api.as_ref(), &scope, "jobs")?;
            let task = call.input["task"].as_str().ok_or_else(|| anyhow!("task required"))?;
            let background = call.input["background"].as_bool().unwrap_or(true);
            let parent = api.snapshot(&scope.session)?;
            let current = jobs(&parent)?.into_iter().find(|j| j.owner == self.owner && j.scope.call == scope.call);
            let job = if let Some(job) = current { job } else {
                let child = if let Some(child) = call.input["session"].as_str() {
                    if api.snapshot(child).is_err() { api.open(child).await?; }
                    let data = api.snapshot(child)?;
                    ensure!(data.settings["_parent"]["session"] == scope.session, "session is not this parent's subagent");
                    ensure!(!jobs(&parent)?.iter().any(|j| j.state == JobState::Running && j.detail["child"] == child), "subagent is already working");
                    // A later sender can only narrow the child's original authority.
                    let cap: Authority = serde_json::from_value(data.settings["_authority"].clone())?;
                    ensure!(work_authority(api.as_ref(), &scope)?.contains(&cap), "sender has less authority than this subagent; start a narrower subagent");
                    child.to_string()
                } else {
                    let depth = parent.settings["_parent"]["depth"].as_u64().unwrap_or(0) + 1;
                    ensure!(depth <= parent.settings["subagent_depth_limit"].as_u64().unwrap_or(3), "subagent depth limit");
                    let mut settings = parent.settings.clone();
                    let mut authority = work_authority(api.as_ref(), &scope)?;
                    if let Some(cap) = call.input.get("authority").filter(|v| !v.is_null()) {
                        let cap: Authority = serde_json::from_value(cap.clone())?;
                        ensure!(Authority::full().contains(&cap), "authority must contain only named rights");
                        authority = authority.intersect(&cap);
                    }
                    settings["_authority"] = json!(authority);
                    settings["_parent"] = json!({"session":scope.session,"actor":scope.actor,"depth":depth});
                    settings["_runtime"] = json!(if self.durable { "durable" } else { "transient" });
                    if let Some(model) = call.input.get("model") { settings["model"] = model.clone(); }
                    let child = api.create(&parent.project, settings).await?;
                    api.append(&Scope::session(&child), "feature.subagents", Draft::new("subagent.init", false, json!({"parent":scope.session,"call":call.id})))?;
                    child
                };
                job_service(api.as_ref())?.start(api.clone(), scope.clone(), &self.owner, "subagent", json!({"child":child,"task":task}), background).await?
            };
            let child = job.detail["child"].as_str().unwrap_or("");
            if background {
                let mut result = ToolResult::new(&call, ToolStatus::Completed, format!("Subagent {child} started as job {}", job.id));
                result.value = Some(json!({"job":job.id,"session":child}));
                Ok(result)
            } else {
                let service = job_service(api.as_ref())?;
                let done = tokio::select! {
                    done = service.wait(api.clone(), &scope.session, &job.id) => done?,
                    _ = cancel.cancelled() => return Ok(ToolResult::new(&call, ToolStatus::Cancelled, "parent stopped waiting; job remains running")),
                };
                let turn = done.result.ok_or_else(|| anyhow!("job has no result"))?;
                let mut result = ToolResult::new(&call, if done.state == JobState::Completed { ToolStatus::Completed } else if done.state == JobState::Unknown { ToolStatus::Unknown } else { ToolStatus::Failed }, format!("{}{}", turn.text, turn.error.unwrap_or_default()));
                result.value = Some(json!({"job":job.id,"session":child,"usage":turn.usage}));
                Ok(result)
            }
        }.await;
        run.unwrap_or_else(|e| ToolResult::new(&call, ToolStatus::Failed, e.to_string()))
    }
}
#[async_trait]
impl JobRunner for Subagents {
    fn durable(&self) -> bool {
        self.durable
    }
    async fn run(
        &self,
        api: Api,
        job: Job,
        _: bool,
        cancel: CancellationToken,
    ) -> Result<TurnResult> {
        let child = job.detail["child"]
            .as_str()
            .ok_or_else(|| anyhow!("child session missing"))?;
        if api.snapshot(child).is_err() {
            let opening = api.open(child);
            tokio::pin!(opening);
            tokio::select! {
                result = &mut opening => result?,
                _ = cancel.cancelled() => { api.cancel(child).await?; opening.await?; }
            }
        }
        let child_scope = Scope {
            job: Some(job.id.clone()),
            ..Scope::session(child)
        };
        api.publish(
            &child_scope,
            "feature.subagents",
            vec![],
            Some((
                job.detail["task"].as_str().unwrap_or("").into(),
                "user".into(),
            )),
            Some(format!("job-task:{}", job.id)),
        )?;
        loop {
            if cancel.is_cancelled() {
                api.cancel(child).await?;
                return accounted(
                    api.as_ref(),
                    child,
                    &job.id,
                    TurnResult {
                        outcome: Outcome::Cancelled,
                        ..TurnResult::default()
                    },
                );
            }
            let next = api.next_turn(child);
            tokio::pin!(next);
            let result = tokio::select! {
                result = &mut next => result?,
                _ = cancel.cancelled() => { api.cancel(child).await?; next.await? }
            };
            if let Some(result) = result {
                if result.open_calls.is_empty() {
                    return accounted(api.as_ref(), child, &job.id, result);
                }
            } else if let Some(e) = api
                .snapshot(child)?
                .branch()
                .into_iter()
                .rev()
                .find(|e| e.kind == "turn.end" && e.scope.job.as_ref() == Some(&job.id))
            {
                let result: TurnResult = serde_json::from_value(
                    e.content.ok_or_else(|| anyhow!("erased subagent result"))?,
                )?;
                if result.open_calls.is_empty() {
                    return accounted(api.as_ref(), child, &job.id, result);
                }
            }
            tokio::select! { _ = cancel.cancelled() => (), _ = tokio::time::sleep(Duration::from_millis(10)) => () }
        }
    }
    async fn stop(&self, api: Api, job: &Job) -> Result<()> {
        if let Some(child) = job.detail["child"].as_str() {
            if api.snapshot(child).is_err() && !self.durable {
                api.open(child).await?;
            }
            if api.snapshot(child).is_ok() {
                api.close(child).await?;
            }
        }
        Ok(())
    }
}
