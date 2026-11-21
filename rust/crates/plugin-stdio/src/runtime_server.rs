use crate::{
    rpc::{Fault, Peer, Work},
    runtime_host::{Callback, Execution, RemoteRuntime, TurnWork},
};
use agent_api::*;
use std::sync::{Arc, Mutex};

/// A transport-independent Runtime invocation and its host callbacks.
#[async_trait]
pub trait RuntimeHandler: Send + Sync {
    async fn run(
        &self,
        method: &str,
        params: Value,
        context: RuntimeContext,
    ) -> Result<Value, Fault>;
}

pub fn local_runtime(
    handler: Arc<dyn RuntimeHandler>,
    registration: Value,
    points: std::collections::BTreeMap<String, HookPoint>,
) -> Arc<dyn Runtime> {
    Arc::new(RemoteRuntime {
        execution: Execution::Local(handler),
        points,
        registration,
        ui_runtime: None,
    })
}

#[derive(Clone)]
enum Backend {
    Local {
        work: Arc<Work>,
        turn: Arc<TurnWork>,
    },
    Remote {
        peer: Arc<Peer>,
        parent: Value,
    },
}

#[derive(Clone)]
pub struct RuntimeContext {
    backend: Backend,
    pub(crate) settled: CancellationToken,
    cancelled: CancellationToken,
}
impl RuntimeContext {
    pub(crate) fn local(turn: Arc<TurnWork>, work: Arc<Work>) -> Self {
        Self {
            cancelled: work.cancel.clone(),
            backend: Backend::Local { work, turn },
            settled: CancellationToken::new(),
        }
    }
    pub fn remote(
        peer: Arc<Peer>,
        parent: Value,
        cancelled: CancellationToken,
    ) -> (Self, impl Drop) {
        let settled = CancellationToken::new();
        let guard = settled.clone().drop_guard();
        (
            Self {
                backend: Backend::Remote { peer, parent },
                cancelled,
                settled,
            },
            guard,
        )
    }
    pub fn cancelled(&self) -> &CancellationToken {
        &self.cancelled
    }

    pub async fn report(&self, mut params: Value) -> Result<(), Fault> {
        if self.settled.is_cancelled() {
            return Err(Fault::new(
                "invalid_request",
                "the Runtime call has settled",
            ));
        }
        match &self.backend {
            Backend::Local { work, turn } => {
                let api = work
                    .api
                    .upgrade()
                    .ok_or_else(|| Fault::new("lost", "the Runtime host is closed"))?;
                turn.report(&api, work, &params)
                    .await
                    .map_err(|e| Fault::new("invalid_request", e))
            }
            Backend::Remote { peer, parent } => {
                params["parentRequestId"] = parent.clone();
                peer.notify("host/runtime/report", params);
                Ok(())
            }
        }
    }
    pub async fn callback(&self, method: &str, mut params: Value) -> Result<Value, Fault> {
        if self.settled.is_cancelled() {
            return Err(Fault::new(
                "invalid_request",
                "the Runtime call has settled",
            ));
        }
        if !params.is_object() {
            return Err(Fault::new(
                "invalid_request",
                "the callback requires an object",
            ));
        }
        if self.cancelled.is_cancelled()
            && !(matches!(method, "history" | "record")
                || (method == "hook" && params["hook"] == "turn.end"))
        {
            return Err(Fault::new("cancelled", "the Runtime call is cancelled"));
        }
        let name = if method == "history" {
            "host/history".to_owned()
        } else {
            format!("host/runtime/{method}")
        };
        // Settlement callbacks must still work after cooperative turn cancellation.
        let cancellation = if matches!(method, "history" | "record" | "hook") {
            self.settled.clone()
        } else {
            self.cancelled.child_token()
        };
        match &self.backend {
            Backend::Remote { peer, parent } => {
                params["parentRequestId"] = parent.clone();
                peer.call(&name, params, None, cancellation).await
            }
            Backend::Local { work, turn } => {
                let api = work
                    .api
                    .upgrade()
                    .ok_or_else(|| Fault::new("lost", "the Runtime host is closed"))?;
                if method == "history" {
                    return history(&api, &work.scope, &params)
                        .map_err(|e| Fault::new("invalid_request", e));
                }
                turn.callback(
                    &api,
                    work,
                    Callback {
                        peer: None,
                        id: Value::Null,
                        method: &name,
                        params: &params,
                    },
                    cancellation,
                )
                .await
                .map_err(|e| {
                    if let Some(fault) = e.downcast_ref::<Fault>() {
                        fault.clone()
                    } else if e.is::<LostPart>() {
                        Fault::new("lost", e)
                    } else {
                        Fault::new("invalid_request", e)
                    }
                })
            }
        }
    }
}

fn history(api: &Api, scope: &Scope, params: &Value) -> Result<Value> {
    require(api.as_ref(), scope, "watch")?;
    ensure!(
        params["sessionId"] == scope.session,
        "history is outside this Runtime call"
    );
    let data = api.snapshot(&scope.session)?;
    let entries: Vec<_> = if params["all"] == true {
        data.entries.clone()
    } else {
        data.branch()
    }
    .into_iter()
    .filter(|row| row.writer != "rust.derived")
    .collect();
    let start = match params["after"].as_str() {
        Some(id) => {
            entries
                .iter()
                .position(|entry| entry.id == id)
                .ok_or_else(|| anyhow!("unknown history cursor"))?
                + 1
        }
        None => 0,
    };
    let mut page = vec![];
    let mut bytes = b"{\"entries\":[]}".len();
    for (i, entry) in entries.iter().enumerate().skip(start).take(500) {
        let row = wire::entry(entry, &data)?;
        let total = bytes + serde_json::to_vec(&row)?.len() + usize::from(!page.is_empty());
        let cursor = if i + 1 < entries.len() {
            b",\"next\":".len() + serde_json::to_vec(&entry.id)?.len()
        } else {
            0
        };
        if total + cursor > 4 * 1024 * 1024 {
            ensure!(!page.is_empty(), "history entry exceeds 4 MiB");
            break;
        }
        page.push(row);
        bytes = total;
    }
    let mut result = json!({"entries":page});
    if start + page.len() < entries.len() {
        result["next"] = page.last().unwrap()["id"].clone();
    }
    Ok(result)
}

pub struct Host {
    peer: Arc<Peer>,
    parent: Value,
    cancel: CancellationToken,
    records: Mutex<Vec<Value>>,
}
impl Host {
    pub fn new(peer: Arc<Peer>, parent: Value, cancel: CancellationToken) -> Self {
        Self {
            peer,
            parent,
            cancel,
            records: Mutex::default(),
        }
    }
}
#[async_trait]
impl runtime_engine::binding::Host for Host {
    async fn ask(&self, method: &str, mut params: Value, cancellable: bool) -> Result<Value> {
        params["parentRequestId"] = self.parent.clone();
        let reply = self
            .peer
            .call(
                &format!("host/runtime/{method}"),
                params,
                None,
                if cancellable {
                    self.cancel.clone()
                } else {
                    CancellationToken::new()
                },
            )
            .await
            .map_err(|fault| {
                if fault.code == "turn_limit"
                    && let Some(limit) = &fault.limit
                {
                    return anyhow!(runtime_engine::binding::TurnLimit(limit.clone()));
                }
                anyhow!(fault)
            })?;
        if method == "record" {
            self.records.lock().unwrap().push(reply["id"].clone());
        }
        Ok(reply)
    }
    async fn history(&self, session: &Value, after: Option<&Value>) -> Result<Value> {
        self.read_history(session, after, false).await
    }
    async fn history_all(&self, session: &Value, after: Option<&Value>) -> Result<Value> {
        self.read_history(session, after, true).await
    }
    fn cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }
    fn entries(&self) -> Value {
        json!(*self.records.lock().unwrap())
    }
}
impl Host {
    async fn read_history(
        &self,
        session: &Value,
        after: Option<&Value>,
        all: bool,
    ) -> Result<Value> {
        let mut params = json!({"parentRequestId":self.parent,"sessionId":session,"all":all});
        if let Some(after) = after {
            params["after"] = after.clone();
        }
        Ok(self
            .peer
            .call("host/history", params, None, self.cancel.clone())
            .await?)
    }
}
