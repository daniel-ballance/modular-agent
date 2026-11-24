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
