//! Loopback HTTP transport for the opaque history binding.
use super::{BODY_LIMIT, PAGE_LIMIT};
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

/// Serve a dedicated snapshot store until the future is dropped. Plaintext is only
/// supported on loopback. A filesystem store is required for crash persistence.
pub async fn serve_history(
    store: Arc<dyn HistoryStore>,
    options: ServeHistoryOptions,
) -> agent_api::Result<()> {
    ensure!(
        options.address.ip().is_loopback(),
        "plaintext history service must listen on loopback"
    );
    let ttl_ms = u64::try_from(options.ttl.as_millis())?;
    ensure!(
        (1..=MAX_COUNT).contains(&ttl_ms) && options.ttl == Duration::from_millis(ttl_ms),
        "history lease TTL must be a positive whole number of milliseconds"
    );
    ensure!(
        options.max_sessions > 0,
        "history session quota must be positive"
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
    let max_sessions = options.max_sessions;
    let server =
        tokio::task::spawn_blocking(move || Server::new(store, token, ttl_ms, max_sessions))
            .await??;
    let server = Arc::new(server);
    let listener = tokio::net::TcpListener::bind(options.address).await?;
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
    store: Arc<dyn HistoryStore>,
    _exclusive: Box<dyn Lease>,
    ttl_ms: u64,
    hold: Option<Instant>,
    max_sessions: usize,
    leases: Mutex<HashMap<String, Grant>>,
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

impl Server {
    fn new(
        store: Arc<dyn HistoryStore>,
        token: [u8; 32],
        ttl_ms: u64,
        max_sessions: usize,
    ) -> agent_api::Result<Self> {
        let exclusive = store.acquire(CONTROL)?;
        let prior = match store.load(CONTROL) {
            Ok(data) => Some(
                data.settings["historyTtlBound"]
                    .as_u64()
                    .filter(|ms| (1..=MAX_COUNT).contains(ms))
                    .ok_or_else(|| anyhow!("unknown previous history lease bound"))?,
            ),
            Err(e) if missing(&e) => {
                ensure!(
                    store.list(None)?.is_empty(),
                    "history service needs a dedicated store with a verifiable lease bound"
                );
                None
            }
            Err(e) => return Err(e),
        };
        let bound = ttl_ms.max(prior.unwrap_or(0));
        if prior != Some(bound) {
            store.save(&snapshot_data(
                CONTROL.into(),
                json!({"historyTtlBound": bound}),
                vec![],
            ))?;
        }
        let hold = prior.map(|_| Instant::now() + Duration::from_millis(bound));
        Ok(Self {
            token,
            store,
            _exclusive: exclusive,
            ttl_ms,
            hold,
            max_sessions,
            leases: Mutex::default(),
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

    fn apply(&self, route: Route, op: Op, query: Query, mut body: Value) -> Answer {
        let mut leases = self.leases.lock().map_err(|_| Failure::unavailable())?;
        let now = Instant::now();
        leases.retain(|_, lease| lease.until > now);
        let id = match route {
            Route::Root => {
                return Ok(json!({"binding":"modular-agent-history/1","ttlMs":self.ttl_ms}));
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
            Route::Session(ref id)
            | Route::Acquire(ref id)
            | Route::Lease(ref id, _)
            | Route::Renew(ref id, _)
            | Route::Entries(ref id)
            | Route::Erase(ref id) => id,
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
                let mut bytes = [0_u8; 32];
                getrandom::fill(&mut bytes).map_err(|_| Failure::unavailable())?;
                let token = hex(&bytes);
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
                let more = body["entries"].take();
                let added = stage(&record, more.as_array().unwrap())?;
                let kept = added.len();
                if kept != 0 {
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
                    self.save(id, record)?;
                }
                Ok(json!({"erased":erased}))
            }
            Op::Put => unreachable!(),
        }
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
    mut envelope: Value,
    field: &str,
    rows: &[Value],
    query: Query,
    unknown: &'static str,
) -> Answer {
    let start = if let Some(after) = query.after {
        rows.iter()
            .position(|e| e["id"] == after)
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
            8 + serde_json::to_vec(&row["id"])
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
        envelope["next"] = rows[best - 1]["id"].clone();
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
        if let Some(value) = entry.get(key) {
            if value.is_string() {
                out[key] = value.clone();
            }
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
        .header(header::CONTENT_TYPE, "application/json");
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
    let query = Query::parse(parts.uri.query(), &route, &op)?;
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        wire::decode_json(&bytes).map_err(|_| Failure::invalid())?
    };
    op.validate_body(&body, bytes.is_empty())?;
    tokio::task::spawn_blocking(move || server.apply(route, op, query, body))
        .await
        .map_err(|_| Failure::Uncertain)?
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
}
impl Route {
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
        };
        op.ok_or(Failure::Http(
            405,
            "method_not_allowed",
            Some(("allow", allow)),
        ))
    }
    fn validate(&mut self) -> std::result::Result<(), Failure> {
        let (id, lease) = match self {
            Self::Root | Self::Sessions => return Ok(()),
            Self::Session(id) | Self::Acquire(id) | Self::Entries(id) | Self::Erase(id) => {
                (id, None)
            }
            Self::Lease(id, key) | Self::Renew(id, key) => (id, Some(key)),
        };
        *id = decode(id)?;
        if id.is_empty() {
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
struct Query {
    after: Option<String>,
    project: Option<String>,
    limit: usize,
}
impl Query {
    fn parse(query: Option<&str>, route: &Route, op: &Op) -> std::result::Result<Self, Failure> {
        let mut parsed = Self {
            after: None,
            project: None,
            limit: 500,
        };
        if let Some(query) = query {
            if !matches!(op, Op::Get) || !matches!(route, Route::Sessions | Route::Session(_)) {
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
