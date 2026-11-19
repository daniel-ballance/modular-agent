//! The parts every SDK agent has: configuration, credentials and history.
use agent_api::*;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::{Arc, Mutex},
};

pub(crate) struct CorePlugin {
    pub settings: Value,
    pub history: Arc<dyn HistoryStore>,
}

impl Plugin for CorePlugin {
    fn name(&self) -> &str {
        "sdk.core"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.provide::<dyn Configuration>("configuration", Arc::new(Defaults(self.settings.clone())))?;
        r.provide::<dyn CredentialStore>("credentials", Arc::new(EnvironmentCredentials))?;
        r.provide::<dyn HistoryStore>("history", self.history.clone())
    }
}

pub(crate) struct SdkJobs(pub bool);
impl Plugin for SdkJobs {
    fn name(&self) -> &str {
        feature_jobs::JobsPlugin.name()
    }
    fn install(&self, registrar: &mut Registrar<'_>) -> Result<()> {
        feature_jobs::JobsPlugin.install(registrar)?;
        registrar.declare(json!({"job_reports_start_turns":self.0,"starts_unasked_turns":self.0}));
        Ok(())
    }
}

/// Default settings for new sessions, from `createAgent`.
struct Defaults(Value);
impl Configuration for Defaults {
    fn settings(&self, _: &Path) -> Result<Value> {
        Ok(self.0.clone())
    }
}

/// Credentials from environment variables, by the names each Provider documents.
struct EnvironmentCredentials;
impl CredentialStore for EnvironmentCredentials {
    fn get(&self, name: &str) -> Result<String> {
        let key = match name {
            "openai" => "OPENAI_API_KEY".to_owned(),
            "anthropic" => "ANTHROPIC_API_KEY".to_owned(),
            other => other.to_ascii_uppercase().replace('-', "_") + "_API_KEY",
        };
        std::env::var(&key).map_err(|_| anyhow!("credential {key} is not set in the environment"))
    }
}

/// History kept in memory: nothing survives the process.
#[derive(Default)]
pub(crate) struct MemoryHistory(Arc<Mutex<Memory>>);
#[derive(Default)]
struct Memory {
    sessions: BTreeMap<String, SessionData>,
    held: BTreeSet<String>,
}
struct MemoryLease(Arc<Mutex<Memory>>, String);
impl Lease for MemoryLease {}
impl Drop for MemoryLease {
    fn drop(&mut self) {
        if let Ok(mut m) = self.0.lock() {
            m.held.remove(&self.1);
        }
    }
}
impl HistoryStore for MemoryHistory {
    fn acquire(&self, session: &str) -> Result<Box<dyn Lease>> {
        let mut m = self.0.lock().unwrap();
        ensure!(
            m.held.insert(session.into()),
            OperationError::Busy(format!("session {session} is held by another writer"))
        );
        Ok(Box::new(MemoryLease(self.0.clone(), session.into())))
    }
    fn load(&self, session: &str) -> Result<SessionData> {
        self.0
            .lock()
            .unwrap()
            .sessions
            .get(session)
            .cloned()
            .ok_or_else(|| anyhow!(std::io::Error::from(std::io::ErrorKind::NotFound)))
    }
    fn save(&self, session: &SessionData) -> Result<()> {
        self.0
            .lock()
            .unwrap()
            .sessions
            .insert(session.id.clone(), session.clone());
        Ok(())
    }
    fn list(&self, project: Option<&Path>) -> Result<Vec<SessionData>> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .sessions
            .values()
            .filter(|s| project.is_none_or(|p| s.project == p))
            .cloned()
            .collect())
    }
    fn erase(&self, _: Vec<String>, _: &[String]) -> Result<Vec<SessionData>> {
        bail!("erasure is not supported by the memory store yet")
    }
}
