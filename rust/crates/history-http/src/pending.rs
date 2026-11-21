//! Wire and durable records for the pending-erasure profile. No payload or keys.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashSet};

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Registry {
    pub intents: Vec<Intent>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Intent {
    pub id: String,
    pub source: String,
    pub targets: BTreeSet<String>,
    pub plans: Vec<(String, Plan)>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Plan {
    pub intent_id: String,
    pub source_session_id: String,
    pub record_id: String,
    pub copies: Vec<Copy>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Copy {
    pub entry_id: String,
    pub complete: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CopySet {
    pub session_id: String,
    pub record_id: String,
    pub entry_ids: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Publication {
    pub lease: String,
    pub revision: String,
    pub intent_id: String,
    pub entry_ids: Vec<String>,
    pub copies: Vec<CopySet>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Published {
    pub intent_id: String,
    pub session_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlansPage {
    pub revision: String,
    pub plans: Vec<Plan>,
    pub next: Option<String>,
}

pub(crate) fn path_id(id: &str) -> bool {
    !matches!(id, "" | "." | "..")
}

pub(crate) fn distinct_ids(ids: &[String]) -> bool {
    !ids.is_empty()
        && ids.iter().all(|id| !id.is_empty())
        && ids.iter().collect::<HashSet<_>>().len() == ids.len()
}

impl Intent {
    pub fn new(source: &str, id: String, targets: BTreeSet<String>, copies: Vec<CopySet>) -> Self {
        let plans = copies
            .into_iter()
            .map(|set| {
                (
                    set.session_id,
                    Plan {
                        intent_id: id.clone(),
                        source_session_id: source.into(),
                        record_id: set.record_id,
                        copies: set
                            .entry_ids
                            .into_iter()
                            .map(|entry_id| Copy {
                                entry_id,
                                complete: false,
                            })
                            .collect(),
                    },
                )
            })
            .collect();
        Self {
            id,
            source: source.into(),
            targets,
            plans,
        }
    }

    pub fn published(&self) -> Published {
        Published {
            intent_id: self.id.clone(),
            session_ids: self
                .plans
                .iter()
                .filter(|(session, _)| session != &self.source)
                .map(|(session, _)| session.clone())
                .collect(),
        }
    }

    pub fn plan(&self, session: &str) -> Option<&Plan> {
        self.plans
            .iter()
            .find(|(sid, _)| sid == session)
            .map(|(_, plan)| plan)
    }

    pub fn same_copies(&self, copies: &[CopySet]) -> bool {
        self.plans.len() == copies.len()
            && copies.iter().all(|set| {
                self.plan(&set.session_id).is_some_and(|plan| {
                    plan.record_id == set.record_id
                        && plan.copies.len() == set.entry_ids.len()
                        && plan
                            .copies
                            .iter()
                            .all(|copy| set.entry_ids.contains(&copy.entry_id))
                })
            })
    }
}

impl Registry {
    pub fn plans(&self, session: &str) -> impl Iterator<Item = &Plan> {
        self.intents
            .iter()
            .filter_map(move |intent| intent.plan(session))
    }

    // Adopt an existing Rust store without losing either pending or completed marks.
    pub fn migrate(value: agent_api::Value) -> agent_api::Result<Self> {
        #[derive(Deserialize)]
        struct LegacyRegistry {
            intents: Vec<LegacyIntent>,
        }
        #[derive(Deserialize)]
        struct LegacyIntent {
            source: String,
            targets: Vec<String>,
            copies: BTreeMap<String, LegacyPlan>,
        }
        #[derive(Deserialize)]
        struct LegacyPlan {
            record: String,
            targets: Vec<String>,
            #[serde(default)]
            confirmed: BTreeSet<String>,
        }
        let old: LegacyRegistry = serde_json::from_value(value)?;
        let mut intents = Vec::new();
        for old in old.intents {
            let id = agent_api::id();
            let plans = old
                .copies
                .into_iter()
                .map(|(sid, plan)| {
                    (
                        sid,
                        Plan {
                            intent_id: id.clone(),
                            source_session_id: old.source.clone(),
                            record_id: plan.record,
                            copies: plan
                                .targets
                                .into_iter()
                                .map(|entry_id| Copy {
                                    complete: plan.confirmed.contains(&entry_id),
                                    entry_id,
                                })
                                .collect(),
                        },
                    )
                })
                .collect();
            intents.push(Intent {
                id,
                source: old.source,
                targets: old.targets.into_iter().collect(),
                plans,
            });
        }
        Ok(Self { intents })
    }
}
