//! History choices. The HTTP client uses the base's lease and portable-record implementation.
use crate::{Code, Error, Result, core::MemoryHistory};
use agent_api as base;
pub use agent_api::HistoryStore;
pub use history_http::{
    EntryPage, HistoryFault, HistoryResult, HistoryServer, LeaseGrant, PortableHistoryStore,
    ServeHistoryOptions, SessionPage,
};
use serde_json::Value;
use std::{path::Path, sync::Arc};

/// Serve a dedicated history store on loopback.
pub async fn serve_history(store: History, options: ServeHistoryOptions) -> Result<()> {
    check_service(&store)?;
    if let Some(part) = store.3 {
        Ok(history_http::serve_portable_history(part, options).await?)
    } else {
        Ok(history_http::serve_history(store.0, options).await?)
    }
}

/// Bind a history service, returning its URL and a close handle when ready.
pub async fn listen_history(store: History, options: ServeHistoryOptions) -> Result<HistoryServer> {
    check_service(&store)?;
    if let Some(part) = store.3 {
        Ok(history_http::listen_portable_history(part, options).await?)
    } else {
        Ok(history_http::listen_history(store.0, options).await?)
    }
}

fn check_service(store: &History) -> Result<()> {
    if !store.3.as_ref().map_or_else(
        || store.0.supports_service_snapshots(),
        |part| store.1 && part.supports_history_service() && part.supports_erasure(),
    ) {
        return Err(Error::new(
            Code::NotSupported,
            format!(
                "the {} history store cannot serve durable opaque records, leases and tombstones",
                store.2
            ),
        ));
    }
    Ok(())
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
    pub(crate) Option<Arc<dyn PortableHistoryStore>>,
);

/// Saved session metadata, available without acquiring its writer lease.
#[derive(Clone, Debug)]
pub struct SessionInfo {
    pub id: String,
    pub project: std::path::PathBuf,
    pub settings: Value,
    pub model: Option<crate::ModelRef>,
    pub title: Option<String>,
    pub created_at: u64,
    pub last_active: u64,
}

impl From<base::SessionData> for SessionInfo {
    fn from(data: base::SessionData) -> Self {
        let settings = base::portable::settings_to_wire(&data.settings);
        Self {
            model: serde_json::from_value(settings["model"].clone()).ok(),
            title: settings["title"].as_str().map(str::to_owned),
            id: data.id,
            project: data.project,
            settings,
            created_at: data.entries.first().map_or(0, |e| e.at),
            last_active: data.entries.last().map_or(0, |e| e.at),
        }
    }
}

impl History {
    /// Adapt an advanced native snapshot store into an SDK history part.
    pub fn from_store(store: impl HistoryStore + 'static, persistent: bool) -> Self {
        Self(Arc::new(store), persistent, "custom", None)
    }

    /// Use a store that accepts opaque shared records and fences appends with the
    /// active writer token. The agent owns reconstruction and lease renewal.
    pub fn from_portable(store: impl PortableHistoryStore, persistent: bool) -> Result<Self> {
        Self::from_named_portable("portable custom", store, persistent)
    }

    /// Name a custom store for diagnostics, including refusal to serve it.
    pub fn from_named_portable(
        name: &'static str,
        store: impl PortableHistoryStore,
        persistent: bool,
    ) -> Result<Self> {
        let store = Arc::new(store);
        Ok(Self(
            Arc::new(history_http::HttpHistory::from_store(store.clone())?),
            persistent,
            name,
            Some(store),
        ))
    }

    pub fn sessions(&self, project: Option<&Path>) -> Result<Vec<SessionInfo>> {
        let project = project.map(Path::canonicalize).transpose()?;
        Ok(self
            .0
            .list(project.as_deref())?
            .into_iter()
            .map(SessionInfo::from)
            .collect())
    }

    pub fn session_info(&self, id: &str) -> Result<SessionInfo> {
        Ok(self.0.load(id)?.into())
    }
}

/// Opt into the history service configured by the binding's environment variables.
pub fn http_history_from_env() -> Result<Option<History>> {
    Ok(history_http::HttpHistory::from_env()?
        .map(|store| History(std::sync::Arc::new(store), true, "http", None)))
}

pub fn memory_history() -> History {
    History(Arc::new(MemoryHistory::default()), false, "memory", None)
}
/// A dedicated file store for opaque records. Use a directory separate from
/// native file history. When serving this store, set `ServeHistoryOptions::lease_ttl`
/// to the same duration so the declaration matches the TTL the store enforces.
pub fn portable_file_history(
    dir: impl AsRef<Path>,
    lease_ttl: std::time::Duration,
    max_sessions: usize,
) -> Result<History> {
    let snapshots = history_fs::FileHistory::new(dir.as_ref())?;
    let store = history_http::SnapshotStore::new(Arc::new(snapshots), lease_ttl, max_sessions)?;
    History::from_named_portable("portable file", Arc::new(store), true)
}

pub fn file_history(dir: impl AsRef<Path>) -> Result<History> {
    Ok(History(
        Arc::new(history_fs::FileHistory::new(dir.as_ref())?),
        true,
        "file",
        None,
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
        None,
    ))
}
