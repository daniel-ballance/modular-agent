use super::{Harness, OpenSession};
use agent_api::*;

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
            if open.active.is_some()
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

    pub(super) async fn erase_history(
        &self,
        scope: &Scope,
        entries: Vec<String>,
    ) -> Result<ErasureReport> {
        require(self, scope, "erase")?;
        let _erasure = self.erasure.try_write().map_err(|_| {
            OperationError::Busy("erasure requires idle turns and no other erasure".into())
        })?;
        let (erased, unresolved, affected) = {
            let mut sessions = self.sessions.lock().unwrap();
            ensure!(
                sessions
                    .values()
                    .all(|s| s.active.is_none() && s.check_rewind().is_ok())
                    && self.blocked_projects.lock().unwrap().is_empty(),
                OperationError::Busy("erasure requires all local turns to be idle".into())
            );
            let store = self
                .store()
                .filter(|s| s.coordinates_erasure())
                .ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::Unsupported,
                        "no coordinated erasure store",
                    )
                })?;
            let mut affected = store.mark_erasure(&scope.session, &entries)?;
            // An internal request with no record targets still asks the Provider
            // to discard its copies of the source session.
            affected.entry(scope.session.clone()).or_default();
            let mut erased = vec![];
            let mut unresolved = std::collections::BTreeSet::new();
            for (session, targets) in &affected {
                let result = if let Some(open) = sessions.get_mut(session) {
                    if self.check_open_writer(open).is_ok()
                        && open.lease.is_some()
                        && open.environment_work == 0
                    {
                        store
                            .reconcile_erasure(session)
                            .and_then(|result| match result {
                                Some((data, ids)) => {
                                    self.install_erased_data(open, data)?;
                                    Ok(Some(ids))
                                }
                                None => Ok(None),
                            })
                    } else {
                        Ok(None)
                    }
                } else {
                    store.acquire(session).and_then(|_lease| {
                        store.reconcile_erasure(session).and_then(|result| {
                            result
                                .map(|(data, ids)| {
                                    if let Some(remove) = self.private_erasure.get() {
                                        remove(&data)?;
                                    }
                                    Ok(ids)
                                })
                                .transpose()
                        })
                    })
                };
                let done = result
                    .ok()
                    .flatten()
                    .unwrap_or_else(|| store.confirmed_erasure(session).unwrap_or_default());
                for id in targets {
                    if done.contains(id) {
                        erased.push(id.clone());
                    } else {
                        unresolved.insert(id.clone());
                    }
                }
            }
            (erased, unresolved, affected)
        };
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
