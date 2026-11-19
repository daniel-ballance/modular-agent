//! Shared checkpoint rules for the Runtime and its host.
use crate::*;

pub const STEP_AFTER: &str = "modular-agent.stepAfter";

pub fn is_auxiliary_response(response: &Value, history: &[Value]) -> bool {
    history.iter().any(|entry| {
        entry["kind"] == "modelRequest"
            && entry["stepId"] == response["stepId"]
            && entry["data"]["auxiliary"] == true
    })
}

pub fn last_answered_step(history: &[Value]) -> Result<Option<(&Value, Value)>> {
    let Some(response) = history.iter().rev().find(|e| {
        e["kind"] == "response"
            && e["data"]["recovery"] != true
            && !is_auxiliary_response(e, history)
    }) else {
        return Ok(None);
    };
    ensure!(
        response["erased"] != true && response["message"]["role"] == "assistant",
        "last answered response is unavailable"
    );
    let step = wire::string(response, "stepId")?;
    let decision = checkpoint_decision(history, step)?;
    let mut resumed = json!({"stepId":step});
    if let Some(decision) = decision {
        resumed["decision"] = decision;
    }
    Ok(Some((response, resumed)))
}

/// None means a complete checkpoint proves that the gate is due.
pub fn checkpoint_decision(history: &[Value], step: &str) -> Result<Option<Value>> {
    let mut decisions = history
        .iter()
        .filter(|e| e["kind"] == STEP_AFTER && e["stepId"] == step);
    if let Some(record) = decisions.next() {
        ensure!(decisions.next().is_none(), "duplicate step.after decision");
        let decision = record["data"]
            .get("decision")
            .ok_or_else(|| anyhow!("step.after decision is unavailable"))?;
        ensure!(
            record["erased"] != true
                && (decision.is_null()
                    || decision
                        .as_object()
                        .is_some_and(|d| d.len() == 1 && d["refuse"].is_string())),
            "invalid step.after decision"
        );
        return Ok(Some(decision.clone()));
    }
    ensure!(
        history.iter().any(|e| e["kind"] == "modelRequest"
            && e["stepId"] == step
            && e["erased"] != true
            && e["data"]["tracksStepAfter"] == true),
        "cannot establish step.after state"
    );
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_state_distinguishes_due_allowed_refused_and_unknown() {
        let mut log = vec![
            json!({"kind":"modelRequest","stepId":"s","data":{"tracksStepAfter":true}}),
            json!({"kind":"response","stepId":"s","message":{"role":"assistant"}}),
            json!({"kind":"response","stepId":"abort","data":{"recovery":true}}),
        ];
        assert_eq!(
            last_answered_step(&log).unwrap().unwrap().1,
            json!({"stepId":"s"})
        );
        log.push(json!({"kind":STEP_AFTER,"stepId":"s","data":{"decision":null}}));
        assert_eq!(
            last_answered_step(&log).unwrap().unwrap().1,
            json!({"stepId":"s","decision":null})
        );
        log[3]["data"]["decision"] = json!({"refuse":"stop"});
        assert_eq!(
            last_answered_step(&log).unwrap().unwrap().1["decision"],
            json!({"refuse":"stop"})
        );
        log[3] = json!({"kind":STEP_AFTER,"stepId":"s","erased":true});
        assert!(last_answered_step(&log).is_err());
        log.pop();
        log[0]["data"] = json!({});
        assert!(last_answered_step(&log).is_err());
        log[1] = json!({"kind":"response","stepId":"s","erased":true});
        assert!(last_answered_step(&log).is_err());
    }
}
