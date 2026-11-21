//! Values crossing the sandbox boundary, as JSON on the agent's side.
use monty_types::{MontyObject, ObjectRef};
use serde_json::{Value, json};

pub fn to_python(value: &Value) -> MontyObject {
    match value {
        Value::Null => MontyObject::none(),
        Value::Bool(b) => MontyObject::bool(*b),
        Value::Number(n) => match n.as_i64() {
            Some(i) => MontyObject::int(i),
            None => MontyObject::float(n.as_f64().unwrap_or(f64::NAN)),
        },
        Value::String(s) => MontyObject::string(s.as_str()),
        Value::Array(items) => MontyObject::list(items.iter().map(to_python)),
        Value::Object(map) => MontyObject::dict(
            map.iter()
                .map(|(k, v)| (MontyObject::string(k.as_str()), to_python(v))),
        ),
    }
}

/// JSON has fewer types than Python. Sequences become arrays, keys become
/// strings, and anything without a JSON form becomes its `repr`.
pub fn to_json(value: ObjectRef<'_>) -> Value {
    if let Some(b) = value.as_bool() {
        return json!(b);
    }
    if let Some(i) = value.as_int() {
        return json!(i);
    }
    if value.type_name() == "int"
        && let Ok(number) = value.py_repr().parse::<serde_json::Number>()
    {
        return Value::Number(number);
    }
    if let Some(f) = value.as_float() {
        return serde_json::Number::from_f64(f)
            .map_or_else(|| json!(value.py_repr()), Value::Number);
    }
    if let Some(s) = value.as_str() {
        return json!(s);
    }
    match value.type_name() {
        "NoneType" => Value::Null,
        "dict" => match value.pairs() {
            Some(pairs) => Value::Object(
                pairs
                    .into_iter()
                    .map(|(k, v)| {
                        let key = k.as_str().map(str::to_owned).unwrap_or_else(|| k.py_repr());
                        (key, to_json(v))
                    })
                    .collect(),
            ),
            None => json!(value.py_repr()),
        },
        "list" | "tuple" | "set" | "frozenset" => match value.items() {
            Some(items) => Value::Array(items.into_iter().map(to_json).collect()),
            None => json!(value.py_repr()),
        },
        _ => json!(value.py_repr()),
    }
}

pub(super) fn image(value: ObjectRef<'_>, text: &mut String) -> Option<Value> {
    if value.type_name() != "dict" {
        return None;
    }
    let fields = value.pairs()?;
    let field = |name| {
        fields
            .iter()
            .find_map(|(k, v)| (k.as_str() == Some(name)).then(|| v.as_str()).flatten())
    };
    if field("type")? != "image" {
        return None;
    }
    let image = json!({"type": "image", "mimeType": field("mimeType")?, "data": field("data")?});
    if let Some(note) = field("note") {
        text.push_str(note);
        text.push('\n');
    }
    Some(image)
}
