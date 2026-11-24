//! An approval is inherited from a running invocation, never from a start in history.
use agent_api::*;
use std::{collections::BTreeMap, sync::Mutex};

type Key = (String, String);
struct Active {
    scope: Scope,
    cover: ApprovalCover,
    live: CancellationToken,
}
#[derive(Default)]
pub(super) struct Dispatches(Mutex<BTreeMap<Key, Active>>);

fn parent<'a>(
    map: &'a BTreeMap<Key, Active>,
    scope: &Scope,
    call: &ToolCall,
) -> Option<&'a Active> {
    if call.started_by != "tool" {
        return None;
    }
    let id = call.extra["parentCallId"].as_str()?;
    let active = map.get(&(scope.session.clone(), id.into()))?;
    let mut expected = scope.clone();
    expected.call = Some(id.into());
    (active.scope == expected && !active.live.is_cancelled()).then_some(active)
}
impl super::Harness {
    pub(super) fn cover_is_current(
        &self,
        scope: &Scope,
        call: &ToolCall,
        cover: &ApprovalCover,
    ) -> Result<bool> {
        let data = self.snapshot(&scope.session)?;
        if data.settings.get("approval").is_some_and(|v| {
            !matches!(
                v.as_str(),
                Some("ask_always" | "ask_unless_read_only" | "off")
            )
        }) {
            return Ok(false);
        }
        if cover.tool_call_id != call.id {
            return Ok(self.live_covers.parent(scope, call).as_ref() == Some(cover));
        }
        // Bind the dispatch to the offered view, not just the ID returned by the gate.
        let Some(q) = questions(&data)?
            .into_iter()
            .find(|q| q.id == cover.request_id && q.covers_nested())
        else {
            return Ok(false);
        };
        if !wire::json_eq(&q.extra["approvalCall"], &wire::call(call, scope))
            || !q.answer.as_ref().is_some_and(|a| {
                !a.declined
                    && a.value == "allow"
                    && self
                        .authority(&a.session, &a.actor)
                        .is_ok_and(|rights| rights.has("approve"))
            })
        {
            return Ok(false);
        }
        Ok(self.capability_names("tools.").iter().any(|key| {
            wire::json_eq(&self.tool_registration(key), &q.extra["source"])
                && capability::<dyn ToolSource>(self, key).is_ok_and(|s| {
                    s.tools(&data).iter().any(|d| {
                        d.name == call.name
                            && wire::json_eq(
                                &wire::registered_definition(d),
                                &q.extra["definition"],
                            )
                    })
                })
        }))
    }
}
impl Dispatches {
    pub(super) fn parent(&self, scope: &Scope, call: &ToolCall) -> Option<ApprovalCover> {
        parent(&self.0.lock().unwrap(), scope, call).map(|p| p.cover.clone())
    }
    pub(super) fn begin(
        &self,
        scope: &Scope,
        call: &ToolCall,
        cover: ApprovalCover,
    ) -> Result<Dispatch<'_>> {
        let mut map = self.0.lock().unwrap();
        let live = if call.id == cover.tool_call_id && call.started_by != "tool" {
            CancellationToken::new()
        } else {
            parent(&map, scope, call)
                .filter(|p| p.cover == cover)
                .ok_or_else(|| anyhow!("the covering dispatch ended"))?
                .live
                .child_token()
        };
        let key = (scope.session.clone(), call.id.clone());
        ensure!(!map.contains_key(&key), "call is already running");
        map.insert(
            key.clone(),
            Active {
                scope: scope.clone(),
                cover,
                live,
            },
        );
        Ok(Dispatch(self, key))
    }
}
pub(super) struct Dispatch<'a>(&'a Dispatches, Key);
impl Drop for Dispatch<'_> {
    fn drop(&mut self) {
        if let Some(active) = self.0.0.lock().unwrap().remove(&self.1) {
            active.live.cancel();
        }
    }
}
