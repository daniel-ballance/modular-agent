//! Read-only folds for session discovery and recovery. Nothing here opens a writer.
use crate::*;
use serde::Serialize;
use std::collections::BTreeSet;

pub fn unfinished_turns(branch: &[Entry]) -> impl Iterator<Item = &Scope> {
    let ended: BTreeSet<_> = branch
        .iter()
        .filter(|e| e.kind == "turn.end")
        .filter_map(|e| e.scope.turn.as_ref())
        .collect();
    branch
        .iter()
        .filter(move |e| {
            e.kind == "turn.start" && e.scope.turn.as_ref().is_some_and(|id| !ended.contains(id))
        })
        .map(|e| &e.scope)
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitingSummary {
    pub questions: usize,
    pub tool_calls: usize,
    pub turn: TurnState,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnState {
    None,
    Running,
    Interrupted,
}

impl SessionData {
    pub fn tenant_id(&self) -> Option<&str> {
        self.entries
            .iter()
            .find(|e| e.kind == "tenant")?
            .content
            .as_ref()?["tenant"]
            .as_str()
    }

    /// A departure is a recorded empty grant, not permission to join again.
    pub fn recorded_rights(&self, actor: &str) -> Result<Option<Authority>> {
        for e in self.entries.iter().rev() {
            let Some(v) = &e.content else { continue };
            if e.kind == "actor.grant" && v["actor"] == actor {
                return Ok(Some(serde_json::from_value(v["authority"].clone())?));
            }
            if e.kind == "actor.left" && v["actorId"] == actor {
                return Ok(Some(Authority::default()));
            }
        }
        Ok(None)
    }

    /// Count waits on the current branch for one connection. The Interface
    /// checks any delivery or presence requirement without offering a new view.
    pub fn waiting_summary(
        &self,
        rights: &Authority,
        actor: &str,
        route: Option<&str>,
        running: bool,
        eligible: impl Fn(&Question, bool) -> bool,
    ) -> Result<WaitingSummary> {
        let branch = self.branch();
        let unfinished: BTreeSet<_> = unfinished_turns(&branch)
            .filter_map(|s| s.turn.as_ref())
            .collect();
        let questions = questions_in(&branch)?
            .into_iter()
            .filter(|q| {
                q.answerable
                    && q.kind != RequestKind::Secret
                    && q.credential.is_none()
                    && q.route.contains(&self.id)
                    && rights.has(if q.kind == RequestKind::Approval {
                        "approve"
                    } else {
                        "answer"
                    })
                    && eligible(
                        q,
                        q.scope
                            .turn
                            .as_ref()
                            .is_some_and(|id| unfinished.contains(id)),
                    )
            })
            .count();

        let tool_calls = if let Some(route) = route.filter(|_| rights.has("tools")) {
            let settled: BTreeSet<_> = branch
                .iter()
                .filter(|e| e.kind == "tool.result")
                .filter_map(|e| e.scope.call.as_ref())
                .collect();
            branch
                .iter()
                .filter(|e| {
                    interface_handoff(e)
                        && e.scope
                            .call
                            .as_ref()
                            .is_some_and(|id| !settled.contains(id))
                        && e.content
                            .as_ref()
                            .is_some_and(|v| v["executorActorId"] == actor && v["routeId"] == route)
                })
                .count()
        } else {
            0
        };
        Ok(WaitingSummary {
            questions,
            tool_calls,
            turn: if unfinished.is_empty() {
                TurnState::None
            } else if running {
                TurnState::Running
            } else {
                TurnState::Interrupted
            },
        })
    }
}
