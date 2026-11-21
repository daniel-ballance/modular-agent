//! Render the last Python value without losing types or dictionary order in JSON.
use monty_types::{
    FormatFloat,
    unstable::{MontyGraph, MontyNode, NodeId},
};
use std::fmt::{self, Write};

pub(super) fn key(node: &MontyNode) -> Option<String> {
    Some(match node {
        MontyNode::String(s) => return Some(s.clone()),
        MontyNode::None => "null".into(),
        MontyNode::Bool(b) => b.to_string(),
        MontyNode::Int(i) => i.to_string(),
        MontyNode::BigInt(i) => i.to_string(),
        MontyNode::Float(f) if f.is_finite() => FormatFloat(*f).to_string(),
        _ => return None,
    })
}

fn sequence(node: &MontyNode) -> Option<&[NodeId]> {
    match node {
        MontyNode::List(items) | MontyNode::Tuple(items) => Some(items),
        MontyNode::NamedTuple { values, .. } => Some(values),
        _ => None,
    }
}

// Check the whole value before choosing JSON or repr, even when the bad part
// comes after the result cutoff. Visit shared subtrees only once and reject cycles.
fn is_json(graph: &MontyGraph, root: NodeId) -> bool {
    #[derive(Clone, Copy, PartialEq)]
    enum Visit {
        New,
        Active,
        Done,
    }
    let mut seen = vec![Visit::New; graph.len()];
    let mut pending = vec![(root, false)];
    while let Some((id, leaving)) = pending.pop() {
        let state = &mut seen[id.0 as usize];
        if leaving {
            *state = Visit::Done;
            continue;
        }
        match *state {
            Visit::Active => return false,
            Visit::Done => continue,
            Visit::New => *state = Visit::Active,
        }
        pending.push((id, true));
        match graph.node(id) {
            MontyNode::Dict(pairs) => {
                for &(k, v) in pairs {
                    if key(graph.node(k)).is_none() {
                        return false;
                    }
                    pending.push((v, false));
                }
            }
            node => {
                if let Some(items) = sequence(node) {
                    pending.extend(items.iter().map(|&id| (id, false)));
                } else if key(node).is_none() {
                    return false;
                }
            }
        }
    }
    true
}

pub(super) fn value(out: &mut String, graph: &MontyGraph, root: NodeId, cap: usize) {
    let mut sink = Prefix { out, cap };
    match graph.node(root) {
        MontyNode::None => (),
        MontyNode::String(s) => {
            let _ = sink.write_str(s);
        }
        _ if is_json(graph, root) => {
            let _ = write_json(&mut sink, graph, root, 0);
        }
        _ => {
            let _ = write!(sink, "{}", graph.value(root));
        }
    }
}

// One byte past the final result budget is enough to signal truncation.
// This also bounds traversal of deeply nested or repeatedly shared values.
struct Prefix<'a> {
    out: &'a mut String,
    cap: usize,
}
impl Write for Prefix<'_> {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        let left = self.cap.saturating_sub(self.out.len());
        if s.len() <= left {
            self.out.push_str(s);
            Ok(())
        } else {
            // Keep the whole code point that crosses the budget. The final
            // cut removes it and any bytes reserved for its notice.
            let end = s.ceil_char_boundary(left + 1);
            self.out.push_str(&s[..end]);
            Err(fmt::Error)
        }
    }
}

fn write_json(out: &mut Prefix<'_>, graph: &MontyGraph, id: NodeId, depth: usize) -> fmt::Result {
    let node = graph.node(id);
    if let MontyNode::Dict(pairs) = node {
        out.write_char('{')?;
        for (i, &(k, v)) in pairs.iter().enumerate() {
            entry(out, i, depth + 1)?;
            quoted(out, &key(graph.node(k)).expect("validated JSON key"))?;
            out.write_str(": ")?;
            write_json(out, graph, v, depth + 1)?;
        }
        close(out, pairs.len(), depth, '}')
    } else if let Some(items) = sequence(node) {
        out.write_char('[')?;
        for (i, &item) in items.iter().enumerate() {
            entry(out, i, depth + 1)?;
            write_json(out, graph, item, depth + 1)?;
        }
        close(out, items.len(), depth, ']')
    } else if let MontyNode::String(s) = node {
        quoted(out, s)
    } else {
        out.write_str(&key(node).expect("validated JSON scalar"))
    }
}

fn quoted(out: &mut Prefix<'_>, s: &str) -> fmt::Result {
    // Escape control characters as json.dumps does, but leave Unicode intact.
    out.write_char('"')?;
    for c in s.chars() {
        match c {
            '"' => out.write_str("\\\"")?,
            '\\' => out.write_str("\\\\")?,
            '\u{8}' => out.write_str("\\b")?,
            '\u{c}' => out.write_str("\\f")?,
            '\n' => out.write_str("\\n")?,
            '\r' => out.write_str("\\r")?,
            '\t' => out.write_str("\\t")?,
            '\0'..='\u{1f}' => write!(out, "\\u{:04x}", u32::from(c))?,
            _ => out.write_char(c)?,
        }
    }
    out.write_char('"')
}

fn entry(out: &mut Prefix<'_>, i: usize, depth: usize) -> fmt::Result {
    if i != 0 {
        out.write_char(',')?;
    }
    indent(out, depth)
}

fn close(out: &mut Prefix<'_>, count: usize, depth: usize, c: char) -> fmt::Result {
    if count != 0 {
        indent(out, depth)?;
    }
    out.write_char(c)
}

fn indent(out: &mut Prefix<'_>, depth: usize) -> fmt::Result {
    writeln!(out)?;
    write!(out, "{:width$}", "", width = depth * 2)
}

#[cfg(test)]
mod tests {
    use monty_types::{MontyObject, unstable};

    fn render(value: MontyObject) -> String {
        let (graph, root) = unstable::graph_parts(&value);
        let mut out = String::new();
        super::value(&mut out, graph, root, 51200);
        out
    }

    #[test]
    fn json_keeps_exact_numbers_key_types_and_insertion_order() {
        assert_eq!(
            render(MontyObject::dict([
                (
                    MontyObject::string("z"),
                    MontyObject::bigint("1180591620717411303424".parse().unwrap())
                ),
                (
                    MontyObject::none(),
                    MontyObject::tuple([MontyObject::float(1.0), MontyObject::float(1e-7)])
                ),
                (MontyObject::string("null"), MontyObject::string("é")),
            ])),
            "{\n  \"z\": 1180591620717411303424,\n  \"null\": [\n    1.0,\n    1e-07\n  ],\n  \"null\": \"é\"\n}"
        );
    }

    #[test]
    fn a_value_with_any_non_json_member_uses_repr_as_a_whole() {
        assert_eq!(render(MontyObject::set([MontyObject::int(1)])), "{1}");
        assert_eq!(
            render(MontyObject::list([MontyObject::float(f64::NAN)])),
            "[nan]"
        );
        assert_eq!(
            render(MontyObject::dict([(
                MontyObject::tuple([MontyObject::int(1), MontyObject::int(2)]),
                MontyObject::bool(true)
            )])),
            "{(1, 2): True}"
        );
    }
}
