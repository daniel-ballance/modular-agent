use super::{Harness, OpenSession};
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

    pub(super) fn writer_interruption_token(&self, session: &str) -> Result<CancellationToken> {
        self.sessions
            .lock()
            .unwrap()
            .get(session)
            .map(|open| open.interruption.clone())
            .ok_or_else(|| OperationError::NotFound("session not open".into()).into())
    }

    pub(super) fn check_session_writer(&self, session: &str) -> Result<()> {
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
        Ok(())
    }
}
