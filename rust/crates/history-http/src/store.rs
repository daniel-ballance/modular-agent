use super::*;

impl HistoryStore for HttpHistory {
    fn coordinates_erasure(&self) -> bool {
        self.coordinated
    }
    fn mark_erasure(
        &self,
        session: &str,
        entry_ids: &[String],
    ) -> Result<BTreeMap<String, Vec<String>>> {
        ensure!(
            self.coordinated,
            "history service does not coordinate erasure"
        );
        if entry_ids.is_empty() {
            return Ok(BTreeMap::new());
        }
        let state = self
            .lease(session)
            .unwrap_or_else(|| self.temporary_lease(session));
        let lease = state.acquire_with_wait(self.ttl, false)?;
        let (revision, _) = self.erasure_plans(session)?;
        let sessions = self.erasure_lineage()?;
        let source = sessions
            .iter()
            .find(|s| s.id == session)
            .ok_or_else(|| OperationError::NotFound("unknown erasure source".into()))?;
        let entries: BTreeSet<_> = entry_ids.iter().cloned().collect();
        for target in &entries {
            let e = source
                .entries
                .iter()
                .find(|e| &e.id == target)
                .ok_or_else(|| OperationError::NotFound("unknown erasure target".into()))?;
            ensure!(
                erasable(e),
                OperationError::Forbidden("protected erasure target".into())
            );
        }
        let affected = discover_copies(&sessions, entries.clone());
        let intent = pending::Publication {
            lease,
            revision,
            intent_id: id(),
            entry_ids: entries.into_iter().collect(),
            copies: affected
                .iter()
                .map(|(sid, ids)| pending::CopySet {
                    session_id: sid.clone(),
                    record_id: id(),
                    entry_ids: ids.clone(),
                })
                .collect(),
        };
        state.acquire(self.ttl)?;
        let response = self.writer_post(
            &state,
            &["v1", "sessions", session, "pending-erasure"],
            json!(intent),
        )?;
        let published: pending::Published = serde_json::from_value(response)
            .map_err(|_| registry_unavailable("invalid erasure publication response"))?;
        ensure!(
            pending::path_id(&published.intent_id)
                && (published.session_ids.is_empty()
                    || pending::distinct_ids(&published.session_ids))
                && published
                    .session_ids
                    .iter()
                    .all(|sid| pending::path_id(sid)),
            registry_unavailable("invalid erasure publication response")
        );
        if published.intent_id == intent.intent_id {
            ensure!(
                published.session_ids.iter().eq(affected.keys()),
                registry_unavailable(
                    "erasure publication did not return the submitted destinations"
                )
            );
            return Ok(affected);
        }
        // Recover the source plan and every published destination, even if unlisted.
        let mut original = BTreeMap::new();
        // sessionIds lists every copy set's session, the source's included (history-http.md).
        for sid in published.session_ids.iter().map(String::as_str) {
            let plan = self
                .erasure_plans(sid)?
                .1
                .into_iter()
                .find(|p| p.intent_id == published.intent_id && p.source_session_id == session)
                .ok_or_else(|| registry_unavailable("missing published erasure plan"))?;
            original.insert(
                sid.into(),
                plan.copies.into_iter().map(|c| c.entry_id).collect(),
            );
        }
        Ok(original)
    }
    fn check_erasure(&self, data: &SessionData) -> Result<()> {
        if !self.coordinated {
            return Ok(());
        }
        if self.lease(&data.id).is_some_and(|state| {
            state.lease.lock().unwrap().is_none() && !state.lost.is_cancelled()
        }) {
            // This writer is still assembling a local, unpublished session.
            return Ok(());
        }
        check_plans(data, &self.erasure_plans(&data.id)?.1)
    }
    fn pending_erasure_sessions(&self) -> Result<Option<Vec<String>>> {
        if !self.coordinated || !self.indexed {
            return Ok(None);
        }
        self.pending_index().map(Some).map_err(|error| {
            OperationError::Unavailable(format!("Pending erasure index unavailable: {error}"))
                .into()
        })
    }
    fn pending_erasure_ids(&self, session: &str) -> Result<Vec<String>> {
        if !self.coordinated {
            return Ok(vec![]);
        }
        Ok(self
            .erasure_plans(session)?
            .1
            .into_iter()
            .flat_map(|p| p.copies)
            .filter(|c| !c.complete)
            .map(|c| c.entry_id)
            .collect())
    }
    fn confirmed_erasure(&self, session: &str) -> Result<Vec<String>> {
        if !self.coordinated {
            return Ok(Vec::new());
        }
        Ok(self
            .erasure_plans(session)?
            .1
            .into_iter()
            .flat_map(|plan| {
                plan.copies
                    .into_iter()
                    .filter(|c| c.complete)
                    .map(|c| c.entry_id)
            })
            .collect())
    }
    fn reconcile_erasure(
        &self,
        session: &str,
        write: &mut ErasureWrite<'_>,
    ) -> Result<Option<(SessionData, Vec<String>)>> {
        self.reconcile(session, write)
    }
    fn supports_erasure(&self) -> bool {
        self.coordinated
    }
    fn acquire(&self, session: &str) -> Result<Box<dyn Lease>> {
        let mut held = self.held.lock().unwrap();
        ensure!(
            held.get(session).and_then(Weak::upgrade).is_none(),
            OperationError::Busy("history session is already open here".into())
        );
        let state = self.temporary_lease(session);
        held.insert(session.into(), Arc::downgrade(&state));
        Ok(Box::new(Held(state)))
    }
    fn acquire_for_erasure(&self, session: &str) -> Result<Box<dyn Lease>> {
        let lease = self.acquire(session)?;
        self.lease(session)
            .ok_or_else(|| anyhow!("missing writer"))?
            .acquire_with_wait(self.ttl, false)?;
        Ok(lease)
    }
    fn erasure_scope(
        &self,
        session: &str,
        project: Option<&Path>,
    ) -> Result<Option<Option<String>>> {
        let (_, listed) = self.service.pages(&["v1", "sessions"], None, "sessions")?;
        let meta = listed
            .iter()
            .find(|row| row["id"] == session)
            .ok_or_else(|| OperationError::NotFound("unknown session".into()))?;
        let saved_project = wire::string(meta, "project")?;
        if project.is_some_and(|project| project != Path::new(saved_project)) {
            return Ok(None);
        }
        let page = checked(self.service.exchange(
            Method::GET,
            &["v1", "sessions", session],
            None,
            Exchange {
                limit: Some(1),
                ..Exchange::default()
            },
        )?)?;
        // The tenant, when set, is the first record (also copied first on forks).
        let rows = page["entries"]
            .as_array()
            .ok_or_else(|| registry_unavailable("Missing scope entry"))?;
        ensure!(
            rows.len() == 1 && page["session"]["project"] == saved_project,
            registry_unavailable("Invalid scope page")
        );
        let entry = &rows[0];
        Ok(Some(if entry["kind"] == "tenant" {
            Some(wire::string(&entry["data"], "tenant")?.to_owned())
        } else {
            None
        }))
    }
    fn inspect(&self, session: &str) -> Result<SessionData> {
        self.fetch(session).map(|(data, _)| data)
    }
    fn load(&self, session: &str) -> Result<SessionData> {
        let state = self.lease(session);
        if let Some(state) = &state {
            state.acquire(self.ttl)?;
        }
        let (data, entries) = self.fetch(session)?;
        if let Some(state) = state {
            *state.kept.lock().unwrap() = entries
                .iter()
                .filter_map(|v| v["id"].as_str().map(str::to_owned))
                .collect();
        }
        Ok(data)
    }
    fn save(&self, data: &SessionData) -> Result<()> {
        let state = self
            .lease(&data.id)
            .ok_or_else(|| anyhow!("no history writer lease"))?;
        let mut kept = state.kept.lock().unwrap();
        let mut entries = data
            .entries
            .iter()
            .filter(|e| !kept.contains(&e.id) && e.writer != "rust.derived")
            .map(|e| portable::entry(e, data))
            .collect::<Result<Vec<_>>>()?;
        // A session used only for setup should not leave a row or take a lease.
        if entries.is_empty()
            || (kept.is_empty()
                && data.origin.is_none()
                && data.entries.iter().all(|e| {
                    matches!(
                        e.kind.as_str(),
                        "settings"
                            | "actor.grant"
                            | "actor.identity"
                            | "plugins.changed"
                            | "tenant"
                    )
                }))
        {
            return Ok(());
        }
        if state.lease.lock().unwrap().is_none() {
            // The allowed lease alphabet needs no JSON escaping. Use the actual
            // sender encoding and the longest admissible lease before creating a row.
            let envelope = json!({"lease":"A".repeat(LEASE_BYTES), "entries":[]});
            ensure!(
                serde_json::to_vec(&envelope)?.len() - 2 + serde_json::to_vec(&entries)?.len()
                    <= BODY_LIMIT,
                OperationError::ResultTooLarge("initial history append is too large".into())
            );
            let mut meta = json!({"project":data.project,"created":data.entries.first().map(|e|e.at).unwrap_or(0)});
            if let Some((parent, entry)) = &data.origin {
                meta["parentSessionId"] = json!(parent);
                if let Some(entry) = entry {
                    meta["forkedFrom"] = json!({"sessionId":parent,"entryId":entry});
                }
            }
            checked(self.service.request(
                Method::PUT,
                &["v1", "sessions", &data.id],
                None,
                Some(meta),
            )?)?;
        }
        let lease = state.acquire(self.ttl)?;
        let revision = self
            .coordinated
            .then(|| self.check_append(data, &entries))
            .transpose()?;
        let tombstones = entries
            .iter_mut()
            .filter_map(|entry| {
                if entry["erased"] != true {
                    return None;
                }
                // Append only the redacted envelope: the service owns the marker.
                entry.as_object_mut().unwrap().remove("erased");
                Some(entry["id"].clone())
            })
            .collect::<Vec<_>>();
        state.acquire(self.ttl)?;
        let appended = self.guarded_append(&data.id, &lease, &entries, revision.as_deref());
        let guard = state.lease.lock().unwrap();
        let remote = guard.as_ref().expect("acquired lease");
        if appended.as_ref().map_or(true, |(status, body)| {
            body["code"] == "lost" || (status.is_success() && !body["kept"].is_u64())
        }) {
            state.lost.cancel();
        }
        remote.check(&state.lost)?;
        checked(appended?)?;
        drop(guard);
        if !tombstones.is_empty() {
            self.writer_post(
                &state,
                &["v1", "sessions", &data.id, "erase"],
                json!({"lease":lease,"entryIds":tombstones}),
            )?;
        }
        kept.extend(
            entries
                .drain(..)
                .filter_map(|v| v["id"].as_str().map(str::to_owned)),
        );
        Ok(())
    }
    fn list(&self, project: Option<&Path>) -> Result<Vec<SessionData>> {
        let (_, listed) = self
            .service
            .pages(&["v1", "sessions"], project, "sessions")?;
        listed
            .iter()
            .map(|meta| self.fetch(wire::string(meta, "id")?).map(|(s, _)| s))
            .collect()
    }
    fn erase(&self, ids: Vec<String>, held: &[String]) -> Result<Vec<SessionData>> {
        ensure!(
            self.coordinated,
            registry_unavailable("history service does not coordinate erasure")
        );
        let erased: BTreeSet<_> = ids.into_iter().collect();
        let sessions = self.list(None)?;
        let mut affected = BTreeSet::new();
        for source in sessions {
            let targets: Vec<_> = source
                .entries
                .iter()
                .filter(|e| erasable(e) && erased.contains(&e.id))
                .map(|e| e.id.clone())
                .collect();
            if !targets.is_empty() {
                affected.extend(self.mark_erasure(&source.id, &targets)?.into_keys());
            }
        }
        let mut result = Vec::new();
        for sid in affected {
            let _lease = if held.contains(&sid) {
                None
            } else {
                Some(self.acquire(&sid)?)
            };
            self.lease(&sid)
                .ok_or_else(|| anyhow!("missing history lease"))?
                .acquire(self.ttl)?;
            if let Some((data, _)) = self.reconcile_erasure(&sid, &mut |_, _, write| write())? {
                result.push(data);
            }
        }
        Ok(result)
    }
}
