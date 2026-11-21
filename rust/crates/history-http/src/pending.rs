//! Rust-only history coordination. The raw binding still reads opaque records.
use agent_api::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default, Serialize, Deserialize)]
pub(crate) struct Registry {
    intents: Vec<Intent>,
}

#[derive(Serialize, Deserialize)]
struct Intent {
    source: String,
    targets: Vec<String>,
    copies: BTreeMap<String, Plan>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Plan {
    pub(crate) record: String,
    pub(crate) targets: Vec<String>,
    #[serde(default)]
    pub(crate) confirmed: BTreeSet<String>,
}

impl Registry {
    pub(crate) fn plans(&self, session: &str) -> Vec<Plan> {
        self.intents
            .iter()
            .filter_map(|i| i.copies.get(session).cloned())
            .collect()
    }

    pub(crate) fn confirm(&mut self, session: &str, entries: &[Value], erased: &[&Value]) -> bool {
        let mut changed = false;
        for plan in self
            .intents
            .iter_mut()
            .filter_map(|i| i.copies.get_mut(session))
        {
            for id in &plan.targets {
                if erased.iter().any(|v| v.as_str() == Some(id))
                    && entries.iter().any(|e| {
                        e["kind"] == "erasure"
                            && e["erased"] != true
                            && e["data"]["entryIds"]
                                .as_array()
                                .is_some_and(|ids| ids.iter().any(|v| v.as_str() == Some(id)))
                    })
                {
                    changed |= plan.confirmed.insert(id.clone());
                }
            }
        }
        changed
    }

    pub(crate) fn affected(&self, entry: &Value) -> bool {
        let ids = self
            .intents
            .iter()
            .flat_map(|i| i.copies.values())
            .flat_map(|p| &p.targets);
        ids.into_iter().any(|id| {
            entry["id"].as_str() == Some(id)
                || entry["sources"]
                    .as_array()
                    .is_some_and(|sources| sources.iter().any(|source| source.as_str() == Some(id)))
        })
    }

    pub(crate) fn mark(
        &mut self,
        source: &str,
        mut targets: Vec<String>,
        sessions: &[SessionData],
    ) -> Result<BTreeMap<String, Vec<String>>> {
        targets.sort();
        targets.dedup();
        if let Some(intent) = self
            .intents
            .iter()
            .find(|i| i.source == source && i.targets == targets)
        {
            return Ok(intent
                .copies
                .iter()
                .map(|(session, plan)| (session.clone(), plan.targets.clone()))
                .collect());
        }
        let source_data = sessions
            .iter()
            .find(|s| s.id == source)
            .ok_or_else(|| OperationError::NotFound("unknown erasure source".into()))?;
        for target in &targets {
            let entry = source_data
                .entries
                .iter()
                .find(|entry| entry.id == *target)
                .ok_or_else(|| OperationError::NotFound("unknown erasure target".into()))?;
            ensure!(
                entry.writer != "rust.derived"
                    && !authority_record(entry)
                    && entry.kind != "erasure",
                OperationError::Forbidden("protected erasure target".into())
            );
        }
        let mut ids: BTreeSet<String> = targets.iter().cloned().collect();
        loop {
            let before = ids.len();
            for e in sessions.iter().flat_map(|s| &s.entries) {
                if e.kind == "input" && ids.contains(&e.id) {
                    ids.extend(e.copies.iter().cloned());
                }
                if e.copies.iter().any(|id| ids.contains(id)) {
                    ids.insert(e.id.clone());
                }
            }
            if before == ids.len() {
                break;
            }
        }
        let copies: BTreeMap<_, _> = sessions
            .iter()
            .filter_map(|s| {
                let targets: Vec<_> = s
                    .entries
                    .iter()
                    .filter(|e| {
                        e.writer != "rust.derived"
                            && !authority_record(e)
                            && e.kind != "erasure"
                            && ids.contains(&e.id)
                    })
                    .map(|e| e.id.clone())
                    .collect();
                (!targets.is_empty()).then(|| {
                    (
                        s.id.clone(),
                        Plan {
                            record: id(),
                            targets,
                            confirmed: BTreeSet::new(),
                        },
                    )
                })
            })
            .collect();
        let result = copies
            .iter()
            .map(|(session, plan)| (session.clone(), plan.targets.clone()))
            .collect();
        self.intents.push(Intent {
            source: source.into(),
            targets,
            copies,
        });
        Ok(result)
    }
}
