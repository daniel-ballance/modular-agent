use agent_api::{ModelResponse, OperationError, Result, SessionData};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    ops::Add,
    sync::{Arc, Mutex},
};

/// Count ceilings at one scope. Calls include unfinished model attempts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Capacity {
    pub inputs: usize,
    pub calls: usize,
    pub jobs: usize,
}

impl Default for Capacity {
    fn default() -> Self {
        Self {
            inputs: 128,
            calls: 128,
            jobs: 32,
        }
    }
}
impl Add for Capacity {
    type Output = Self;
    fn add(self, rhs: Self) -> Self {
        Self {
            inputs: self.inputs.saturating_add(rhs.inputs),
            calls: self.calls.saturating_add(rhs.calls),
            jobs: self.jobs.saturating_add(rhs.jobs),
        }
    }
}
impl Capacity {
    const ZERO: Self = Self {
        inputs: 0,
        calls: 0,
        jobs: 0,
    };
    const INPUT: Self = Self {
        inputs: 1,
        ..Self::ZERO
    };
    const CALL: Self = Self {
        calls: 1,
        ..Self::ZERO
    };

    fn growth(self, before: Self) -> Self {
        Self {
            inputs: self.inputs.saturating_sub(before.inputs),
            calls: self.calls.saturating_sub(before.calls),
            jobs: self.jobs.saturating_sub(before.jobs),
        }
    }
    fn permits(self, current: Self, growth: Self) -> bool {
        (growth.inputs == 0 || current.inputs.saturating_add(growth.inputs) <= self.inputs)
            && (growth.calls == 0 || current.calls.saturating_add(growth.calls) <= self.calls)
            && (growth.jobs == 0 || current.jobs.saturating_add(growth.jobs) <= self.jobs)
    }
}

/// Limits set by the operator, not by project settings.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ResourceLimits {
    pub session: Capacity,
    pub tenant: Capacity,
    pub agent: Capacity,
}
impl Default for ResourceLimits {
    fn default() -> Self {
        Self {
            session: Capacity::default(),
            tenant: Capacity {
                inputs: 1024,
                calls: 1024,
                jobs: 256,
            },
            agent: Capacity {
                inputs: 4096,
                calls: 4096,
                jobs: 1024,
            },
        }
    }
}

type Step = (Option<String>, Option<String>);
struct Charge {
    tenant: Option<String>,
    committed: Capacity,
    temporary: Capacity,
    // A served Runtime receives the response before it records it. These are
    // the extra slots beyond the model intent which the answer will settle.
    staged: BTreeMap<Step, usize>,
}
impl Charge {
    fn new(data: &SessionData) -> Self {
        Self {
            tenant: super::tenants::name(data).map(str::to_owned),
            committed: Capacity::ZERO,
            temporary: Capacity::ZERO,
            staged: BTreeMap::new(),
        }
    }
    fn usage(&self) -> Capacity {
        self.committed
            + self.temporary
            + Capacity {
                calls: self.staged.values().copied().sum(),
                ..Capacity::ZERO
            }
    }
}

fn obligations(data: &SessionData) -> Capacity {
    let mut attempts = BTreeSet::new();
    let mut calls = BTreeSet::new();
    let mut jobs = BTreeMap::new();
    let mut terminal_calls = BTreeSet::new();
    for e in &data.entries {
        match e.kind.as_str() {
            "model.request" => {
                attempts.insert((&e.scope.turn, &e.scope.step));
            }
            "model.response" => {
                attempts.remove(&(&e.scope.turn, &e.scope.step));
                if let Some(parts) = e.content.as_ref().and_then(|v| v["parts"].as_array()) {
                    calls.extend(parts.iter().filter_map(|p| p["call"]["id"].as_str()));
                }
            }
            "tool.call" => {
                calls.extend(e.scope.call.as_deref());
            }
            "tool.result" => {
                terminal_calls.extend(e.scope.call.as_deref());
            }
            "job.start" => {
                if let Some(job) = e.scope.job.as_deref() {
                    jobs.insert(job, e.content.as_ref().is_none_or(|v| v["report"] == true));
                }
            }
            "job.end" => {
                if let Some(job) = e.scope.job.as_deref() {
                    jobs.remove(job);
                }
            }
            _ => {}
        }
    }
    Capacity {
        inputs: data.pending_inputs().len() + jobs.values().filter(|report| **report).count(),
        calls: attempts.len() + calls.difference(&terminal_calls).count(),
        jobs: jobs.len(),
    }
}

pub struct Pool {
    limits: ResourceLimits,
    charges: Mutex<BTreeMap<String, Charge>>,
}
impl Pool {
    pub fn new(limits: ResourceLimits) -> Self {
        Self {
            limits,
            charges: Mutex::default(),
        }
    }
    pub fn limits(&self) -> &ResourceLimits {
        &self.limits
    }

    pub fn rebuild(&self, data: &SessionData) {
        let mut charges = self.charges.lock().unwrap();
        charges
            .entry(data.id.clone())
            .or_insert_with(|| Charge::new(data))
            .committed = obligations(data);
        Self::prune(&mut charges, &data.id);
    }

    fn prune(charges: &mut BTreeMap<String, Charge>, session: &str) {
        if charges
            .get(session)
            .is_some_and(|c| c.usage() == Capacity::ZERO && c.staged.is_empty())
        {
            charges.remove(session);
        }
    }

    fn check(
        &self,
        charges: &BTreeMap<String, Charge>,
        data: &SessionData,
        growth: Capacity,
    ) -> Result<()> {
        if growth == Capacity::ZERO {
            return Ok(());
        }
        let tenant = super::tenants::name(data);
        let session_used = charges.get(&data.id).map_or(Capacity::ZERO, Charge::usage);
        let mut agent_used = Capacity::ZERO;
        let mut tenant_used = Capacity::ZERO;
        for charge in charges.values() {
            let used = charge.usage();
            agent_used = agent_used + used;
            if charge.tenant.as_deref() == tenant {
                tenant_used = tenant_used + used;
            }
        }
        if !self.limits.session.permits(session_used, growth)
            || !self.limits.tenant.permits(tenant_used, growth)
            || !self.limits.agent.permits(agent_used, growth)
        {
            return Err(OperationError::Busy("reservation capacity exhausted".into()).into());
        }
        Ok(())
    }

    pub(crate) fn admit(self: &Arc<Self>, data: &SessionData) -> Result<Reservation> {
        self.reserve(data, Capacity::INPUT)
    }
    pub(crate) fn command(self: &Arc<Self>, data: &SessionData) -> Result<Reservation> {
        self.reserve(data, Capacity::CALL)
    }
    fn reserve(self: &Arc<Self>, data: &SessionData, amount: Capacity) -> Result<Reservation> {
        let mut charges = self.charges.lock().unwrap();
        self.check(&charges, data, amount)?;
        let charge = charges
            .entry(data.id.clone())
            .or_insert_with(|| Charge::new(data));
        charge.temporary = charge.temporary + amount;
        Ok(Reservation {
            pool: self.clone(),
            session: data.id.clone(),
            amount,
        })
    }

    pub(crate) fn stage_response(
        &self,
        data: &SessionData,
        step: Step,
        response: &ModelResponse,
    ) -> Result<()> {
        let extra = response.tool_calls().len().saturating_sub(1);
        if extra == 0 {
            return Ok(());
        }
        let mut charges = self.charges.lock().unwrap();
        self.check(
            &charges,
            data,
            Capacity {
                calls: extra,
                ..Capacity::ZERO
            },
        )?;
        charges
            .entry(data.id.clone())
            .or_insert_with(|| Charge::new(data))
            .staged
            .insert(step, extra);
        Ok(())
    }

    /// Keep admissions and other starts serialized with the write. On failure,
    /// retain the previous durable obligations. No successful check may be
    /// followed by another operation spending the same slot.
    pub(crate) fn commit<T>(
        &self,
        before: &SessionData,
        after: &SessionData,
        mut reservation: Option<Reservation>,
        save: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        let mut charges = self.charges.lock().unwrap();
        let next = obligations(after);
        let n = reservation.as_ref().map_or(Capacity::ZERO, |r| r.amount);
        let mut consumed = Capacity::ZERO;
        let mut finished_turns = BTreeSet::new();
        if let Some(charge) = charges.get(&after.id) {
            for e in after.entries.iter().skip(before.entries.len()) {
                if e.kind == "model.response" {
                    consumed.calls += charge
                        .staged
                        .get(&(e.scope.turn.clone(), e.scope.step.clone()))
                        .copied()
                        .unwrap_or(0);
                } else if e.kind == "turn.end" {
                    finished_turns.insert(e.scope.turn.clone());
                }
            }
        }
        let old = charges
            .get(&after.id)
            .map_or(Capacity::ZERO, |c| c.committed);
        self.check(&charges, after, next.growth(old + n + consumed))?;
        let result = save()?;
        if next != Capacity::ZERO || charges.contains_key(&after.id) {
            let charge = charges
                .entry(after.id.clone())
                .or_insert_with(|| Charge::new(after));
            charge.committed = next;
            if let Some(reservation) = &mut reservation {
                charge.temporary = charge.temporary.growth(n);
                reservation.amount = Capacity::ZERO;
            }
            for e in after
                .entries
                .iter()
                .skip(before.entries.len())
                .filter(|e| e.kind == "model.response")
            {
                charge
                    .staged
                    .remove(&(e.scope.turn.clone(), e.scope.step.clone()));
            }
            charge
                .staged
                .retain(|(turn, _), _| !finished_turns.contains(turn));
            Self::prune(&mut charges, &after.id);
        }
        Ok(result)
    }
}

pub(crate) struct Reservation {
    pool: Arc<Pool>,
    session: String,
    amount: Capacity,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        if self.amount == Capacity::ZERO {
            return;
        }
        let mut charges = self.pool.charges.lock().unwrap();
        let charge = charges
            .get_mut(&self.session)
            .expect("reservation owns a charge");
        charge.temporary = charge.temporary.growth(self.amount);
        Pool::prune(&mut charges, &self.session);
    }
}
