use crate::rpc::Peer;
use agent_api::*;
use std::sync::{Arc, Mutex};

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
