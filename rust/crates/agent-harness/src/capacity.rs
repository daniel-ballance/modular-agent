use agent_api::{OperationError, Result, SessionData};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

/// Pending input slots at one scope.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Capacity {
    pub inputs: usize,
}

impl Default for Capacity {
    fn default() -> Self {
        Self { inputs: 128 }
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
            tenant: Capacity { inputs: 1024 },
            agent: Capacity { inputs: 4096 },
        }
    }
}

#[derive(Default)]
struct Charge {
    tenant: Option<String>,
    committed: usize,
    admitting: usize,
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

    /// Rebuild from the backend before serving, or refresh a session whenever its writer commits.
    pub fn rebuild(&self, data: &SessionData) {
        let mut charges = self.charges.lock().unwrap();
        if let Some(charge) = charges.get_mut(&data.id) {
            charge.committed = data.pending_inputs().len();
            if charge.committed == 0 && charge.admitting == 0 {
                charges.remove(&data.id);
            }
        } else {
            let committed = data.pending_inputs().len();
            if committed != 0 {
                charges.insert(
                    data.id.clone(),
                    Charge {
                        committed,
                        tenant: super::tenants::name(data).map(str::to_owned),
                        ..Default::default()
                    },
                );
            }
        }
    }

    pub(crate) fn reserve(self: &Arc<Self>, data: &SessionData) -> Result<InputReservation> {
        let mut charges = self.charges.lock().unwrap();
        let tenant = super::tenants::name(data);
        let session_used = charges
            .get(&data.id)
            .map_or(0, |c| c.committed + c.admitting);
        let mut agent_used = 0;
        let mut tenant_used = 0;
        for charge in charges.values() {
            let used = charge.committed + charge.admitting;
            agent_used += used;
            if charge.tenant.as_deref() == tenant {
                tenant_used += used;
            }
        }
        if session_used >= self.limits.session.inputs
            || tenant_used >= self.limits.tenant.inputs
            || agent_used >= self.limits.agent.inputs
        {
            return Err(OperationError::Busy("input reservation capacity exhausted".into()).into());
        }
        let charge = charges.entry(data.id.clone()).or_insert_with(|| Charge {
            tenant: tenant.map(str::to_owned),
            ..Default::default()
        });
        charge.admitting += 1;
        Ok(InputReservation {
            pool: self.clone(),
            session: data.id.clone(),
        })
    }
}

pub(crate) struct InputReservation {
    pool: Arc<Pool>,
    session: String,
}
impl InputReservation {
    pub fn transfer(mut self, data: &SessionData) {
        let mut charges = self.pool.charges.lock().unwrap();
        let charge = charges
            .get_mut(&self.session)
            .expect("input reservation owns a charge");
        charge.committed = data.pending_inputs().len();
        charge.admitting -= 1;
        self.session.clear();
    }
}
impl Drop for InputReservation {
    fn drop(&mut self) {
        if self.session.is_empty() {
            return;
        }
        let mut charges = self.pool.charges.lock().unwrap();
        let charge = charges
            .get_mut(&self.session)
            .expect("input reservation owns a charge");
        charge.admitting -= 1;
        if charge.admitting == 0 && charge.committed == 0 {
            charges.remove(&self.session);
        }
    }
}
