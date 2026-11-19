#![allow(dead_code)] // Each acceptance test binary uses a different subset of this fixture.
pub mod acp;
pub mod openai;
use agent_api::*;
use agent_harness::Harness;
use interface_terminal::TerminalPlugin;
use provider_fake::{FakePlugin, Probe, Script};
use std::sync::{Arc, Mutex};
use tempfile::TempDir;
#[derive(Default)]
pub struct Events {
    pub values: Mutex<Vec<Event>>,
    notify: tokio::sync::Notify,
}
impl EventSink for Events {
    fn send(&self, event: Event) {
        self.values.lock().unwrap().push(event);
        self.notify.notify_waiters();
    }
}
impl Events {
    pub async fn wait(&self, kind: &str) {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let notified = self.notify.notified();
                if self.values.lock().unwrap().iter().any(|e| e.kind == kind) {
                    return;
                }
                notified.await;
            }
        })
        .await
        .expect("event timeout");
    }
}
pub struct Rig {
    pub h: Arc<Harness>,
    pub id: String,
    pub root: TempDir,
    pub project: TempDir,
    pub probe: Arc<Probe>,
    pub events: Arc<Events>,
}
impl Rig {
    pub async fn new(scripts: Vec<Script>) -> Self {
        Self::with(scripts, vec![], vec![], json!({})).await
    }
    pub async fn with(
        scripts: Vec<Script>,
        plugins: Vec<Arc<dyn Plugin>>,
        secrets: Vec<String>,
        patch: Value,
    ) -> Self {
        let root = TempDir::new().unwrap();
        let project = TempDir::new().unwrap();
        std::fs::write(
            project.path().join("AGENTS.md"),
            "Project instruction: answer briefly.",
        )
        .unwrap();
        let fake = Arc::new(FakePlugin::new(scripts));
        let probe = fake.probe.clone();
        let events = Arc::new(Events::default());
        let h = modular_agent::vanilla(
            modular_agent::Options {
                history: root.path().join("sessions"),
                global_config: root.path().join("settings.json"),
                key_file: root.path().join("NONEXISTENT-KEY"),
                secrets,
            },
            fake,
            Arc::new(TerminalPlugin {
                sink: events.clone(),
            }),
        )
        .await
        .unwrap();
        for p in plugins {
            h.load(p).await.unwrap();
        }
        let mut settings = json!({"model":"fake"});
        merge(&mut settings, patch);
        let id = h.create(project.path(), settings).await.unwrap();
        Self {
            h,
            id,
            root,
            project,
            probe,
            events,
        }
    }
    pub async fn run(&self, text: &str) -> TurnResult {
        self.h
            .submit(&self.id, "user", text, Timing::Now, None)
            .await
            .unwrap();
        self.h.run_next(&self.id).await.unwrap().unwrap()
    }
    pub fn data(&self) -> SessionData {
        self.h.snapshot(&self.id).unwrap()
    }
    pub fn results(&self) -> Vec<ToolResult> {
        self.data()
            .entries
            .iter()
            .filter(|e| e.kind == "tool.result")
            .map(|e| serde_json::from_value(e.content.clone().unwrap()).unwrap())
            .collect()
    }
}
pub fn text(value: &str) -> Script {
    Script::response(ModelResponse::text(value))
}
pub fn calls(values: Vec<ToolCall>) -> Script {
    Script::response(ModelResponse::calls(values))
}
