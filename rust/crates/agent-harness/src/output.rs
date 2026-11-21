use agent_api::*;

/// Apply only the gate's string edits. Keep the original representation of
/// everything else so a numeric echo cannot trigger a reverse translation.
pub fn apply_redactions(before: &mut Value, after: &Value) -> bool {
    match (before, after) {
        (Value::String(a), Value::String(b)) => {
            a.clone_from(b);
            true
        }
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter_mut().zip(b).all(|(a, b)| apply_redactions(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter_mut().all(|(k, v)| {
                    b.get(k).is_some_and(|w| {
                        if matches!(
                            k.as_str(),
                            "type" | "kind" | "status" | "method" | "stop" | "id"
                        ) || k.ends_with("Id")
                            || k.ends_with("Ids")
                        {
                            v == w
                        } else {
                            apply_redactions(v, w)
                        }
                    })
                })
        }
        (Value::Number(a), Value::Number(b)) => {
            a == b || equal_decimal(&a.to_string(), &b.to_string())
        }
        (a, b) => a == b,
    }
}

fn equal_decimal(a: &str, b: &str) -> bool {
    let (negative_a, digits_a, exponent_a, offset_a) = decimal(a);
    let (negative_b, digits_b, exponent_b, offset_b) = decimal(b);
    negative_a == negative_b
        && digits_a == digits_b
        && (digits_a.is_empty() || equal_scale(exponent_a, exponent_b, offset_b - offset_a))
}

/// Sign, significant digits, and scale (the written exponent plus an offset).
/// Comparing the original digits avoids rounding different numbers together.
fn decimal(number: &str) -> (bool, String, &str, i128) {
    let (negative, unsigned) = match number.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, number),
    };
    let (mantissa, exponent) = unsigned.split_once(['e', 'E']).unwrap_or((unsigned, "0"));
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = format!("{whole}{fraction}");
    let significant = digits.trim_matches('0');
    if significant.is_empty() {
        return (false, String::new(), "0", 0);
    }
    let trailing = digits.len() - digits.trim_end_matches('0').len();
    (
        negative,
        significant.to_owned(),
        exponent,
        trailing as i128 - fraction.len() as i128,
    )
}

fn exponent_digits(exponent: &str) -> impl Iterator<Item = i128> + '_ {
    let sign = if exponent.starts_with('-') { -1 } else { 1 };
    exponent
        .trim_start_matches(['+', '-'])
        .bytes()
        .rev()
        .map(move |digit| sign * i128::from(digit - b'0'))
}

fn equal_scale(a: &str, b: &str, mut difference: i128) -> bool {
    // Subtract the expected difference one digit at a time, so even a very
    // large written exponent does not need to fit in a machine integer.
    let (mut a, mut b) = (exponent_digits(a), exponent_digits(b));
    loop {
        match (a.next(), b.next()) {
            (None, None) => return difference == 0,
            (a, b) => {
                difference -= a.unwrap_or(0) - b.unwrap_or(0);
                if difference % 10 != 0 {
                    return false;
                }
                difference /= 10;
            }
        }
    }
}

/// Only copy fields that changed between the two native projections. A
/// single-entry projection cannot fill in fields that depend on the rest of
/// the session, such as the turn's step count.
fn overlay_projection(original: &mut Value, before: &Value, after: &Value) {
    if before == after {
        return;
    }
    match (original, before, after) {
        (Value::Object(original), Value::Object(before), Value::Object(after)) => {
            for (key, value) in original.iter_mut() {
                if let (Some(old), Some(new)) = (before.get(key), after.get(key)) {
                    overlay_projection(value, old, new);
                }
            }
        }
        (Value::Array(original), Value::Array(before), Value::Array(after))
            if original.len() == before.len() && before.len() == after.len() =>
        {
            for ((item, old), new) in original.iter_mut().zip(before).zip(after) {
                overlay_projection(item, old, new);
            }
        }
        (original, _, after) => *original = after.clone(),
    }
}

pub fn encode(event: &Event, api: &dyn AgentApi) -> Result<Value> {
    let c = &event.content;
    let s = &event.scope;
    let (kind, data) = match event.kind.as_str() {
        "session.interrupted" => ("sessionInterrupted", event.content.clone()),
        "model.delta" | "model.thought" => {
            let mut data = json!({"delta":c});
            if let Some(step) = &s.step {
                data["stepId"] = json!(step);
            }
            (
                if event.kind == "model.delta" {
                    "text"
                } else {
                    "reasoning"
                },
                data,
            )
        }
        "tool.requested" | "tool.started" => (
            "toolCall",
            json!({"call":wire::call(&serde_json::from_value(c.clone())?, s)}),
        ),
        "tool.progress" if s.call.is_some() && c.is_string() => {
            ("toolOutput", json!({"toolCallId":s.call,"chunk":c}))
        }
        "tool.ended" => {
            let r = wire::result(&serde_json::from_value(c.clone())?);
            (
                "toolResult",
                json!({"toolCallId":r["callId"],"status":r["status"],"content":r["content"]}),
            )
        }
        "turn.result" | "turn.end" => {
            let mut d = wire::turn_outcome(&serde_json::from_value(c.clone())?);
            d["turnId"] = json!(s.turn);
            ("turnEnded", d)
        }
        "history.entry" => (
            "entry",
            json!({"entry":wire::public_entry(&serde_json::from_value(c.clone())?, &api.snapshot(&s.session)?)?}),
        ),
        k => {
            return Ok(
                json!({"type":if k.contains('.') {k.to_owned()} else {format!("rust.{k}")},"data":c}),
            );
        }
    };
    Ok(json!({"type":kind,"data":data}))
}

fn entry_projection(wire: &Value, original: &Value, session: &str) -> Result<Value> {
    // This projection is for field names and shapes, not a reconstruction
    // of the recorded session.
    let rebuilt = portable::session(
        &json!({"id":wire["sessionId"].as_str().unwrap_or(session), "project":""}),
        std::slice::from_ref(wire),
    )?;
    let mut mapped = json!(
        rebuilt
            .entries
            .into_iter()
            .find(|e| e.id == wire["id"])
            .ok_or_else(|| anyhow!("cannot map changed history entry"))?
    );
    if original["kind"] == "runtime.private"
        && original["content"]["kind"]
            .as_str()
            .is_some_and(|kind| kind.contains('.'))
    {
        // A Runtime's own kind is an opaque envelope in a live entry.
        // Portable reopening may know it as a native kind, but the view
        // must redact the envelope we have, not reinterpret it.
        mapped["content"] = wire.clone();
        return Ok(mapped);
    }
    match wire["kind"].as_str().unwrap_or_default() {
        "actorJoined" if original["kind"] == "actor.identity" => {
            mapped["content"]["id"] = mapped["content"]["actor"].take();
        }
        "toolResult" => {
            // The portable reader wraps this value for future model requests.
            // Here it was sent from the existing native entry as-is.
            mapped["content"]["value"] = wire["data"]["value"].clone();
        }
        "turnEnd" => {
            // Only call ids are on the wire. Keep the rest of each call.
            mapped["content"]["open_calls"] = json!(
                wire["data"]["result"]["openToolCalls"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|id| json!({"id":id}))
                    .collect::<Vec<_>>()
            );
        }
        _ => (),
    }
    Ok(mapped)
}

pub fn decode(mut event: Event, before: &Value, after: &Value) -> Result<Event> {
    if before == after {
        return Ok(event);
    }
    // The wire answer has already been checked and applied to a copy of before.
    let d = &after["data"];
    match after["type"].as_str().unwrap_or_default() {
        "text" | "reasoning" => event.content = d["delta"].clone(),
        "toolCall" => {
            let c = &d["call"];
            event.content["id"] = c["id"].clone();
            event.content["name"] = c["name"].clone();
            event.content["input"] = c["input"].clone();
            event.content["started_by"] = c["startedBy"].clone();
            if !event.content["extra"].is_null() {
                event.content["extra"] = c.clone();
            }
        }
        "toolOutput" => {
            event.scope.call = d["toolCallId"].as_str().map(str::to_owned);
            event.content = d["chunk"].clone();
        }
        "toolResult" => {
            let mut r = serde_json::from_value::<ToolResult>(event.content.clone())?;
            let status =
                wire::parse_result(d.clone(), d["toolCallId"].as_str().unwrap_or_default())?.status;
            r.call = d["toolCallId"].as_str().unwrap_or_default().to_owned();
            r.status = status;
            r.text = wire::text(&d["content"]);
            if let Some(w) = r.value.as_mut().and_then(|v| v.get_mut("_pluginWire")) {
                w["content"] = d["content"].clone();
                w["callId"] = d["toolCallId"].clone();
                w["status"] = d["status"].clone();
            }
            event.content = json!(r);
        }
        "turnEnded" => {
            let mut r: TurnResult = serde_json::from_value(event.content.clone())?;
            let mapped = wire::parse_outcome(&d["outcome"], &d["result"], &Value::Null)?;
            r.outcome = mapped.outcome;
            r.error = mapped.error;
            r.limit = mapped.limit;
            r.text = mapped.text;
            r.value = mapped.value;
            for (call, id) in r
                .open_calls
                .iter_mut()
                .zip(d["result"]["openToolCalls"].as_array().unwrap())
            {
                call.id = id.as_str().unwrap().to_owned();
            }
            event.content = json!(r);
        }
        "entry" => {
            let before = &before["data"]["entry"];
            let after = &d["entry"];
            ensure!(
                before["kind"] == after["kind"],
                "changed history kind cannot be mapped back"
            );
            let old = entry_projection(before, &event.content, &event.scope.session)?;
            let new = entry_projection(after, &event.content, &event.scope.session)?;
            ensure!(
                old["kind"] == new["kind"],
                "changed history variant cannot be mapped back"
            );
            overlay_projection(&mut event.content, &old, &new);
            if event.content["kind"] == "job.end" {
                let (before, after) = (&before["data"], &after["data"]);
                let content = &mut event.content["content"];
                // Native jobs derive these shared fields from the result.
                if content.get("wireResult").is_none() && before["result"] != after["result"] {
                    content["result"]["text"] = json!(wire::text(&after["result"]));
                }
                if content.get("wireOutcome").is_none()
                    && before["outcome"]["error"] != after["outcome"]["error"]
                {
                    content["result"]["error"] = after["outcome"]["error"].clone();
                }
            }
        }
        _ => event.content = d.clone(),
    }
    Ok(event)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_spelling_does_not_count_as_a_gate_edit() {
        for (a, b) in [
            ("0.0", "0"),
            ("-0", "0e9"),
            ("-120.0e-2", "-1.2"),
            ("9007199254740993.0", "9007199254740993"),
            (
                "0.01e1000000000000000000000000000000000000000",
                "1e999999999999999999999999999999999999998",
            ),
        ] {
            let original: Value = serde_json::from_str(a).unwrap();
            let mut returned = original.clone();
            assert!(
                apply_redactions(&mut returned, &serde_json::from_str(b).unwrap()),
                "{a} and {b}"
            );
            assert_eq!(returned, original);
        }
    }

    #[test]
    fn redacted_runtime_entry_remains_an_opaque_entry() {
        let entry = json!({"id":"e","kind":"rust.custom","data":{"detail":"canary"}});
        let event = Event::new(
            &Scope::session("s"),
            "history.entry",
            json!({"kind":"runtime.private","content":entry}),
        );
        let before = json!({"type":"entry","data":{"entry":entry}});
        let mut after = before.clone();
        after["data"]["entry"]["data"]["detail"] = json!("[redacted]");
        let view = decode(event, &before, &after).unwrap();
        assert_eq!(
            view.content,
            json!({"kind":"runtime.private","content":after["data"]["entry"]})
        );
    }

    #[test]
    fn a_gate_cannot_change_numbers_or_structure() {
        for (a, b) in [
            ("9007199254740993", "9007199254740992.0"),
            ("1.00000000000000001", "1"),
            ("1.0", r#""1""#),
            (r#"{"a":"text"}"#, r#"{"b":"text"}"#),
            ("[false]", "[true]"),
            ("[1]", "[1,2]"),
        ] {
            assert!(
                !apply_redactions(
                    &mut serde_json::from_str(a).unwrap(),
                    &serde_json::from_str(b).unwrap()
                ),
                "{a} and {b}"
            );
        }
    }
}
