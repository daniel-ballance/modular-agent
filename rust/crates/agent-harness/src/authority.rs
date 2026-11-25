use super::{Harness, tenants};
use agent_api::*;

pub(super) fn admitted_authority(
    api: &dyn AgentApi,
    session: &str,
    mut cap: Authority,
    v: &Value,
) -> Result<Authority> {
    if let Some(saved) = v.get("authority").filter(|v| !v.is_null()) {
        cap = cap.intersect(&serde_json::from_value(saved.clone())?);
    }
    for key in ["sponsor", "releasedBy"] {
        if let Some(actor) = v[key].as_str() {
            cap = cap.intersect(&api.authority(session, actor)?);
        }
    }
    Ok(cap)
}

impl Harness {
    pub fn configure_tenants(&self, config: Option<&str>) -> Result<()> {
        ensure!(
            self.sessions.lock().unwrap().is_empty(),
            "tenants are fixed while sessions are open"
        );
        *self.tenants.write().unwrap() =
            config.map(tenants::parse).transpose()?.unwrap_or_default();
        Ok(())
    }
    /// Apply tenant limits before an Interface creates a provisional session.
    pub fn tenant_rights(&self, name: &str) -> Result<Authority> {
        Ok(self.check_tenant(name)?.rights)
    }
    /// Effective rights for discovery, without joining a prospective member.
    pub fn discovery_rights(
        &self,
        data: &SessionData,
        actor: &str,
        ceiling: &Authority,
        join: bool,
    ) -> Result<Authority> {
        let rights = data.recorded_rights(actor)?.unwrap_or_else(|| {
            if join {
                ceiling.clone()
            } else {
                Authority::default()
            }
        });
        self.limit_rights(
            data,
            ConnectionCeiling::for_discovery(&data.id, actor, rights.intersect(ceiling)),
        )
    }
    pub(super) fn limit_rights(
        &self,
        data: &SessionData,
        mut rights: Authority,
    ) -> Result<Authority> {
        if let Some(cap) = data
            .entries
            .iter()
            .rev()
            .find(|e| e.kind == "limit")
            .and_then(|e| e.content.as_ref())
            .and_then(|v| wire::optional(v, "rights"))
        {
            rights = rights.intersect(&serde_json::from_value(cap.clone())?);
        }
        if let Some(tenant) = data.tenant_id() {
            rights = rights.intersect(&self.check_tenant(tenant)?.rights);
        }
        if let Some(cap) = data.settings.get("_authority") {
            rights = rights.intersect(&serde_json::from_value(cap.clone())?);
        }
        if let Some(parent) = data.settings["_parent"]["session"].as_str() {
            let parent_actor = data.settings["_parent"]["actor"].as_str().unwrap_or("user");
            rights = rights.intersect(&self.authority(parent, parent_actor)?);
        }
        Ok(rights)
    }
    pub(super) fn check_tenant(&self, name: &str) -> Result<tenants::Tenant> {
        self.tenants
            .read()
            .unwrap()
            .get(name)
            .cloned()
            .ok_or_else(|| anyhow!("unknown tenant {name}"))
    }

    pub(super) fn tenant_info(&self, session: &str) -> Result<Value> {
        let data = self.snapshot(session)?;
        let Some(name) = tenants::name(&data) else {
            return Ok(json!({"tenant":null,"rights":null,"tokens":null}));
        };
        let tenant = self.check_tenant(name)?;
        let tokens = if let Some(budget) = tenant.tokens {
            let mut sessions = self.list(None)?;
            if !sessions.iter().any(|s| s.id == session) {
                sessions.push(data.clone());
            }
            let mut used = 0u64;
            for s in sessions.iter().filter(|s| tenants::name(s) == Some(name)) {
                used = used.saturating_add(tenants::used(s)?);
            }
            json!({"budget":budget,"used":used})
        } else {
            Value::Null
        };
        Ok(json!({"tenant":name,"rights":tenant.rights,"tokens":tokens}))
    }

    pub(super) fn actor_authority(&self, session: &str, actor: &str) -> Result<Authority> {
        let data = self.snapshot(session).or_else(|_| {
            self.store()
                .ok_or_else(|| anyhow!("session unavailable"))?
                .load(session)
        })?;
        if let Some(id) = actor.strip_prefix("job:") {
            let job = jobs(&data)?
                .into_iter()
                .find(|j| j.id == id)
                .ok_or_else(|| anyhow!("unknown job actor"))?;
            let mut origin = job.scope.clone();
            origin.job = None;
            let mut cap = job.authority.intersect(&work_authority(self, &origin)?);
            if let Some(child) = job.detail["child"].as_str() {
                cap = cap.intersect(&self.authority(child, "user")?);
            }
            return Ok(cap);
        }
        let rights = data.recorded_rights(actor)?.unwrap_or_else(|| {
            if actor == "user" {
                Authority::full()
            } else {
                Authority::default()
            }
        });
        self.limit_rights(&data, ConnectionCeiling::narrow(&data.id, actor, rights))
    }

    pub(super) fn grant_actor(
        &self,
        scope: &Scope,
        actor: &str,
        authority: Authority,
    ) -> Result<()> {
        require(self, scope, "grant")?;
        ensure!(!actor.starts_with("job:"), "reserved actor identity");
        ensure!(
            work_authority(self, scope)?
                .intersect(&Authority::full())
                .contains(&authority),
            "cannot grant more authority than actor has"
        );
        self.append(
            scope,
            "harness",
            Draft::new(
                "actor.grant",
                false,
                json!({"actor":actor,"authority":authority}),
            ),
        )?;
        Ok(())
    }
}
