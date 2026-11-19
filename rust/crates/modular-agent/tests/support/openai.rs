use agent_api::*;
use axum::{
    Router,
    body::Body,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, post},
};
use provider_openai::{Mode, OpenAiPlugin};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex},
};
use tempfile::TempDir;

#[derive(Clone)]
pub enum Reply {
    Text(String),
    Call(ToolCall),
    Error(u16, Value),
    Broken(bool),
    Wait,
}
impl From<&str> for Reply {
    fn from(s: &str) -> Self {
        Self::Text(s.into())
    }
}
#[derive(Default)]
pub struct Remote {
    pub replies: VecDeque<Reply>,
    pub requests: Vec<Value>,
    pub effective: Vec<Value>,
    pub stored: BTreeMap<String, Vec<Value>>,
    pub deleted: Vec<String>,
    pub refuse_delete: bool,
    pub sequence: u64,
}
pub struct Server {
    pub remote: Arc<Mutex<Remote>>,
    pub endpoint: String,
    task: tokio::task::JoinHandle<()>,
}
impl Server {
    pub async fn new(replies: Vec<Reply>) -> Self {
        let remote = Arc::new(Mutex::new(Remote {
            replies: replies.into(),
            ..Default::default()
        }));
        let router = Router::new()
            .route("/v1/responses", post(generate))
            .route("/v1/responses/{id}", delete(erase))
            .with_state(remote.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1/responses", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        Self {
            remote,
            endpoint,
            task,
        }
    }
    pub async fn stop(&mut self) {
        self.task.abort();
        assert!((&mut self.task).await.unwrap_err().is_cancelled());
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn erase(State(remote): State<Arc<Mutex<Remote>>>, Path(id): Path<String>) -> Response {
    let mut remote = remote.lock().unwrap();
    if remote.refuse_delete {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    remote.stored.remove(&id);
    remote.deleted.push(id.clone());
    axum::Json(json!({"id":id,"deleted":true,"object":"response.deleted"})).into_response()
}
async fn generate(
    State(remote): State<Arc<Mutex<Remote>>>,
    axum::Json(body): axum::Json<Value>,
) -> Response {
    let mut remote = remote.lock().unwrap();
    remote.requests.push(body.clone());
    let mut effective = if let Some(previous) = body["previous_response_id"].as_str() {
        let Some(context) = remote.stored.get(previous) else {
            return (StatusCode::NOT_FOUND, axum::Json(json!({"error":{"param":"previous_response_id","code":"previous_response_not_found"}}))).into_response();
        };
        context.clone()
    } else {
        vec![]
    };
    effective.extend(body["input"].as_array().unwrap().iter().cloned());
    remote.effective.push(json!(effective));
    let reply = remote
        .replies
        .pop_front()
        .expect("fake OpenAI script exhausted");
    if let Reply::Error(status, payload) = reply {
        return (StatusCode::from_u16(status).unwrap(), axum::Json(payload)).into_response();
    }
    remote.sequence += 1;
    let id = format!("resp_{}", remote.sequence);
    let output = match &reply {
        Reply::Text(text) => {
            json!([{"id":format!("msg_{}",remote.sequence),"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]}])
        }
        Reply::Call(call) => {
            json!([{"type":"function_call","id":format!("fc_{}",remote.sequence),"call_id":call.id,"name":call.name,"arguments":serde_json::to_string(&call.input).unwrap(),"status":"completed"}])
        }
        _ => json!([]),
    };
    let response = json!({"id":id,"status":"completed","output":output,"usage":{"input_tokens":10,"output_tokens":2}});
    if body["store"] == true {
        effective.extend(output.as_array().unwrap().iter().cloned());
        remote.stored.insert(id.clone(), effective);
    }
    let created = json!({"type":"response.created","response":{"id":id}});
    let completed = json!({"type":"response.completed","response":response});
    let stream = match reply {
        Reply::Broken(false) => String::new(),
        Reply::Broken(true) | Reply::Wait => format!("data: {created}\n\n"),
        _ => format!("data: {created}\n\ndata: {completed}\n\n"),
    };
    let wait = matches!(reply, Reply::Wait);
    drop(remote);
    let bytes: Vec<_> = stream
        .into_bytes()
        .chunks(7)
        .map(|c| Ok::<_, std::io::Error>(c.to_vec()))
        .collect();
    let chunks = futures_util::stream::iter(bytes);
    let body = if wait {
        use futures_util::StreamExt;
        Body::from_stream(chunks.chain(futures_util::stream::pending()))
    } else {
        Body::from_stream(chunks)
    };
    Response::builder()
        .header("content-type", "text/event-stream")
        .body(body)
        .unwrap()
}
#[derive(Default)]
pub struct FullRequests(pub Mutex<Vec<Value>>, pub Mutex<Value>);
struct Observe(Arc<FullRequests>);
impl Plugin for Observe {
    fn name(&self) -> &str {
        "test.openai-observer"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        let full = self.0.clone();
        r.on(
            "provider.openai.before",
            Order::Last,
            handler(move |_, _, mut body| {
                let full = full.clone();
                Box::pin(async move {
                    let patch = full.1.lock().unwrap().clone();
                    if patch.is_object() {
                        merge(&mut body, patch);
                    }
                    full.0.lock().unwrap().push(body.clone());
                    Ok(answer(body))
                })
            }),
        );
        Ok(())
    }
}
pub struct OpenRig {
    pub root: TempDir,
    pub project: TempDir,
    pub server: Server,
    pub h: Arc<agent_harness::Harness>,
    pub id: String,
    pub full: Arc<FullRequests>,
    pub events: Arc<super::Events>,
    mode: Mode,
    durable: bool,
}
impl OpenRig {
    pub async fn new(mode: Mode, durable: bool, replies: Vec<Reply>) -> Self {
        let root = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        // Deliberately synthetic. The real credential file is never read in tests.
        std::fs::write(root.path().join("key"), "offline-fixture-key").unwrap();
        let server = Server::new(replies).await;
        let (h, full, events) = composition(root.path(), &server, mode, durable).await;
        let id = h
            .create(
                project.path(),
                json!({"model":"gpt-6-luna","approval":"off"}),
            )
            .await
            .unwrap();
        Self {
            root,
            project,
            server,
            h,
            id,
            full,
            events,
            mode,
            durable,
        }
    }
    pub fn scope(&self) -> Scope {
        Scope::session(&self.id)
    }
    pub async fn run_in(&self, id: &str, text: &str) -> TurnResult {
        self.h
            .submit(id, "user", text, Timing::Now, None)
            .await
            .unwrap();
        self.h.run_next(id).await.unwrap().unwrap()
    }
    pub async fn run(&self, text: &str) -> TurnResult {
        self.run_in(&self.id, text).await
    }
    pub async fn reopen(&mut self) {
        self.reopen_result().await.unwrap();
    }
    pub async fn reopen_result(&mut self) -> Result<()> {
        self.h.close(&self.id).await.unwrap();
        let (h, full, events) =
            composition(self.root.path(), &self.server, self.mode, self.durable).await;
        self.h = h;
        self.full = full;
        self.events = events;
        self.h.open(&self.id).await
    }
    pub fn aligned(&self) {
        let remote = self.server.remote.lock().unwrap();
        let full = self.full.0.lock().unwrap();
        let effective = &remote.effective[remote.effective.len() - full.len()..];
        for (actual, expected) in effective.iter().zip(full.iter()) {
            assert_eq!(actual, &expected["input"]);
        }
    }
    pub async fn finish(mut self) {
        self.h.close(&self.id).await.unwrap();
        self.server.stop().await;
    }
}
async fn composition(
    root: &std::path::Path,
    server: &Server,
    mode: Mode,
    durable: bool,
) -> (
    Arc<agent_harness::Harness>,
    Arc<FullRequests>,
    Arc<super::Events>,
) {
    let provider = OpenAiPlugin::new(mode, root.join("openai"))
        .with_test_endpoint(&server.endpoint)
        .unwrap();
    let events = Arc::new(super::Events::default());
    let h = modular_agent::compose(
        modular_agent::Options {
            history: root.join("sessions"),
            global_config: root.join("settings"),
            key_file: root.join("key"),
            secrets: vec![],
        },
        Arc::new(provider),
        Arc::new(interface_terminal::TerminalPlugin {
            sink: events.clone(),
        }),
        if durable {
            Arc::new(runtime_durable::DurablePlugin)
        } else {
            Arc::new(runtime_transient::TransientPlugin)
        },
    )
    .await
    .unwrap();
    let full = Arc::new(FullRequests::default());
    h.load(Arc::new(Observe(full.clone()))).await.unwrap();
    (h, full, events)
}
