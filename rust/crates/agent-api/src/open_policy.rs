use crate::{Authority, SessionData};
use std::path::PathBuf;

/// Operator policy for one Interface attachment. This is not a work grant.
pub struct SessionOpenPolicy {
    pub session: String,
    pub actor: String,
    pub kind: String,
    pub rights: Authority,
    pub project: PathBuf,
    pub tenants: Vec<Option<String>>,
    pub join_on_open: bool,
    pub several_actors: bool,
    pub required: &'static [&'static str],
    pub writer: &'static str,
}

impl SessionOpenPolicy {
    pub fn allows(&self, data: &SessionData) -> bool {
        self.session == data.id
            && self.project == data.project
            && self
                .tenants
                .iter()
                .any(|t| t.as_deref() == data.tenant_id())
    }

    pub fn allows_join(&self, data: &SessionData) -> bool {
        self.join_on_open && (self.several_actors || crate::actors(data).is_empty())
    }
}

tokio::task_local! {
    pub static SESSION_OPEN_POLICY: SessionOpenPolicy;
}
