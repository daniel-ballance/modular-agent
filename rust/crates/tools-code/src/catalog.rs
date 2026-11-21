//! Tools as Python functions: names, signatures, argument binding and the
//! prompt section that lists them.
use crate::convert;
use anyhow::{Result, anyhow, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Deserialize, Serialize)]
pub struct Definition {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(rename = "parameters")]
    pub input: Value,
    #[serde(default)]
    pub hints: Value,
}
use monty_types::CallArgs;

/// Tools listed with their full description. Past this, each gets one line
/// and `describe_tool` gives the rest.
const FULL_DESCRIPTIONS: usize = 12;

pub struct Function {
    /// The Python name: the tool's name with other characters as '_'.
    pub name: String,
    pub tool: Definition,
    /// Parameter names in call order: required first, as declared, then the
    /// optional ones by name.
    pub parameters: Vec<String>,
    required: Vec<String>,
}

fn identifier(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.chars().next().is_none_or(|c| c.is_ascii_digit()) {
        out.insert(0, '_');
    }
    out
}
fn python_type(schema: &Value) -> String {
    match schema["type"].as_str() {
        Some("string") => "str".into(),
        Some("integer") => "int".into(),
        Some("number") => "float".into(),
        Some("boolean") => "bool".into(),
        Some("array") => format!("list[{}]", python_type(&schema["items"])),
        Some("object") => "dict".into(),
        Some("null") => "None".into(),
        _ => "Any".into(),
    }
}

impl Function {
    pub fn new(tool: Value) -> Result<Self> {
        let tool: Definition = serde_json::from_value(tool)?;
        let required: Vec<String> = tool.input["required"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect();
        let mut parameters = required.clone();
        if let Some(properties) = tool.input["properties"].as_object() {
            parameters.extend(properties.keys().filter(|k| !required.contains(k)).cloned());
            parameters[required.len()..].sort_unstable();
        }
        Ok(Self {
            name: identifier(&tool.name),
            tool,
            parameters,
            required,
        })
    }
    pub fn signature(&self) -> String {
        let parameters: Vec<String> = self
            .parameters
            .iter()
            .map(|name| {
                let kind = python_type(&self.tool.input["properties"][name]);
                if self.required.contains(name) {
                    format!("{name}: {kind}")
                } else {
                    format!("{name}: {kind} = None")
                }
            })
            .collect();
        format!("{}.{}({})", crate::MODULE, self.name, parameters.join(", "))
    }
    pub fn describe(&self) -> Value {
        json!({
            "name": self.name,
            "signature": self.signature(),
            "description": self.tool.description,
            "parameters": self.tool.input,
            "read_only": self.tool.hints["readOnly"] == true,
        })
    }
    /// The tool input for a Python call. Keywords, positions, or one dict.
    pub fn input(&self, args: &CallArgs) -> Result<Value> {
        let mut json = convert::Arguments::default();
        let mut positional = args
            .args()
            .map(|value| json.value(value))
            .collect::<Result<Vec<_>>>()?;
        let mut input = serde_json::Map::new();
        let first_is_object = self
            .parameters
            .first()
            .is_some_and(|name| self.tool.input["properties"][name]["type"] == "object");
        if positional.len() == 1 && positional[0].is_object() && !first_is_object {
            input = positional.remove(0).as_object().unwrap().clone();
        }
        ensure!(
            positional.len() <= self.parameters.len(),
            "takes at most {} arguments, got {}",
            self.parameters.len(),
            positional.len()
        );
        for (name, value) in self.parameters.iter().zip(positional) {
            input.insert(name.clone(), value);
        }
        for (key, value) in args.kwargs() {
            let key = key
                .as_str()
                .ok_or_else(|| anyhow!("keyword names must be strings"))?;
            ensure!(!input.contains_key(key), "got two values for {key}");
            input.insert(key.to_owned(), json.value(value)?);
        }
        // None means "left out", as the signatures' defaults say.
        input.retain(|_, value| !value.is_null());
        if self.tool.input["additionalProperties"] == false
            && let Some(properties) = self.tool.input["properties"].as_object()
            && let Some(unknown) = input.keys().find(|k| !properties.contains_key(*k))
        {
            bail!(
                "unexpected argument {unknown}; the signature is {}",
                self.signature()
            );
        }
        if let Some(missing) = self.required.iter().find(|name| !input.contains_key(*name)) {
            bail!(
                "missing argument {missing}; the signature is {}",
                self.signature()
            );
        }
        Ok(Value::Object(input))
    }
}

fn first_line(text: &str) -> &str {
    let line = text.lines().next().unwrap_or("");
    match line.char_indices().nth(160) {
        Some((at, _)) => &line[..at],
        None => line,
    }
}

pub fn prompt(functions: &[Function]) -> String {
    let mut out = String::from(
        "# Functions in codemode\n\nYou have one tool, `codemode`, which runs Python. These functions exist inside it, on the `tools` object, and nowhere else. Call them as written; no import and no `await` is needed. Arguments go by keyword or in the order shown. A function returns a string unless its entry says otherwise, and raises `RuntimeError` when the call fails, is refused or is cancelled. Do several steps in one run when the later steps do not depend on your judgement of the earlier ones.\n",
    );
    let full = functions.len() <= FULL_DESCRIPTIONS;
    for function in functions {
        if full {
            out.push_str(&format!(
                "\n## {}\n{}\n",
                function.signature(),
                function.tool.description
            ));
        } else {
            out.push_str(&format!(
                "\n- `{}`: {}",
                function.signature(),
                first_line(&function.tool.description)
            ));
        }
    }
    if !full {
        out.push('\n');
    }
    out.push_str(
        "\n## describe_tool(name: str)\nReturns a dict with the full description of the `tools` function of that name and the JSON schema of its parameters.\n\n## search_tools(query: str)\nReturns the functions whose name or description contains every word of the query, as a list of dicts with `name`, `signature` and `description`.\n",
    );
    if functions.iter().any(|f| f.name == "read") {
        out.push_str(
            "\n`tools.read` on an image file (png, jpeg, gif, webp, bmp) returns a dict, not a string. To look at the image, make that dict the last expression of the run, alone or in a list.\n",
        );
    }
    if functions.iter().any(|f| f.name == "exec") {
        out.push_str(
            "\n`tools.exec` returns a dict: `output` (stdout and stderr together), `exit_code`, `truncated`, `wall_time_seconds`, and `full_output_path` when the output was cut. A command that exits non-zero returns its dict; it does not raise.\n",
        );
    }
    out
}

pub fn search<'a>(functions: impl Iterator<Item = &'a Function>, query: &str) -> Value {
    let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    Value::Array(
        functions
            .filter(|f| {
                let text = format!("{} {}", f.name, f.tool.description).to_lowercase();
                words.iter().all(|word| text.contains(word))
            })
            .map(|f| json!({"name":f.name,"signature":f.signature(),"description":first_line(&f.tool.description)}))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use monty_types::MontyObject;

    #[test]
    fn positional_arguments_bind_in_the_order_shown_in_the_prompt() {
        let functions = crate::functions(vec![
            json!({"name": "read", "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "offset": {"type": "integer"},
                    "limit": {"type": "integer"},
                },
                "required": ["path"],
            }}),
            json!({"name": "mcp_inventory__lookup", "parameters": {
                "type": "object",
                "properties": {
                    "zone": {"type": "string"},
                    "sku": {"type": "string"},
                    "limit": {"type": "integer"},
                    "depot": {"type": "string"},
                    "aisle": {"type": "string"},
                },
                "required": ["sku", "depot"],
            }}),
        ])
        .unwrap();
        let prompt = prompt(&functions);

        let read = CallArgs::from(vec![
            MontyObject::string("in.txt"),
            MontyObject::int(1),
            MontyObject::int(2),
        ]);
        assert_eq!(
            functions[0].input(&read).unwrap(),
            json!({"path": "in.txt", "limit": 1, "offset": 2})
        );
        assert!(
            prompt.contains("## tools.read(path: str, limit: int = None, offset: int = None)\n")
        );

        let lookup = CallArgs::from(vec![
            MontyObject::string("A123"),
            MontyObject::string("north"),
            MontyObject::string("B"),
            MontyObject::int(10),
            MontyObject::string("Z1"),
        ]);
        assert_eq!(
            functions[1].input(&lookup).unwrap(),
            json!({"sku": "A123", "depot": "north", "aisle": "B", "limit": 10, "zone": "Z1"})
        );
        assert!(prompt.contains(
            "## tools.mcp_inventory__lookup(sku: str, depot: str, aisle: str = None, limit: int = None, zone: str = None)\n"
        ));
    }
}
