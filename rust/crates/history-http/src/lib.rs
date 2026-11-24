//! A synchronous HistoryStore port backed by a separately driven HTTP client.
use agent_api::*;
mod pending;
mod portable_store;
mod server;
pub use portable_store::{
    EntryPage, HistoryFault, HistoryResult, LeaseGrant, PortableHistoryStore, SessionPage,
};
use reqwest::{Client, Method, StatusCode, Url};
pub use server::{
    HistoryServer, ServeHistoryOptions, SnapshotStore, listen_history, listen_portable_history,
    serve_history, serve_portable_history,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::{Arc, Mutex, OnceLock, Weak},
    time::Duration,
};

const BODY_LIMIT: usize = 64 * 1024 * 1024;
const PAGE_LIMIT: usize = 4 * 1024 * 1024;
const LEASE_BYTES: usize = 128;

fn lease_value(value: &Value) -> Result<&str> {
    let lease = wire::string(value, "lease")?;
    ensure!(
        !lease.is_empty()
            && lease.len() <= LEASE_BYTES
            && lease
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')),
        "invalid history lease"
    );
    Ok(lease)
}

// Both clocks advance during suspension (see clock_gettime(3) on macOS).
#[cfg(target_os = "linux")]
const LEASE_CLOCK: libc::clockid_t = libc::CLOCK_BOOTTIME;
#[cfg(target_os = "macos")]
const LEASE_CLOCK: libc::clockid_t = libc::CLOCK_MONOTONIC;

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn now() -> Duration {
    let mut t = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    assert_eq!(unsafe { libc::clock_gettime(LEASE_CLOCK, &mut t) }, 0);
    Duration::new(t.tv_sec as u64, t.tv_nsec as u32)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn now() -> Duration {
    static START: OnceLock<std::time::Instant> = OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed()
}

static IO: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
fn io() -> &'static tokio::runtime::Runtime {
    IO.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("history-http")
            .build()
            .expect("history HTTP runtime")
    })
}

#[derive(Clone)]
struct Service {
    transport: Transport,
    margin: Duration,
}

#[derive(Clone)]
enum Transport {
    Http {
        client: Client,
        base: Url,
        token: Arc<str>,
    },
    Embedded(Arc<dyn PortableHistoryStore>),
}

fn clock_margin() -> Result<Duration> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        Ok(Duration::ZERO)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        Ok(Duration::from_millis(std::env::var("MODULAR_AGENT_HISTORY_LEASE_MARGIN_MS")
        .map_err(|_| anyhow!("configure MODULAR_AGENT_HISTORY_LEASE_MARGIN_MS without a suspension-aware clock"))?.parse()?))
    }
}
impl Service {
    async fn send(
        &self,
        method: Method,
        path: &[&str],
        project: Option<&Path>,
        body: Option<Value>,
        after: Option<&str>,
        revision: Option<&str>,
    ) -> Result<(StatusCode, Value)> {
        ensure!(
            path.iter().all(|s| !matches!(*s, "." | "..")),
            "invalid history path segment"
        );
        let (client, base, token) = match &self.transport {
            Transport::Http {
                client,
                base,
                token,
            } => (client, base, token),
            Transport::Embedded(store) => {
                return portable_store::request(
                    store.as_ref(),
                    method,
                    path,
                    body,
                    portable_store::RequestOptions {
                        project,
                        after,
                        limit: 500,
                        revision,
                    },
                )
                .await;
            }
        };
        let mut url = base.clone();
        url.path_segments_mut()
            .map_err(|_| anyhow!("history service URL cannot be a base"))?
            .pop_if_empty()
            .extend(path);
        let mut query = Vec::new();
        if let Some(project) = project {
            query.push(format!("project={}", escape(&project.to_string_lossy())));
        }
        if let Some(after) = after {
            query.push(format!("after={}", escape(after)));
        }
        if !query.is_empty() {
            url.set_query(Some(&query.join("&")));
        }
        let mut request = client
            .request(method.clone(), url)
            .bearer_auth(token.as_ref());
        if let Some(parent) = agent_api::telemetry::traceparent(&agent_api::telemetry::current()) {
            request = request.header("traceparent", parent);
        }
        if let Some(revision) = revision {
            request = request.header("History-Revision", revision);
        }
        if method == Method::GET && path.last() == Some(&"pending-erasure") {
            request = request.header(reqwest::header::CACHE_CONTROL, "no-store");
        }
        if let Some(body) = body {
            let body = serde_json::to_vec(&body)?;
            ensure!(body.len() <= BODY_LIMIT, "history request is too large");
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body);
        }
        // Do not blindly repeat a mutation after an ambiguous reply.
        let reply = request
            .send()
            .await
            .map_err(|_| anyhow!("could not reach history service"))?;
        let status = reply.status();
        ensure!(
            reply
                .headers()
                .get(reqwest::header::CONTENT_ENCODING)
                .is_none(),
            "encoded history reply"
        );
        ensure!(
            reply
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v
                    .split(';')
                    .next()
                    .unwrap()
                    .trim()
                    .eq_ignore_ascii_case("application/json")),
            "invalid history response media type"
        );
        let limit =
            if method == Method::GET && path.get(1) == Some(&"sessions") && status.is_success() {
                PAGE_LIMIT
            } else {
                BODY_LIMIT
            };
        let mut reply = reply;
        let mut bytes = Vec::new();
        while let Some(chunk) = reply
            .chunk()
            .await
            .map_err(|_| anyhow!("could not read history service reply"))?
        {
            ensure!(
                bytes.len() + chunk.len() <= limit,
                "history response is too large"
            );
            bytes.extend_from_slice(&chunk);
        }
        let body = wire::decode_json(&bytes)?;
        ensure!(body.is_object(), "history response is not an object");
        Ok((status, body))
    }
    fn request(
        &self,
        method: Method,
        path: &[&str],
        project: Option<&Path>,
        body: Option<Value>,
    ) -> Result<(StatusCode, Value)> {
        self.request_with(method, path, project, body, None, None)
    }
    fn request_with(
        &self,
        method: Method,
        path: &[&str],
        project: Option<&Path>,
        body: Option<Value>,
        after: Option<&str>,
        deadline: Option<Duration>,
    ) -> Result<(StatusCode, Value)> {
        self.exchange(
            method,
            path,
            body,
            Exchange {
                project,
                after,
                deadline,
                revision: None,
            },
        )
    }
    fn exchange(
        &self,
        method: Method,
        path: &[&str],
        body: Option<Value>,
        options: Exchange<'_>,
    ) -> Result<(StatusCode, Value)> {
        let Exchange {
            project,
            after,
            deadline,
            revision,
        } = options;
        let service = self.clone();
        let path: Vec<_> = path.iter().map(|s| s.to_string()).collect();
        let project = project.map(Path::to_owned);
        let after = after.map(str::to_owned);
        let revision = revision.map(str::to_owned);
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let cx = agent_api::telemetry::current();
        io().spawn(agent_api::telemetry::within(cx, async move {
            let path: Vec<_> = path.iter().map(String::as_str).collect();
            let send = service.send(
                method,
                &path,
                project.as_deref(),
                body,
                after.as_deref(),
                revision.as_deref(),
            );
            let result = if let Some(deadline) = deadline {
                match tokio::time::timeout(deadline.saturating_sub(now()), send).await {
                    Ok(result) => result,
                    Err(_) => Err(OpenBudgetExpired.into()),
                }
            } else {
                send.await
            };
            let _ = tx.send(result);
        }));
        rx.recv()?
    }
    fn get(&self, path: &[&str], project: Option<&Path>) -> Result<Value> {
        checked(self.request(Method::GET, path, project, None)?)
    }
    fn pages(
        &self,
        path: &[&str],
        project: Option<&Path>,
        field: &str,
    ) -> Result<(Value, Vec<Value>)> {
        let mut after: Option<String> = None;
        let mut seen = BTreeSet::new();
        let mut all = Vec::new();
        let mut meta = Value::Null;
        loop {
            let mut page = checked(self.request_with(
                Method::GET,
                path,
                project,
                None,
                after.as_deref(),
                None,
            )?)?;
            if after.is_none() {
                meta = page["session"].take();
            }
            let rows = page[field]
                .as_array()
                .ok_or_else(|| anyhow!("missing history {field}"))?;
            let next = wire::optional(&page, "next")
                .map(|_| wire::string(&page, "next").map(str::to_owned))
                .transpose()?;
            if let Some(ref cursor) = next {
                ensure!(
                    rows.last().and_then(|row| row["id"].as_str()) == Some(cursor)
                        && seen.insert(cursor.clone()),
                    "invalid history page cursor"
                );
            }
            all.append(page[field].as_array_mut().unwrap());
            if next.is_none() {
                return Ok((meta, all));
            }
            after = next;
        }
    }
}
#[derive(Default)]
struct Exchange<'a> {
    project: Option<&'a Path>,
    after: Option<&'a str>,
    deadline: Option<Duration>,
    revision: Option<&'a str>,
}
fn positive_ms(value: &Value, key: &str) -> Result<u64> {
    value[key]
        .as_u64()
        .filter(|n| (1..=9_007_199_254_740_991).contains(n))
        .ok_or_else(|| anyhow!("invalid history {key}"))
}
fn escape(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            out.push(char::from(byte));
        } else {
            use std::fmt::Write as _;
            write!(out, "%{byte:02X}").unwrap();
        }
    }
    out
}
fn checked((status, value): (StatusCode, Value)) -> Result<Value> {
    if (status == StatusCode::CONFLICT && value["code"] == "stale_revision")
        || status == StatusCode::SERVICE_UNAVAILABLE
    {
        return Err(registry_unavailable(
            "history state changed or is unavailable",
        ));
    }
    if status == StatusCode::NOT_FOUND && value["code"] == "unknown_session" {
        return Err(OperationError::NotFound("unknown session".into()).into());
    }
    ensure!(
        status.is_success(),
        "history service {} ({})",
        status.as_u16(),
        value["code"].as_str().unwrap_or("unknown error")
    );
    ensure!(
        value.is_object(),
        "history service returned a malformed answer"
    );
    Ok(value)
}
struct OpenBudgetExpired;
impl std::fmt::Debug for OpenBudgetExpired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, f)
    }
}
impl std::fmt::Display for OpenBudgetExpired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("history open budget expired")
    }
}
impl std::error::Error for OpenBudgetExpired {}

struct RemoteLease {
    id: String,
    stop: CancellationToken,
    cutoff: Arc<Mutex<Duration>>,
}
impl RemoteLease {
    fn check(&self, lost: &CancellationToken) -> Result<()> {
        if now() >= *self.cutoff.lock().unwrap() {
            lost.cancel();
        }
        ensure!(
            !lost.is_cancelled(),
            LostPart("history writer lease was lost".into())
        );
        Ok(())
    }
}
struct State {
    service: Service,
    session: String,
    lease: Mutex<Option<RemoteLease>>,
    lost: CancellationToken,
    kept: Mutex<BTreeSet<String>>,
    owner: String,
}
impl State {
    fn observe_write(&self, result: Result<(StatusCode, Value)>) -> Result<(StatusCode, Value)> {
        let guard = self.lease.lock().unwrap();
        let remote = guard.as_ref().expect("acquired lease");
        if result
            .as_ref()
            .map_or(true, |(_, body)| body["code"] == "lost")
        {
            self.lost.cancel();
        }
        remote.check(&self.lost)?;
        result
    }
    fn acquire(&self, ttl_ms: u64) -> Result<String> {
        self.acquire_with_wait(ttl_ms, true)
    }
    fn acquire_with_wait(&self, ttl_ms: u64, wait_for_writer: bool) -> Result<String> {
        let mut guard = self.lease.lock().unwrap();
        if let Some(lease) = &*guard {
            lease.check(&self.lost)?;
            return Ok(lease.id.clone());
        }
        let mut budget = None;
        let margin = self.service.margin;
        let (lease, ttl, sent) = loop {
            let sent = now();
            let reply = self.service.request_with(
                Method::POST,
                &["v1", "sessions", &self.session, "lease"],
                None,
                Some(json!({"owner":self.owner})),
                None,
                budget.map(|(until, _)| until),
            );
            let received = now();
            if let Some((until, retry_after_ms)) = budget
                && (received >= until || reply.as_ref().is_err_and(|e| e.is::<OpenBudgetExpired>()))
            {
                return Err(HistoryHeld { retry_after_ms }.into());
            }
            let reply = reply?;
            if reply.0 == StatusCode::CONFLICT && reply.1["code"] == "held" {
                let retry_after_ms = positive_ms(&reply.1, "retryAfterMs")?;
                if !wait_for_writer {
                    return Err(HistoryHeld { retry_after_ms }.into());
                }
                let wait = Duration::from_millis(retry_after_ms);
                let until = budget
                    .map(|(until, _)| until)
                    .unwrap_or(received + Duration::from_millis(ttl_ms + 1000));
                if wait >= until.saturating_sub(received) {
                    return Err(HistoryHeld { retry_after_ms }.into());
                }
                budget = Some((until, retry_after_ms));
                let next = received + wait;
                while now() < next {
                    std::thread::sleep(next.saturating_sub(now()));
                }
                if now() >= until {
                    return Err(HistoryHeld { retry_after_ms }.into());
                }
                continue;
            }
            let v = checked(reply)?;
            break (lease_value(&v)?.to_owned(), positive_ms(&v, "ttlMs")?, sent);
        };
        let cutoff = sent + (Duration::from_millis(ttl) / 2).saturating_sub(margin);
        ensure!(now() < cutoff, "history writer lease was lost");
        let remote = RemoteLease {
            id: lease.clone(),
            stop: CancellationToken::new(),
            cutoff: Arc::new(Mutex::new(cutoff)),
        };
        let service = self.service.clone();
        let session = self.session.clone();
        let lease_id = lease.clone();
        let backend_lost = match &service.transport {
            Transport::Embedded(store) => store.writer_lost(&session, &lease),
            Transport::Http { .. } => None,
        };
        let stop = remote.stop.clone();
        if let Some(signal) = backend_lost {
            if signal.is_cancelled() {
                self.lost.cancel();
                bail!(LostPart("history writer lease was lost".into()));
            }
            let (stop, lost) = (stop.clone(), self.lost.clone());
            io().spawn(async move {
                tokio::select! {
                    _ = stop.cancelled() => {},
                    _ = lost.cancelled() => {},
                    _ = signal.cancelled() => lost.cancel(),
                }
            });
        }
        let lost = self.lost.clone();
        let cutoff = remote.cutoff.clone();
        io().spawn(async move {
            let mut ttl = Duration::from_millis(ttl);
            let mut due = sent + (ttl / 3).saturating_sub(margin);
            loop {
                tokio::select! {
                    _ = stop.cancelled() => return,
                    _ = lost.cancelled() => return,
                    _ = tokio::time::sleep(due.saturating_sub(now())) => {}
                }
                let sent = now();
                let old = *cutoff.lock().unwrap();
                if sent >= old {
                    eprintln!("history writer renewal could not start before its cutoff");
                    break;
                }
                let path = ["v1", "sessions", &session, "lease", &lease_id, "renew"];
                let span = agent_api::telemetry::Operation::internal("modular_agent.history.lease.renew", &Scope::session(&session));
                let renew = span.run(tokio::time::timeout(
                    old - sent,
                    service.send(Method::POST, &path, None, None, None, None),
                ));
                let reply = tokio::select! {
                    _ = stop.cancelled() => return,
                    _ = lost.cancelled() => return,
                    r = renew => match r {
                        Ok(Ok(reply)) => checked(reply).ok(),
                        Ok(Err(_)) => { eprintln!("history writer renewal transport failed"); None },
                        Err(_) => { eprintln!("history writer renewal arrived after its cutoff"); None },
                    }
                };
                let Some(ms) = reply.and_then(|v| positive_ms(&v, "ttlMs").ok()) else {
                    span.error("renewal_failed");
                    break;
                };
                ttl = Duration::from_millis(ms);
                let next = sent + (ttl / 2).saturating_sub(margin);
                let mut current = cutoff.lock().unwrap();
                if now() >= old.min(next) || lost.is_cancelled() {
                    break;
                }
                *current = next;
                due = sent + (ttl / 3).saturating_sub(margin);
            }
            lost.cancel();
        });
        *guard = Some(remote);
        Ok(lease)
    }
}
impl Drop for State {
    fn drop(&mut self) {
        if let Some(lease) = self.lease.get_mut().unwrap().take() {
            lease.stop.cancel();
            let _ = self.service.request(
                Method::DELETE,
                &["v1", "sessions", &self.session, "lease", &lease.id],
                None,
                None,
            );
        }
    }
}
struct Held(#[allow(dead_code)] Arc<State>);
impl Lease for Held {
    fn lost(&self) -> Option<CancellationToken> {
        Some(self.0.lost.clone())
    }
    fn check(&self) -> Result<()> {
        if let Some(lease) = self.0.lease.lock().unwrap().as_ref() {
            lease.check(&self.0.lost)?;
        }
        Ok(())
    }
}

pub struct HttpHistory {
    service: Service,
    ttl: u64,
    coordinated: bool,
    held: Mutex<BTreeMap<String, Weak<State>>>,
}
impl HttpHistory {
    pub fn new(url: &str, token: &str) -> Result<Self> {
        let margin = clock_margin()?;
        ensure!(!token.is_empty(), "history token file is empty");
        let base = Url::parse(url)?;
        ensure!(
            ["http", "https"].contains(&base.scheme())
                && base.username().is_empty()
                && base.password().is_none()
                && base.query().is_none()
                && base.fragment().is_none(),
            "invalid history service URL"
        );
        ensure!(
            base.scheme() == "https"
                || base
                    .host_str()
                    .and_then(|s| s.trim_matches(['[', ']']).parse::<std::net::IpAddr>().ok())
                    .is_some_and(|ip| ip.is_loopback()),
            "plaintext history requires a numeric loopback address"
        );
        Self::from_service(Service {
            transport: Transport::Http {
                client: Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .connect_timeout(Duration::from_secs(3))
                    .timeout(Duration::from_secs(8))
                    .build()?,
                base,
                token: token.into(),
            },
            margin,
        })
    }
    pub fn from_store(store: Arc<dyn PortableHistoryStore>) -> Result<Self> {
        Self::from_service(Service {
            transport: Transport::Embedded(store),
            margin: clock_margin()?,
        })
    }
    fn from_service(service: Service) -> Result<Self> {
        let version = service.get(&["v1"], None)?;
        ensure!(
            version["binding"] == "modular-agent-history/1",
            "unsupported history service binding"
        );
        let ttl = positive_ms(&version, "ttlMs")?;
        ensure!(
            service.margin < Duration::from_millis(ttl) / 3,
            "history lease clock margin leaves no renewal time"
        );
        Ok(Self {
            service,
            ttl,
            coordinated: wire::json_eq(&version["pendingErasure"], &json!(1)),
            held: Mutex::default(),
        })
    }
    pub fn from_env() -> Result<Option<Self>> {
        match (
            std::env::var_os("MODULAR_AGENT_HISTORY_URL"),
            std::env::var_os("MODULAR_AGENT_HISTORY_TOKEN_FILE"),
        ) {
            (None, None) => Ok(None),
            (Some(url), Some(path)) => Ok(Some(Self::new(
                url.to_str()
                    .ok_or_else(|| anyhow!("invalid history service URL"))?,
                std::fs::read_to_string(path)?.trim(),
            )?)),
            _ => bail!(
                "history service needs both MODULAR_AGENT_HISTORY_URL and MODULAR_AGENT_HISTORY_TOKEN_FILE"
            ),
        }
    }
    fn lease(&self, id: &str) -> Option<Arc<State>> {
        self.held.lock().unwrap().get(id).and_then(Weak::upgrade)
    }
    fn fetch(&self, id: &str) -> Result<(SessionData, Vec<Value>)> {
        let (meta, entries) = self
            .service
            .pages(&["v1", "sessions", id], None, "entries")?;
        Ok((portable::session(&meta, &entries)?, entries))
    }
    fn erasure_plans(&self, session: &str) -> Result<(String, Vec<pending::Plan>)> {
        let read = || -> Result<_> {
            let mut after: Option<String> = None;
            let mut seen = BTreeSet::new();
            let mut revision = None;
            let mut plans = Vec::new();
            loop {
                let value = checked(self.service.request_with(
                    Method::GET,
                    &["v1", "sessions", session, "pending-erasure"],
                    None,
                    None,
                    after.as_deref(),
                    None,
                )?)?;
                ensure!(
                    value.get("next").is_none_or(Value::is_string),
                    "invalid registry cursor"
                );
                let page: pending::PlansPage = serde_json::from_value(value)?;
                lease_value(&json!({"lease":page.revision}))?;
                ensure!(
                    revision.as_ref().is_none_or(|r| *r == page.revision),
                    "registry changed during paging"
                );
                ensure!(
                    page.plans.len() <= 500
                        && page.plans.iter().all(|p| {
                            pending::path_id(&p.intent_id)
                                && seen.insert(p.intent_id.clone())
                                && pending::path_id(&p.source_session_id)
                                && !p.record_id.is_empty()
                                && pending::distinct_ids(
                                    &p.copies
                                        .iter()
                                        .map(|c| c.entry_id.clone())
                                        .collect::<Vec<_>>(),
                                )
                        }),
                    "invalid registry plans"
                );
                ensure!(
                    after.is_none() || !page.plans.is_empty(),
                    "empty continuation of registry plans"
                );
                if let Some(next) = &page.next {
                    ensure!(
                        page.plans.last().is_some_and(|p| &p.intent_id == next),
                        "invalid registry cursor"
                    );
                }
                plans.extend(page.plans);
                if page.next.is_none() {
                    return Ok((page.revision, plans));
                }
                revision = Some(page.revision);
                after = page.next;
            }
        };
        read()
            .map_err(|error| registry_unavailable(&format!("pending erasure unavailable: {error}")))
    }
    fn guarded_append(
        &self,
        session: &str,
        lease: &str,
        entries: &[Value],
        revision: Option<&str>,
    ) -> Result<(StatusCode, Value)> {
        self.service.exchange(
            Method::POST,
            &["v1", "sessions", session, "entries"],
            Some(json!({"lease":lease,"entries":entries})),
            Exchange {
                revision,
                ..Exchange::default()
            },
        )
    }
    fn check_append(&self, data: &SessionData, entries: &[Value]) -> Result<String> {
        let (revision, plans) = self.erasure_plans(&data.id)?;
        check_plans(data, &plans)?;
        let mut sources: BTreeSet<_> = entries
            .iter()
            .flat_map(|e| e["sources"].as_array().into_iter().flatten())
            .filter_map(Value::as_str)
            .collect();
        let fork_source = data.origin.as_ref().filter(|_| {
            !entries.is_empty() && entries.first().is_some_and(|e| e["parentId"].is_null())
        });
        // Sources local to the append or its current session need no other plan read.
        for e in &data.entries {
            if sources.remove(e.id.as_str()) && e.content.is_none() {
                return Err(registry_unavailable("append uses erased content"));
            }
        }
        let check_source = |source: &SessionData, sources: &mut BTreeSet<&str>| -> Result<()> {
            let (observed, plans) = self.erasure_plans(&source.id)?;
            ensure!(
                observed == revision,
                registry_unavailable("registry changed during append preparation")
            );
            check_plans(source, &plans)?;
            for e in &source.entries {
                if sources.remove(e.id.as_str()) && e.content.is_none() {
                    return Err(registry_unavailable("append uses erased content"));
                }
            }
            Ok(())
        };
        if let Some((parent, _)) = fork_source {
            let source = self.fetch(parent)?.0;
            check_source(&source, &mut sources)?;
            // A fork retains the provenance of the parent's already-checked copies.
            for entry in &source.entries {
                for inherited in &entry.copies {
                    sources.remove(inherited.as_str());
                }
            }
        } else if !sources.is_empty() {
            // The binding carries unqualified source IDs. Locate external sources
            // without assuming that a project or local open-session set is complete.
            for source in self.list(None)? {
                if source.id != data.id
                    && source
                        .entries
                        .iter()
                        .any(|e| sources.contains(e.id.as_str()))
                {
                    check_source(&source, &mut sources)?;
                }
            }
        }
        ensure!(
            sources.is_empty(),
            registry_unavailable("could not establish append source freshness")
        );
        Ok(revision)
    }
    fn writer_post(&self, state: &State, path: &[&str], body: Value) -> Result<Value> {
        checked(state.observe_write(self.service.request(Method::POST, path, None, Some(body)))?)
    }
    fn temporary_lease(&self, session: &str) -> Arc<State> {
        Arc::new(State {
            service: self.service.clone(),
            session: session.into(),
            lease: Mutex::default(),
            lost: CancellationToken::new(),
            kept: Mutex::default(),
            owner: id(),
        })
    }
}
fn registry_unavailable(message: &str) -> anyhow::Error {
    OperationError::Unavailable(message.into()).into()
}

fn erasable(e: &Entry) -> bool {
    e.writer != "rust.derived" && !authority_record(e) && e.kind != "erasure"
}

fn discover_copies(
    sessions: &[SessionData],
    mut ids: BTreeSet<String>,
) -> BTreeMap<String, Vec<String>> {
    loop {
        let before = ids.len();
        for e in sessions.iter().flat_map(|s| &s.entries) {
            if e.kind == "input" && ids.contains(&e.id) {
                ids.extend(e.copies.iter().cloned());
            }
            if e.copies.iter().any(|id| ids.contains(id)) {
                ids.insert(e.id.clone());
            }
        }
        if ids.len() == before {
            break;
        }
    }
    sessions
        .iter()
        .filter_map(|s| {
            let copies: Vec<_> = s
                .entries
                .iter()
                .filter(|e| erasable(e) && ids.contains(&e.id))
                .map(|e| e.id.clone())
                .collect();
            (!copies.is_empty()).then(|| (s.id.clone(), copies))
        })
        .collect()
}

fn check_plans(data: &SessionData, plans: &[pending::Plan]) -> Result<()> {
    let tombstones: BTreeSet<_> = data
        .entries
        .iter()
        .filter(|e| e.content.is_none())
        .map(|e| &e.id)
        .collect();
    ensure!(
        plans
            .iter()
            .flat_map(|plan| &plan.copies)
            .all(|copy| copy.complete && tombstones.contains(&copy.entry_id)),
        registry_unavailable("session has pending erasure or lacks its tombstones")
            .context(PendingErasure)
    );
    Ok(())
}

impl HistoryStore for HttpHistory {
    fn coordinates_erasure(&self) -> bool {
        self.coordinated
    }
    fn mark_erasure(
        &self,
        session: &str,
        entry_ids: &[String],
    ) -> Result<BTreeMap<String, Vec<String>>> {
        ensure!(
            self.coordinated,
            "history service does not coordinate erasure"
        );
        if entry_ids.is_empty() {
            return Ok(BTreeMap::new());
        }
        let state = self
            .lease(session)
            .unwrap_or_else(|| self.temporary_lease(session));
        let lease = state.acquire_with_wait(self.ttl, false)?;
        let (revision, _) = self.erasure_plans(session)?;
        let sessions = self.list(None)?;
        let source = sessions
            .iter()
            .find(|s| s.id == session)
            .ok_or_else(|| OperationError::NotFound("unknown erasure source".into()))?;
        let entries: BTreeSet<_> = entry_ids.iter().cloned().collect();
        for target in &entries {
            let e = source
                .entries
                .iter()
                .find(|e| &e.id == target)
                .ok_or_else(|| OperationError::NotFound("unknown erasure target".into()))?;
            ensure!(
                erasable(e),
                OperationError::Forbidden("protected erasure target".into())
            );
        }
        let affected = discover_copies(&sessions, entries.clone());
        let intent = pending::Publication {
            lease,
            revision,
            intent_id: id(),
            entry_ids: entries.into_iter().collect(),
            copies: affected
                .iter()
                .map(|(sid, ids)| pending::CopySet {
                    session_id: sid.clone(),
                    record_id: id(),
                    entry_ids: ids.clone(),
                })
                .collect(),
        };
        state.acquire(self.ttl)?;
        let response = self.writer_post(
            &state,
            &["v1", "sessions", session, "pending-erasure"],
            json!(intent),
        )?;
        let published: pending::Published = serde_json::from_value(response)
            .map_err(|_| registry_unavailable("invalid erasure publication response"))?;
        ensure!(
            pending::path_id(&published.intent_id)
                && (published.session_ids.is_empty()
                    || pending::distinct_ids(&published.session_ids))
                && published
                    .session_ids
                    .iter()
                    .all(|sid| pending::path_id(sid)),
            registry_unavailable("invalid erasure publication response")
        );
        if published.intent_id == intent.intent_id {
            ensure!(
                published.session_ids.iter().eq(affected.keys()),
                registry_unavailable(
                    "erasure publication did not return the submitted destinations"
                )
            );
            return Ok(affected);
        }
        // Recover the source plan and every published destination, even if unlisted.
        let mut original = BTreeMap::new();
        // sessionIds lists every copy set's session, the source's included (history-http.md).
        for sid in published.session_ids.iter().map(String::as_str) {
            let plan = self
                .erasure_plans(sid)?
                .1
                .into_iter()
                .find(|p| p.intent_id == published.intent_id && p.source_session_id == session)
                .ok_or_else(|| registry_unavailable("missing published erasure plan"))?;
            original.insert(
                sid.into(),
                plan.copies.into_iter().map(|c| c.entry_id).collect(),
            );
        }
        Ok(original)
    }
    fn check_erasure(&self, data: &SessionData) -> Result<()> {
        if !self.coordinated {
            return Ok(());
        }
        if self.lease(&data.id).is_some_and(|state| {
            state.lease.lock().unwrap().is_none() && !state.lost.is_cancelled()
        }) {
            // This writer is still assembling a local, unpublished session.
            return Ok(());
        }
        check_plans(data, &self.erasure_plans(&data.id)?.1)
    }
    fn confirmed_erasure(&self, session: &str) -> Result<Vec<String>> {
        if !self.coordinated {
            return Ok(Vec::new());
        }
        Ok(self
            .erasure_plans(session)?
            .1
            .into_iter()
            .flat_map(|plan| {
                plan.copies
                    .into_iter()
                    .filter(|c| c.complete)
                    .map(|c| c.entry_id)
            })
            .collect())
    }
    fn reconcile_erasure(&self, session: &str) -> Result<Option<(SessionData, Vec<String>)>> {
        if !self.coordinated {
            return Ok(None);
        }
        let Some(state) = self.lease(session) else {
            return Err(anyhow!("no history writer lease"));
        };
        let lease = state.acquire_with_wait(self.ttl, false)?;
        let (_, plans) = self.erasure_plans(session)?;
        if plans.is_empty() {
            return Ok(None);
        }
        let mut confirmed = BTreeSet::new();
        for plan in plans {
            let targets: Vec<_> = plan.copies.iter().map(|c| c.entry_id.clone()).collect();
            let pending: Vec<_> = plan
                .copies
                .iter()
                .filter(|c| !c.complete)
                .map(|c| c.entry_id.clone())
                .collect();
            confirmed.extend(
                plan.copies
                    .iter()
                    .filter(|c| c.complete)
                    .map(|c| c.entry_id.clone()),
            );
            if pending.is_empty() {
                continue;
            }
            let (revision, fresh) = self.erasure_plans(session)?;
            ensure!(
                fresh.contains(&plan),
                registry_unavailable("erasure plan changed before reconciliation")
            );
            let (mut data, raw) = self.fetch(session)?;
            if !raw.iter().any(|e| e["id"] == plan.record_id) {
                let keys = erased_input_keys(&data, &targets);
                let first = data.entries.len();
                record_erasure(&mut data, targets.clone(), keys);
                data.entries.last_mut().unwrap().id = plan.record_id.clone();
                let entries = data.entries[first..]
                    .iter()
                    .map(|entry| portable::entry(entry, &data))
                    .collect::<Result<Vec<_>>>()?;
                state.acquire(self.ttl)?;
                checked(state.observe_write(self.guarded_append(
                    session,
                    &lease,
                    &entries,
                    Some(&revision),
                ))?)?;
            } else {
                ensure!(
                    raw.iter().any(|e| e["id"] == plan.record_id
                        && e["kind"] == "erasure"
                        && e["erased"] != true
                        && e["data"]["entryIds"].as_array().is_some_and(|ids| targets
                            .iter()
                            .all(|target| ids.iter().any(|v| v == target)))),
                    registry_unavailable("erasure bookkeeping does not match the plan")
                );
            }
            state.acquire(self.ttl)?;
            self.writer_post(
                &state,
                &["v1", "sessions", session, "erase"],
                json!({"lease":lease,"entryIds":pending}),
            )?;
            let (_, raw) = self.fetch(session)?;
            let verified: Vec<_> = pending
                .into_iter()
                .filter(|id| raw.iter().any(|e| e["id"] == *id && e["erased"] == true))
                .collect();
            if !verified.is_empty() {
                state.acquire(self.ttl)?;
                self.writer_post(
                    &state,
                    &[
                        "v1",
                        "sessions",
                        session,
                        "pending-erasure",
                        &plan.intent_id,
                        "complete",
                    ],
                    json!({"lease":lease,"entryIds":verified}),
                )?;
                confirmed.extend(verified);
            }
        }
        // Include bookkeeping written outside save() in the next append's base.
        let (data, entries) = self.fetch(session)?;
        self.check_erasure(&data)?;
        state.acquire(self.ttl)?;
        *state.kept.lock().unwrap() = entries
            .iter()
            .filter_map(|v| v["id"].as_str().map(str::to_owned))
            .collect();
        Ok(Some((data, confirmed.into_iter().collect())))
    }
    fn supports_erasure(&self) -> bool {
        self.coordinated
    }
    fn acquire(&self, session: &str) -> Result<Box<dyn Lease>> {
        let mut held = self.held.lock().unwrap();
        ensure!(
            held.get(session).and_then(Weak::upgrade).is_none(),
            "history session is already open here"
        );
        let state = self.temporary_lease(session);
        held.insert(session.into(), Arc::downgrade(&state));
        Ok(Box::new(Held(state)))
    }
    fn inspect(&self, session: &str) -> Result<SessionData> {
        self.fetch(session).map(|(data, _)| data)
    }
    fn load(&self, session: &str) -> Result<SessionData> {
        let state = self.lease(session);
        if let Some(state) = &state {
            state.acquire(self.ttl)?;
        }
        let (data, entries) = self.fetch(session)?;
        if let Some(state) = state {
            *state.kept.lock().unwrap() = entries
                .iter()
                .filter_map(|v| v["id"].as_str().map(str::to_owned))
                .collect();
        }
        Ok(data)
    }
    fn save(&self, data: &SessionData) -> Result<()> {
        let state = self
            .lease(&data.id)
            .ok_or_else(|| anyhow!("no history writer lease"))?;
        let mut kept = state.kept.lock().unwrap();
        let mut entries = data
            .entries
            .iter()
            .filter(|e| !kept.contains(&e.id) && e.writer != "rust.derived")
            .map(|e| portable::entry(e, data))
            .collect::<Result<Vec<_>>>()?;
        // A session used only for setup should not leave a row or take a lease.
        if entries.is_empty()
            || (kept.is_empty()
                && data.origin.is_none()
                && data.entries.iter().all(|e| {
                    matches!(
                        e.kind.as_str(),
                        "settings"
                            | "actor.grant"
                            | "actor.identity"
                            | "plugins.changed"
                            | "tenant"
                    )
                }))
        {
            return Ok(());
        }
        if state.lease.lock().unwrap().is_none() {
            // The allowed lease alphabet needs no JSON escaping. Use the actual
            // sender encoding and the longest admissible lease before creating a row.
            let envelope = json!({"lease":"A".repeat(LEASE_BYTES), "entries":[]});
            ensure!(
                serde_json::to_vec(&envelope)?.len() - 2 + serde_json::to_vec(&entries)?.len()
                    <= BODY_LIMIT,
                "initial history append is too large"
            );
            let mut meta = json!({"project":data.project,"created":data.entries.first().map(|e|e.at).unwrap_or(0)});
            if let Some((parent, entry)) = &data.origin {
                meta["parentSessionId"] = json!(parent);
                if let Some(entry) = entry {
                    meta["forkedFrom"] = json!({"sessionId":parent,"entryId":entry});
                }
            }
            checked(self.service.request(
                Method::PUT,
                &["v1", "sessions", &data.id],
                None,
                Some(meta),
            )?)?;
        }
        let lease = state.acquire(self.ttl)?;
        let revision = self
            .coordinated
            .then(|| self.check_append(data, &entries))
            .transpose()?;
        state.acquire(self.ttl)?;
        let appended = self.guarded_append(&data.id, &lease, &entries, revision.as_deref());
        let guard = state.lease.lock().unwrap();
        let remote = guard.as_ref().expect("acquired lease");
        if appended.as_ref().map_or(true, |(status, body)| {
            body["code"] == "lost" || (status.is_success() && !body["kept"].is_u64())
        }) {
            state.lost.cancel();
        }
        remote.check(&state.lost)?;
        checked(appended?)?;
        kept.extend(
            entries
                .drain(..)
                .filter_map(|v| v["id"].as_str().map(str::to_owned)),
        );
        Ok(())
    }
    fn list(&self, project: Option<&Path>) -> Result<Vec<SessionData>> {
        let (_, listed) = self
            .service
            .pages(&["v1", "sessions"], project, "sessions")?;
        listed
            .iter()
            .map(|meta| self.fetch(wire::string(meta, "id")?).map(|(s, _)| s))
            .collect()
    }
    fn erase(&self, ids: Vec<String>, held: &[String]) -> Result<Vec<SessionData>> {
        ensure!(
            self.coordinated,
            registry_unavailable("history service does not coordinate erasure")
        );
        let erased: BTreeSet<_> = ids.into_iter().collect();
        let sessions = self.list(None)?;
        let mut affected = BTreeSet::new();
        for source in sessions {
            let targets: Vec<_> = source
                .entries
                .iter()
                .filter(|e| erasable(e) && erased.contains(&e.id))
                .map(|e| e.id.clone())
                .collect();
            if !targets.is_empty() {
                affected.extend(self.mark_erasure(&source.id, &targets)?.into_keys());
            }
        }
        let mut result = Vec::new();
        for sid in affected {
            let _lease = if held.contains(&sid) {
                None
            } else {
                Some(self.acquire(&sid)?)
            };
            self.lease(&sid)
                .ok_or_else(|| anyhow!("missing history lease"))?
                .acquire(self.ttl)?;
            if let Some((data, _)) = self.reconcile_erasure(&sid)? {
                result.push(data);
            }
        }
        Ok(result)
    }
}
pub struct HttpPlugin(pub HttpHistory);
impl Plugin for HttpPlugin {
    fn name(&self) -> &str {
        "history.http"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        r.provide::<dyn HistoryStore>(
            "history",
            Arc::new(HttpHistory {
                service: self.0.service.clone(),
                ttl: self.0.ttl,
                coordinated: self.0.coordinated,
                held: Mutex::default(),
            }),
        )
    }
}
