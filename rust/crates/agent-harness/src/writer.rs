use super::{Harness, OpenSession, rewind::EnvironmentWork};
use agent_api::*;

impl Harness {
    pub(super) fn watch_writer(&self, id: &str) {
        if let Some(open) = self.sessions.lock().unwrap().get(id) {
            self.watch_open_writer(open);
        }
    }
    pub(super) fn watch_open_writer(&self, open: &OpenSession) {
        let Some(lost) = open.lease.as_ref().and_then(|lease| lease.lost()) else {
            return;
        };
        let generation = open.generation.clone();
        let weak = self.me.clone();
        let id = open.data.id.clone();
        tokio::spawn(async move {
            tokio::select! {
                biased;
                _ = generation.cancelled() => {},
                _ = lost.cancelled() => {
                    if let Some(h) = weak.upgrade()
                        && let Some(open) = h.sessions.lock().unwrap().get_mut(&id)
                        && !generation.is_cancelled()
                    {
                        h.interrupt(open, "writerLost");
                    }
                }
            }
        });
    }
    pub(super) fn interrupt(&self, open: &mut OpenSession, reason: &str) {
        if open.interruption.is_cancelled() {
            return;
        }
        open.cancel.cancel();
        open.interruption.cancel();
        let h = self.api();
        let event = Event::new(
            &Scope::session(&open.data.id),
            "session.interrupted",
            json!({"reason":reason}),
        );
        // The transition runs under the sessions lock; gates and delivery must not.
        tokio::spawn(async move {
            if let Err(error) = h.emit(event).await {
                eprintln!("session interruption delivery failed: {error}");
            }
        });
    }
    pub(super) fn check_open_writer(&self, open: &mut OpenSession) -> Result<()> {
        ensure!(
            !open.interruption.is_cancelled(),
            LostPart("session writer interrupted; reopen to recover".into())
        );
        if let Some(lease) = &open.lease
            && let Err(error) = lease.check()
        {
            self.interrupt(open, "writerLost");
            return Err(LostPart(format!("session writer lost: {error}")).into());
        }
        Ok(())
    }

    pub(super) fn start_environment_work(
        &self,
        session: &str,
        retry_erasure: bool,
    ) -> Result<Box<dyn Send>> {
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(session)
            .ok_or_else(|| anyhow!("session not open"))?;
        open.check_rewind()?;
        self.check_open_writer(open)?;
        if retry_erasure {
            self.check_open_erasure(open)?;
        }
        open.environment_work += 1;
        Ok(Box::new(EnvironmentWork {
            harness: self.me.clone(),
            session: session.into(),
        }))
    }

    pub(super) fn writer_interruption_token(&self, session: &str) -> Result<CancellationToken> {
        self.sessions
            .lock()
            .unwrap()
            .get(session)
            .map(|open| open.interruption.clone())
            .ok_or_else(|| OperationError::NotFound("session not open".into()).into())
    }

    pub(super) fn check_session_writer(&self, session: &str) -> Result<()> {
        self.check_delivery_view(session, |_| ())
    }

    pub(super) fn writer_delivery_epoch(&self, session: &str) -> Result<Option<String>> {
        self.check_delivery_view(session, |data| {
            data.entries
                .iter()
                .rev()
                .find(|entry| entry.kind == "erasure")
                .map(|entry| entry.id.clone())
        })
    }

    fn check_delivery_view<T>(
        &self,
        session: &str,
        view: impl FnOnce(&SessionData) -> T,
    ) -> Result<T> {
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(session)
            .ok_or_else(|| anyhow!("session not open"))?;
        self.check_open_writer(open)?;
        if !open.provisional
            && let Some(store) = self.store()
        {
            store.check_erasure(&open.data)?;
        }
        Ok(view(&open.data))
    }
}
