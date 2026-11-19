use agent_api::{Value, json};

const SECRET: &str = "conformance-secret";
const REDACTED: &str = "[redacted]";

pub fn redact(events: &Value) -> Value {
    let Some(events) = events.as_array() else {
        return json!({"block":true});
    };
    let mut output = events.clone();
    for (kind, field) in [
        ("text", "delta"),
        ("reasoning", "delta"),
        ("toolOutput", "chunk"),
    ] {
        let mut joined = String::new();
        let mut pieces = Vec::new();
        for (index, event) in events.iter().enumerate().filter(|(_, e)| e["type"] == kind) {
            if let Some(part) = event["data"][field].as_str() {
                joined.push_str(part);
                pieces.push((index, joined.len()));
            }
        }
        let mut rewritten = vec![String::new(); pieces.len()];
        let mut pos = 0;
        let mut part = 0;
        while pos < joined.len() {
            while pieces[part].1 <= pos {
                part += 1;
            }
            if joined[pos..].starts_with(SECRET) {
                rewritten[part].push_str(REDACTED);
                pos += SECRET.len();
            } else {
                let ch = joined[pos..].chars().next().unwrap();
                rewritten[part].push(ch);
                pos += ch.len_utf8();
            }
        }
        for ((index, _), value) in pieces.into_iter().zip(rewritten) {
            output[index]["data"][field] = json!(value);
        }
    }
    fn replace(v: &mut Value) {
        match v {
            Value::String(s) => *s = s.replace(SECRET, REDACTED),
            Value::Array(values) => values.iter_mut().for_each(replace),
            Value::Object(fields) => fields.values_mut().for_each(replace),
            _ => (),
        }
    }
    output
        .iter_mut()
        .for_each(|event| replace(&mut event["data"]));
    if *events == output {
        Value::Null
    } else {
        json!({"events":output})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn split_secret_is_removed_without_losing_events_or_unicode() {
        let value = redact(&json!([
            {"type":"text","data":{"delta":"é conformance-"}},
            {"type":"text","data":{"delta":"secret 🐈"}},
            {"type":"entry","data":{"text":"conformance-secret"}}
        ]));
        assert_eq!(
            value["events"],
            json!([
                {"type":"text","data":{"delta":"é [redacted]"}},
                {"type":"text","data":{"delta":" 🐈"}},
                {"type":"entry","data":{"text":"[redacted]"}}
            ])
        );
    }
}
