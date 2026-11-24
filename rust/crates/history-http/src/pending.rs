//! Wire and durable records for the pending-erasure profile. No payload or keys.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashSet};

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

    pub fn consistent(&self) -> bool {
        let mut intents = HashSet::new();
        let mut operations = HashSet::new();
        let mut records = HashSet::new();
        self.intents.iter().all(|intent| {
            let mut sessions = HashSet::new();
            path_id(&intent.id)
                && intents.insert(&intent.id)
                && operations.insert((&intent.source, &intent.targets))
                && !intent.targets.is_empty()
                && intent.plan(&intent.source).is_some_and(|source| {
                    intent
                        .targets
                        .iter()
                        .all(|id| source.copies.iter().any(|c| c.entry_id == *id))
                })
                && intent.plans.iter().all(|(sid, plan)| {
                    let mut entries = HashSet::new();
                    path_id(sid)
                        && sessions.insert(sid)
                        && plan.intent_id == intent.id
                        && plan.source_session_id == intent.source
                        && !plan.record_id.is_empty()
                        && records.insert((sid, &plan.record_id))
                        && !plan.copies.is_empty()
                        && plan.copies.iter().all(|c| {
                            !c.entry_id.is_empty()
                                && c.entry_id != plan.record_id
                                && entries.insert(&c.entry_id)
                        })
                })
        })
    }
}
