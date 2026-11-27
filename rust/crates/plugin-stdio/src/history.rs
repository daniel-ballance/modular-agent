//! Raw history pages over the plugin binding.
use crate::rpc::Fault;
use agent_api::{portable, wire, *};
use std::collections::BTreeSet;

#[derive(Default)]
struct Selector<'a> {
    turn: Option<&'a str>,
    calls: BTreeSet<&'a str>,
}

impl<'a> Selector<'a> {
    fn parse(value: &'a Value, agreed: bool) -> Result<Self> {
        ensure!(agreed, "history selectors were not negotiated");
        let object = value
            .as_object()
            .ok_or_else(|| anyhow!("select must be an object"))?;
        ensure!(
            !object.is_empty()
                && object
                    .keys()
                    .all(|k| matches!(k.as_str(), "turnId" | "toolCallIds")),
            "select must contain turnId or toolCallIds"
        );
        let turn = object.get("turnId").map(selector_id).transpose()?;
        let mut calls = BTreeSet::new();
        if let Some(ids) = object.get("toolCallIds") {
            let ids = ids
                .as_array()
                .filter(|a| (1..=64).contains(&a.len()))
                .ok_or_else(|| anyhow!("toolCallIds must contain 1 to 64 IDs"))?;
            for id in ids {
                ensure!(calls.insert(selector_id(id)?), "duplicate toolCallId");
            }
        }
        Ok(Self { turn, calls })
    }

    fn matches(&self, entry: &Entry) -> bool {
        self.turn
            .is_some_and(|turn| entry.scope.turn.as_deref() == Some(turn))
            || entry
                .scope
                .call
                .as_deref()
                .is_some_and(|call| self.calls.contains(call))
    }
}

fn selector_id(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| anyhow!("selector IDs must be nonempty strings"))
}

fn read_fault(error: anyhow::Error) -> Fault {
    if error.is::<SessionNotOpen>()
        || matches!(
            error.downcast_ref::<OperationError>(),
            Some(OperationError::Forbidden(_))
        )
    {
        Fault::new("invalid_request", error)
    } else {
        Fault::new(
            "internal",
            "History freshness or read rights could not be established",
        )
    }
}

pub(crate) fn page(
    api: &dyn AgentApi,
    scope: &Scope,
    params: &Value,
    agreed: bool,
) -> Result<Value> {
    require(api, scope, "watch").map_err(read_fault)?;
    let data = api.snapshot(&scope.session).map_err(read_fault)?;
    let selector = params
        .get("select")
        .map(|value| Selector::parse(value, agreed))
        .transpose()?;
    let mut entries = if params["all"] == true {
        data.entries.clone()
    } else {
        data.branch()
    };
    entries
        .retain(|e| e.writer != "rust.derived" && selector.as_ref().is_none_or(|s| s.matches(e)));
    let start = if params
        .get("after")
        .is_some_and(|v| selector.is_some() || !v.is_null())
    {
        let after = wire::string(params, "after")?;
        entries
            .iter()
            .position(|e| e.id == after)
            .ok_or_else(|| anyhow!("unknown history cursor"))?
            + 1
    } else {
        0
    };
    let limit = match wire::optional(params, "limit") {
        None => 500,
        Some(v) => v
            .as_u64()
            .filter(|n| (1..=500).contains(n))
            .ok_or_else(|| anyhow!("limit must be an integer from 1 to 500"))?
            as usize,
    };
    ensure!(
        wire::optional(params, "all").is_none_or(Value::is_boolean),
        "all must be a boolean"
    );
    let mut page = Vec::new();
    let mut size = b"{\"entries\":[]}".len();
    for (i, e) in entries.iter().enumerate().skip(start).take(limit) {
        let mut value = wire::entry(e, &data)?;
        portable::omit_trace_metadata(&mut value);
        let total = size + serde_json::to_vec(&value)?.len() + usize::from(!page.is_empty());
        let cursor_size = if i + 1 < entries.len() {
            b",\"next\":".len() + serde_json::to_vec(&e.id)?.len()
        } else {
            0
        };
        if total + cursor_size > 4 * 1024 * 1024 {
            if page.is_empty() {
                return Err(Fault::new(
                    "result_too_large",
                    "One entry and its cursor do not fit in a page",
                )
                .into());
            }
            break;
        }
        size = total;
        page.push(value);
    }
    let next = page
        .last()
        .filter(|_| start + page.len() < entries.len())
        .map(|v| v["id"].clone());
    let mut result = json!({"entries":page});
    if let Some(next) = next {
        result["next"] = next;
    }
    Ok(result)
}
