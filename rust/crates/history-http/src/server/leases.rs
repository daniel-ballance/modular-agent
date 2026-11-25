//! Writer leases of the snapshot-backed service.
use super::{Failure, nonce};
use agent_api::Value;
use std::{
    collections::HashMap,
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};

/// Never held across I/O, so a renewal does not wait for another session's
/// storage work. The service grants and releases leases under its storage
/// lock as well; renewals take only this one.
pub(super) struct Leases {
    ttl: Duration,
    grants: Mutex<HashMap<String, Grant>>,
}
struct Grant {
    token: String,
    owner: String,
    until: Instant,
}
type Result<T> = std::result::Result<T, Failure>;

impl Leases {
    pub(super) fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            grants: Mutex::new(HashMap::new()),
        }
    }

    fn current(&self) -> Result<MutexGuard<'_, HashMap<String, Grant>>> {
        let mut grants = self.grants.lock().map_err(|_| Failure::unavailable())?;
        let now = Instant::now();
        grants.retain(|_, grant| grant.until > now);
        Ok(grants)
    }

    pub(super) fn acquire(&self, id: &str, owner: &str) -> Result<String> {
        let token = nonce()?;
        let mut grants = self.current()?;
        if let Some(grant) = grants.get(id) {
            return if grant.owner == owner {
                Ok(grant.token.clone())
            } else {
                Err(Failure::held(grant.until))
            };
        }
        let until = Instant::now() + self.ttl;
        grants.insert(
            id.into(),
            Grant {
                token: token.clone(),
                owner: owner.into(),
                until,
            },
        );
        Ok(token)
    }

    /// A current lease already proves the session exists, so renewing one
    /// needs no record.
    pub(super) fn renew(&self, id: &str, token: &str) -> Result<bool> {
        let mut grants = self.current()?;
        let Some(grant) = grants.get_mut(id).filter(|g| g.token == token) else {
            return Ok(false);
        };
        grant.until = Instant::now() + self.ttl;
        Ok(true)
    }

    pub(super) fn release(&self, id: &str, token: &str) -> Result<()> {
        let mut grants = self.current()?;
        if grants.get(id).is_some_and(|g| g.token == token) {
            grants.remove(id);
        }
        Ok(())
    }

    pub(super) fn check(&self, id: &str, token: &Value) -> Result<()> {
        match self.current()?.get(id) {
            Some(grant) if *token == grant.token => Ok(()),
            _ => Err(Failure::lost()),
        }
    }

    pub(super) fn until(&self, id: &str) -> Result<Option<Instant>> {
        Ok(self.current()?.get(id).map(|g| g.until))
    }
}
