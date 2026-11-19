//! History choices. The HTTP client uses the base's lease and portable-record implementation.
use crate::{Code, Error, Result, core::MemoryHistory};
use agent_api as base;
pub use history_http::ServeHistoryOptions;
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
