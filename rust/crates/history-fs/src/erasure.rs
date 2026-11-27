use super::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Default, Deserialize, Serialize)]
pub(super) struct Registry {
    intents: Vec<Intent>,
}

#[derive(Deserialize, Serialize)]
struct Intent {
    id: String,
    source: String,
    targets: Vec<String>,
    copies: BTreeMap<String, Vec<String>>,
    confirmed: BTreeMap<String, Vec<String>>,
}

pub(super) fn unavailable(error: impl std::fmt::Display) -> anyhow::Error {
    OperationError::Unavailable(format!("pending erasure unavailable: {error}")).into()
}

impl FileHistory {
    pub(super) fn initialize_registry(&self) -> Result<bool> {
        let dir = self.root.join(".erasure");
        if dir.try_exists()? {
            self.read_registry()?;
            return Ok(false);
        }
        ensure!(
            self.snapshots()?.is_empty(),
            unavailable("missing registry for existing history")
        );
        if let Some(witness) = &self.witness {
            witness.require_unused()?;
        }
        fs::create_dir(&dir)?;
        self.replace(
            &dir.join("intents"),
            &serde_json::to_vec(&Registry::default())?,
        )?;
        File::open(&self.root)?.sync_all()?;
        Ok(true)
    }

    fn read_registry(&self) -> Result<Registry> {
        let bytes = fs::read(self.root.join(".erasure/intents")).map_err(unavailable)?;
        serde_json::from_slice(&bytes).map_err(unavailable)
    }

    fn write_registry(&self, registry: &Registry) -> Result<()> {
        let dir = self.root.join(".erasure");
        self.replace_tracked(&dir.join("intents"), &serde_json::to_vec(registry)?)
            .map_err(unavailable)
    }

    /// Publication and native snapshot writes take the same lock. Once a mark
    /// exists, no written snapshot can republish its content or derived copies.
    pub(super) fn check_unlocked(&self, data: &SessionData) -> Result<()> {
        let registry = self.read_registry()?;
        if registry.intents.is_empty() {
            return Ok(());
        }
        let targets = registry
            .intents
            .iter()
            .flat_map(|intent| intent.copies.values().flatten().map(String::as_str))
            .collect::<BTreeSet<_>>();
        for entry in &data.entries {
            if entry.content.is_some()
                && !authority_record(entry)
                && entry.kind != "erasure"
                && (targets.contains(entry.id.as_str())
                    || entry.copies.iter().any(|id| targets.contains(id.as_str())))
            {
                return Err(unavailable("session contains content marked for erasure")
                    .context(PendingErasure));
            }
        }
        Ok(())
    }

    pub(super) fn mark(
        &self,
        source: &str,
        targets: &[String],
    ) -> Result<BTreeMap<String, Vec<String>>> {
        let _lock = self.lock().map_err(unavailable)?;
        let mut registry = self.read_registry()?;
        let mut targets = targets.to_vec();
        targets.sort();
        targets.dedup();
        if let Some(old) = registry
            .intents
            .iter()
            .find(|e| e.source == source && e.targets == targets)
        {
            return Ok(old.copies.clone());
        }
        let sessions = self.all_unlocked().map_err(unavailable)?;
        let source_record = sessions
            .iter()
            .find(|s| s.id == source)
            .ok_or_else(|| OperationError::NotFound("unknown erasure source".into()))?;
        for target in &targets {
            let e = source_record
                .entries
                .iter()
                .find(|e| &e.id == target)
                .ok_or_else(|| OperationError::NotFound("unknown erasure target".into()))?;
            ensure!(
                !authority_record(e) && e.kind != "erasure",
                OperationError::Forbidden("protected erasure target".into())
            );
        }
        let mut ids = targets.iter().cloned().collect::<BTreeSet<_>>();
        loop {
            let before = ids.len();
            for entry in sessions.iter().flat_map(|s| &s.entries) {
                if entry.kind == "input" && ids.contains(&entry.id) {
                    ids.extend(entry.copies.iter().cloned());
                }
                if entry.copies.iter().any(|source| ids.contains(source)) {
                    ids.insert(entry.id.clone());
                }
            }
            if ids.len() == before {
                break;
            }
        }
        let copies: BTreeMap<_, _> = sessions
            .iter()
            .filter_map(|s| {
                let kept: Vec<_> = s
                    .entries
                    .iter()
                    .filter(|e| ids.contains(&e.id) && !authority_record(e) && e.kind != "erasure")
                    .map(|e| e.id.clone())
                    .collect();
                (!kept.is_empty()).then(|| (s.id.clone(), kept))
            })
            .collect();
        registry.intents.push(Intent {
            id: id(),
            source: source.into(),
            targets,
            copies: copies.clone(),
            confirmed: BTreeMap::new(),
        });
        self.write_registry(&registry)?;
        Ok(copies)
    }

    pub(super) fn reconcile(
        &self,
        session: &str,
        write: &mut ErasureWrite<'_>,
    ) -> Result<Option<(SessionData, Vec<String>)>> {
        let _lock = self.lock().map_err(unavailable)?;
        let mut registry = self.read_registry()?;
        if !registry
            .intents
            .iter()
            .any(|i| i.copies.contains_key(session))
        {
            return Ok(None);
        }
        let mut data = self.load_unlocked(session).map_err(unavailable)?;
        let mut progress = false;
        let mut confirmed = BTreeSet::new();
        for intent in &mut registry.intents {
            let Some(targets) = intent.copies.get(session) else {
                continue;
            };
            // The bookkeeping ID is stable across a lost tombstone reply or restart.
            let record = format!("{}-{session}", intent.id);
            let has_bookkeeping = data
                .entries
                .iter()
                .any(|e| e.kind == "erasure" && e.id == record);
            let kept: Vec<String> = data
                .entries
                .iter()
                .filter(|e| targets.contains(&e.id) && e.content.is_some())
                .map(|e| e.id.clone())
                .collect();
            if !kept.is_empty() {
                let mut staged = data.clone();
                if !has_bookkeeping {
                    let keys = erased_input_keys(&data, &kept);
                    record_erasure(&mut staged, kept.clone(), keys);
                    staged.entries.last_mut().unwrap().id = record.clone();
                    staged.position = Some(record);
                }
                let mut next = staged.clone();
                let settings = next
                    .entries
                    .iter()
                    .any(|e| kept.contains(&e.id) && e.kind == "settings");
                for e in next.entries.iter_mut().filter(|e| kept.contains(&e.id)) {
                    e.erase_payload();
                }
                if settings {
                    next.settings = next
                        .entries
                        .iter()
                        .rev()
                        .find(|e| e.kind == "settings")
                        .and_then(|e| e.content.clone())
                        .unwrap_or_else(|| json!({}));
                }
                // Bookkeeping and tombstones share the atomic replacement.
                // Restoring older settings can make the final snapshot larger.
                let peak = if settings
                    && serde_json::to_vec(&next)?.len() > serde_json::to_vec(&staged)?.len()
                {
                    &next
                } else {
                    &staged
                };
                data = write(&data, peak, &mut || {
                    self.save_unlocked(&next).map_err(unavailable)?;
                    Ok(next.clone())
                })?;
            }
            let done: Vec<String> = targets
                .iter()
                .filter(|id| {
                    data.entries
                        .iter()
                        .any(|e| e.id == **id && e.content.is_none())
                        && data.entries.iter().any(|e| {
                            e.kind == "erasure"
                                && e.content.as_ref().is_some_and(|c| {
                                    c["entryIds"]
                                        .as_array()
                                        .is_some_and(|ids| ids.iter().any(|v| v == *id))
                                })
                        })
                })
                .cloned()
                .collect();
            if intent.confirmed.get(session) != Some(&done) {
                confirmed.extend(done.iter().cloned());
                intent.confirmed.insert(session.into(), done);
                progress = true;
            } else {
                confirmed.extend(done);
            }
        }
        if progress {
            self.write_registry(&registry)?;
        }
        Ok(Some((data, confirmed.into_iter().collect())))
    }
}
