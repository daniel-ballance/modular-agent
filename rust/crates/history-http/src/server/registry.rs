use super::super::pending::Intent;
use super::*;

impl SnapshotStore {
    pub(super) fn registry(&self) -> std::result::Result<(SessionData, Registry), Failure> {
        let control = self
            .store
            .load(CONTROL)
            .map_err(|_| Failure::unavailable())?;
        let registry = Control::read(&control)
            .ok_or_else(Failure::unavailable)?
            .pending_erasure_v1;
        Ok((control, registry))
    }

    fn save_registry(
        &self,
        mut control: SessionData,
        registry: Registry,
        revision: &mut String,
    ) -> Answer {
        advance(revision)?;
        control.settings["pendingErasureV1"] = json!(registry);
        self.store.save(&control).map_err(|_| Failure::Uncertain)?;
        Ok(json!({}))
    }

    pub(super) fn publish(
        &self,
        session: &str,
        request: Publication,
        revision: &mut String,
    ) -> Answer {
        let lease = json!(request.lease);
        let (control, mut registry) = self.registry()?;
        let targets = request.entry_ids.into_iter().collect();
        if let Some(intent) = registry.intents.iter().find(|i| i.id == request.intent_id) {
            return if intent.source == session
                && intent.targets == targets
                && intent.same_copies(&request.copies)
            {
                Ok(json!(intent.published()))
            } else {
                Err(Failure::conflict())
            };
        }
        if let Some(intent) = registry
            .intents
            .iter()
            .find(|i| i.source == session && i.targets == targets)
        {
            return Ok(json!(intent.published()));
        }
        if request.revision != *revision {
            return Err(Failure::http(409, "stale_revision"));
        }
        let intent = Intent::new(session, request.intent_id, targets, request.copies);
        for (sid, plan) in &intent.plans {
            let record = self
                .load(sid)?
                .ok_or_else(|| Failure::http(404, "unknown_session"))?;
            let entries: HashSet<_> = record
                .entries
                .iter()
                .filter_map(|e| e["id"].as_str())
                .collect();
            if plan
                .copies
                .iter()
                .any(|copy| !entries.contains(copy.entry_id.as_str()))
            {
                return Err(Failure::http(404, "unknown_entry"));
            }
            if entries.contains(plan.record_id.as_str())
                || registry.plans(sid).any(|p| p.record_id == plan.record_id)
            {
                return Err(Failure::conflict());
            }
            if !fits(&json!({"revision":"A".repeat(128),"plans":[plan],"next":intent.id})) {
                return Err(Failure::http(413, "request_too_large"));
            }
        }
        let reply = json!(intent.published());
        registry.intents.push(intent);
        self.leases.check(session, &lease)?;
        self.save_registry(control, registry, revision)?;
        Ok(reply)
    }

    pub(super) fn complete(
        &self,
        session: &str,
        intent: &str,
        record: &Snapshot,
        lease: &Value,
        ids: Value,
        revision: &mut String,
    ) -> Answer {
        let (control, mut registry) = self.registry()?;
        let plan = registry
            .intents
            .iter_mut()
            .find(|i| i.id == intent)
            .and_then(|i| i.plans.iter_mut().find(|(sid, _)| sid == session))
            .map(|(_, plan)| plan)
            .ok_or_else(|| Failure::http(404, "unknown_intent"))?;
        let ids: Vec<String> = serde_json::from_value(ids).map_err(|_| Failure::invalid())?;
        let ids: HashSet<_> = ids.iter().map(String::as_str).collect();
        if plan
            .copies
            .iter()
            .filter(|c| ids.contains(c.entry_id.as_str()))
            .count()
            != ids.len()
        {
            return Err(Failure::invalid());
        }
        let bookkeeping = record
            .entries
            .iter()
            .find(|e| e["id"] == plan.record_id && e["kind"] == "erasure" && e["erased"] != true)
            .and_then(|e| e["data"]["entryIds"].as_array())
            .ok_or_else(Failure::conflict)?;
        let listed: HashSet<_> = bookkeeping.iter().filter_map(Value::as_str).collect();
        let tombstones: HashSet<_> = record
            .entries
            .iter()
            .filter(|e| e["erased"] == true)
            .filter_map(|e| e["id"].as_str())
            .collect();
        if !ids.is_subset(&listed) || !ids.is_subset(&tombstones) {
            return Err(Failure::conflict());
        }
        let mut changed = false;
        for copy in &mut plan.copies {
            if ids.contains(copy.entry_id.as_str()) && !copy.complete {
                copy.complete = true;
                changed = true;
            }
        }
        if changed {
            self.leases.check(session, lease)?;
            self.save_registry(control, registry, revision)
        } else {
            Ok(json!({}))
        }
    }
}
