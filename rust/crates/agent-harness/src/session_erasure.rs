use super::{Harness, OpenSession, ReservationPool};
use agent_api::*;
use std::{ops::Deref, sync::Arc};

/// The same accounting applies on writer acquisition, active-session refresh,
/// and explicit erasure, including destinations not open in this Harness.
pub(super) struct AccountedHistory {
    pub(super) store: Arc<dyn HistoryStore>,
    pub(super) pool: Arc<ReservationPool>,
}
impl Deref for AccountedHistory {
    type Target = dyn HistoryStore;

    fn deref(&self) -> &Self::Target {
        self.store.as_ref()
    }
}
impl AccountedHistory {
    pub(super) fn reconcile_erasure(&self, id: &str) -> Result<Option<(SessionData, Vec<String>)>> {
        self.pool.reconcile_erasure(self.store.as_ref(), id)
    }
}

impl Harness {
    pub fn on_reconciled_erasure(
        &self,
        remove: impl Fn(&SessionData) -> Result<()> + Send + Sync + 'static,
    ) {
        assert!(self.private_erasure.set(Box::new(remove)).is_ok());
    }

    pub(super) fn refresh_open_erasure(&self, open: &mut OpenSession) -> Result<()> {
        if !open.provisional
            && let Some(store) = self.store()
            && let Err(error) = store.check_erasure(&open.data)
        {
            if open.active.is_some() {
                open.cancel.cancel();
                return Err(error);
            }
            if self.needs_local_provider_discard()?
                || open.environment_work > 0
                || open.rewinding
                || open.lease.is_none()
                || self.check_open_writer(open).is_err()
            {
                return Err(error);
            }
            let Some((data, _)) = store.reconcile_erasure(&open.data.id)? else {
                return Err(error);
            };
            store.check_erasure(&data)?;
            self.install_erased_data(open, data)?;
        }
        Ok(())
    }
    fn install_erased_data(&self, open: &mut OpenSession, data: SessionData) -> Result<()> {
        if let Some(remove) = self.private_erasure.get() {
            remove(&data)?;
        }
        let session = data.id.clone();
        open.queue.retain(|q| {
            data.entries
                .iter()
                .any(|e| e.id == q.id && e.content.is_some())
        });
        self.reservations().rebuild(&data);
        open.data = data;
        open.approval_views.clear();
        if let Some(commits) = &open.commits {
            let _ = commits.send(());
        }
        self.pending_events
            .lock()
            .unwrap()
            .retain(|e| e.scope.session != session);
        self.held_output
            .lock()
            .unwrap()
            .retain(|(id, _, _), _| id != &session);
        self.invalidate_providers(&session)
    }

    pub(super) async fn discard_local_provider_state(&self, session: &str) -> Result<()> {
        for name in self.capability_names("provider.") {
            let provider = capability::<dyn Provider>(self, &name)?;
            if provider.needs_erasure_discard() {
                provider.discard_for_erasure(session).await?;
            }
        }
        Ok(())
    }

    fn needs_local_provider_discard(&self) -> Result<bool> {
        for name in self.capability_names("provider.") {
            if capability::<dyn Provider>(self, &name)?.needs_erasure_discard() {
                return Ok(true);
            }
        }
        Ok(false)
    }

    async fn settle_erasure_jobs(&self, session: &str) -> Result<()> {
        for job in self.job_records(session)? {
            if job.state != JobState::Running {
                continue;
            }
            let owner = self
                .capability_names("external.jobs.")
                .iter()
                .find_map(|name| {
                    let owner = capability::<dyn ExternalJobs>(self, name).ok()?;
                    (owner.owner() == job.owner).then_some(owner)
                });
            if let Some(owner) = owner {
                let _ = owner.cancel(self.api(), job).await;
            } else if let Ok(service) = job_service(self) {
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    service.cancel(self.api(), session, "user", &job.id),
                )
                .await;
            }
        }
        ensure!(
            !self
                .job_records(session)?
                .iter()
                .any(|job| job.state.is_unfinished()),
            OperationError::Unavailable("Erasure is pending job settlement".into())
        );
        Ok(())
    }

    async fn reconcile_live_erasure(
        &self,
        store: &AccountedHistory,
        session: &str,
    ) -> Result<Vec<String>> {
        loop {
            let settled = self.turn_settled.notified();
            tokio::pin!(settled);
            settled.as_mut().enable();
            {
                let mut sessions = self.sessions.lock().unwrap();
                let open = sessions.get_mut(session).ok_or(super::SessionNotOpen)?;
                self.check_open_writer(open)?;
                open.check_rewind()?;
                ensure!(
                    open.lease.is_some(),
                    OperationError::Unavailable("Erasure needs a writer".into())
                );
                match store.check_erasure(&open.data) {
                    Ok(()) => return store.confirmed_erasure(session),
                    Err(error) if error.is::<PendingErasure>() => {}
                    Err(error) => return Err(error),
                }
                if open.active.is_none() {
                    ensure!(
                        open.environment_work == 0,
                        OperationError::Busy("Environment work is active".into())
                    );
                    break;
                }
                open.cancel.cancel();
            }
            settled.await;
        }
        self.settle_erasure_jobs(session).await?;
        self.discard_local_provider_state(session).await?;
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions.get_mut(session).ok_or(super::SessionNotOpen)?;
        self.check_open_writer(open)?;
        open.check_rewind()?;
        ensure!(
            open.active.is_none() && open.environment_work == 0,
            OperationError::Busy("Session work is active".into())
        );
        if let Some((data, ids)) = store.reconcile_erasure(session)? {
            self.install_erased_data(open, data)?;
            Ok(ids)
        } else {
            store.check_erasure(&open.data)?;
            Ok(vec![])
        }
    }

    pub async fn reconcile_pending_erasure(&self, session: &str) -> Result<()> {
        let Some(store) = self.store() else {
            return Ok(());
        };
        {
            let sessions = self.sessions.lock().unwrap();
            let Some(open) = sessions.get(session) else {
                return Ok(());
            };
            if open.provisional || store.check_erasure(&open.data).is_ok() {
                return Ok(());
            }
        }
        let _request = self
            .erasure_requests
            .try_lock()
            .map_err(|_| OperationError::Unavailable("Erasure is being reconciled".into()))?;
        self.reconcile_live_erasure(&store, session).await?;
        Ok(())
    }

    pub(super) async fn erase_history(
        &self,
        scope: &Scope,
        entries: Vec<String>,
    ) -> Result<ErasureReport> {
        require(self, scope, "erase")?;
        let _request = self
            .erasure_requests
            .try_lock()
            .map_err(|_| OperationError::Busy("another erasure is in progress".into()))?;
        let store = self
            .store()
            .filter(|s| s.coordinates_erasure())
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::Unsupported,
                    "no coordinated erasure store",
                )
            })?;
        let mut affected = {
            let mut sessions = self.sessions.lock().unwrap();
            let open = sessions
                .get_mut(&scope.session)
                .ok_or(super::SessionNotOpen)?;
            self.check_open_writer(open)?;
            open.check_rewind()?;
            ensure!(
                !open.provisional,
                OperationError::InvalidParams("Session has not admitted its first input".into())
            );
            ensure!(
                open.active.is_none(),
                OperationError::Busy("Cannot erase during a turn".into())
            );
            store.mark_erasure(&scope.session, &entries)?
        };
        affected.entry(scope.session.clone()).or_default();
        let mut erased = vec![];
        let mut unresolved = std::collections::BTreeSet::new();
        for (session, targets) in &affected {
            let live = self.sessions.lock().unwrap().contains_key(session);
            let result: Result<Vec<String>> = async {
                if live {
                    return self.reconcile_live_erasure(&store, session).await;
                }
                let lease = store.acquire(session)?;
                let data = store.load(session)?;
                match store.check_erasure(&data) {
                    Ok(()) => return store.confirmed_erasure(session),
                    Err(error) if error.is::<PendingErasure>() => {}
                    Err(error) => return Err(error),
                }
                check_erasure_jobs(&data)?;
                self.discard_local_provider_state(session).await?;
                lease.check()?;
                if let Some((data, ids)) = store.reconcile_erasure(session)? {
                    if let Some(remove) = self.private_erasure.get() {
                        remove(&data)?;
                    }
                    self.invalidate_providers(session)?;
                    Ok(ids)
                } else {
                    Ok(vec![])
                }
            }
            .await;
            let done =
                result.unwrap_or_else(|_| store.confirmed_erasure(session).unwrap_or_default());
            for id in targets {
                if done.contains(id) {
                    erased.push(id.clone());
                } else {
                    unresolved.insert(id.clone());
                }
            }
        }
        let mut out_of_reach = vec!["output already delivered to recipients".into()];
        let mut pending = unresolved;
        for name in self.capability_names("provider.") {
            let report = capability::<dyn Provider>(self, &name)?
                .erase_binding_copies(self.api(), &affected)
                .await?;
            pending.extend(report.pending);
            out_of_reach.extend(report.out_of_reach);
        }
        let qualified = affected
            .iter()
            .flat_map(|(session, ids)| ids.iter().map(|id| (session.clone(), id.clone())))
            .collect();
        Ok(ErasureReport {
            qualified,
            pending: pending.into_iter().collect(),
            erased,
            out_of_reach,
        })
    }
}
