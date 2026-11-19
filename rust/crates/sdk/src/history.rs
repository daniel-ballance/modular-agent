//! History choices. The HTTP client uses the base's lease and portable-record implementation.
use crate::{Code, Error, Result, core::MemoryHistory};
use agent_api as base;
pub use history_http::ServeHistoryOptions;
use serde_json::Value;
use std::{path::Path, sync::Arc};

/// Serve a dedicated history store on loopback.
pub async fn serve_history(store: History, options: ServeHistoryOptions) -> Result<()> {
    if !store.0.supports_service_snapshots() {
        return Err(Error::new(
            Code::NotSupported,
            format!(
                "the {} history store cannot serve durable opaque snapshots",
                store.2
            ),
        ));
    }
    Ok(history_http::serve_history(store.0, options).await?)
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErasureReport {
    pub erased: Vec<ErasedEntry>,
    pub pending: Vec<ErasedEntry>,
    pub out_of_reach: Vec<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErasedEntry {
    pub session_id: String,
    pub id: String,
}

#[derive(Clone)]
pub struct History(
    pub(crate) Arc<dyn base::HistoryStore>,
    pub(crate) bool,
    pub(crate) &'static str,
);

/// Saved session metadata, available without acquiring its writer lease.
#[derive(Clone, Debug)]
pub struct SessionInfo {
    pub id: String,
    pub project: std::path::PathBuf,
    pub settings: Value,
    pub last_active: u64,
}

impl From<base::SessionData> for SessionInfo {
    fn from(data: base::SessionData) -> Self {
        Self {
            id: data.id,
            project: data.project,
            settings: data.settings,
            last_active: data.entries.last().map_or(0, |e| e.at),
        }
    }
}

impl History {
    pub fn sessions(&self, project: Option<&Path>) -> Result<Vec<SessionInfo>> {
        Ok(self
            .0
            .list(project)?
            .into_iter()
            .map(SessionInfo::from)
            .collect())
    }

    pub fn session(&self, id: &str) -> Result<SessionInfo> {
        Ok(self.0.load(id)?.into())
    }
}

/// Opt into the history service configured by the binding's environment variables.
pub fn http_history_from_env() -> Result<Option<History>> {
    Ok(history_http::HttpHistory::from_env()?
        .map(|store| History(std::sync::Arc::new(store), true, "http")))
}

pub fn memory_history() -> History {
    History(Arc::new(MemoryHistory::default()), false, "memory")
}
pub fn file_history(dir: impl AsRef<Path>) -> Result<History> {
    Ok(History(
        Arc::new(history_fs::FileHistory::new(dir.as_ref())?),
        true,
        "file",
    ))
}
pub fn http_history(url: &str, token_file: impl AsRef<Path>) -> Result<History> {
    let token = std::fs::read_to_string(token_file)?;
    if token.trim().is_empty() {
        return Err(Error::new(
            Code::InvalidParams,
            "history token file is empty",
        ));
    }
    Ok(History(
        Arc::new(history_http::HttpHistory::new(url, token.trim())?),
        true,
        "HTTP client",
    ))
}
