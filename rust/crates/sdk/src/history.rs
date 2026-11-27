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

pub use base::{TurnState, WaitingSummary};

/// The connection ceiling, scope and live offers supplied by a trusted Interface.
pub struct SessionViewer<'a> {
    pub actor: &'a str,
    pub rights: &'a crate::Rights,
    pub scope: &'a dyn Fn(&Path, Option<&str>) -> bool,
    pub route_id: Option<&'a str>,
    pub join_on_open: bool,
    /// Whether this connection holds the in-turn question ID (and, for approval, its exact view).
    pub in_turn: &'a dyn Fn(&str, bool) -> bool,
}

impl<'a> SessionViewer<'a> {
    /// A recorded actor, no tenant, executor, presence or prospective membership.
    pub fn new(actor: &'a str, rights: &'a crate::Rights) -> Self {
        Self {
            actor,
            rights,
            scope: &|_, t| t.is_none(),
            route_id: None,
            join_on_open: false,
            in_turn: &|_, _| false,
        }
    }
}

#[derive(Debug)]
pub struct SessionSummary {
    pub id: String,
    pub project: std::path::PathBuf,
    /// Unix milliseconds.
    pub updated_at: u64,
    pub waiting: WaitingSummary,
}

impl crate::Agent {
    /// Read a kept session in this agent's project without joining or starting recovery.
    pub fn session_summary(
        &self,
        id: &str,
        viewer: &SessionViewer<'_>,
    ) -> Result<Option<SessionSummary>> {
        if !self.inner.persistent {
            return Ok(None);
        }
        let history = &self.inner.history;
        let data = match history.0.inspect(id).map_err(Error::from) {
            Ok(data) => data,
            Err(e) if e.code() == Code::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        if data.project != self.inner.project {
            return Ok(None);
        }
        // An SDK session starts with the implicit local "user" grant.
        // Network bindings instead pass their own prospective admission policy.
        let viewer = SessionViewer {
            join_on_open: viewer.actor == "user"
                || (viewer.join_on_open
                    && (self.inner.several_actors || viewer.actor == base::ACP_HOST_ACTOR)),
            ..*viewer
        };
        Ok(self.session_summary_from(history, &data, &viewer, false)?)
    }

    // Bindings can reuse the committed record from a listing. A composed ACP
    // service may have a common discovery store for several projects.
    pub(crate) fn session_summary_from(
        &self,
        history: &History,
        data: &base::SessionData,
        viewer: &SessionViewer<'_>,
        running: bool,
    ) -> base::Result<Option<SessionSummary>> {
        use base::AgentApi;
        if !history.1
            || data.entries.is_empty()
            || !(viewer.scope)(&data.project, data.tenant_id())
            || history.0.check_erasure(data).is_err()
        {
            return Ok(None);
        }
        let rights = self.inner.harness.discovery_rights(
            data,
            viewer.actor,
            viewer.rights,
            viewer.join_on_open,
        )?;
        if !rights.has("watch") {
            return Ok(None);
        }
        let waiting = data.waiting_summary(
            &rights,
            viewer.actor,
            viewer.route_id,
            || {
                running
                    || self.inner.harness.is_driving_turn(&data.id)
                    || history.0.confirms_writer(&data.id)
            },
            |q, live| {
                let approval = q.kind == base::RequestKind::Approval;
                if live {
                    (viewer.in_turn)(&q.id, approval)
                } else {
                    !approval
                        || q.waits_for_approval()
                            && self.inner.harness.max_approval_wait_ms().is_some()
                            && data.settings["approvalWait"] == "untilDeadline"
                            && q.extra["deadlineAt"]
                                .as_u64()
                                .is_some_and(|end| base::now() < end)
                            && q.extra["answerers"]
                                .as_array()
                                .is_none_or(|set| set.iter().any(|a| a == viewer.actor))
                }
            },
        )?;
        Ok(Some(SessionSummary {
            id: data.id.clone(),
            project: data.project.clone(),
            updated_at: data.entries.last().map_or(0, |e| e.at),
            waiting,
        }))
    }
}

/// Saved session metadata, available without acquiring its writer lease.
#[derive(Clone, Debug)]
pub struct SessionInfo {
    pub id: String,
    pub project: std::path::PathBuf,
    pub settings: Value,
    pub model: Option<crate::ModelRef>,
    pub title: Option<String>,
    pub created_at: u64,
    /// Time of the last stored entry, or 0 if there are no entries or the last is erased.
    pub last_active: u64,
    /// A committed start on the active branch has no matching end.
    pub unfinished_turn: bool,
    pub tenant: Option<String>,
}

impl From<base::SessionData> for SessionInfo {
    fn from(data: base::SessionData) -> Self {
        let settings = base::portable::settings_to_wire(&data.settings);
        Self {
            model: serde_json::from_value(settings["model"].clone()).ok(),
            title: settings["title"].as_str().map(str::to_owned),
            unfinished_turn: base::unfinished_turns(&data.branch()).next().is_some(),
            tenant: data.tenant_id().map(str::to_owned),
            id: data.id,
            project: data.project,
            settings,
            created_at: data.entries.first().map_or(0, |e| e.at),
            // A tombstone has no time (docs/bindings/data.md), though a native
            // store keeps `at` on an erased entry: an erased last entry gives none.
            last_active: data
                .entries
                .last()
                .filter(|e| e.content.is_some())
                .map_or(0, |e| e.at),
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
