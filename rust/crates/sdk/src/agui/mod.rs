//! AG-UI 1.0 over authenticated HTTP. The adapter owns streams and reconciliation
//! metadata. The Harness owns every admission, decision and settlement.
mod input;
mod listing;
mod run;
mod view;
use crate::{AcpActor, Agent, Code, Error, InterfaceConnection, Rights, Session};
use agent_api::{self as base, AgentApi, Scope, SessionData, Value, json};
use axum::{
    body::{Body, Bytes},
    http::{Method, header},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use transport_websocket::http::{Request, Response};
use view::Cursor;

pub type AguiServer = transport_websocket::Server;
#[derive(Clone, Debug)]
pub struct AguiActor {
    pub principal: AcpActor,
    pub client_id: String,
    pub join_on_open: bool,
    pub trust_trace_context: bool,
    pub trace_state_keys: Vec<String>,
}
impl AguiActor {
    pub fn new(client_id: impl Into<String>, principal: AcpActor) -> Self {
        let join_on_open = principal.actor.id == base::ACP_HOST_ACTOR;
        Self {
            trust_trace_context: principal.trust_trace_context,
            principal,
            client_id: client_id.into(),
            join_on_open,
            trace_state_keys: vec![],
        }
    }
}
type StateSnapshot = dyn Fn(&str) -> Option<(String, Value)> + Send + Sync;

/// The plugin supplies its current revision and document. A withheld snapshot
/// cannot establish a base for subsequent patches.
#[derive(Clone)]
pub struct AguiState {
    pub plugin: String,
    pub snapshot: Arc<StateSnapshot>,
}
#[derive(Default)]
pub struct AguiOptions {
    pub listen: String,
    pub actors: Vec<AguiActor>,
    pub tls: Option<crate::TlsOptions>,
    pub client_ca_file: Option<PathBuf>,
    pub tenant: Option<String>,
    pub acp: bool,
    pub origins: Vec<String>,
    pub state: Option<AguiState>,
    /// (emitting plugin, event name) -> RAW.source. The event data is the foreign event.
    pub raw_events: BTreeMap<(String, String), String>,
    pub acp_composition: Option<Arc<dyn crate::AcpComposition>>,
}
#[derive(Clone, Copy, Debug, PartialEq)]
enum Fail {
    Invalid,
    Version,
    Auth,
    Missing,
    Refused,
    Withheld,
    Conflict,
    Cursor,
    Size,
    Busy,
    Lost,
}
type R<T> = std::result::Result<T, Fail>;
impl Fail {
    fn code(self) -> &'static str {
        match self {
            Self::Invalid => "invalid_request",
            Self::Version => "not_supported",
            Self::Auth => "unauthenticated",
            Self::Missing => "not_found",
            Self::Refused => "refused",
            Self::Withheld => "output_withheld",
            Self::Conflict => "conflict",
            Self::Cursor => "cursor_expired",
            Self::Size => "result_too_large",
            Self::Busy => "busy",
            Self::Lost => "unavailable",
        }
    }
    fn response(self) -> Response {
        let status = match self {
            Self::Invalid | Self::Version => 400,
            Self::Auth => 401,
            Self::Missing => 404,
            Self::Withheld | Self::Refused => 403,
            Self::Conflict | Self::Cursor => 409,
            Self::Size => 413,
            Self::Busy | Self::Lost => 503,
        };
        reply(
            status,
            "application/json",
            Body::from(json!({"code":self.code()}).to_string()),
        )
    }
}
impl From<anyhow::Error> for Fail {
    fn from(e: anyhow::Error) -> Self {
        match e.downcast_ref::<base::OperationError>() {
            Some(base::OperationError::Forbidden(_)) => Self::Refused,
            Some(base::OperationError::Busy(_)) => Self::Busy,
            Some(base::OperationError::Conflict(_)) => Self::Conflict,
            Some(base::OperationError::InvalidParams(_)) => Self::Invalid,
            Some(base::OperationError::NotFound(_)) => Self::Missing,
            _ => Self::Lost,
        }
    }
}
fn reply(status: u16, ty: &str, body: Body) -> Response {
    axum::http::Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, ty)
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Accel-Buffering", "no")
        .body(body)
        .unwrap()
}
const MAX: usize = transport_websocket::LIMIT;
fn encode(v: &Value) -> R<Vec<u8>> {
    let b = serde_json::to_vec(v).map_err(|_| Fail::Invalid)?;
    if b.len() > MAX {
        return Err(Fail::Size);
    }
    Ok(b)
}
fn warn(field: &str) {
    if log::log_enabled!(target:"modular_agent::agui::warning",log::Level::Warn) {
        log::warn!(target:"modular_agent::agui::warning","{field}");
    } else {
        eprintln!("AG-UI: ignored {field}");
    }
}
fn scope(id: &str, actor: &str) -> Scope {
    Scope {
        actor: actor.into(),
        ..Scope::session(id)
    }
}
fn invalid(reason: &str) -> Error {
    Error::new(Code::InvalidComposition, reason)
}
#[derive(Default)]
struct Routes {
    clients: BTreeMap<(String, String), Arc<Client>>,
}
#[derive(Default)]
struct Client {
    run: Arc<tokio::sync::Mutex<()>>,
    cursor: Mutex<Option<Cursor>>,
    presence: Mutex<Option<String>>,
    questions: Mutex<BTreeMap<String, Option<String>>>,
    paused: Mutex<Option<(String, InterfaceConnection)>>,
    runs: Mutex<std::collections::VecDeque<String>>,
}
struct Service {
    agent: Agent,
    tenant: Option<String>,
    state: Option<AguiState>,
    raw: BTreeMap<(String, String), String>,
    routes: Mutex<Routes>,
    pages: Mutex<listing::Pages>,
    acp_open: Arc<interface_acp::OpenRoutes>,
    opening: tokio::sync::Mutex<()>,
}
impl Agent {
    pub async fn serve_agui(&self, options: AguiOptions) -> crate::Result<AguiServer> {
        if options.acp {
            self.check_acp_host()?;
        }
        let mut entries = Vec::new();
        let mut clients = BTreeMap::new();
        for mut actor in options.actors {
            crate::acp::validate_actor(&actor.principal.actor)?;
            let p = &mut actor.principal;
            p.projects = crate::acp::validate_scope(p.projects.take(), &p.tenants, &p.represents)?;
            if actor.client_id.is_empty() || !Rights::full().contains(&p.actor.rights) {
                return Err(invalid("invalid AG-UI client or rights"));
            }
            let identity = (
                p.actor.id.clone(),
                p.actor.kind.clone(),
                p.actor.rights.clone(),
                p.projects.clone(),
                p.tenants.clone(),
                actor.join_on_open,
                actor.trust_trace_context,
                actor.trace_state_keys.clone(),
                p.represents.clone(),
            );
            if clients
                .insert(actor.client_id.clone(), identity.clone())
                .is_some_and(|v| v != identity)
            {
                return Err(invalid(
                    "AG-UI client ID has different principals or scopes",
                ));
            }
            entries.push((p.token_file.clone(), Arc::new(actor)));
        }
        for source in &self.inner.interface_sources {
            if clients
                .get(&source.route_id)
                .is_some_and(|id| id.0 != source.actor_id)
            {
                return Err(invalid("AG-UI route has a different registered executor"));
            }
        }
        let routes = self.acp_routes();
        if options.acp {
            self.acp_factory(options.acp_composition.clone(), routes.clone())
                .await?;
        }
        let open_routes = Arc::new(interface_acp::OpenRoutes::default());
        let origins = options.origins;
        let service = Arc::new(Service {
            agent: self.clone(),
            tenant: options.tenant,
            state: options.state,
            raw: options.raw_events,
            routes: Mutex::default(),
            pages: Mutex::default(),
            acp_open: open_routes.clone(),
            opening: Default::default(),
        });
        let secure = options.tls.is_some();
        Ok(transport_websocket::http::serve(&options.listen,options.tls,options.client_ca_file.as_deref(),entries,move |actor,req,upgrade| {
            let service=service.clone();
            let origin=req.headers().get(header::ORIGIN).cloned();
            let allowed=origin.as_ref().is_none_or(|origin|origin.to_str().is_ok_and(|s| origins.iter().any(|o|o==s) || req.headers().get(header::HOST).and_then(|h|h.to_str().ok()).is_some_and(|host| s==format!("{}://{host}",if secure {"https"}else{"http"}))));
            let acp=options.acp.then(||(options.acp_composition.clone(),routes.clone(),open_routes.clone()));
            async move {
                if !allowed {return Fail::Refused.response()}
                let mut response=if req.method()==Method::OPTIONS && origin.is_some() {reply(204,"text/plain",Body::empty())} else if let Some(actor)=actor {
                    if req.uri().path()=="/" && let Some((compose,routes,open))=acp {
                        let p=&actor.principal;
                        let identity=interface_acp::Identity{id:p.actor.id.clone(),kind:p.actor.kind.clone(),rights:p.actor.rights.clone(),tenants:p.tenants.clone(),projects:p.projects.clone(),represents:p.represents.clone(),explicit_rights:true,join_on_open:actor.join_on_open,network:true,trust_trace_context:Some(actor.trust_trace_context)};
                        let factory=service.agent.connection_factory(compose,routes);
                        return upgrade.acp(req,move |conn| async move { let _=interface_acp::run_websocket(factory,identity,conn,open).await; }).unwrap_or_else(||Fail::Invalid.response());
                    }
                    let ceiling=Arc::new(base::ConnectionCeiling::new(actor.principal.actor.id.clone(),actor.principal.actor.rights.clone()));
                    base::CONNECTION_CEILING.scope(ceiling,service.handle(actor,req)).await.unwrap_or_else(Fail::response)
                }else {Fail::Auth.response()};
                if let Some(origin)=origin {let h=response.headers_mut();h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN,origin);h.insert(header::VARY,"Origin".parse().unwrap());h.insert(header::ACCESS_CONTROL_ALLOW_METHODS,"GET, POST, OPTIONS".parse().unwrap());h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS,"Authorization, Content-Type, MA-History-Cursor, traceparent, tracestate".parse().unwrap());} response
            }
        }).await?)
    }
}
impl AguiActor {
    fn id(&self) -> &str {
        &self.principal.actor.id
    }
    fn allows(&self, project: &Path, tenant: Option<&str>) -> bool {
        self.principal
            .projects
            .as_ref()
            .is_none_or(|v| v.iter().any(|p| p == project))
            && self
                .principal
                .tenants
                .as_ref()
                .map_or(tenant.is_none(), |v| {
                    v.iter().any(|t| t.as_deref() == tenant)
                })
    }
}
impl Service {
    fn h(&self) -> &agent_harness::Harness {
        &self.agent.inner.harness
    }
    fn scope_ok(&self, a: &AguiActor, d: &SessionData) -> bool {
        d.project == self.agent.inner.project
            && d.tenant_id() == self.tenant.as_deref()
            && a.allows(&d.project, d.tenant_id())
    }
    fn discovery_rights(&self, a: &AguiActor, d: &SessionData) -> R<Rights> {
        if !self.scope_ok(a, d) {
            return Ok(Rights::default());
        }
        let join =
            a.join_on_open && (self.agent.inner.several_actors || a.id() == base::ACP_HOST_ACTOR);
        Ok(self
            .h()
            .discovery_rights(d, a.id(), &a.principal.actor.rights, join)?)
    }
    fn watch(&self, a: &AguiActor, id: &str) -> R<SessionData> {
        self.h().check_writer(id)?;
        let d = self.h().snapshot(id)?;
        if !self.scope_ok(a, &d) || !self.right(a, id, "watch")? {
            return Err(Fail::Missing);
        }
        Ok(d)
    }
    fn right(&self, a: &AguiActor, id: &str, right: &str) -> R<bool> {
        Ok(a.principal.actor.rights.has(right) && self.h().authority(id, a.id())?.has(right))
    }
    async fn gate(&self, a: &AguiActor, id: &str, mut value: Value) -> R<Value> {
        if !id.is_empty() {
            self.watch(a, id)?;
        }
        let view = self
            .h()
            .output(
                &scope(id, a.id()),
                base::Output {
                    recipient: a.client_id.clone(),
                    value: value.clone(),
                    stream: None,
                    end: true,
                },
            )
            .await?
            .ok_or(Fail::Withheld)?;
        if !id.is_empty() {
            self.watch(a, id)?;
        }
        if value != view && !agent_harness::apply_redactions(&mut value, &view) {
            return Err(Fail::Withheld);
        }
        Ok(view)
    }
    fn buffer(&self, id: &str, bytes: Vec<u8>) -> R<Bytes> {
        struct Reserved(Vec<u8>, #[allow(dead_code)] Box<dyn Send>);
        impl AsRef<[u8]> for Reserved {
            fn as_ref(&self) -> &[u8] {
                &self.0
            }
        }
        let permit = self.h().reserve_output(id, bytes.len() as u64)?;
        Ok(Bytes::from_owner(Reserved(bytes, permit)))
    }
    fn client(&self, id: &str, a: &AguiActor) -> R<Arc<Client>> {
        let mut r = self.routes.lock().unwrap();
        let key = (id.into(), a.client_id.clone());
        if r.clients.len() >= 4096 && !r.clients.contains_key(&key) {
            r.clients
                .retain(|_, c| Arc::strong_count(c) > 1 || c.paused.lock().unwrap().is_some());
            if r.clients.len() >= 4096 {
                return Err(Fail::Busy);
            }
        }
        Ok(r.clients.entry(key).or_default().clone())
    }
    fn grant(&self, a: &AguiActor, id: &str) -> R<()> {
        let rights = self.h().discovery_rights(
            &self.h().snapshot(id)?,
            a.id(),
            &a.principal.actor.rights,
            true,
        )?;
        if !rights.has("watch") {
            return Err(Fail::Missing);
        }
        self.h().append(&scope(id,a.id()),"interface.agui",base::Draft::new("actor.grant",false,json!({"actor":a.id(),"kind":a.principal.actor.kind,"authority":rights,"operatorAdmission":true})))?;
        Ok(())
    }
    async fn attach(&self, a: &AguiActor, id: &str) -> R<Session> {
        let _lock = self.opening.lock().await;
        if !a.principal.actor.rights.has("watch")
            || id.is_empty()
            || id.contains(['/', '\\'])
            || id == ".."
            || id == "."
        {
            return Err(Fail::Missing);
        }
        let open = self.h().open_session_ids().iter().any(|s| s == id);
        let data = if open {
            self.h().snapshot(id)?
        } else {
            self.agent
                .inner
                .history
                .0
                .load(id)
                .map_err(|_| Fail::Missing)?
        };
        if !self.discovery_rights(a, &data)?.has("watch") {
            return Err(Fail::Missing);
        }
        let member = base::actors(&data).contains_key(a.id());
        let session = Session::new(self.agent.inner.clone(), id.into());
        if !open {
            self.h().install_recovery(id).await?;
        }
        if !member {
            self.grant(a, id)?;
        }
        self.watch(a, id)?;
        if !open {
            self.agent.attach(id).map_err(|_| Fail::Lost)?;
            self.h().run_recovery(id).await?;
            session
                .drive()
                .await
                .map_err(|_| Fail::Lost)?
                .map_err(|_| Fail::Lost)?;
        }
        Ok(session)
    }
    async fn handle(self: Arc<Self>, a: Arc<AguiActor>, req: Request) -> R<Response> {
        let path = req.uri().path().to_owned();
        let prefix = "/agui/v1";
        if req.method() == Method::GET && path == "/agui/v1/threads" {
            return self.list_threads(&a, req.uri().query()).await;
        }
        if req.uri().query().is_some() {
            return Err(Fail::Invalid);
        }
        match (req.method(), path.strip_prefix(prefix)) {
            (&Method::GET, Some("")) => {
                if !a.principal.actor.rights.has("watch") {
                    return Err(Fail::Refused);
                }
                let d = self.agent.declaration().map_err(|_| Fail::Lost)?;
                self.json(&a,"",200,json!({"binding":"modular-agent-agui/1","protocolVersion":"1.0","declaration":d})).await
            }
            (&Method::POST, Some("/threads")) => {
                if body(req).await? != json!({}) {
                    return Err(Fail::Invalid);
                }
                let mut rights = a.principal.actor.rights.clone();
                if let Some(tenant) = &self.tenant {
                    rights = rights
                        .intersect(&self.h().tenant_rights(tenant).map_err(|_| Fail::Refused)?);
                }
                if !a.allows(&self.agent.inner.project, self.tenant.as_deref())
                    || !["input", "watch"].iter().all(|r| rights.has(r))
                {
                    return Err(Fail::Refused);
                }
                let id = self
                    .h()
                    .create_provisional(
                        &self.agent.inner.project,
                        self.agent.inner.session_settings.clone(),
                        self.tenant.as_deref(),
                    )
                    .await?;
                let result=async{self.grant(&a,&id)?; if !self.right(&a,&id,"input")? {return Err(Fail::Refused)} self.agent.attach(&id).map_err(|_|Fail::Lost)?; self.json(&a,&id,201,json!({"threadId":id,"declaration":self.agent.declaration_for(Some(&id),false).map_err(|_|Fail::Lost)?})).await}.await;
                if result.is_err() {
                    let _ = self.h().close(&id).await;
                }
                result
            }
            (&Method::GET, Some(p)) if p.starts_with("/threads/") => {
                let rest = &p[9..];
                let id = rest.strip_suffix("/presence").unwrap_or(rest);
                self.attach(&a, id).await?;
                let c = self.client(id, &a)?;
                if id != rest {
                    self.presence(a, id.to_owned(), c)
                } else {
                    self.http_snapshot(&a, id, &c).await
                }
            }
            (&Method::POST, Some("/run")) => {
                let headers = req.headers().clone();
                let request = input::Input::parse(body(req).await?)?;
                let context = input::trace(&a, &headers);
                base::telemetry::within(context, self.start(a, request, headers)).await
            }
            _ => Err(Fail::Missing),
        }
    }
    async fn json(&self, a: &AguiActor, id: &str, status: u16, v: Value) -> R<Response> {
        let v = self.gate(a, id, v).await?;
        Ok(reply(status, "application/json", Body::from(encode(&v)?)))
    }
    fn presence(self: Arc<Self>, a: Arc<AguiActor>, id: String, c: Arc<Client>) -> R<Response> {
        let route = base::id();
        let questions = base::requests(self.h())?;
        let mut slot = c.presence.lock().unwrap();
        if slot.is_some() {
            return Err(Fail::Conflict);
        }
        let approvals = self.right(&a, &id, "approve")?;
        questions.connect_answer_route(&id, a.id(), &route, approvals);
        *slot = Some(route.clone());
        drop(slot);
        struct Guard(Arc<Client>, Arc<dyn base::InputRequests>, String, String);
        impl Drop for Guard {
            fn drop(&mut self) {
                let mut slot = self.0.presence.lock().unwrap();
                self.1.detach_presence(&self.2, &self.3);
                *slot = None;
                self.0.questions.lock().unwrap().retain(|_, r| r.is_none());
                self.0.paused.lock().unwrap().take();
            }
        }
        let guard = Guard(c, questions, id.clone(), route);
        let stream = async_stream::stream! {let _guard=guard;loop{if self.watch(&a,&id).is_err(){break} yield Ok::<_,std::convert::Infallible>(Bytes::from_static(b": present\n\n"));tokio::time::sleep(Duration::from_secs(10)).await;}};
        Ok(reply(200, "text/event-stream", Body::from_stream(stream)))
    }
}
async fn body(req: Request) -> R<Value> {
    if req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_none_or(|v| !v.trim().eq_ignore_ascii_case("application/json"))
    {
        return Err(Fail::Invalid);
    }
    let bytes = axum::body::to_bytes(req.into_body(), MAX)
        .await
        .map_err(|_| Fail::Size)?;
    base::wire::decode_json(&bytes).map_err(|_| Fail::Invalid)
}
