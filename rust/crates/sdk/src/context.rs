//! Call-scoped callbacks common to tools, commands and hook handlers.
use crate::{Code, Error, Result, tool::Backend};
use agent_api as base;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

/// A page of raw history. This is a trusted plugin view, not an actor projection.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct HistoryPage {
    pub entries: Vec<Value>,
    pub next: Option<String>,
}

#[derive(Clone, Default)]
pub struct HookContext {
    pub session_id: String,
    pub actor_id: String,
    pub turn_id: Option<String>,
    pub step_id: Option<String>,
    pub tool_call_id: Option<String>,
    pub job_id: Option<String>,
    pub cancelled: CancellationToken,
    pub(crate) settled: CancellationToken,
    pub(crate) backend: Option<Backend>,
    pub(crate) job_owner: Option<(String, crate::jobs::Owner)>,
}

impl std::fmt::Debug for HookContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HookContext")
            .field("session_id", &self.session_id)
            .field("actor_id", &self.actor_id)
            .field("turn_id", &self.turn_id)
            .field("step_id", &self.step_id)
            .field("tool_call_id", &self.tool_call_id)
            .finish_non_exhaustive()
    }
}

impl HookContext {
    pub(crate) fn local(api: base::Api, scope: base::Scope) -> Self {
        let cancelled = api.cancellation(&scope.session).unwrap_or_default();
        Self {
            session_id: scope.session.clone(),
            actor_id: scope.actor.clone(),
            turn_id: scope.turn.clone(),
            step_id: scope.step.clone(),
            tool_call_id: scope.call.clone(),
            job_id: scope.job.clone(),
            cancelled,
            backend: Some(Backend::Local { api, scope }),
            ..Default::default()
        }
    }
    pub(crate) fn remote(backend: Backend, payload: &Value, cancelled: CancellationToken) -> Self {
        let id = |key| payload[key].as_str().map(str::to_owned);
        Self {
            session_id: id("sessionId").unwrap_or_default(),
            actor_id: id("actorId").unwrap_or_default(),
            turn_id: id("turnId"),
            step_id: id("stepId"),
            tool_call_id: id("toolCallId")
                .or_else(|| payload["call"]["id"].as_str().map(str::to_owned)),
            job_id: id("jobId"),
            cancelled,
            backend: Some(backend),
            ..Default::default()
        }
    }
    pub fn log(&self, message: impl std::fmt::Display) {
        eprintln!("hook in session {}: {message}", self.session_id);
    }
    pub(crate) fn backend(&self) -> Result<&Backend> {
        self.backend
            .as_ref()
            .filter(|_| !self.settled.is_cancelled())
            .ok_or_else(|| Error::new(Code::InvalidRequest, "hook context is not active"))
    }
    /// Job-owner operations are available only during this plugin's session.start hook.
    pub fn jobs(&self) -> crate::StartJobs<'_> {
        crate::StartJobs(self)
    }
    pub async fn history(&self, after: Option<&str>) -> Result<HistoryPage> {
        history(self.backend()?, &self.session_id, after).await
    }
    pub async fn emit(&self, kind: &str, data: Value) -> Result<()> {
        emit(self.backend()?, &self.session_id, kind, data).await
    }
    pub async fn call_hook(
        &self,
        hook: &crate::DefinedHook,
        value: Value,
    ) -> Result<crate::HookReply> {
        call_hook(self.backend()?, hook, value).await
    }
}

pub(crate) async fn history(
    backend: &Backend,
    session: &str,
    after: Option<&str>,
) -> Result<HistoryPage> {
    match backend {
        Backend::Local { api, scope } => {
            let data = api.snapshot(&scope.session)?;
            let entries: Vec<_> = data
                .entries
                .iter()
                .filter(|e| e.writer != "rust.derived")
                .collect();
            let start = after
                .map(|after| {
                    entries
                        .iter()
                        .position(|e| e.id == after)
                        .map(|i| i + 1)
                        .ok_or_else(|| Error::new(Code::InvalidRequest, "unknown history cursor"))
                })
                .transpose()?
                .unwrap_or_default();
            let mut page = HistoryPage {
                entries: Vec::new(),
                next: None,
            };
            let mut size = b"{\"entries\":[]}".len();
            for (i, entry) in entries.iter().enumerate().skip(start).take(500) {
                let row = base::wire::entry(entry, &data)?;
                let n = serde_json::to_vec(&row)?.len() + usize::from(!page.entries.is_empty());
                let cursor_size = if i + 1 < entries.len() {
                    b",\"next\":".len() + serde_json::to_vec(&entry.id)?.len()
                } else {
                    0
                };
                if size + n + cursor_size > 4 * 1024 * 1024 {
                    if page.entries.is_empty() {
                        return Err(Error::new(
                            Code::ResultTooLarge,
                            "history entry exceeds the page size",
                        ));
                    }
                    break;
                }
                size += n;
                page.entries.push(row);
                page.next = (i + 1 < entries.len()).then(|| entry.id.clone());
            }
            Ok(page)
        }
        Backend::Remote { peer, parent } => {
            let mut params = json!({"sessionId":session,"all":true});
            if !parent.is_null() {
                params["parentRequestId"] = parent.clone();
            }
            if let Some(after) = after {
                params["after"] = json!(after);
            }
            let response = peer
                .call("host/history", params, None, CancellationToken::new())
                .await
                .map_err(crate::serve::from_fault)?;
            Ok(serde_json::from_value(response)?)
        }
    }
}

pub(crate) async fn emit(backend: &Backend, session: &str, kind: &str, data: Value) -> Result<()> {
    if !kind.contains('.') {
        return Err(Error::new(
            Code::InvalidRequest,
            "custom event type must contain a dot",
        ));
    }
    match backend {
        Backend::Local { api, scope } => api.emit(base::Event::new(scope, kind, data)).await?,
        Backend::Remote { peer, parent } => {
            let mut payload = json!({"sessionId":session,"type":kind,"data":data});
            if !parent.is_null() {
                payload["parentRequestId"] = parent.clone();
            }
            peer.notify("host/emit", payload);
        }
    }
    Ok(())
}

pub(crate) async fn call_hook(
    backend: &Backend,
    hook: &crate::DefinedHook,
    value: Value,
) -> Result<crate::HookReply> {
    let Backend::Local { api, scope } = backend else {
        return Err(crate::plugin::cannot_serve("custom hooks"));
    };
    let point = hook
        .0
        .get()
        .ok_or_else(|| Error::new(Code::InvalidRequest, "hook is not installed"))?;
    let reply = api.invoke(point, scope, value).await?;
    Ok(crate::HookReply {
        value: reply.value,
        answered: reply.answered,
        refused: reply.refused,
    })
}
