//! Adapter from the SDK's fixed-project agent to the base ACP Interface.
use crate::{Agent, Code, Error, Result};
use agent_api as base;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex},
};

type Sink = Arc<dyn base::EventSink>;
#[derive(Default)]
pub(crate) struct Routes {
    pending: Mutex<Option<Sink>>,
    attached: Mutex<BTreeMap<String, Sink>>,
    serving: tokio::sync::Mutex<()>,
}
impl base::EventSink for Routes {
    fn send(&self, event: base::Event) {
        if let Some(sink) = self
            .attached
            .lock()
            .unwrap()
            .get(&event.scope.session)
            .cloned()
        {
            sink.send(event);
        }
    }
}

impl Agent {
    /// Serve this agent's project on stdio. Build with `plugin_host(true)` before serving.
    /// Start the Interface before opening embedded sessions; stdout belongs to ACP.
    pub async fn serve_acp(&self) -> Result<()> {
        if !self.inner.plugin_host {
            return Err(Error::new(
                Code::InvalidComposition,
                "serve_acp requires a plugin host",
            ));
        }
        let routes = self
            .inner
            .acp
            .get_or_init(|| Arc::new(Routes::default()))
            .clone();
        let _serving = routes
            .serving
            .try_lock()
            .map_err(|_| Error::new(Code::Busy, "ACP is already serving"))?;
        use base::AgentApi;
        if !self
            .inner
            .harness
            .capability_names("interface.acp")
            .iter()
            .any(|name| name == "interface.acp")
        {
            self.inner
                .harness
                .load(Arc::new(interface_acp::AcpPlugin {
                    sink: routes.clone(),
                }))
                .await
                .map_err(|e| {
                    Error::new(
                        Code::InvalidComposition,
                        format!("cannot install ACP: {e:#}"),
                    )
                })?;
        }
        interface_acp::run(Arc::new(Factory(self.clone(), routes.clone()))).await?;
        Ok(())
    }
}

struct Factory(Agent, Arc<Routes>);
#[async_trait::async_trait]
impl interface_acp::Factory for Factory {
    async fn declaration(&self) -> base::Result<Value> {
        Ok(self.0.declaration_for(None, true)?)
    }
    fn session_declaration(&self, _: &dyn base::AgentApi, session: &str) -> base::Result<Value> {
        Ok(self.0.declaration_for(Some(session), true)?)
    }
    fn owns_session_agent(&self) -> bool {
        false
    }
    async fn build(&self, project: &Path, sink: Sink) -> base::Result<base::Api> {
        base::ensure!(
            project == self.0.inner.project,
            "ACP cwd must be the configured project"
        );
        *self.1.pending.lock().unwrap() = Some(sink);
        Ok(self.0.inner.harness.clone())
    }
    fn list(&self, project: Option<&Path>) -> base::Result<Vec<base::SessionData>> {
        base::AgentApi::list(self.0.inner.harness.as_ref(), project)
    }
    fn trust(&self, _project: &Path) -> base::Result<()> {
        base::bail!("ACP cannot change project trust")
    }
    fn initial_settings(&self) -> Value {
        self.0.inner.session_settings.clone()
    }
    async fn attach(
        &self,
        _: base::Api,
        session: &str,
        _: &Path,
        servers: Value,
    ) -> base::Result<()> {
        let sink = self
            .1
            .pending
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| base::anyhow!("no ACP sink"))?;
        base::ensure!(
            servers.as_array().is_some_and(Vec::is_empty),
            "ACP cannot add MCP servers to a composed agent"
        );
        self.1.attached.lock().unwrap().insert(session.into(), sink);
        Ok(())
    }
    async fn detach(&self, _: base::Api, session: &str) {
        self.1.attached.lock().unwrap().remove(session);
    }
}
