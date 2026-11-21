//! Loopback HTTP transport for the opaque history binding.
use super::{
    BODY_LIMIT, EntryPage, HistoryFault, HistoryResult, LeaseGrant, PAGE_LIMIT,
    PortableHistoryStore, SessionPage,
    pending::{self, Intent, Publication, Registry},
    portable_store,
};
use agent_api::{
    Entry, HistoryStore, Lease, OperationError, Scope, SessionData, Value, anyhow, ensure, json,
    wire,
};
use http_body_util::{BodyExt, Full};
use hyper::{
    Method, Request, Response, StatusCode,
    body::{Bytes, Incoming},
    header,
    server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;

const CONTROL: &str = "history-service-control-v1";
const PREFIX: &str = "history-service-v1-";
const MAX_COUNT: u64 = 9_007_199_254_740_991;

/// Options for a dedicated loopback service (one bearer identity). The operator must
/// trust all local accounts and provision a token with at least 128 bits of entropy.
#[derive(Clone, Debug)]
pub struct ServeHistoryOptions {
    pub address: SocketAddr,
    pub token_file: PathBuf,
    pub ttl: Duration,
    pub max_sessions: usize,
}
impl ServeHistoryOptions {
    pub fn new(address: SocketAddr, token_file: impl Into<PathBuf>) -> Self {
        Self {
            address,
            token_file: token_file.into(),
            ttl: Duration::from_millis(2500),
            max_sessions: 10_000,
        }
    }
}

/// Serve a dedicated durable snapshot store until the future is dropped.
/// Plaintext is only supported on loopback.
pub async fn serve_history(
    store: Arc<dyn HistoryStore>,
    options: ServeHistoryOptions,
) -> agent_api::Result<()> {
    let (listener, server) = prepare(store, options).await?;
    drive(listener, server).await
}

/// A bound listener and its task. Dropping or closing the handle stops the service.
pub struct HistoryServer {
    pub url: String,
    task: tokio::task::JoinHandle<agent_api::Result<()>>,
}
impl HistoryServer {
    pub async fn close(mut self) {
        self.task.abort();
        let _ = (&mut self.task).await;
    }
}
impl Drop for HistoryServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub async fn listen_history(
    store: Arc<dyn HistoryStore>,
    options: ServeHistoryOptions,
) -> agent_api::Result<HistoryServer> {
    let (listener, server) = prepare(store, options).await?;
    Ok(HistoryServer {
        url: format!("http://{}", listener.local_addr()?),
        task: tokio::spawn(drive(listener, server)),
    })
}

pub async fn serve_portable_history(
    part: Arc<dyn PortableHistoryStore>,
    options: ServeHistoryOptions,
) -> agent_api::Result<()> {
    let (listener, server) = prepare_backend(Backend::Portable(part), options).await?;
    drive(listener, server).await
}

pub async fn listen_portable_history(
    part: Arc<dyn PortableHistoryStore>,
    options: ServeHistoryOptions,
) -> agent_api::Result<HistoryServer> {
    let (listener, server) = prepare_backend(Backend::Portable(part), options).await?;
    Ok(HistoryServer {
        url: format!("http://{}", listener.local_addr()?),
        task: tokio::spawn(drive(listener, server)),
    })
}

async fn prepare(
    store: Arc<dyn HistoryStore>,
    options: ServeHistoryOptions,
) -> agent_api::Result<(tokio::net::TcpListener, Arc<Server>)> {
    let ttl = options.ttl;
    let max_sessions = options.max_sessions;
    let store =
        tokio::task::spawn_blocking(move || SnapshotStore::new(store, ttl, max_sessions)).await??;
    prepare_backend(Backend::Snapshot(Arc::new(store)), options).await
}

async fn prepare_backend(
    backend: Backend,
    options: ServeHistoryOptions,
) -> agent_api::Result<(tokio::net::TcpListener, Arc<Server>)> {
    if let Backend::Portable(store) = &backend {
        ensure!(
            store.supports_history_service() && store.supports_erasure(),
            "history store cannot serve durable opaque records, leases and tombstones"
        );
        ensure!(
            (1..=MAX_COUNT).contains(&store.ttl_ms()),
            "invalid history lease TTL"
        );
    }
    ensure!(
        options.address.ip().is_loopback(),
        "plaintext history service must listen on loopback"
    );
    let token = std::fs::read_to_string(&options.token_file)?;
    let token = token.trim_matches([' ', '\t', '\r', '\n']);
    let bare = token.trim_end_matches('=');
    ensure!(
        bare.len() >= 22
            && bare
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-._~+/".contains(&c)),
        "history bearer token must encode at least 128 random bits"
    );
    let token = Sha256::digest(token).into();
    let server = Arc::new(Server { token, backend });
    let listener = tokio::net::TcpListener::bind(options.address).await?;
    Ok((listener, server))
}

async fn drive(listener: tokio::net::TcpListener, server: Arc<Server>) -> agent_api::Result<()> {
    let mut connections = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let server = server.clone();
                connections.spawn(async move {
                    let _ = http1::Builder::new().timer(hyper_util::rt::TokioTimer::new())
                        .serve_connection(TokioIo::new(stream), service_fn(move |req| handle(server.clone(), req))).await;
                });
            }
            _ = connections.join_next(), if !connections.is_empty() => (),
        }
    }
}

struct Server {
    token: [u8; 32],
    backend: Backend,
}
enum Backend {
    Snapshot(Arc<SnapshotStore>),
    Portable(Arc<dyn PortableHistoryStore>),
}

/// Durable portable records over a dedicated native snapshot store. Holds
/// exclusive access and records a conservative restart exclusion bound.
pub struct SnapshotStore {
    store: Arc<dyn HistoryStore>,
    _exclusive: Box<dyn Lease>,
    ttl_ms: u64,
    hold: Option<Instant>,
    max_sessions: usize,
    state: Mutex<State>,
}
struct State {
    leases: HashMap<String, Grant>,
    // Reads and mutations share this lock. A new random epoch on startup
    // invalidates every old observation, even after an uncertain save.
    revision: String,
}
impl State {
    fn advance(revision: &mut String) -> std::result::Result<(), Failure> {
        *revision = nonce()?;
        Ok(())
    }
}
struct Grant {
    token: String,
    owner: String,
    until: Instant,
}
struct Snapshot {
    metadata: Value,
    entries: Vec<Value>,
}

impl SnapshotStore {
    pub fn new(
        store: Arc<dyn HistoryStore>,
        ttl: Duration,
        max_sessions: usize,
    ) -> agent_api::Result<Self> {
        ensure!(
            store.supports_service_snapshots(),
            "the history service requires durable opaque snapshots and exclusive writer leases"
        );
        let ttl_ms = u64::try_from(ttl.as_millis())?;
        ensure!(
            (1..=MAX_COUNT).contains(&ttl_ms) && ttl == Duration::from_millis(ttl_ms),
            "history lease TTL must be a positive whole number of milliseconds"
        );
        ensure!(max_sessions > 0, "history session quota must be positive");
        let exclusive = store.acquire(CONTROL)?;
        let (prior, mut control) = match store.load(CONTROL) {
            Ok(data) => {
                let bound = data.settings["historyTtlBound"]
                    .as_u64()
                    .filter(|ms| (1..=MAX_COUNT).contains(ms))
                    .ok_or_else(|| anyhow!("unknown previous history lease bound"))?;
                (Some(bound), data)
            }
            Err(e) if missing(&e) => {
                ensure!(
                    store.list(None)?.is_empty(),
                    "history service needs a dedicated store with a verifiable lease bound"
                );
                (
                    None,
                    snapshot_data(
                        CONTROL.into(),
                        json!({"pendingErasureV1": Registry::default()}),
                        vec![],
                    ),
                )
            }
            Err(e) => return Err(e),
        };
        let bound = ttl_ms.max(prior.unwrap_or(0));
        let migrated = if !control.settings["pendingErasure"].is_null() {
            if control.settings.get("pendingErasureV1").is_none()
                && let Ok(registry) = Registry::migrate(control.settings["pendingErasure"].clone())
            {
                control.settings["pendingErasureV1"] = json!(registry);
                control
                    .settings
                    .as_object_mut()
                    .unwrap()
                    .remove("pendingErasure");
                true
            } else {
                false
            }
        } else {
            false
        };
        if prior != Some(bound) || migrated {
            control.settings["historyTtlBound"] = json!(bound);
            store.save(&control)?;
        }
        let hold = prior.map(|_| Instant::now() + Duration::from_millis(bound));
        Ok(Self {
            store,
            _exclusive: exclusive,
            ttl_ms,
            hold,
            max_sessions,
            state: Mutex::new(State {
                leases: HashMap::new(),
                revision: nonce().map_err(|_| anyhow!("cannot generate history revision"))?,
            }),
        })
    }

    fn load(&self, id: &str) -> std::result::Result<Option<Snapshot>, Failure> {
        match self.store.load(&storage_key(id)) {
            Ok(data) => {
                let record = unpack(data)?;
                if record.metadata["id"] != id {
                    return Err(Failure::unavailable());
                }
                Ok(Some(record))
            }
            Err(e) if missing(&e) => Ok(None),
            Err(_) => Err(Failure::unavailable()),
        }
    }

    fn save(&self, id: &str, record: Snapshot) -> std::result::Result<(), Failure> {
        let Snapshot { metadata, entries } = record;
        let data = snapshot_data(storage_key(id), metadata, entries);
        // A backend error may have been raised after its atomic rename/commit.
        self.store.save(&data).map_err(|_| Failure::Uncertain)
    }

    fn registry(&self) -> std::result::Result<(SessionData, Registry), Failure> {
        let control = self
            .store
            .load(CONTROL)
            .map_err(|_| Failure::unavailable())?;
        let registry = serde_json::from_value(control.settings["pendingErasureV1"].clone())
            .map_err(|_| Failure::unavailable())?;
        Ok((control, registry))
    }

    fn save_registry(
        &self,
        mut control: SessionData,
        registry: Registry,
        revision: &mut String,
    ) -> Answer {
        State::advance(revision)?;
        control.settings["pendingErasureV1"] = json!(registry);
        self.store.save(&control).map_err(|_| Failure::Uncertain)?;
        Ok(json!({}))
    }

    fn publish(&self, session: &str, request: Publication, revision: &mut String) -> Answer {
        let (control, mut registry) = self.registry()?;
        let targets = request.entry_ids.into_iter().collect();
        if let Some(intent) = registry.intents.iter().find(|i| i.id == request.intent_id) {
            return if intent.source == session
                && intent.targets == targets
                && intent.same_copies(&request.copies)
            {
                Ok(json!({"intentId":intent.id}))
            } else {
                Err(Failure::conflict())
            };
        }
        if let Some(intent) = registry
            .intents
            .iter()
            .find(|i| i.source == session && i.targets == targets)
        {
            return Ok(json!({"intentId":intent.id}));
        }
        if request.revision != *revision {
            return Err(Failure::http(409, "stale_revision"));
        }
        let intent = Intent::new(session, request.intent_id, targets, request.copies);
        for (sid, plan) in &intent.plans {
            let record = self
                .load(sid)?
                .ok_or_else(|| Failure::http(404, "unknown_session"))?;
            let entries: HashSet<_> = record
                .entries
                .iter()
                .filter_map(|e| e["id"].as_str())
                .collect();
            if plan
                .copies
                .iter()
                .any(|copy| !entries.contains(copy.entry_id.as_str()))
            {
                return Err(Failure::http(404, "unknown_entry"));
            }
            if entries.contains(plan.record_id.as_str())
                || registry.plans(sid).any(|p| p.record_id == plan.record_id)
            {
                return Err(Failure::conflict());
            }
            if !fits(&json!({"revision":"A".repeat(128),"plans":[plan],"next":intent.id})) {
                return Err(Failure::http(413, "request_too_large"));
            }
        }
        let reply = json!({"intentId":intent.id});
        registry.intents.push(intent);
        self.save_registry(control, registry, revision)?;
        Ok(reply)
    }

    fn complete(
        &self,
        session: &str,
        intent: &str,
        record: &Snapshot,
        ids: Value,
        revision: &mut String,
    ) -> Answer {
        let (control, mut registry) = self.registry()?;
        let plan = registry
            .intents
            .iter_mut()
            .find(|i| i.id == intent)
            .and_then(|i| i.plans.iter_mut().find(|(sid, _)| sid == session))
            .map(|(_, plan)| plan)
            .ok_or_else(|| Failure::http(404, "unknown_intent"))?;
        let ids: Vec<String> = serde_json::from_value(ids).map_err(|_| Failure::invalid())?;
        let ids: HashSet<_> = ids.iter().map(String::as_str).collect();
        if plan
            .copies
            .iter()
            .filter(|c| ids.contains(c.entry_id.as_str()))
            .count()
            != ids.len()
        {
            return Err(Failure::invalid());
        }
        let bookkeeping = record
            .entries
            .iter()
            .find(|e| e["id"] == plan.record_id && e["kind"] == "erasure" && e["erased"] != true)
            .and_then(|e| e["data"]["entryIds"].as_array())
            .ok_or_else(Failure::conflict)?;
        let listed: HashSet<_> = bookkeeping.iter().filter_map(Value::as_str).collect();
        let tombstones: HashSet<_> = record
            .entries
            .iter()
            .filter(|e| e["erased"] == true)
            .filter_map(|e| e["id"].as_str())
            .collect();
        if !ids.is_subset(&listed) || !ids.is_subset(&tombstones) {
            return Err(Failure::conflict());
        }
        let mut changed = false;
        for copy in &mut plan.copies {
            if ids.contains(copy.entry_id.as_str()) && !copy.complete {
                copy.complete = true;
                changed = true;
            }
        }
        if changed {
            self.save_registry(control, registry, revision)
        } else {
            Ok(json!({}))
        }
    }

    fn apply(&self, route: Route, op: Op, query: Query, mut body: Value) -> Answer {
        let mut state = self.state.lock().map_err(|_| Failure::unavailable())?;
        let State { leases, revision } = &mut *state;
        let now = Instant::now();
        leases.retain(|_, lease| lease.until > now);
        let id = match route {
            Route::Root => {
                return Ok(
                    json!({"binding":"modular-agent-history/1","ttlMs":self.ttl_ms,"pendingErasure":1}),
                );
            }
            Route::Sessions => {
                let mut rows = self
                    .store
                    .list(None)
                    .map_err(|_| Failure::unavailable())?
                    .into_iter()
                    .filter(|s| s.id.starts_with(PREFIX) && !s.entries.is_empty())
                    .map(|s| Ok(unpack(s)?.metadata))
                    .collect::<std::result::Result<Vec<_>, Failure>>()?;
                rows.retain(|m| query.project.as_ref().is_none_or(|p| m["project"] == *p));
                rows.sort_by(|a, b| {
                    count(&b["created"])
                        .cmp(&count(&a["created"]))
                        .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
                });
                return page(json!({}), "sessions", &rows, query, "unknown_session");
            }
            Route::Pending(ref id) if matches!(op, Op::Get) => {
                let (_, registry) = self.registry()?;
                if self.load(id)?.is_none() {
                    return Err(Failure::http(404, "unknown_session"));
                }
                let plans: Vec<_> = registry.plans(id).map(|p| json!(p)).collect();
                return page_with_cursor(
                    json!({"revision":revision}),
                    "plans",
                    &plans,
                    query,
                    "intentId",
                    "unknown_intent",
                );
            }
            Route::Session(ref id)
            | Route::Acquire(ref id)
            | Route::Lease(ref id, _)
            | Route::Renew(ref id, _)
            | Route::Entries(ref id)
            | Route::Erase(ref id)
            | Route::Pending(ref id)
            | Route::Complete(ref id, _) => id,
        };
        if matches!(op, Op::Put) {
            body["id"] = json!(id);
            if let Some(old) = self.load(id)? {
                return if wire::json_eq(&old.metadata, &body) {
                    Ok(json!({}))
                } else {
                    Err(Failure::conflict())
                };
            }
            if !fits(&json!({"session":body,"entries":[]}))
                || !fits(&json!({"sessions":[body],"next":id}))
            {
                return Err(Failure::http(413, "request_too_large"));
            }
            if self
                .store
                .list(None)
                .map_err(|_| Failure::unavailable())?
                .len()
                > self.max_sessions
            {
                return Err(Failure::unavailable());
            }
            State::advance(revision)?;
            self.save(
                id,
                Snapshot {
                    metadata: body,
                    entries: vec![],
                },
            )?;
            return Ok(json!({}));
        }
        let mut record = self
            .load(id)?
            .ok_or_else(|| Failure::http(404, "unknown_session"))?;
        let now = Instant::now();
        leases.retain(|_, lease| lease.until > now);
        let hold = self.hold.filter(|until| *until > now);
        let active = leases.get_mut(id);
        let ttl = Duration::from_millis(self.ttl_ms);
        match op {
            Op::Get => page(
                json!({"session":record.metadata}),
                "entries",
                &record.entries,
                query,
                "unknown_entry",
            ),
            Op::Acquire => {
                if let Some(until) = hold {
                    return Err(Failure::held(until));
                }
                let owner = body["owner"].as_str().unwrap();
                if let Some(grant) = active {
                    if grant.owner != owner {
                        return Err(Failure::held(grant.until));
                    }
                    return Ok(json!({"lease":grant.token,"ttlMs":self.ttl_ms}));
                }
                let token = nonce()?;
                leases.insert(
                    id.clone(),
                    Grant {
                        token: token.clone(),
                        owner: owner.into(),
                        until: Instant::now() + ttl,
                    },
                );
                Ok(json!({"lease":token,"ttlMs":self.ttl_ms}))
            }
            Op::Renew => {
                let Route::Renew(_, token) = route else {
                    unreachable!()
                };
                let grant = active
                    .filter(|g| g.token == token)
                    .ok_or_else(Failure::lost)?;
                grant.until = Instant::now() + ttl;
                Ok(json!({"ttlMs":self.ttl_ms}))
            }
            Op::Release => {
                let Route::Lease(_, ref token) = route else {
                    unreachable!()
                };
                if active.is_some_and(|g| g.token == *token) {
                    leases.remove(id);
                }
                Ok(json!({}))
            }
            Op::Append => {
                if !active.is_some_and(|g| body["lease"] == g.token) {
                    return Err(Failure::lost());
                }
                if let Some(guard) = &query.revision {
                    self.registry()?;
                    if guard != revision {
                        return Err(Failure::http(409, "stale_revision"));
                    }
                }
                let more = body["entries"].take();
                let added = stage(&record, more.as_array().unwrap())?;
                let kept = added.len();
                if kept != 0 {
                    State::advance(revision)?;
                    record.entries.extend(added);
                    self.save(id, record)?;
                }
                Ok(json!({"kept":kept}))
            }
            Op::Erase => {
                if let Some(token) = body.get("lease") {
                    if !active.is_some_and(|g| *token == g.token) {
                        return Err(Failure::lost());
                    }
                } else if let Some(until) = hold.or_else(|| active.map(|g| g.until)) {
                    return Err(Failure::held(until));
                }
                let mut entries = record
                    .entries
                    .iter_mut()
                    .map(|e| (e["id"].as_str().unwrap().to_owned(), e))
                    .collect::<HashMap<_, _>>();
                let mut erased = vec![];
                let mut changed = false;
                for target in body["entryIds"].as_array().unwrap() {
                    if let Some(entry) = entries.remove(target.as_str().unwrap()) {
                        erased.push(target);
                        if entry["erased"] != true {
                            *entry = tombstone(entry);
                            changed = true;
                        }
                    }
                }
                if changed {
                    State::advance(revision)?;
                    self.save(id, record)?;
                }
                Ok(json!({"erased":erased}))
            }
            Op::Mark | Op::Complete => {
                if !active.is_some_and(|g| body["lease"] == g.token) {
                    return Err(Failure::lost());
                }
                match route {
                    Route::Pending(_) => self.publish(
                        id,
                        serde_json::from_value(body).map_err(|_| Failure::invalid())?,
                        revision,
                    ),
                    Route::Complete(_, ref intent) => {
                        self.complete(id, intent, &record, body["entryIds"].take(), revision)
                    }
                    _ => unreachable!(),
                }
            }
            Op::Put => unreachable!(),
        }
    }
}

impl From<Failure> for HistoryFault {
    fn from(fault: Failure) -> Self {
        match fault {
            Failure::Held(until) => Self::Held {
                retry_after_ms: until
                    .saturating_duration_since(Instant::now())
                    .as_nanos()
                    .div_ceil(1_000_000)
                    .max(1) as u64,
            },
            Failure::Uncertain => Self::Uncertain,
            Failure::Http(_, code, _) => match code {
                "unknown_session" => Self::UnknownSession,
                "unknown_entry" => Self::UnknownEntry,
                "unknown_intent" => Self::UnknownIntent,
                "stale_revision" => Self::StaleRevision,
                "invalid_request" => Self::InvalidRequest,
                "lost" => Self::Lost,
                "conflict" => Self::Conflict,
                "entry_too_large" => Self::EntryTooLarge,
                "request_too_large" => Self::RequestTooLarge,
                _ => Self::Unavailable,
            },
        }
    }
}

impl SnapshotStore {
    async fn portable(
        self: Arc<Self>,
        mut route: Route,
        op: Op,
        query: Query,
        body: Value,
    ) -> HistoryResult<Value> {
        route.validate()?;
        op.validate_body(&body, body.is_null())?;
        validate_source(&route, &op, &body)?;
        tokio::task::spawn_blocking(move || self.apply(route, op, query, body))
            .await
            .map_err(|_| HistoryFault::Uncertain)?
            .map_err(Into::into)
    }
}

#[agent_api::async_trait]
impl PortableHistoryStore for Arc<SnapshotStore> {
    fn ttl_ms(&self) -> u64 {
        self.ttl_ms
    }
    fn supports_erasure(&self) -> bool {
        true
    }
    fn supports_history_service(&self) -> bool {
        true
    }

    fn pending_erasure_v1(&self) -> bool {
        true
    }
    async fn erasure_plans(
        &self,
        session: &str,
        after: Option<&str>,
        limit: usize,
    ) -> HistoryResult<Value> {
        self.clone()
            .portable(
                Route::Pending(session.into()),
                Op::Get,
                Query {
                    after: after.map(str::to_owned),
                    limit: limit.clamp(1, 500),
                    ..Query::default()
                },
                Value::Null,
            )
            .await
    }
    async fn publish_erasure(&self, session: &str, body: Value) -> HistoryResult<Value> {
        self.clone()
            .portable(
                Route::Pending(session.into()),
                Op::Mark,
                Query::default(),
                body,
            )
            .await
    }
    async fn complete_erasure(
        &self,
        session: &str,
        intent: &str,
        body: Value,
    ) -> HistoryResult<Value> {
        self.clone()
            .portable(
                Route::Complete(session.into(), intent.into()),
                Op::Complete,
                Query::default(),
                body,
            )
            .await
    }
    async fn guarded_append(
        &self,
        session: &str,
        lease: &str,
        entries: Vec<Value>,
        revision: &str,
    ) -> HistoryResult<u64> {
        if !valid_lease(revision) {
            return Err(HistoryFault::InvalidRequest);
        }
        let reply = self
            .clone()
            .portable(
                Route::Entries(session.into()),
                Op::Append,
                Query {
                    revision: Some(revision.into()),
                    ..Query::default()
                },
                json!({"lease":lease,"entries":entries}),
            )
            .await?;
        reply["kept"].as_u64().ok_or(HistoryFault::Unavailable)
    }

    async fn create(&self, session: &str, metadata: Value) -> HistoryResult<()> {
        self.clone()
            .portable(
                Route::Session(session.into()),
                Op::Put,
                Query::default(),
                metadata,
            )
            .await
            .map(|_| ())
    }
    async fn acquire(&self, session: &str, owner: &str) -> HistoryResult<LeaseGrant> {
        let grant = self
            .clone()
            .portable(
                Route::Acquire(session.into()),
                Op::Acquire,
                Query::default(),
                json!({"owner":owner}),
            )
            .await?;
        serde_json::from_value(grant).map_err(|_| HistoryFault::Unavailable)
    }
    async fn renew(&self, session: &str, lease: &str) -> HistoryResult<u64> {
        let reply = self
            .clone()
            .portable(
                Route::Renew(session.into(), lease.into()),
                Op::Renew,
                Query::default(),
                Value::Null,
            )
            .await?;
        reply["ttlMs"].as_u64().ok_or(HistoryFault::Unavailable)
    }
    async fn release(&self, session: &str, lease: &str) -> HistoryResult<()> {
        self.clone()
            .portable(
                Route::Lease(session.into(), lease.into()),
                Op::Release,
                Query::default(),
                Value::Null,
            )
            .await
            .map(|_| ())
    }
    async fn append(&self, session: &str, lease: &str, entries: Vec<Value>) -> HistoryResult<u64> {
        let reply = self
            .clone()
            .portable(
                Route::Entries(session.into()),
                Op::Append,
                Query::default(),
                json!({"lease":lease,"entries":entries}),
            )
            .await?;
        reply["kept"].as_u64().ok_or(HistoryFault::Unavailable)
    }
    async fn read(
        &self,
        session: &str,
        after: Option<&str>,
        limit: usize,
    ) -> HistoryResult<EntryPage> {
        let page = self
            .clone()
            .portable(
                Route::Session(session.into()),
                Op::Get,
                Query {
                    after: after.map(str::to_owned),
                    limit: limit.clamp(1, 500),
                    project: None,
                    revision: None,
                },
                Value::Null,
            )
            .await?;
        serde_json::from_value(page).map_err(|_| HistoryFault::Unavailable)
    }
    async fn list(
        &self,
        project: Option<&std::path::Path>,
        after: Option<&str>,
        limit: usize,
    ) -> HistoryResult<SessionPage> {
        let page = self
            .clone()
            .portable(
                Route::Sessions,
                Op::Get,
                Query {
                    after: after.map(str::to_owned),
                    limit: limit.clamp(1, 500),
                    project: project.map(|p| p.to_string_lossy().into_owned()),
                    revision: None,
                },
                Value::Null,
            )
            .await?;
        serde_json::from_value(page).map_err(|_| HistoryFault::Unavailable)
    }
    async fn erase(
        &self,
        session: &str,
        lease: Option<&str>,
        entries: Vec<String>,
    ) -> HistoryResult<Vec<String>> {
        let mut body = json!({"entryIds":entries});
        if let Some(lease) = lease {
            body["lease"] = json!(lease);
        }
        let reply = self
            .clone()
            .portable(
                Route::Erase(session.into()),
                Op::Erase,
                Query::default(),
                body,
            )
            .await?;
        serde_json::from_value(reply["erased"].clone()).map_err(|_| HistoryFault::Unavailable)
    }
}

fn stage(record: &Snapshot, proposed: &[Value]) -> std::result::Result<Vec<Value>, Failure> {
    let mut seen = record
        .entries
        .iter()
        .map(|e| (e["id"].as_str().unwrap(), e))
        .collect::<HashMap<_, _>>();
    let mut added = vec![];
    for entry in proposed {
        let id = entry["id"].as_str().unwrap();
        if let Some(old) = seen.insert(id, entry) {
            if !wire::json_eq(old, entry) {
                return Err(Failure::conflict());
            }
            continue;
        }
        for value in [entry, &tombstone(entry)] {
            if !fits(&json!({"session":record.metadata,"entries":[value],"next":id})) {
                return Err(Failure::http(413, "entry_too_large"));
            }
        }
        added.push(entry.clone());
    }
    Ok(added)
}

fn fits(value: &Value) -> bool {
    serde_json::to_vec(value).is_ok_and(|v| v.len() <= PAGE_LIMIT)
}
fn page(
    envelope: Value,
    field: &str,
    rows: &[Value],
    query: Query,
    unknown: &'static str,
) -> Answer {
    page_with_cursor(envelope, field, rows, query, "id", unknown)
}
fn page_with_cursor(
    mut envelope: Value,
    field: &str,
    rows: &[Value],
    query: Query,
    cursor: &str,
    unknown: &'static str,
) -> Answer {
    let start = if let Some(after) = query.after {
        rows.iter()
            .position(|e| e[cursor] == after)
            .ok_or_else(|| Failure::http(404, unknown))?
            + 1
    } else {
        0
    };
    let rows = &rows[start..];
    envelope[field] = json!([]);
    let base = serde_json::to_vec(&envelope)
        .map_err(|_| Failure::unavailable())?
        .len();
    let mut size = base;
    let mut best = 0;
    for (i, row) in rows.iter().take(query.limit).enumerate() {
        size += serde_json::to_vec(row)
            .map_err(|_| Failure::unavailable())?
            .len()
            + usize::from(i != 0);
        if size > PAGE_LIMIT {
            break;
        }
        let cursor_size = if i + 1 < rows.len() {
            8 + serde_json::to_vec(&row[cursor])
                .map_err(|_| Failure::unavailable())?
                .len()
        } else {
            0
        };
        if size + cursor_size <= PAGE_LIMIT {
            best = i + 1;
        }
    }
    if best == 0 && !rows.is_empty() {
        return Err(Failure::unavailable());
    }
    envelope[field] = json!(&rows[..best]);
    if best < rows.len() {
        envelope["next"] = rows[best - 1][cursor].clone();
    }
    Ok(envelope)
}

fn tombstone(entry: &Value) -> Value {
    let kind = entry["kind"].as_str();
    let mut out = json!({"id":entry["id"],"parentId":entry["parentId"],"kind":kind,"erased":true});
    for key in [
        "turnId",
        "stepId",
        "toolCallId",
        "jobId",
        "inputId",
        "requestId",
        "continuesTurnId",
    ] {
        if let Some(value) = entry.get(key)
            && value.is_string()
        {
            out[key] = value.clone();
        }
    }
    let data = &entry["data"];
    let fallback: Option<(&str, &[&Value])> = match kind {
        Some("inputAccepted" | "input" | "inputHandedBack") => {
            Some(("inputId", &[&data["inputId"]]))
        }
        Some("inputRequest") => Some(("requestId", &[&data["requestId"], &data["request"]["id"]])),
        Some("inputAnswer") => Some(("requestId", &[&data["requestId"]])),
        Some("turnStart") => Some(("continuesTurnId", &[&data["continuesTurnId"]])),
        _ => None,
    };
    if let Some((key, choices)) = fallback
        && entry.get(key).is_none()
        && let Some(value) = choices.iter().find(|v| valid_id(v))
    {
        out[key] = (*value).clone();
    }
    if kind == Some("inputHandedBack")
        && entry.get("inputId").is_none()
        && data.get("inputId").is_none()
        && data["inputIds"]
            .as_array()
            .is_some_and(|a| !a.is_empty() && a.iter().all(valid_id))
    {
        out["inputIds"] = data["inputIds"].clone();
    }
    if entry["sources"]
        .as_array()
        .is_some_and(|a| a.iter().all(valid_id))
    {
        out["sources"] = entry["sources"].clone();
    }
    if kind == Some("jobStarted") && valid_id(&data["key"]) && valid_id(&entry["writer"]) {
        out["writer"] = entry["writer"].clone();
        out["jobKey"] = data["key"].clone();
    }
    let usage = match kind {
        Some("response") => &entry["message"]["usage"],
        Some("jobEnded" | "turnEnd") => &data["usage"],
        _ => &Value::Null,
    };
    let mut kept = serde_json::Map::new();
    for key in ["input", "output", "cacheRead", "cacheWrite", "cost"] {
        if usage[key].is_number() {
            kept.insert(key.into(), usage[key].clone());
        }
    }
    if !kept.is_empty() {
        out["usage"] = Value::Object(kept);
    }
    out
}

fn missing(e: &anyhow::Error) -> bool {
    agent_api::is_file_not_found(e)
        || matches!(
            e.downcast_ref::<OperationError>(),
            Some(OperationError::NotFound(_))
        )
}
fn storage_key(id: &str) -> String {
    format!("{PREFIX}{}", hex(&Sha256::digest(id)))
}
fn nonce() -> std::result::Result<String, Failure> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| Failure::unavailable())?;
    Ok(hex(&bytes))
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn snapshot_data(id: String, settings: Value, entries: Vec<Value>) -> SessionData {
    let entries = entries
        .into_iter()
        .enumerate()
        .map(|(i, content)| Entry {
            id: format!("record-{i}"),
            parent: i.checked_sub(1).map(|n| format!("record-{n}")),
            scope: Scope::session(&id),
            writer: "history-http".into(),
            at: 0,
            kind: "history.service-record".into(),
            visible: false,
            copies: vec![],
            content: Some(content),
        })
        .collect::<Vec<_>>();
    SessionData {
        id,
        project: "/".into(),
        settings,
        plugins: vec![],
        position: entries.last().map(|e| e.id.clone()),
        entries,
        origin: None,
    }
}
fn unpack(data: SessionData) -> std::result::Result<Snapshot, Failure> {
    let metadata = data.settings;
    Ok(Snapshot {
        metadata,
        entries: data
            .entries
            .into_iter()
            .map(|e| e.content.ok_or_else(Failure::unavailable))
            .collect::<std::result::Result<_, _>>()?,
    })
}

#[derive(Debug)]
enum Failure {
    Http(u16, &'static str, Option<(&'static str, &'static str)>),
    Held(Instant),
    Uncertain,
}
type Answer = std::result::Result<Value, Failure>;
impl Failure {
    fn http(status: u16, code: &'static str) -> Self {
        Self::Http(status, code, None)
    }
    fn invalid() -> Self {
        Self::http(400, "invalid_request")
    }
    fn unavailable() -> Self {
        Self::http(503, "unavailable")
    }
    fn conflict() -> Self {
        Self::http(409, "conflict")
    }
    fn lost() -> Self {
        Self::http(409, "lost")
    }
    fn held(until: Instant) -> Self {
        Self::Held(until)
    }
}

async fn handle(
    server: Arc<Server>,
    req: Request<Incoming>,
) -> std::result::Result<Response<Full<Bytes>>, std::io::Error> {
    let response = request(server, req).await;
    let (status, body, header) = match response {
        Ok(value) => (200, value, None),
        Err(Failure::Uncertain) => {
            return Err(std::io::Error::other("unconfirmed history operation"));
        }
        Err(Failure::Held(until)) => {
            let ms = until
                .saturating_duration_since(Instant::now())
                .as_nanos()
                .div_ceil(1_000_000)
                .max(1);
            (
                409,
                json!({"error":"The session is held by a writer or a restart hold.","code":"held","retryAfterMs":ms}),
                None,
            )
        }
        Err(Failure::Http(status, code, header)) => (
            status,
            json!({"error":code.replace('_', " "),"code":code}),
            header,
        ),
    };
    let mut response = Response::builder()
        .status(StatusCode::from_u16(status).unwrap())
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store");
    if let Some((key, value)) = header {
        response = response.header(key, value);
    }
    Ok(response
        .body(Full::new(Bytes::from(serde_json::to_vec(&body)?)))
        .unwrap())
}
async fn request(server: Arc<Server>, req: Request<Incoming>) -> Answer {
    let (parts, mut stream) = req.into_parts();
    let authorized = parts
        .headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split_once(' '))
        .is_some_and(|(scheme, token)| {
            scheme.eq_ignore_ascii_case("Bearer")
                && bool::from(Sha256::digest(token).as_slice().ct_eq(&server.token))
        });
    if !authorized {
        return Err(Failure::Http(
            401,
            "unauthorized",
            Some(("www-authenticate", "Bearer")),
        ));
    }
    let mut route = Route::parse(parts.uri.path())?;
    let profile = match &server.backend {
        Backend::Snapshot(_) => true,
        Backend::Portable(store) => store.pending_erasure_v1(),
    };
    if !profile && matches!(route, Route::Pending(_) | Route::Complete(..)) {
        return Err(Failure::http(404, "not_found"));
    }
    let op = route.method(&parts.method)?;
    let mut bytes = Vec::new();
    while let Some(frame) = stream.frame().await {
        let frame = frame.map_err(|_| Failure::invalid())?;
        if let Some(chunk) = frame.data_ref() {
            if bytes.len() + chunk.len() > BODY_LIMIT {
                return Err(Failure::http(413, "request_too_large"));
            }
            bytes.extend_from_slice(chunk);
        }
    }
    if parts.headers.contains_key(header::CONTENT_ENCODING)
        || (!bytes.is_empty()
            && !parts
                .headers
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.split(';').next())
                .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json")))
    {
        return Err(Failure::http(415, "unsupported_media_type"));
    }
    route.validate()?;
    let mut query = Query::parse(parts.uri.query(), &route, &op)?;
    if profile && matches!(op, Op::Append) {
        let mut headers = parts.headers.get_all("history-revision").iter();
        if let Some(revision) = headers.next() {
            let revision = revision
                .to_str()
                .ok()
                .filter(|s| valid_lease(s))
                .ok_or_else(Failure::invalid)?;
            if headers.next().is_some() {
                return Err(Failure::invalid());
            }
            query.revision = Some(revision.into());
        }
    }
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        wire::decode_json(&bytes).map_err(|_| Failure::invalid())?
    };
    op.validate_body(&body, bytes.is_empty())?;
    validate_source(&route, &op, &body)?;
    match &server.backend {
        Backend::Snapshot(store) => {
            let store = store.clone();
            tokio::task::spawn_blocking(move || store.apply(route, op, query, body))
                .await
                .map_err(|_| Failure::Uncertain)?
        }
        Backend::Portable(store) => {
            let path = route.segments();
            let (status, value) = portable_store::request(
                store.as_ref(),
                parts.method,
                &path,
                (!bytes.is_empty()).then_some(body),
                portable_store::RequestOptions {
                    project: query.project.as_deref().map(std::path::Path::new),
                    after: query.after.as_deref(),
                    limit: query.limit,
                    revision: query.revision.as_deref(),
                },
            )
            .await
            .map_err(|_| Failure::Uncertain)?;
            if status.is_success() {
                if !fits(&value) {
                    return Err(Failure::unavailable());
                }
                Ok(value)
            } else {
                Err(match value["code"].as_str() {
                    Some("held") => Failure::held(
                        Instant::now()
                            + Duration::from_millis(
                                value["retryAfterMs"]
                                    .as_u64()
                                    .unwrap_or(1)
                                    .clamp(1, MAX_COUNT),
                            ),
                    ),
                    Some("lost") => Failure::lost(),
                    Some("conflict") => Failure::conflict(),
                    Some("entry_too_large") => Failure::http(413, "entry_too_large"),
                    Some("unknown_entry") => Failure::http(404, "unknown_entry"),
                    Some("unknown_intent") => Failure::http(404, "unknown_intent"),
                    Some("stale_revision") => Failure::http(409, "stale_revision"),
                    Some("request_too_large") => Failure::http(413, "request_too_large"),
                    Some("unknown_session") => Failure::http(404, "unknown_session"),
                    Some("invalid_request") => Failure::invalid(),
                    _ => Failure::unavailable(),
                })
            }
        }
    }
}

#[derive(Debug)]
enum Route {
    Root,
    Sessions,
    Session(String),
    Acquire(String),
    Lease(String, String),
    Renew(String, String),
    Entries(String),
    Erase(String),
    Pending(String),
    Complete(String, String),
}
impl Route {
    fn segments(&self) -> Vec<&str> {
        match self {
            Self::Root => vec!["v1"],
            Self::Sessions => vec!["v1", "sessions"],
            Self::Session(id) => vec!["v1", "sessions", id],
            Self::Acquire(id) => vec!["v1", "sessions", id, "lease"],
            Self::Lease(id, token) => vec!["v1", "sessions", id, "lease", token],
            Self::Renew(id, token) => vec!["v1", "sessions", id, "lease", token, "renew"],
            Self::Entries(id) => vec!["v1", "sessions", id, "entries"],
            Self::Erase(id) => vec!["v1", "sessions", id, "erase"],
            Self::Pending(id) => vec!["v1", "sessions", id, "pending-erasure"],
            Self::Complete(id, intent) => {
                vec!["v1", "sessions", id, "pending-erasure", intent, "complete"]
            }
        }
    }

    fn parse(path: &str) -> std::result::Result<Self, Failure> {
        let p: Vec<_> = path.split('/').collect();
        // Dot segments are illegal even when they replace a fixed segment.
        if p.iter()
            .any(|s| decode(s).is_ok_and(|d| matches!(d.as_str(), "." | "..")))
        {
            return Err(Failure::invalid());
        }
        Ok(match p.as_slice() {
            ["", "v1"] => Self::Root,
            ["", "v1", "sessions"] => Self::Sessions,
            ["", "v1", "sessions", id] => Self::Session((*id).into()),
            ["", "v1", "sessions", id, "lease"] => Self::Acquire((*id).into()),
            ["", "v1", "sessions", id, "lease", key] => Self::Lease((*id).into(), (*key).into()),
            ["", "v1", "sessions", id, "lease", key, "renew"] => {
                Self::Renew((*id).into(), (*key).into())
            }
            ["", "v1", "sessions", id, "entries"] => Self::Entries((*id).into()),
            ["", "v1", "sessions", id, "erase"] => Self::Erase((*id).into()),
            ["", "v1", "sessions", id, "pending-erasure"] => Self::Pending((*id).into()),
            [
                "",
                "v1",
                "sessions",
                id,
                "pending-erasure",
                intent,
                "complete",
            ] => Self::Complete((*id).into(), (*intent).into()),
            _ => return Err(Failure::http(404, "not_found")),
        })
    }
    fn method(&self, method: &Method) -> std::result::Result<Op, Failure> {
        let (allow, op) = match self {
            Self::Root | Self::Sessions => ("GET", (*method == Method::GET).then_some(Op::Get)),
            Self::Session(_) => (
                "GET, PUT",
                match *method {
                    Method::GET => Some(Op::Get),
                    Method::PUT => Some(Op::Put),
                    _ => None,
                },
            ),
            Self::Acquire(_) => ("POST", (*method == Method::POST).then_some(Op::Acquire)),
            Self::Lease(..) => ("DELETE", (*method == Method::DELETE).then_some(Op::Release)),
            Self::Renew(..) => ("POST", (*method == Method::POST).then_some(Op::Renew)),
            Self::Entries(_) => ("POST", (*method == Method::POST).then_some(Op::Append)),
            Self::Erase(_) => ("POST", (*method == Method::POST).then_some(Op::Erase)),
            Self::Complete(..) => ("POST", (*method == Method::POST).then_some(Op::Complete)),
            Self::Pending(_) => (
                "GET, POST",
                match *method {
                    Method::GET => Some(Op::Get),
                    Method::POST => Some(Op::Mark),
                    _ => None,
                },
            ),
        };
        op.ok_or(Failure::Http(
            405,
            "method_not_allowed",
            Some(("allow", allow)),
        ))
    }
    fn validate(&mut self) -> std::result::Result<(), Failure> {
        let (id, lease) = match self {
            Self::Complete(id, intent) => {
                *intent = decode(intent)?;
                if !pending::path_id(intent) {
                    return Err(Failure::invalid());
                }
                (id, None)
            }
            Self::Root | Self::Sessions => return Ok(()),
            Self::Session(id)
            | Self::Acquire(id)
            | Self::Entries(id)
            | Self::Erase(id)
            | Self::Pending(id) => (id, None),
            Self::Lease(id, key) | Self::Renew(id, key) => (id, Some(key)),
        };
        *id = decode(id)?;
        if !pending::path_id(id) {
            return Err(Failure::invalid());
        }
        if let Some(key) = lease {
            *key = decode(key)?;
            if !valid_lease(key) {
                return Err(Failure::invalid());
            }
        }
        Ok(())
    }
}

enum Op {
    Get,
    Put,
    Acquire,
    Renew,
    Release,
    Append,
    Erase,
    Mark,
    Complete,
}
impl Op {
    fn validate_body(&self, body: &Value, empty: bool) -> std::result::Result<(), Failure> {
        if matches!(self, Self::Get | Self::Renew | Self::Release) {
            return if empty {
                Ok(())
            } else {
                Err(Failure::invalid())
            };
        }
        if !body.is_object() {
            return Err(Failure::invalid());
        }
        let valid = match self {
            Self::Put => {
                body.get("id").is_none()
                    && body["project"].is_string()
                    && count(&body["created"]).is_some()
                    && body.get("parentSessionId").is_none_or(valid_id)
                    && body
                        .get("forkedFrom")
                        .is_none_or(|f| valid_id(&f["sessionId"]) && valid_id(&f["entryId"]))
            }
            Self::Acquire => valid_id(&body["owner"]),
            Self::Append => {
                lease_field(&body["lease"])
                    && body["entries"].as_array().is_some_and(|a| {
                        a.iter().all(|e| {
                            valid_id(&e["id"])
                                && e.get("parentId")
                                    .is_some_and(|p| p.is_null() || valid_id(p))
                                && e["erased"] != true
                        })
                    })
            }
            Self::Mark => serde_json::from_value::<Publication>(body.clone()).is_ok_and(|p| {
                let mut sessions = HashSet::new();
                valid_lease(&p.lease)
                    && valid_lease(&p.revision)
                    && pending::path_id(&p.intent_id)
                    && pending::distinct_ids(&p.entry_ids)
                    && !p.copies.is_empty()
                    && p.copies.iter().all(|c| {
                        pending::path_id(&c.session_id)
                            && sessions.insert(&c.session_id)
                            && !c.record_id.is_empty()
                            && pending::distinct_ids(&c.entry_ids)
                    })
            }),
            Self::Complete => {
                body.as_object().is_some_and(|b| b.len() == 2)
                    && lease_field(&body["lease"])
                    && serde_json::from_value::<Vec<String>>(body["entryIds"].clone())
                        .is_ok_and(|ids| pending::distinct_ids(&ids))
            }
            Self::Erase => {
                body.get("lease").is_none_or(lease_field)
                    && body["entryIds"]
                        .as_array()
                        .is_some_and(|a| a.iter().all(valid_id))
            }
            _ => unreachable!(),
        };
        if valid {
            Ok(())
        } else {
            Err(Failure::invalid())
        }
    }
}
fn validate_source(route: &Route, op: &Op, body: &Value) -> std::result::Result<(), Failure> {
    if let (Route::Pending(source), Op::Mark) = (route, op) {
        let copies = body["copies"].as_array().unwrap();
        let set = copies
            .iter()
            .find(|set| set["sessionId"] == *source)
            .ok_or_else(Failure::invalid)?;
        let ids: HashSet<_> = set["entryIds"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        if !body["entryIds"]
            .as_array()
            .unwrap()
            .iter()
            .all(|target| ids.contains(target.as_str().unwrap()))
        {
            return Err(Failure::invalid());
        }
    }
    Ok(())
}
fn count(value: &Value) -> Option<u64> {
    let n = value.as_f64()?;
    (n >= 0.0 && n <= MAX_COUNT as f64 && n.fract() == 0.0).then_some(n as u64)
}
fn valid_id(value: &Value) -> bool {
    value.as_str().is_some_and(|s| !s.is_empty())
}
fn valid_lease(s: &str) -> bool {
    (1..=128).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
}
fn lease_field(value: &Value) -> bool {
    value.as_str().is_some_and(valid_lease)
}
#[derive(Default)]
struct Query {
    after: Option<String>,
    project: Option<String>,
    limit: usize,
    revision: Option<String>,
}
impl Query {
    fn parse(query: Option<&str>, route: &Route, op: &Op) -> std::result::Result<Self, Failure> {
        let mut parsed = Self {
            after: None,
            project: None,
            limit: 500,
            revision: None,
        };
        if let Some(query) = query {
            if !matches!(op, Op::Get)
                || !matches!(
                    route,
                    Route::Sessions | Route::Session(_) | Route::Pending(_)
                )
            {
                return Err(Failure::invalid());
            }
            let mut seen = HashSet::new();
            for pair in query.split('&') {
                let (key, value) = pair.split_once('=').ok_or_else(Failure::invalid)?;
                let key = decode(key)?;
                if !seen.insert(key.clone()) {
                    return Err(Failure::invalid());
                }
                let value = decode(value)?;
                match key.as_str() {
                    "project" if matches!(route, Route::Sessions) => parsed.project = Some(value),
                    "after" if !value.is_empty() => parsed.after = Some(value),
                    "limit" if value.bytes().all(|b| b.is_ascii_digit()) => {
                        parsed.limit = value
                            .parse::<usize>()
                            .ok()
                            .filter(|n| (1..=500).contains(n))
                            .ok_or_else(Failure::invalid)?
                    }
                    _ => return Err(Failure::invalid()),
                }
            }
        }
        Ok(parsed)
    }
}
fn decode(raw: &str) -> std::result::Result<String, Failure> {
    let mut output = Vec::with_capacity(raw.len());
    let mut bytes = raw.bytes();
    while let Some(b) = bytes.next() {
        if b != b'%' {
            output.push(b);
            continue;
        }
        let mut digit = || {
            bytes
                .next()
                .and_then(|b| (b as char).to_digit(16))
                .ok_or_else(Failure::invalid)
        };
        output.push((digit()? * 16 + digit()?) as u8);
    }
    String::from_utf8(output).map_err(|_| Failure::invalid())
}
