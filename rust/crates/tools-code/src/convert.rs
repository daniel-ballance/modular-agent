//! Values crossing the sandbox boundary, as JSON on the agent's side.
use anyhow::{Result, anyhow, bail, ensure};
use monty_types::{
    MontyObject, ObjectRef,
    unstable::{self, MontyNode},
};
use serde_json::{Value, json};

pub fn to_python(value: &Value) -> MontyObject {
    match value {
        Value::Null => MontyObject::none(),
        Value::Bool(b) => MontyObject::bool(*b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                MontyObject::int(i)
            } else if let Ok(i) = n.as_str().parse() {
                MontyObject::bigint(i)
            } else {
                MontyObject::float(n.as_f64().unwrap_or(f64::NAN))
            }
        }
        Value::String(s) => MontyObject::string(s.as_str()),
        Value::Array(items) => MontyObject::list(items.iter().map(to_python)),
        Value::Object(map) => MontyObject::dict(
            map.iter()
                .map(|(k, v)| (MontyObject::string(k.as_str()), to_python(v))),
        ),
    }
}

/// Convert the whole call before dispatch. JSON arrays accept tuples, but
/// sets, non-string keys, non-finite numbers and other lossy forms are refused.
/// Bound expansion of a worker value that shares the same subtree many times.
pub(super) struct Arguments {
    left: usize,
}

impl Default for Arguments {
    fn default() -> Self {
        Self { left: 250_000 }
    }
}

impl Arguments {
    pub(super) fn value(&mut self, value: ObjectRef<'_>) -> Result<Value> {
        self.convert(value, 0)
    }

    fn convert(&mut self, value: ObjectRef<'_>, depth: usize) -> Result<Value> {
        ensure!(
            self.left > 0 && depth <= 400,
            "tool arguments are too large"
        );
        self.left -= 1;
        let child = |id| unstable::child(value, id);
        Ok(match unstable::node(value) {
            MontyNode::None => Value::Null,
            MontyNode::Bool(b) => json!(b),
            MontyNode::Int(i) => Value::Number((*i).into()),
            // The SDK reads tool inputs through serde's Value visitor. It
            // accepts 64-bit integers but cannot carry all arbitrary-precision
            // numbers, even though serde_json can print them without loss.
            MontyNode::BigInt(i) => {
                if let Ok(n) = i64::try_from(i) {
                    Value::Number(n.into())
                } else if let Ok(n) = u64::try_from(i) {
                    Value::Number(n.into())
                } else {
                    bail!("tool argument integer is outside the JSON input range");
                }
            }
            MontyNode::Float(f) => Value::Number(
                serde_json::Number::from_f64(*f)
                    .ok_or_else(|| anyhow!("tool arguments must be finite JSON numbers"))?,
            ),
            MontyNode::String(s) => json!(s),
            MontyNode::List(ids) | MontyNode::Tuple(ids) => Value::Array(
                ids.iter()
                    .map(|&id| self.convert(child(id), depth + 1))
                    .collect::<Result<_>>()?,
            ),
            MontyNode::Dict(pairs) => Value::Object(
                pairs
                    .iter()
                    .map(|&(k, v)| {
                        let key = child(k)
                            .as_str()
                            .ok_or_else(|| anyhow!("tool argument keys must be strings"))?;
                        Ok((key.to_owned(), self.convert(child(v), depth + 1)?))
                    })
                    .collect::<Result<_>>()?,
            ),
            _ => bail!(
                "tool arguments must be JSON values, not {}",
                value.type_name()
            ),
        })
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
