use super::{Harness, waiting_approvals};
use agent_api::*;
use std::sync::Arc;

/// A question alone does not show that its invocation stopped. Use only the
/// pending record for this call, its cited questions, and its start (if any).
pub(super) fn pending_questions(branch: &[Entry], call: &Entry) -> bool {
    let Some((index, pending)) = branch
        .iter()
        .enumerate()
        .rev()
        .find(|(_, p)| p.kind == "tool.pending" && p.scope.call == call.scope.call)
    else {
        return false;
    };
    let Some(proof) = &pending.content else {
        return false;
    };
    if pending.scope.turn != call.scope.turn
        || pending.scope.step != call.scope.step
        || pending.scope.session != call.scope.session
    {
        return false;
    }
    let same_call = |e: &Entry| {
        e.scope.turn == pending.scope.turn
            && e.scope.step == pending.scope.step
            && e.scope.call == pending.scope.call
            && e.scope.session == pending.scope.session
    };
    let before = &branch[..index];
    let start = before
        .iter()
        .rev()
        .find(|e| e.kind == "tool.started" && same_call(e));
    if start.is_some_and(|e| e.content.is_none())
        || proof.get("toolStartedId") != start.map(|e| &e.id).map(|id| json!(id)).as_ref()
    {
        return false;
    }
    proof["requestIds"].as_array().is_some_and(|ids| {
        !ids.is_empty()
            && ids.iter().all(|id| {
                id.is_string()
                    && before.iter().any(|e| {
                        e.kind == "request.open"
                            && same_call(e)
                            && e.content.as_ref().is_some_and(|q| q["id"] == *id)
                    })
            })
    })
}

pub(super) fn next_continuation(data: &SessionData) -> Result<Option<(Input, Vec<ToolCall>)>> {
    let branch = data.branch();
    let qs = questions(data)?;
    let mut resume = vec![];
    for e in branch.iter().filter(|e| e.kind == "tool.call") {
        if branch.iter().any(|r| {
            (interface_handoff(r) || waiting_approvals::marked(r)) && r.scope.turn == e.scope.turn
        }) || branch
            .iter()
            .any(|r| r.kind == "tool.result" && r.scope.call == e.scope.call)
        {
            continue;
        }
        let ended = e.scope.turn.is_none()
            || branch.iter().any(|r| {
                r.kind == "turn.end"
                    && r.scope.turn == e.scope.turn
                    && r.content.as_ref().is_some_and(|v| {
                        v["open_calls"].as_array().is_some_and(|a| {
                            a.iter().any(|c| {
                                Some(c["id"].as_str().unwrap_or("")) == e.scope.call.as_deref()
                            })
                        })
                    })
            });
        let related: Vec<_> = qs.iter().filter(|q| q.scope.call == e.scope.call).collect();
        if ended
            && pending_questions(&branch, e)
            && !related.is_empty()
            && related.iter().all(|q| !q.answerable)
            && related.iter().any(|q| q.answer.is_some())
        {
            resume.push(serde_json::from_value::<ToolCall>(
                e.content
                    .clone()
                    .ok_or_else(|| anyhow!("erased open call"))?,
            )?);
        }
    }
    let ready: std::collections::BTreeSet<_> = resume.iter().map(|c| c.id.clone()).collect();
    resume.retain(|call| {
        let source = branch
            .iter()
            .find(|e| e.kind == "tool.call" && e.scope.call.as_ref() == Some(&call.id))
            .unwrap();
        source.scope.turn.is_none()
            || branch
                .iter()
                .filter(|e| e.kind == "tool.call" && e.scope.turn == source.scope.turn)
                .all(|e| {
                    branch
                        .iter()
                        .any(|r| r.kind == "tool.result" && r.scope.call == e.scope.call)
                        || e.scope.call.as_ref().is_some_and(|id| ready.contains(id))
                })
    });
    if let Some(first) = resume.first() {
        let first = first.id.clone();
        let origin = branch
            .iter()
            .find(|e| e.kind == "tool.call" && e.scope.call.as_ref() == Some(&first))
            .unwrap()
            .scope
            .turn
            .clone();
        resume.retain(|c| {
            if origin.is_none() {
                c.id == first
            } else {
                branch.iter().any(|e| {
                    e.kind == "tool.call"
                        && e.scope.call.as_ref() == Some(&c.id)
                        && e.scope.turn == origin
                })
            }
        });
    }
    let Some(first) = resume.first() else {
        return Ok(None);
    };
    let source = branch
        .iter()
        .find(|e| e.kind == "tool.call" && e.scope.call.as_ref() == Some(&first.id))
        .unwrap();
    let input = Input {
        id: source.id.clone(),
        actor: source.scope.actor.clone(),
        text: "Continue after the answered input requests.".into(),
        timing: Timing::Now,
        key: None,
    };
    Ok(Some((input, resume)))
}

impl Harness {
    /// Subscribe before committing a report or answer. This signal carries no
    /// output and names no other origin.
    pub fn watch_continuation(&self, id: &str, origin: &str) -> Result<Arc<CancellationToken>> {
        let mut sessions = self.sessions.lock().unwrap();
        let open = sessions
            .get_mut(id)
            .ok_or_else(|| anyhow!("session not open"))?;
        open.continuation_waiters
            .retain(|_, w| w.strong_count() > 0);
        let slot = open
            .continuation_waiters
            .entry(origin.to_owned())
            .or_default();
        if let Some(existing) = slot.upgrade() {
            return Ok(existing);
        }
        let signal = Arc::new(CancellationToken::new());
        *slot = Arc::downgrade(&signal);
        Ok(signal)
    }
}
