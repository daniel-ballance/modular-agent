use crate::bytes::{self, ByteLimits};
use agent_api::{HistoryStore, ModelResponse, OperationError, Result, SessionData};
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
    retained: u64,
    settlement: u64,
    buffered: u64,
    temporary_bytes: u64,
}
impl Charge {
    fn new(data: &SessionData) -> Self {
        Self {
            tenant: super::tenants::name(data).map(str::to_owned),
            committed: Capacity::ZERO,
            temporary: Capacity::ZERO,
            staged: BTreeMap::new(),
            retained: 0,
            settlement: 0,
            buffered: 0,
            temporary_bytes: 0,
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

// Room for basic intent, closing records and a bounded terminal payload.
const SETTLEMENT: u64 = 64 * 1024;

fn settlement(data: &SessionData, counts: Capacity) -> u64 {
    let mut turns = BTreeSet::new();
    let mut questions = BTreeSet::new();
    for entry in &data.entries {
        match entry.kind.as_str() {
            "turn.start" => {
                turns.insert(&entry.scope.turn);
            }
            "turn.end" => {
                turns.remove(&entry.scope.turn);
            }
            "request.open" => {
                if let Some(id) = entry.content.as_ref().and_then(|v| v["id"].as_str()) {
                    questions.insert(id);
                }
            }
            "request.answer" | "request.closed" | "request.invalidated" => {
                if let Some(id) = entry.content.as_ref().and_then(|v| v["request"].as_str()) {
                    questions.remove(id);
                }
            }
            _ => {}
        }
    }
    let fixed = counts
        .inputs
        .saturating_add(counts.calls)
        .saturating_add(counts.jobs)
        .saturating_add(turns.len())
        .saturating_add(questions.len()) as u64;
    data.pending_inputs()
        .into_iter()
        .fold(fixed.saturating_mul(SETTLEMENT), |n, (_, entry)| {
            n.saturating_add(bytes::size(entry))
        })
}

pub struct Pool {
    limits: ResourceLimits,
    bytes: Option<ByteLimits>,
    charges: Mutex<BTreeMap<String, Charge>>,
}
impl Pool {
    pub fn new(limits: ResourceLimits) -> Self {
        Self::with_bytes(limits, None)
    }
    pub fn with_bytes(limits: ResourceLimits, bytes: Option<ByteLimits>) -> Self {
        Self {
            limits,
            bytes,
            charges: Mutex::default(),
        }
    }
    pub fn limits(&self) -> &ResourceLimits {
        &self.limits
    }

    pub fn rebuild(&self, data: &SessionData) {
        let mut charges = self.charges.lock().unwrap();
        self.rebuild_charge(&mut charges, data);
    }

    fn rebuild_charge(&self, charges: &mut BTreeMap<String, Charge>, data: &SessionData) {
        let charge = charges
            .entry(data.id.clone())
            .or_insert_with(|| Charge::new(data));
        charge.committed = obligations(data);
        if self.bytes.is_some() {
            charge.retained = bytes::size(data);
            charge.settlement = settlement(data, charge.committed);
        }
        Self::prune(charges, &data.id);
    }

    pub(crate) fn reconcile_erasure(
        &self,
        store: &dyn HistoryStore,
        id: &str,
    ) -> Result<Option<(SessionData, Vec<String>)>> {
        let Some(limits) = self.bytes else {
            return store.reconcile_erasure(id, &mut |_, _, write| write());
        };
        // Match ordinary commits' lock order: the ledger precedes the store.
        let mut charges = self.charges.lock().unwrap();
        let result = store.reconcile_erasure(id, &mut |before, staged, write| {
            self.rebuild_charge(&mut charges, before);
            let retained = bytes::size(staged);
            let growth = retained.saturating_sub(bytes::size(before));
            if growth != 0 {
                let used = self.byte_scopes(&charges, before, accounted);
                for (used, cap) in
                    used.into_iter()
                        .zip([limits.session, limits.tenant, limits.agent])
                {
                    if used.saturating_add(growth) > cap.storage {
                        return bytes::busy();
                    }
                }
                // Keep this charge on uncertain writes until the store is read again.
                charges
                    .get_mut(id)
                    .expect("durable history has a charge")
                    .retained = retained;
            }
            let actual = write()?;
            self.rebuild_charge(&mut charges, &actual);
            Ok(actual)
        })?;
        if let Some((actual, _)) = &result {
            self.rebuild_charge(&mut charges, actual);
        }
        Ok(result)
    }

    fn prune(charges: &mut BTreeMap<String, Charge>, session: &str) {
        if charges.get(session).is_some_and(|c| {
            c.usage() == Capacity::ZERO
                && c.staged.is_empty()
                && c.retained == 0
                && c.settlement == 0
                && c.buffered == 0
                && c.temporary_bytes == 0
        }) {
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

    fn byte_scopes(
        &self,
        charges: &BTreeMap<String, Charge>,
        data: &SessionData,
        usage: impl Fn(&Charge) -> u64,
    ) -> [u64; 3] {
        let tenant = super::tenants::name(data);
        let mut used = [charges.get(&data.id).map_or(0, &usage), 0_u64, 0_u64];
        for charge in charges.values() {
            let n = usage(charge);
            if charge.tenant.as_deref() == tenant {
                used[1] = used[1].saturating_add(n);
            }
            used[2] = used[2].saturating_add(n);
        }
        used
    }

    pub(crate) fn buffer(self: &Arc<Self>, data: &SessionData, bytes: u64) -> Result<Buffer> {
        let mut reserved = Buffer {
            pool: self.clone(),
            session: data.id.clone(),
            bytes: 0,
        };
        if let Some(limits) = self.bytes {
            let mut charges = self.charges.lock().unwrap();
            let used = self.byte_scopes(&charges, data, |charge| charge.buffered);
            for (used, cap) in used
                .into_iter()
                .zip([limits.session, limits.tenant, limits.agent])
            {
                if used.saturating_add(bytes) > cap.buffered {
                    return bytes::busy();
                }
            }
            let charge = charges
                .entry(data.id.clone())
                .or_insert_with(|| Charge::new(data));
            charge.buffered += bytes;
            reserved.bytes = bytes;
        }
        Ok(reserved)
    }

    pub(crate) fn admit(self: &Arc<Self>, data: &SessionData, payload: u64) -> Result<Reservation> {
        // Admission and later input records may each retain the payload.
        self.reserve(data, Capacity::INPUT, payload.saturating_mul(2))
    }
    pub(crate) fn command(self: &Arc<Self>, data: &SessionData) -> Result<Reservation> {
        self.reserve(data, Capacity::CALL, 0)
    }
    fn reserve(
        self: &Arc<Self>,
        data: &SessionData,
        amount: Capacity,
        payload: u64,
    ) -> Result<Reservation> {
        let mut charges = self.charges.lock().unwrap();
        self.check(&charges, data, amount)?;
        let bytes = if self.bytes.is_some() {
            payload.saturating_add(SETTLEMENT)
        } else {
            0
        };
        if let Some(limits) = self.bytes {
            let used = self.byte_scopes(&charges, data, accounted);
            for (used, cap) in used
                .into_iter()
                .zip([limits.session, limits.tenant, limits.agent])
            {
                if used.saturating_add(bytes) > cap.storage.saturating_sub(cap.control) {
                    return bytes::busy();
                }
            }
        }
        let charge = charges
            .entry(data.id.clone())
            .or_insert_with(|| Charge::new(data));
        charge.temporary = charge.temporary + amount;
        charge.temporary_bytes += bytes;
        Ok(Reservation {
            pool: self.clone(),
            session: data.id.clone(),
            amount,
            bytes,
        })
    }

    pub(crate) fn stage_response(
        &self,
        data: &SessionData,
        step: Step,
        response: &ModelResponse,
    ) -> Result<()> {
        let extra = response.tool_calls().len().saturating_sub(1);
        if self.bytes.is_some() && bytes::size(response) > SETTLEMENT / 2 {
            return bytes::busy();
        }
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
        if let Some(limits) = self.bytes {
            let used = self.byte_scopes(&charges, data, accounted);
            let growth = (extra as u64).saturating_mul(SETTLEMENT);
            for (used, cap) in used
                .into_iter()
                .zip([limits.session, limits.tenant, limits.agent])
            {
                if used.saturating_add(growth) > cap.storage.saturating_sub(cap.control) {
                    return bytes::busy();
                }
            }
        }
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
        let mut retained = 0;
        let mut reserved = 0;
        if let Some(limits) = self.bytes {
            retained = bytes::size(after);
            reserved = settlement(after, next);
            let old = charges.get(&after.id);
            let before_bytes = old
                .map_or(0, |c| c.retained.saturating_add(c.settlement))
                .saturating_add(reservation.as_ref().map_or(0, |r| r.bytes))
                .saturating_add((consumed.calls as u64).saturating_mul(SETTLEMENT));
            let growth = retained
                .saturating_add(reserved)
                .saturating_sub(before_bytes);
            if growth != 0 {
                let added = after.entries.iter().skip(before.entries.len());
                let control = added.clone().next().is_some()
                    && added.clone().all(|e| {
                        matches!(
                            e.kind.as_str(),
                            "actor.left"
                                | "limit"
                                | "erasure"
                                | "cancel.requested"
                                | "job.cleanup.unconfirmed"
                        )
                    });
                let used = self.byte_scopes(&charges, after, accounted);
                for (used, cap) in
                    used.into_iter()
                        .zip([limits.session, limits.tenant, limits.agent])
                {
                    let available = if control {
                        cap.storage
                    } else {
                        cap.storage.saturating_sub(cap.control)
                    };
                    if used.saturating_add(growth) > available {
                        return bytes::busy();
                    }
                }
            }
        }
        let result = save()?;
        if retained != 0 || next != Capacity::ZERO || charges.contains_key(&after.id) {
            let charge = charges
                .entry(after.id.clone())
                .or_insert_with(|| Charge::new(after));
            charge.committed = next;
            charge.retained = retained;
            charge.settlement = reserved;
            if let Some(reservation) = &mut reservation {
                charge.temporary = charge.temporary.growth(n);
                charge.temporary_bytes -= reservation.bytes;
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

fn accounted(charge: &Charge) -> u64 {
    let staged = charge.staged.values().copied().sum::<usize>() as u64;
    charge
        .retained
        .saturating_add(charge.settlement)
        .saturating_add(charge.temporary_bytes)
        .saturating_add(staged.saturating_mul(SETTLEMENT))
}

pub(crate) struct Buffer {
    pool: Arc<Pool>,
    session: String,
    bytes: u64,
}
impl Drop for Buffer {
    fn drop(&mut self) {
        if self.bytes == 0 {
            return;
        }
        let mut charges = self.pool.charges.lock().unwrap();
        let charge = charges.get_mut(&self.session).expect("output has a charge");
        charge.buffered -= self.bytes;
        Pool::prune(&mut charges, &self.session);
    }
}

pub(crate) struct Reservation {
    pool: Arc<Pool>,
    session: String,
    amount: Capacity,
    bytes: u64,
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
        charge.temporary_bytes -= self.bytes;
        Pool::prune(&mut charges, &self.session);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history_commit::make_entry;
    use agent_api::{Draft, Scope, json};

    fn session(id: &str) -> SessionData {
        SessionData {
            id: id.into(),
            project: "/".into(),
            settings: json!({}),
            plugins: vec![],
            position: None,
            entries: vec![],
            origin: None,
        }
    }

    #[test]
    fn held_output_counts_against_each_scope_and_releases_on_drop() -> Result<()> {
        let at = |buffered| crate::ByteCapacity {
            storage: 1_000_000,
            control: 1000,
            buffered,
        };
        let pool = Arc::new(Pool::with_bytes(
            ResourceLimits::default(),
            Some(ByteLimits {
                session: at(10),
                tenant: at(14),
                agent: at(15),
            }),
        ));
        let a = session("a");
        let b = session("b");
        let mut c = session("c");
        c.entries.push(make_entry(
            &c,
            &Scope::session(&c.id),
            "harness",
            Draft::new("tenant", false, json!({"tenant":"different"})),
        ));
        let first = pool.buffer(&a, 10)?;
        assert!(pool.buffer(&a, 1).is_err());
        assert!(pool.buffer(&b, 5).is_err());
        let second = pool.buffer(&b, 4)?;
        assert!(pool.buffer(&c, 2).is_err());
        drop(first);
        let _other = pool.buffer(&c, 10)?;
        drop(second);
        Ok(())
    }

    #[test]
    fn ordinary_writes_cannot_take_control_space_or_an_input_reservation() -> Result<()> {
        let at = crate::ByteCapacity {
            storage: SETTLEMENT + 3000,
            control: 1000,
            buffered: 0,
        };
        let pool = Arc::new(Pool::with_bytes(
            ResourceLimits::default(),
            Some(ByteLimits {
                session: at,
                tenant: at,
                agent: at,
            }),
        ));
        let a = session("a");
        let reservation = pool.admit(&a, 0)?;
        let append = |kind| {
            let mut next = a.clone();
            next.entries.push(make_entry(
                &a,
                &Scope::session(&a.id),
                "harness",
                Draft::new(kind, false, json!({"padding":"x".repeat(2000)})),
            ));
            next
        };
        assert!(
            pool.commit::<()>(&a, &append("plugin.test"), None, || panic!(
                "no ordinary write under saturation"
            ))
            .is_err()
        );
        pool.commit(&a, &append("limit"), None, || Ok(()))?;
        drop(reservation);
        Ok(())
    }
}
