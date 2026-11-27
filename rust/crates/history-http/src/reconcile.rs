use super::*;

pub(super) fn check_append_plans(
    data: &SessionData,
    plans: &[pending::Plan],
    entries: &[Value],
) -> Result<()> {
    let settlement = |entry: &Value| {
        if entry.get("sources").is_some()
            || entry.get("message").is_some()
            || entry["modelVisible"] != false
        {
            return false;
        }
        if matches!(
            entry["kind"].as_str(),
            Some("actorJoined" | "actorLeft" | "limit" | "inputHandedBack")
        ) {
            return true;
        }
        entry["jobId"].is_string()
            && (entry["kind"] == "jobCleanupUnconfirmed"
                || entry["kind"] == "jobEnded"
                    && entry["data"]["report"] == false
                    && entry["data"]["result"].is_null()
                    && entry["data"]["rust.result"].is_null()
                    && entry["data"]["outcome"]["error"].is_null())
    };
    if !entries.is_empty() && entries.iter().all(settlement) {
        return Ok(());
    }
    check_plans(data, plans)
}

impl HttpHistory {
    pub(super) fn erasure_lineage(&self) -> Result<Vec<SessionData>> {
        let (_, listed) = self.service.pages(&["v1", "sessions"], None, "sessions")?;
        listed
            .iter()
            .map(|meta| {
                let id = wire::string(meta, "id")?;
                let (meta, entries) =
                    self.service
                        .pages(&["v1", "sessions", id], None, "entries")?;
                portable::erasure_lineage(&meta, &entries)
            })
            .collect()
    }

    pub(super) fn reconcile(
        &self,
        session: &str,
        write: &mut ErasureWrite<'_>,
    ) -> Result<Option<(SessionData, Vec<String>)>> {
        if !self.coordinated {
            return Ok(None);
        }
        let Some(state) = self.lease(session) else {
            return Err(anyhow!("no history writer lease"));
        };
        let lease = state.acquire_with_wait(self.ttl, false)?;
        let (_, plans) = self.erasure_plans(session)?;
        if plans.is_empty() {
            return Ok(None);
        }
        let mut confirmed = BTreeSet::new();
        for plan in plans {
            let targets: Vec<_> = plan.copies.iter().map(|c| c.entry_id.clone()).collect();
            let pending: Vec<_> = plan
                .copies
                .iter()
                .filter(|c| !c.complete)
                .map(|c| c.entry_id.clone())
                .collect();
            confirmed.extend(
                plan.copies
                    .iter()
                    .filter(|c| c.complete)
                    .map(|c| c.entry_id.clone()),
            );
            if pending.is_empty() {
                continue;
            }
            let (revision, fresh) = self.erasure_plans(session)?;
            ensure!(
                fresh.contains(&plan),
                registry_unavailable("erasure plan changed before reconciliation")
            );
            let (data, raw) = self.fetch(session)?;
            check_erasure_jobs(&data)?;
            let mut staged = data.clone();
            if !raw.iter().any(|e| e["id"] == plan.record_id) {
                let keys = erased_input_keys(&data, &targets);
                record_erasure(&mut staged, targets.clone(), keys);
                staged.entries.last_mut().unwrap().id = plan.record_id.clone();
                staged.position = Some(plan.record_id.clone());
            } else {
                ensure!(
                    raw.iter().any(|e| e["id"] == plan.record_id
                        && e["kind"] == "erasure"
                        && e["erased"] != true
                        && e["data"]["entryIds"].as_array().is_some_and(|ids| targets
                            .iter()
                            .all(|target| ids.iter().any(|v| v == target)))),
                    registry_unavailable("erasure bookkeeping does not match the plan")
                );
            }
            let mut entries = staged.entries[data.entries.len()..]
                .iter()
                .map(|entry| portable::entry(entry, &staged))
                .collect::<Result<Vec<_>>>()?;
            let mut erase: Vec<_> = pending.iter().map(|id| json!(id)).collect();
            // The service owns the tombstone marker. First commit payload-free
            // terminal envelopes and remember their IDs in the erasure record.
            if let Some((book, settlements)) = entries.split_last_mut() {
                for entry in settlements
                    .iter_mut()
                    .filter(|entry| entry["erased"] == true)
                {
                    let envelope = entry.as_object_mut().unwrap();
                    envelope.remove("erased");
                    envelope.remove("sources");
                    erase.push(entry["id"].clone());
                }
                book["data"]["entryIds"] = json!(
                    targets
                        .iter()
                        .map(|id| json!(id))
                        .chain(erase.iter().skip(pending.len()).cloned())
                        .collect::<Vec<_>>()
                );
            } else if let Some(book) = raw.iter().find(|entry| entry["id"] == plan.record_id) {
                erase.extend(
                    book["data"]["entryIds"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|id| {
                            !targets.iter().any(|target| *id == target)
                                && raw.iter().any(|entry| {
                                    entry["id"] == **id
                                        && entry.get("data").is_none()
                                        && entry.get("message").is_none()
                                        && entry.get("sources").is_none()
                                })
                        })
                        .cloned(),
                );
            }
            write(&data, &staged, &mut || {
                if !entries.is_empty() {
                    state.acquire(self.ttl)?;
                    checked(state.observe_write(self.guarded_append(
                        session,
                        &lease,
                        &entries,
                        Some(&revision),
                    ))?)?;
                }
                state.acquire(self.ttl)?;
                self.writer_post(
                    &state,
                    &["v1", "sessions", session, "erase"],
                    json!({"lease":lease,"entryIds":erase}),
                )?;
                let (actual, raw) = self.fetch(session)?;
                let verified: Vec<_> = pending
                    .iter()
                    .filter(|id| raw.iter().any(|e| e["id"] == **id && e["erased"] == true))
                    .cloned()
                    .collect();
                if !verified.is_empty() {
                    state.acquire(self.ttl)?;
                    self.writer_post(
                        &state,
                        &[
                            "v1",
                            "sessions",
                            session,
                            "pending-erasure",
                            &plan.intent_id,
                            "complete",
                        ],
                        json!({"lease":lease,"entryIds":verified}),
                    )?;
                    confirmed.extend(verified);
                }
                Ok(actual)
            })?;
        }
        // Include bookkeeping written outside save() in the next append's base.
        let (data, entries) = self.fetch(session)?;
        self.check_erasure(&data)?;
        state.acquire(self.ttl)?;
        *state.kept.lock().unwrap() = entries
            .iter()
            .filter_map(|v| v["id"].as_str().map(str::to_owned))
            .collect();
        Ok(Some((data, confirmed.into_iter().collect())))
    }
}
