use super::*;
use crate::events::Message;
use crate::sessions::SharedSession;
use tokio::sync::mpsc;

/// Open session writers shared by one ACP listener. A stdio connection gets a
/// private table. The table never grants access: each attach checks its own policy.
#[derive(Default)]
pub struct OpenRoutes {
    pub(crate) sessions: Mutex<BTreeMap<String, std::sync::Weak<SharedSession>>>,
    pub(crate) setup: tokio::sync::Mutex<()>,
    pub(crate) opening: Mutex<std::collections::BTreeSet<String>>,
    pub(crate) rewind_blocks: Mutex<BTreeMap<PathBuf, String>>,
}

impl OpenRoutes {
    /// An AG-UI listener may share this service with per-session ACP Harnesses.
    pub fn is_running(&self, id: &str) -> bool {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .and_then(std::sync::Weak::upgrade)
            .is_some_and(|s| {
                s.api.is_running(id)
                    && s.api
                        .writer_interruption(id)
                        .is_ok_and(|w| !w.is_cancelled())
            })
    }
}

#[derive(Default)]
pub(crate) struct Fanout {
    senders: Mutex<BTreeMap<String, mpsc::Sender<Message>>>,
    api: Mutex<Option<std::sync::Weak<dyn AgentApi>>>,
}

impl Fanout {
    pub(crate) fn bind(&self, api: &Api) {
        *self.api.lock().unwrap() = Some(Arc::downgrade(api));
    }

    pub(crate) fn add(&self, id: &str, tx: mpsc::Sender<Message>) {
        self.senders.lock().unwrap().insert(id.into(), tx);
    }
    pub(crate) fn remove(&self, id: &str) -> bool {
        let mut senders = self.senders.lock().unwrap();
        senders.remove(id);
        senders.is_empty()
    }
    pub(crate) fn clear(&self) -> Vec<String> {
        std::mem::take(&mut *self.senders.lock().unwrap())
            .into_keys()
            .collect()
    }
}
impl EventSink for Fanout {
    fn send(&self, event: Event) {
        let api = self
            .api
            .lock()
            .unwrap()
            .as_ref()
            .and_then(std::sync::Weak::upgrade);
        let Some(api) = api else {
            return;
        };
        let bytes = serde_json::to_vec(&event).map_or(u64::MAX, |body| body.len() as u64);
        let senders = self
            .senders
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for tx in senders {
            // Dropping optional updates never blocks the writer. Questions and
            // interrupted state can still be read through the binding methods.
            if let Ok(permit) = api.reserve_output(&event.scope.session, bytes) {
                let _ = tx.try_send(Message::Event(Box::new(event.clone()), permit));
            }
        }
    }
}
