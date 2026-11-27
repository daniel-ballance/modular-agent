use super::Harness;
use agent_api::*;
use serde::Serialize;
use std::collections::BTreeSet;

#[derive(Default)]
pub struct ReconcileErasureOptions {
    pub sessions: Vec<String>,
    pub discover: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErasureRetryState {
    Complete,
    Pending,
    Busy,
    Lost,
    OutOfScope,
    Unavailable,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErasureRetryReport {
    pub session_id: String,
    pub state: ErasureRetryState,
    pub erased: Vec<String>,
    pub pending: Vec<String>,
}

impl Harness {
    pub async fn reconcile_erasure_sessions(
        &self,
        options: ReconcileErasureOptions,
    ) -> Result<Vec<ErasureRetryReport>> {
        let store = self
            .store()
            .ok_or_else(|| OperationError::Unavailable("No history store".into()))?;
        let mut ids: BTreeSet<_> = options.sessions.into_iter().collect();
        if options.discover
            && let Some(found) = store.pending_erasure_sessions()?
        {
            ids.extend(found);
        }
        let mut reports = Vec::with_capacity(ids.len());
        for session in ids {
            reports.push(self.retry_session(&store, session).await);
        }
        Ok(reports)
    }

    async fn retry_session(
        &self,
        store: &super::session_erasure::AccountedHistory,
        session: String,
    ) -> ErasureRetryReport {
        use ErasureRetryState::*;
        let mut report = ErasureRetryReport {
            session_id: session.clone(),
            state: Unavailable,
            erased: vec![],
            pending: vec![],
        };
        let Ok(data) = store.inspect(&session) else {
            return report;
        };
        if self
            .project
            .as_ref()
            .is_some_and(|project| project != &data.project)
            || data
                .tenant_id()
                .is_some_and(|tenant| self.check_tenant(tenant).is_err())
        {
            report.state = OutOfScope;
            return report;
        }
        let may_watch = self
            .discovery_rights(&data, "user", &Authority::full(), false)
            .is_ok_and(|rights| rights.has("watch"));
        let result: Result<ErasureRetryState> = async {
            match store.check_erasure(&data) {
                Ok(()) => return Ok(Complete),
                Err(error) if error.is::<PendingErasure>() => {}
                Err(error) => return Err(error),
            }
            let Ok(_request) = self.erasure_requests.try_lock() else {
                return Ok(Busy);
            };
            let live = self.sessions.lock().unwrap().contains_key(&session);
            if live {
                self.reconcile_idle_erasure(store, &session).await?;
                return Ok(Complete);
            }
            let lease = store.acquire_for_erasure(&session)?;
            let mut data = store.load(&session)?;
            self.settle_stored_erasure_jobs(store, lease.as_ref(), &mut data)
                .await?;
            self.discard_local_provider_state(&session).await?;
            lease.check()?;
            if let Some((kept, _)) = store.reconcile_erasure(&session)? {
                data = kept;
                if let Some(remove) = self.private_erasure.get() {
                    remove(&data)?;
                }
                self.invalidate_providers(&session)?;
            }
            lease.check()?;
            store.check_erasure(&data)?;
            Ok(Complete)
        }
        .await;
        report.state = match result {
            Ok(state) => state,
            Err(error) if error.is::<LostPart>() => Lost,
            Err(error)
                if error.is::<HistoryHeld>()
                    || matches!(
                        error.downcast_ref::<OperationError>(),
                        Some(OperationError::Busy(_))
                    ) =>
            {
                Busy
            }
            Err(error) if error.is::<PendingErasure>() => Pending,
            Err(_) => Unavailable,
        };
        if may_watch {
            report.erased = store.confirmed_erasure(&session).unwrap_or_default();
            report.pending = store.pending_erasure_ids(&session).unwrap_or_default();
            report.erased.sort();
            report.erased.dedup();
            report.pending.sort();
            report.pending.dedup();
        }
        report
    }
}
