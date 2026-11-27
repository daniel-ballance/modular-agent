use super::*;
use std::{cmp::Reverse, collections::VecDeque, time::Instant};

type Boundary = (Reverse<u64>, String);
struct Cursor {
    token: String,
    client: String,
    boundary: Boundary,
    expires: Instant,
}
#[derive(Default)]
pub(super) struct Pages(VecDeque<Cursor>);
impl Pages {
    fn resolve(&self, client: &str, after: &str) -> R<Boundary> {
        self.0
            .iter()
            .find(|p| p.client == client && p.token == after && p.expires > Instant::now())
            .map(|p| p.boundary.clone())
            .ok_or(Fail::Invalid)
    }
    fn issue(&mut self, client: &str, boundary: Boundary) -> String {
        if self.0.len() == 1024 {
            self.0.pop_front();
        }
        let token = base::id();
        self.0.push_back(Cursor {
            token: token.clone(),
            client: client.into(),
            boundary,
            expires: Instant::now() + Duration::from_secs(300),
        });
        token
    }
}

impl Service {
    fn thread_row(&self, a: &AguiActor, d: &SessionData) -> R<Option<Value>> {
        let c = self
            .routes
            .lock()
            .unwrap()
            .clients
            .get(&(d.id.clone(), a.client_id.clone()))
            .cloned();
        let viewer = crate::SessionViewer {
            actor: a.id(),
            rights: &a.principal.actor.rights,
            route_id: Some(&a.client_id),
            join_on_open: a.join_on_open
                && (self.agent.inner.several_actors || base::actors(d).is_empty()),
            scope: &|project, tenant| {
                project == self.agent.inner.project
                    && tenant == self.tenant.as_deref()
                    && a.allows(project, tenant)
            },
            in_turn: &|id, _approval| {
                c.as_ref().is_some_and(|c| {
                    let route = c.presence.lock().unwrap();
                    route.is_some() && c.questions.lock().unwrap().get(id) == Some(&*route)
                })
            },
        };
        let Some(row) = self.agent.session_summary_from(
            &self.agent.inner.history,
            d,
            &viewer,
            self.acp_open.is_running(&d.id),
        )?
        else {
            return Ok(None);
        };
        let updated = view::iso(row.updated_at).ok_or(Fail::Lost)?;
        Ok(Some(
            json!({"threadId": row.id, "updatedAt": updated, "waiting": row.waiting}),
        ))
    }

    pub(super) async fn list_threads(&self, a: &AguiActor, query: Option<&str>) -> R<Response> {
        let (mut after, mut limit) = (None, None);
        for (key, value) in form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
            match key.as_ref() {
                "after" if after.is_none() => {
                    after = Some(self.pages.lock().unwrap().resolve(&a.client_id, &value)?)
                }
                "limit" if limit.is_none() && value.bytes().all(|b| b.is_ascii_digit()) => {
                    limit = Some(
                        value
                            .parse::<usize>()
                            .ok()
                            .filter(|n| (1..=500).contains(n))
                            .ok_or(Fail::Invalid)?,
                    );
                }
                _ => return Err(Fail::Invalid),
            }
        }
        let limit = limit.unwrap_or(100);
        let mut threads = Vec::new();
        let mut boundary = None;
        let mut next = None;
        let history = &self.agent.inner.history.0;
        if self.agent.inner.persistent
            && a.principal.actor.rights.has("watch")
            && a.allows(&self.agent.inner.project, self.tenant.as_deref())
        {
            let mut candidates: Vec<_> = history
                .list(Some(&self.agent.inner.project))?
                .into_iter()
                .map(|d| {
                    (
                        (Reverse(d.entries.last().map_or(0, |e| e.at)), d.id.clone()),
                        d,
                    )
                })
                .collect();
            candidates.sort_unstable_by(|l, r| l.0.cmp(&r.0));
            for (key, d) in candidates {
                if after.as_ref().is_some_and(|v| key <= *v) {
                    continue;
                }
                if let Some(row) = self.thread_row(a, &d)? {
                    if threads.len() == limit {
                        next = boundary.map(|b| self.pages.lock().unwrap().issue(&a.client_id, b));
                        break;
                    }
                    threads.push(row);
                    boundary = Some(key);
                }
            }
        }
        let mut page = json!({"threads": threads});
        if let Some(next) = next {
            page["next"] = json!(next);
        }
        // This gate may wait. Do not send a previously authorized count after a
        // departure, a narrower grant, a lost answer route or a pending erasure.
        if self.gate(a, "", page.clone()).await? != page {
            return Err(Fail::Withheld);
        }
        page["threads"].as_array_mut().unwrap().retain(|row| {
            row["threadId"]
                .as_str()
                .and_then(|id| history.inspect(id).ok())
                .and_then(|d| self.thread_row(a, &d).ok().flatten())
                .is_some_and(|fresh| fresh["waiting"] == row["waiting"])
        });
        Ok(reply(200, "application/json", Body::from(encode(&page)?)))
    }
}
