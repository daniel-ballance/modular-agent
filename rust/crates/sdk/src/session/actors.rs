use super::*;

impl Session {
    pub(super) fn check_actor_option(&self) -> Result<()> {
        if !self.inner.several_actors {
            return Err(Error::new(
                Code::NotSupported,
                "several actors are disabled",
            ));
        }
        Ok(())
    }

    /// Act for another session member. The local principal remains the sponsor.
    pub fn r#as(&self, actor_id: &str) -> Result<Self> {
        if actor_id != LOCAL {
            self.check_actor_option()?;
            if !base::actors(&self.inner.harness.authority_snapshot(&self.id)?)
                .contains_key(actor_id)
            {
                return Err(Error::new(Code::NotFound, "unknown actor"));
            }
        }
        Ok(Self {
            actor: actor_id.into(),
            approval_route: PollHandle::new(&self.inner, &self.id),
            ..self.clone()
        })
    }

    pub async fn join(&self, actor: Actor) -> Result<()> {
        self.join_with(actor, None).await
    }

    pub async fn join_with(&self, actor: Actor, granted_by: Option<&str>) -> Result<()> {
        self.check_actor_option()?;
        let who = match granted_by {
            Some(id) => self.r#as(id)?,
            None => self.clone(),
        };
        who.require("grant")?;
        if actor.id.is_empty()
            || actor.id.starts_with("job:")
            || actor.id == LOCAL
            || actor.id == base::ACP_HOST_ACTOR
            || !matches!(actor.kind.as_str(), "user" | "host" | "agent" | "plugin")
            || !Rights::full().contains(&actor.rights)
        {
            return Err(Error::new(
                Code::InvalidParams,
                "invalid actor identity, kind or rights",
            ));
        }
        let h = self.inner.harness.as_ref();
        if !h
            .authority(&self.id, &who.actor)?
            .intersect(&h.authority(&self.id, LOCAL)?)
            .contains(&actor.rights)
        {
            return Err(Error::new(
                Code::Forbidden,
                "cannot grant a right you do not have",
            ));
        }
        h.append(&who.scope(), "interface.sdk", base::Draft::new("actor.grant", false,
            json!({"actor":actor.id,"kind":actor.kind,"authority":actor.rights,"sponsor":LOCAL})))?;
        base::requests(h)?.presence(&self.id, &actor.id, true);
        h.emit(base::Event::new(
            &who.scope(),
            "actor.joined",
            json!({"actorId":actor.id}),
        ))
        .await?;
        Ok(())
    }

    pub async fn leave(&self, actor_id: &str) -> Result<()> {
        self.check_actor_option()?;
        let data = self.inner.harness.authority_snapshot(&self.id)?;
        if actor_id != self.actor {
            self.require("grant")?;
        }
        if !base::actors(&data).contains_key(actor_id) || actor_id == LOCAL {
            return Err(Error::new(Code::NotFound, "unknown actor"));
        }
        let h = self.inner.harness.as_ref();
        h.append(
            &self.scope(),
            "interface.sdk",
            base::Draft::new(
                "actor.left",
                false,
                json!({"actorId":actor_id,"sponsor":LOCAL}),
            ),
        )?;
        base::requests(h)?.presence(&self.id, actor_id, false);
        h.emit(base::Event::new(
            &self.scope(),
            "actor.left",
            json!({"actorId":actor_id}),
        ))
        .await?;
        Ok(())
    }

    pub fn set_limit(&self, rights: Option<Rights>) -> Result<()> {
        if !self.inner.session_limits {
            return Err(Error::new(
                Code::NotSupported,
                "session limits are disabled",
            ));
        }
        self.require("administer")?;
        let h = self.inner.harness.as_ref();
        if let Some(rights) = &rights
            && !Rights::full()
                .intersect(&h.authority(&self.id, &self.actor)?)
                .intersect(&h.authority(&self.id, LOCAL)?)
                .contains(rights)
        {
            return Err(Error::new(
                Code::Forbidden,
                "cannot grant a right you do not have",
            ));
        }
        h.append(
            &self.scope(),
            "interface.sdk",
            base::Draft::new("limit", false, json!({"rights":rights,"sponsor":LOCAL})),
        )?;
        Ok(())
    }
}
