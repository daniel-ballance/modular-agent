//! Scripted, offline Provider. No credentials and no network.
mod conformance;
use agent_api::*;
pub use conformance::ConformancePlugin;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};
#[derive(Clone, Debug)]
pub struct Script {
    pub task: Option<String>,
    pub response: std::result::Result<ModelResponse, ModelFailure>,
    pub pieces: Vec<String>,
    pub delay_ms: u64,
}
impl Script {
    pub fn response(response: ModelResponse) -> Self {
        Self {
            task: None,
            response: Ok(response),
            pieces: vec![],
            delay_ms: 0,
        }
    }
    pub fn for_task(mut self, task: &str) -> Self {
        self.task = Some(task.into());
        self
    }
    pub fn failure(kind: FailureKind) -> Self {
        Self {
            task: None,
            response: Err(ModelFailure {
                kind,
                message: "scripted model failure".into(),
            }),
            pieces: vec![],
            delay_ms: 0,
        }
    }
}
#[derive(Default)]
pub struct Probe {
    pub requests: Mutex<Vec<ModelRequest>>,
}
pub struct FakePlugin {
    pub scripts: Arc<Mutex<VecDeque<Script>>>,
    pub probe: Arc<Probe>,
    pub window: u64,
}
impl FakePlugin {
    pub fn new(scripts: Vec<Script>) -> Self {
        Self {
            scripts: Arc::new(Mutex::new(scripts.into())),
            probe: Arc::default(),
            window: 128000,
        }
    }
}
struct FakeProvider {
    scripts: Arc<Mutex<VecDeque<Script>>>,
    probe: Arc<Probe>,
    info: ModelInfo,
    before: HookPoint,
    piece: HookPoint,
}
impl Plugin for FakePlugin {
    fn name(&self) -> &str {
        "provider.fake"
    }
    fn install(&self, r: &mut Registrar<'_>) -> Result<()> {
        let before = r.define("provider.fake.before", Rule::Transform)?;
        let piece = r.define("provider.fake.piece", Rule::Observe)?;
        r.provide::<dyn Provider>(
            "provider.fake",
            Arc::new(FakeProvider {
                scripts: self.scripts.clone(),
                probe: self.probe.clone(),
                before,
                piece,
                info: ModelInfo {
                    name: "fake".into(),
                    context_window: self.window,
                    output_limit: 4096,
                    thinking: vec!["low".into(), "medium".into(), "high".into()],
                    keeps_state: false,
                    runs_tools: false,
                    extra: Value::Null,
                },
            }),
        )
    }
}
#[async_trait]
impl Provider for FakeProvider {
    async fn erase_copies(&self, _api: Api, _sessions: &[String]) -> Result<Vec<String>> {
        self.probe.requests.lock().unwrap().clear();
        Ok(vec![])
    }
    fn catalog(&self) -> Vec<ModelInfo> {
        vec![
            self.info.clone(),
            ModelInfo {
                name: "fake-alt".into(),
                ..self.info.clone()
            },
        ]
    }
    fn bind(&self, model: &str) -> Result<Arc<dyn ModelAccess>> {
        ensure!(matches!(model, "fake" | "fake-alt"), "unknown fake model");
        Ok(Arc::new(Self {
            scripts: self.scripts.clone(),
            probe: self.probe.clone(),
            info: ModelInfo {
                name: model.into(),
                ..self.info.clone()
            },
            before: self.before.clone(),
            piece: self.piece.clone(),
        }))
    }
}
#[async_trait]
impl ModelAccess for FakeProvider {
    fn info(&self) -> ModelInfo {
        self.info.clone()
    }
    async fn generate(
        &self,
        api: Api,
        scope: Scope,
        request: ModelRequest,
        cancel: CancellationToken,
    ) -> std::result::Result<ModelResponse, ModelFailure> {
        let result:Result<ModelResponse>=async {
            let request=serde_json::from_value(api.invoke(&self.before,&scope,json!(request)).await?.value)?;
            let request: ModelRequest = request;
            let task = request.messages.iter().find(|m| m.role == "user").map(Message::text_content).unwrap_or_default();
            self.probe.requests.lock().unwrap().push(request);
            let script = {
                let mut scripts = self.scripts.lock().unwrap();
                let index = scripts.iter().position(|s| s.task.as_ref().is_none_or(|t| *t == task)).ok_or_else(||anyhow!("fake Provider script exhausted for task"))?;
                scripts.remove(index).unwrap()
            };
            tokio::select! {
                biased;
                _=cancel.cancelled()=>return Err(ModelFailure{kind:FailureKind::Cancelled,message:"cancelled".into()}.into()),
                _=tokio::time::sleep(Duration::from_millis(script.delay_ms))=>(),
            }
            let response=script.response?;
            let pieces=if script.pieces.is_empty(){vec![response.text_content()]}else{script.pieces};
            let stream=id();
            for piece in pieces {
                api.invoke(&self.piece,&scope,json!(piece)).await?;
                let mut event=Event::new(&scope,"model.delta",json!(piece));event.stream=Some(stream.clone());api.emit(event).await?;
            }
            let mut event=Event::new(&scope,"model.end",Value::Null);event.stream=Some(stream);event.end=true;api.emit(event).await?;
            Ok(response)
        }.await;
        result.map_err(|e| {
            e.downcast_ref::<ModelFailure>()
                .cloned()
                .unwrap_or(ModelFailure {
                    kind: FailureKind::Other,
                    message: e.to_string(),
                })
        })
    }
}
