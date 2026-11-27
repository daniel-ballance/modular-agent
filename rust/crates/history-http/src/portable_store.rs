//! Portable operations implemented by an embedded store. The history client
//! drives exactly the same lease and projection code as it does over HTTP.
use agent_api::*;
use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseGrant {
    pub lease: String,
    pub ttl_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionPage {
    pub sessions: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EntryPage {
    pub session: Value,
    pub entries: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
}

#[derive(Clone, Debug)]
#[non_exhaustive]
pub enum HistoryFault {
    UnknownSession,
    UnknownEntry,
    UnknownIntent,
    StaleRevision,
    RequestTooLarge,
    Held {
        retry_after_ms: u64,
    },
    Lost,
    Conflict,
    EntryTooLarge,
    Unavailable,
    InvalidRequest,
    /// The store cannot tell whether the mutation committed.
    Uncertain,
}

pub type HistoryResult<T> = std::result::Result<T, HistoryFault>;

/// A store owns the atomic boundary: every append and erase must check the
/// supplied lease in the same transaction as the commit. Entry bodies are
/// opaque except for ids, equality on append and tombstone projection.
///
/// HTTP calls on separate connections can overlap. Yield during slow I/O and
/// keep renewal independent of storage locks and queues held by other sessions.
#[async_trait]
pub trait PortableHistoryStore: Send + Sync + 'static {
    fn ttl_ms(&self) -> u64;
    /// Opt in only if leases (or an exclusion bound), opaque records, durable
    /// commits and tombstones satisfy the history binding across restarts.
    fn supports_history_service(&self) -> bool {
        false
    }
    fn supports_erasure(&self) -> bool {
        false
    }
    /// Opt in only if the store implements all operations of `pendingErasure: 1`.
    fn pending_erasure_v1(&self) -> bool {
        false
    }
    fn pending_erasure_index_v1(&self) -> bool {
        false
    }
    async fn erasure_index(&self, _after: Option<&str>, _limit: usize) -> HistoryResult<Value> {
        Err(HistoryFault::Unavailable)
    }
    async fn erasure_plans(
        &self,
        _session: &str,
        _after: Option<&str>,
        _limit: usize,
    ) -> HistoryResult<Value> {
        Err(HistoryFault::Unavailable)
    }
    async fn publish_erasure(&self, _session: &str, _body: Value) -> HistoryResult<Value> {
        Err(HistoryFault::Unavailable)
    }
    async fn complete_erasure(
        &self,
        _session: &str,
        _intent: &str,
        _body: Value,
    ) -> HistoryResult<Value> {
        Err(HistoryFault::Unavailable)
    }
    async fn guarded_append(
        &self,
        _session: &str,
        _lease: &str,
        _entries: Vec<Value>,
        _revision: &str,
    ) -> HistoryResult<u64> {
        Err(HistoryFault::Unavailable)
    }
    async fn create(&self, session: &str, metadata: Value) -> HistoryResult<()>;
    async fn acquire(&self, session: &str, owner: &str) -> HistoryResult<LeaseGrant>;
    async fn renew(&self, session: &str, lease: &str) -> HistoryResult<u64>;
    /// If the backend detects revocation independently of renewal, expose a
    /// level-triggered signal, including for a lease already revoked.
    fn writer_lost(&self, _session: &str, _lease: &str) -> Option<CancellationToken> {
        None
    }
    async fn release(&self, session: &str, lease: &str) -> HistoryResult<()>;
    async fn append(&self, session: &str, lease: &str, entries: Vec<Value>) -> HistoryResult<u64>;
    async fn read(
        &self,
        session: &str,
        after: Option<&str>,
        limit: usize,
    ) -> HistoryResult<EntryPage>;
    async fn list(
        &self,
        project: Option<&Path>,
        after: Option<&str>,
        limit: usize,
    ) -> HistoryResult<SessionPage>;
    async fn erase(
        &self,
        _session: &str,
        _lease: Option<&str>,
        _entry_ids: Vec<String>,
    ) -> HistoryResult<Vec<String>> {
        Err(HistoryFault::InvalidRequest)
    }
}

pub(super) struct RequestOptions<'a> {
    pub project: Option<&'a Path>,
    pub after: Option<&'a str>,
    pub limit: usize,
    pub revision: Option<&'a str>,
}

pub(super) async fn request(
    store: &dyn PortableHistoryStore,
    method: Method,
    path: &[&str],
    body: Option<Value>,
    options: RequestOptions<'_>,
) -> Result<(StatusCode, Value)> {
    let RequestOptions {
        project,
        after,
        limit,
        revision,
    } = options;
    let body = body.unwrap_or_default();
    let reply: HistoryResult<Value> = match (method, path) {
        (Method::GET, ["v1"]) => {
            let mut declaration =
                json!({"binding":"modular-agent-history/1", "ttlMs":store.ttl_ms()});
            if store.pending_erasure_v1() {
                declaration["pendingErasure"] = json!(1);
                if store.pending_erasure_index_v1() {
                    declaration["pendingErasureIndex"] = json!(1);
                }
            }
            Ok(declaration)
        }
        (Method::GET, ["v1", "pending-erasure"]) => store.erasure_index(after, limit).await,
        (Method::GET, ["v1", "sessions", id, "pending-erasure"]) => {
            store.erasure_plans(id, after, limit).await
        }
        (Method::POST, ["v1", "sessions", id, "pending-erasure"]) => {
            store.publish_erasure(id, body).await
        }
        (Method::POST, ["v1", "sessions", id, "pending-erasure", intent, "complete"]) => {
            store.complete_erasure(id, intent, body).await
        }
        (Method::PUT, ["v1", "sessions", id]) => store.create(id, body).await.map(|()| json!({})),
        (Method::GET, ["v1", "sessions"]) => {
            store.list(project, after, limit).await.map(|v| json!(v))
        }
        (Method::GET, ["v1", "sessions", id]) => {
            store.read(id, after, limit).await.map(|v| json!(v))
        }
        (Method::POST, ["v1", "sessions", id, "lease"]) => store
            .acquire(id, wire::string(&body, "owner")?)
            .await
            .map(|v| json!(v)),
        (Method::POST, ["v1", "sessions", id, "lease", token, "renew"]) => {
            store.renew(id, token).await.map(|ttl| json!({"ttlMs":ttl}))
        }
        (Method::DELETE, ["v1", "sessions", id, "lease", token]) => {
            store.release(id, token).await.map(|()| json!({}))
        }
        (Method::POST, ["v1", "sessions", id, "entries"]) => {
            let lease = wire::string(&body, "lease")?;
            let entries = serde_json::from_value(body["entries"].clone())?;
            let result = if let Some(revision) = revision.filter(|_| store.pending_erasure_v1()) {
                store.guarded_append(id, lease, entries, revision).await
            } else {
                store.append(id, lease, entries).await
            };
            result.map(|kept| json!({"kept":kept}))
        }
        (Method::POST, ["v1", "sessions", id, "erase"]) => store
            .erase(
                id,
                body["lease"].as_str(),
                serde_json::from_value(body["entryIds"].clone())?,
            )
            .await
            .map(|erased| json!({"erased":erased})),
        _ => Err(HistoryFault::InvalidRequest),
    };
    let fault = match reply {
        Ok(body) => return Ok((StatusCode::OK, body)),
        Err(fault) => fault,
    };
    let (status, code) = match fault {
        HistoryFault::UnknownSession => (StatusCode::NOT_FOUND, "unknown_session"),
        HistoryFault::UnknownEntry => (StatusCode::NOT_FOUND, "unknown_entry"),
        HistoryFault::UnknownIntent => (StatusCode::NOT_FOUND, "unknown_intent"),
        HistoryFault::StaleRevision => (StatusCode::CONFLICT, "stale_revision"),
        HistoryFault::RequestTooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "request_too_large"),
        HistoryFault::Held { retry_after_ms } => {
            return Ok((
                StatusCode::CONFLICT,
                json!({"error":"held","code":"held","retryAfterMs":retry_after_ms}),
            ));
        }
        HistoryFault::Lost => (StatusCode::CONFLICT, "lost"),
        HistoryFault::Conflict => (StatusCode::CONFLICT, "conflict"),
        HistoryFault::EntryTooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "entry_too_large"),
        HistoryFault::Unavailable => (StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
        HistoryFault::InvalidRequest => (StatusCode::BAD_REQUEST, "invalid_request"),
        HistoryFault::Uncertain => {
            bail!("history store cannot confirm whether the mutation committed")
        }
    };
    Ok((status, json!({"error":code,"code":code})))
}
