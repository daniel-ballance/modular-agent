//! Session lifecycle through the SDK, including an OS kill without close hooks.
use modular_agent::{
    Actor, Agent, Code, Durability, EntryPage, History, HistoryResult, InterruptedTurn, LeaseGrant,
    Outcome, Plugin, PortableHistoryStore, Result, Rights, RuntimeCall, RuntimeContext,
    RuntimeDeclaration, RuntimeOutcome, RuntimePart, RuntimeTurn, ServeHistoryOptions,
    SessionOptions, SessionPage, Timing, Usage, async_trait, file_history, http_history,
    listen_history, testing::test_agent,
};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::Notify;

// Use a real persistent backend, recording mutation boundaries at the history port.
struct RecordingStore {
    store: Arc<history_http::SnapshotStore>,
    journal: PathBuf,
    append_gate: Option<Arc<AppendGate>>,
}
const RECORDING_LEASE_TTL: Duration = Duration::from_secs(30);

#[derive(Default)]
struct AppendGate {
    entered: Notify,
    release: Notify,
}

impl RecordingStore {
    fn new(root: &Path) -> Result<Self> {
        Ok(Self {
            store: Arc::new(history_http::SnapshotStore::new(
                Arc::new(history_fs::FileHistory::new(&root.join("history"))?),
                RECORDING_LEASE_TTL,
                100,
            )?),
            journal: root.join("mutations.jsonl"),
            append_gate: None,
        })
    }
    fn record(&self, id: &str, op: &str, data: Value) {
        let mut journal = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.journal)
            .unwrap();
        writeln!(journal, "{}", json!([id, op, data])).unwrap();
    }
}
#[async_trait]
impl PortableHistoryStore for RecordingStore {
    fn ttl_ms(&self) -> u64 {
        self.store.ttl_ms()
    }
    fn supports_history_service(&self) -> bool {
        true
    }
    fn supports_erasure(&self) -> bool {
        true
    }
    async fn create(&self, id: &str, metadata: Value) -> HistoryResult<()> {
        self.record(id, "create", metadata.clone());
        self.store.create(id, metadata).await
    }
    async fn acquire(&self, id: &str, owner: &str) -> HistoryResult<LeaseGrant> {
        self.record(id, "acquire", json!(owner));
        self.store.acquire(id, owner).await
    }
    async fn renew(&self, id: &str, lease: &str) -> HistoryResult<u64> {
        self.store.renew(id, lease).await
    }
    async fn release(&self, id: &str, lease: &str) -> HistoryResult<()> {
        self.store.release(id, lease).await
    }
    async fn append(&self, id: &str, lease: &str, entries: Vec<Value>) -> HistoryResult<u64> {
        if let Some(gate) = &self.append_gate {
            gate.entered.notify_one();
            gate.release.notified().await;
        }
        self.record(id, "append", json!(entries));
        self.store.append(id, lease, entries).await
    }
    async fn read(&self, id: &str, after: Option<&str>, limit: usize) -> HistoryResult<EntryPage> {
        let page = self.store.read(id, after, limit).await?;
        self.record(
            id,
            "read",
            json!(page.entries.iter().map(|e| &e["kind"]).collect::<Vec<_>>()),
        );
        Ok(page)
    }
    async fn list(
        &self,
        project: Option<&Path>,
        after: Option<&str>,
        limit: usize,
    ) -> HistoryResult<SessionPage> {
        self.store.list(project, after, limit).await
    }
    async fn erase(
        &self,
        id: &str,
        lease: Option<&str>,
        entries: Vec<String>,
    ) -> HistoryResult<Vec<String>> {
        self.store.erase(id, lease, entries).await
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quiet_erasure_checks_metadata_before_reading_history() -> Result<()> {
    let root = tempfile::tempdir()?;
    let other = tempfile::tempdir()?;
    let store = RecordingStore::new(root.path())?;
    let journal = store.journal.clone();
    for (id, project) in [
        ("foreign-project", other.path()),
        ("foreign-tenant", root.path()),
    ] {
        store
            .create(id, json!({"project":project,"created":1}))
            .await
            .unwrap();
        let lease = store.acquire(id, "fixture").await.unwrap().lease;
        store.append(id, &lease, vec![
            json!({"id":"setup","parentId":null,"kind":"tenant","data":{"tenant":"outside"}}),
            json!({"id":"payload","parentId":"setup","kind":"fixture.private"}),
        ]).await.unwrap();
        store.release(id, &lease).await.unwrap();
    }
    let token = root.path().join("token");
    fs::write(
        &token,
        "2b2c8752a74147759a4048d8a36b02fae045ad654b6043c2ae22d00e712a4852",
    )?;
    let mut options = ServeHistoryOptions::new("127.0.0.1:0".parse().unwrap(), &token);
    options.lease_ttl = RECORDING_LEASE_TTL;
    let server = listen_history(History::from_portable(store, true)?, options).await?;
    let agent = test_agent()
        .project(root.path())
        .durability(Durability::Kept)
        .history(http_history(&server.url, &token)?)
        .build()
        .await?;
    fs::write(&journal, "")?;
    for id in ["foreign-project", "foreign-tenant"] {
        let report = agent
            .reconcile_erasure(modular_agent::ReconcileErasureOptions {
                sessions: vec![id.into()],
                discover: false,
            })
            .await?
            .pop()
            .unwrap();
        assert_eq!(report.state, modular_agent::ErasureRetryState::OutOfScope);
        assert!(report.erased.is_empty() && report.pending.is_empty());
        let trace = fs::read_to_string(&journal)?;
        let expected = if id == "foreign-project" {
            String::new()
        } else {
            format!("{}\n", json!([id, "read", ["tenant"]]))
        };
        assert_eq!(trace, expected);
    }
    assert_eq!(
        agent
            .reconcile_erasure(modular_agent::ReconcileErasureOptions {
                discover: true,
                ..Default::default()
            })
            .await
            .unwrap_err()
            .code(),
        Code::Unavailable
    );
    Ok(())
}

#[tokio::test]
async fn served_custom_store_renews_while_another_sessions_append_is_blocked() -> Result<()> {
    let root = tempfile::tempdir()?;
    let token = "custom-history-test-token-not-for-deployment";
    let token_file = root.path().join("token");
    fs::write(&token_file, token)?;
    let gate = Arc::new(AppendGate::default());
    let mut store = RecordingStore::new(root.path())?;
    store.append_gate = Some(gate.clone());
    let mut options = ServeHistoryOptions::new("127.0.0.1:0".parse().unwrap(), token_file);
    options.lease_ttl = RECORDING_LEASE_TTL;
    let server = listen_history(History::from_portable(store, true)?, options).await?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let writing = format!("{}/v1/sessions/writing", server.url);
    let renewing = format!("{}/v1/sessions/renewing", server.url);
    let acquire = |session: String| {
        let client = &client;
        async move {
            client
                .put(&session)
                .bearer_auth(token)
                .json(&json!({"project":"/p","created":1}))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
            client
                .post(format!("{session}/lease"))
                .bearer_auth(token)
                .json(&json!({"owner":"test-writer"}))
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .json::<LeaseGrant>()
                .await
                .unwrap()
        }
    };
    let renewing_lease = acquire(renewing.clone()).await.lease;
    let writing_lease = acquire(writing.clone()).await.lease;
    let append = tokio::spawn(
        client
            .post(format!("{writing}/entries"))
            .bearer_auth(token)
            .json(&json!({"lease":writing_lease,"entries":[{"id":"entry","parentId":null}]}))
            .timeout(Duration::from_secs(25))
            .send(),
    );
    tokio::time::timeout(Duration::from_secs(10), gate.entered.notified())
        .await
        .expect("append did not reach the custom store");
    let renewal = client
        .post(format!("{renewing}/lease/{renewing_lease}/renew"))
        .bearer_auth(token)
        .send()
        .await
        .expect("renewal waited for the blocked append")
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(renewal, json!({"ttlMs":RECORDING_LEASE_TTL.as_millis()}));
    assert!(
        !append.is_finished(),
        "append finished before the gate opened"
    );
    gate.release.notify_one();
    let appended = append
        .await
        .unwrap()
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(appended, json!({"kept":1}));
    server.close().await;
    Ok(())
}

struct ServedRuntime;
#[async_trait]
impl RuntimePart for ServedRuntime {
    async fn resume_turn(
        &self,
        _: RuntimeTurn,
        _: InterruptedTurn,
        _: RuntimeContext,
    ) -> Result<RuntimeOutcome> {
        unreachable!()
    }
    async fn continue_open_calls(
        &self,
        _: RuntimeTurn,
        _: Vec<RuntimeCall>,
        _: RuntimeContext,
    ) -> Result<RuntimeOutcome> {
        unreachable!()
    }
    fn declaration(&self) -> RuntimeDeclaration {
        RuntimeDeclaration {
            id: "single-step".into(),
            supports: Default::default(),
        }
    }
    async fn run_turn(&self, _: RuntimeTurn, cx: RuntimeContext) -> Result<RuntimeOutcome> {
        let step = cx.new_id().await?;
        let request = cx.prepare_step(&step, Usage::default()).await?;
        let response = cx.model(&step, request).await?;
        let entry = cx
            .record(json!({"kind":"response","stepId":step,"visible":true,"message":response}))
            .await?;
        cx.hook("step.after", json!({"stepId":step,"response":response}))
            .await?;
        Ok(RuntimeOutcome {
            outcome: Outcome::Completed,
            result: json!({"text":response.0["content"][0]["text"],"openToolCalls":[]}),
            entries: vec![entry["id"].as_str().unwrap().into()],
            usage: response
                .get("usage")
                .cloned()
                .map(serde_json::from_value)
                .transpose()?
                .unwrap_or_default(),
        })
    }
}

async fn compose(root: &Path, store: &str, served: bool, url: &str) -> Result<Agent> {
    let mut builder = test_agent()
        .project(root)
        .data_dir(root.join("agent"))
        .durability(Durability::Kept)
        .several_actors(true)
        .tenants(json!({"demo":{"rights":["watch","input","settings","grant","cancel"]}}))
        .script(json!([{"text":"done"}]));
    builder = match store {
        "file" => builder.history(file_history(root.join("history"))?),
        "http" => builder.history(http_history(url, root.join("token"))?),
        "custom" => {
            let history = History::from_portable(RecordingStore::new(root)?, true)?;
            builder.plugin(
                Plugin::new("test-store")
                    .replaces("history")
                    .setup(move |r| r.history_store(history.clone())),
            )
        }
        _ => unreachable!(),
    };
    if served {
        builder = builder.over_wire(
            Plugin::new("served-runtime")
                .replaces("runtime")
                .setup(|r| r.runtime(ServedRuntime)),
        );
    }
    builder.build().await
}

fn options() -> SessionOptions {
    SessionOptions {
        settings: serde_json::from_value(json!({"maxSteps":4})).unwrap(),
        tenant: Some("demo".into()),
        actors: vec![Actor {
            id: "guest".into(),
            kind: "user".into(),
            rights: Rights::only(&["watch"]),
        }],
    }
}

fn mutations(root: &Path) -> Vec<Value> {
    let path = root.join("mutations.jsonl");
    if !path.exists() {
        return vec![];
    }
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn assert_unpublished(agent: &Agent, root: &Path, id: &str) -> Result<()> {
    assert!(!agent.sessions(None)?.iter().any(|s| s.id == id));
    assert_eq!(agent.session_info(id).unwrap_err().code(), Code::NotFound);
    assert!(mutations(root).iter().all(|m| m[0] != id));
    assert!(!root.join("history").join(format!("{id}.json")).exists());
    Ok(())
}

fn assert_initial_batch(root: &Path, id: &str, entries: &[Value], fork: bool) {
    let writes: Vec<_> = mutations(root).into_iter().filter(|m| m[0] == id).collect();
    assert_eq!(
        writes
            .iter()
            .take(3)
            .map(|m| m[1].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["create", "acquire", "append"]
    );
    assert_eq!(writes[2][2], json!(entries));
    if fork {
        assert_eq!(writes.len(), 3, "fork must use one initial append");
    }
}

#[tokio::test]
async fn provisional_crash_worker() -> Result<()> {
    let Some(root) = std::env::var_os("MA_PROVISIONAL_TEST_ROOT") else {
        return Ok(());
    };
    let root = PathBuf::from(root);
    let store = std::env::var("MA_PROVISIONAL_TEST_STORE").unwrap();
    let served = std::env::var("MA_PROVISIONAL_TEST_SERVED").unwrap() == "yes";
    let url = std::env::var("MA_PROVISIONAL_TEST_URL").unwrap();
    let agent = compose(&root, &store, served, &url).await?;
    let session = agent.session_with(options()).await?;
    session.set_setting("maxSteps", json!(3))?;
    println!("session-ready:{}", session.id());
    std::io::stdout().flush()?;
    std::future::pending().await
}

async fn kill_before_admission(
    root: &Path,
    store: &str,
    served: bool,
    url: &str,
) -> Result<String> {
    use tokio::io::AsyncBufReadExt;
    let mut child = tokio::process::Command::new(std::env::current_exe()?)
        .args(["--exact", "provisional_crash_worker", "--nocapture"])
        .env("MA_PROVISIONAL_TEST_ROOT", root)
        .env("MA_PROVISIONAL_TEST_STORE", store)
        .env(
            "MA_PROVISIONAL_TEST_SERVED",
            if served { "yes" } else { "no" },
        )
        .env("MA_PROVISIONAL_TEST_URL", url)
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut lines = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
    let id = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(line) = lines.next_line().await? {
            if let Some(id) = line.strip_prefix("session-ready:") {
                return Ok::<_, std::io::Error>(id.to_owned());
            }
        }
        panic!("crash worker exited before creating a session");
    })
    .await
    .expect("crash worker did not announce readiness")?;
    child.kill().await?;
    Ok(id)
}

async fn lifecycle(store: &str, served: bool) -> Result<()> {
    let temp = tempfile::tempdir()?;
    let root = temp.path();
    let server = if store == "http" {
        let token = root.join("token");
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&token)?
            .write_all(b"provisional-test-token-not-for-deployment\n")?;
        let history = History::from_portable(RecordingStore::new(root)?, true)?;
        let mut options = ServeHistoryOptions::new("127.0.0.1:0".parse().unwrap(), token);
        options.lease_ttl = RECORDING_LEASE_TTL;
        Some(listen_history(history, options).await?)
    } else {
        None
    };
    let url = server.as_ref().map(|s| s.url.as_str()).unwrap_or_default();
    let crash_root = if store == "custom" {
        root.join("crash")
    } else {
        root.to_owned()
    };
    fs::create_dir_all(&crash_root)?;
    let crashed = kill_before_admission(&crash_root, store, served, url).await?;
    let restarted = compose(&crash_root, store, served, url).await?;
    assert_unpublished(&restarted, &crash_root, &crashed)?;
    assert_eq!(
        restarted.open_session(&crashed).await.err().unwrap().code(),
        Code::NotFound
    );
    restarted.close().await?;

    let agent = compose(root, store, served, url).await?;
    let unused = agent.session_with(options()).await?;
    unused.set_setting("maxSteps", json!(2))?;
    assert_unpublished(&agent, root, unused.id())?;
    unused.close().await?;
    assert_unpublished(&agent, root, unused.id())?;

    let session = agent.session_with(options()).await?;
    session.set_setting("maxSteps", json!(3))?;
    assert_eq!(
        session
            .r#as("guest")?
            .send("refuse this", Timing::Now)
            .await
            .unwrap_err()
            .code(),
        Code::Forbidden
    );
    assert_unpublished(&agent, root, session.id())?;
    let setup = session.history().await?;
    assert_eq!(
        setup
            .iter()
            .map(|e| e["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["tenant", "setting", "plugins", "actorJoined", "setting"]
    );
    assert_eq!(setup[1]["data"]["value"]["maxSteps"], 4);
    assert_eq!(setup[4]["data"]["value"]["maxSteps"], 3);
    assert_eq!(session.prompt("keep this").await?.text, "done");
    let entries = session.history().await?;
    assert_eq!(entries[..setup.len()], setup);
    assert_eq!(entries[setup.len()]["kind"], "inputAccepted");
    assert_eq!(
        entries[setup.len()]["parentId"],
        setup.last().unwrap()["id"]
    );
    assert_eq!(entries[setup.len() + 1]["kind"], "turnStart");
    assert_eq!(entries[setup.len() + 2]["kind"], "input");
    if store != "file" {
        assert_initial_batch(root, session.id(), &entries[..=setup.len()], false);
    }

    let fork = session.fork()?;
    let copied = fork.history().await?;
    for (copy, original) in copied.iter().zip(&entries) {
        assert_ne!(copy["id"], original["id"]);
        assert_eq!(copy["sources"], json!([original["id"]]));
    }
    let fresh = &copied[entries.len()..];
    assert_eq!(
        fresh
            .iter()
            .map(|e| e["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["tenant", "actorJoined", "setting", "plugins"]
    );
    assert!(fresh.iter().all(|e| e.get("sources").is_none()));
    if store != "file" {
        assert_initial_batch(root, fork.id(), &copied, true);
    }
    fork.close().await?;
    assert_eq!(
        agent
            .open_session(fork.id())
            .await?
            .history()
            .await?
            .iter()
            .map(|e| &e["id"])
            .collect::<Vec<_>>(),
        copied.iter().map(|e| &e["id"]).collect::<Vec<_>>()
    );
    agent.close().await?;
    if let Some(server) = server {
        server.close().await;
    }
    Ok(())
}

macro_rules! check {
    ($name:ident, $store:literal, $served:literal) => {
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn $name() -> Result<()> {
            lifecycle($store, $served).await
        }
    };
}
check!(file_native, "file", false);
check!(file_served, "file", true);
check!(http_native, "http", false);
check!(http_served, "http", true);
check!(custom_native, "custom", false);
check!(custom_served, "custom", true);
