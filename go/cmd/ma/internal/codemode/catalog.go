package codemode

import (
	"bytes"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"github.com/daniel-ballance/modular-agent/go/modular"
)

type parameter struct {
	Type  string     `json:"type"`
	Items *parameter `json:"items"`
}
type function struct {
	name                 string
	tool                 modular.ToolDefinition
	parameters, required []string
	properties           map[string]parameter
	closed               bool
}

func catalog(defs []modular.ToolDefinition) ([]function, error) {
	var out []function
	seen := map[string]bool{}
	for _, d := range defs {
		if d.Name == Name {
			continue
		}
		name := identifier(d.Name)
		if seen[name] {
			return nil, fmt.Errorf("two tools share the function name %s", name)
		}
		seen[name] = true
		var s struct {
			Properties           json.RawMessage
			Required             []string
			AdditionalProperties json.RawMessage
		}
		if err := json.Unmarshal(d.Parameters, &s); err != nil {
			return nil, err
		}
		params := slices.Clone(s.Required)
		properties := map[string]parameter{}
		if len(s.Properties) != 0 && string(s.Properties) != "null" {
			// A map loses the order used to bind positional arguments.
			dec := json.NewDecoder(bytes.NewReader(s.Properties))
			if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
				return nil, fmt.Errorf("tool %s properties must be an object", d.Name)
			}
			for dec.More() {
				key, err := dec.Token()
				if err != nil {
					return nil, err
				}
				keyName := key.(string)
				var p parameter
				if err := dec.Decode(&p); err != nil {
					return nil, err
				}
				if !slices.Contains(s.Required, keyName) {
					if _, seen := properties[keyName]; !seen {
						params = append(params, keyName)
					}
				}
				properties[keyName] = p
			}
		}
		out = append(out, function{name, d, params, s.Required, properties, string(s.AdditionalProperties) == "false"})
	}
	return out, nil
}
func identifier(s string) string {
	out := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' {
			return r
		}
		return '_'
	}, s)
	if out == "" || out[0] >= '0' && out[0] <= '9' {
		out = "_" + out
	}
	return out
}
func pythonType(p *parameter) string {
	if p == nil {
		return "Any"
	}
	switch p.Type {
	case "string":
		return "str"
	case "integer":
		return "int"
	case "number":
		return "float"
	case "boolean":
		return "bool"
	case "object":
		return "dict"
	case "null":
		return "None"
	case "array":
		return "list[" + pythonType(p.Items) + "]"
	}
	return "Any"
}
func (f function) signature() string {
	params := []string{}
	for _, n := range f.parameters {
		p := f.properties[n]
		s := n + ": " + pythonType(&p)
		if !slices.Contains(f.required, n) {
			s += " = None"
		}
		params = append(params, s)
	}
	return "tools." + f.name + "(" + strings.Join(params, ", ") + ")"
}
func (f function) describe(full bool) map[string]any {
	d := map[string]any{"name": f.name, "signature": f.signature(), "description": firstLine(f.tool.Description)}
	if full {
		var schema any
		decoder := json.NewDecoder(bytes.NewReader(f.tool.Parameters))
		decoder.UseNumber()
		_ = decoder.Decode(&schema)
		d["parameters"] = schema
		d["read_only"] = f.tool.Hints.ReadOnly
		d["description"] = f.tool.Description
	}
	return d
}
func (f function) bind(args []any, kwargs []keyword) (map[string]any, error) {
	in := map[string]any{}
	if len(args) == 1 && (len(f.parameters) == 0 || f.properties[f.parameters[0]].Type != "object") {
		if m, ok := args[0].(map[string]any); ok {
			in = m
			args = nil
		}
	}
	if len(args) > len(f.parameters) {
		return nil, fmt.Errorf("takes at most %d arguments, got %d", len(f.parameters), len(args))
	}
	for i, v := range args {
		in[f.parameters[i]] = v
	}
	for _, pair := range kwargs {
		k := pair.name
		if _, ok := in[k]; ok {
			return nil, fmt.Errorf("got two values for %s", k)
		}
		in[k] = pair.value
	}
	for k, v := range in {
		if v == nil {
			delete(in, k)
			continue
		}
		if _, ok := f.properties[k]; !ok && f.closed {
			return nil, fmt.Errorf("unexpected argument %s; the signature is %s", k, f.signature())
		}
	}
	for _, k := range f.required {
		if _, ok := in[k]; !ok {
			return nil, fmt.Errorf("missing argument %s; the signature is %s", k, f.signature())
		}
	}
	return in, nil
}
func firstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	r := []rune(line)
	return string(r[:min(160, len(r))])
}
func search(functions []function, q string) []any {
	words := strings.Fields(strings.ToLower(q))
	out := []any{}
	for _, f := range functions {
		haystack := strings.ToLower(f.name + " " + f.tool.Description)
		if !slices.ContainsFunc(words, func(w string) bool { return !strings.Contains(haystack, w) }) {
			out = append(out, f.describe(false))
		}
	}
	return out
}

// Prompt lists the actual tools registered for the session, not just its model offer.
func Prompt(defs []modular.ToolDefinition) (string, error) {
	fs, err := catalog(defs)
	if err != nil {
		return "", err
	}
	var out strings.Builder
	out.WriteString("# Functions in codemode\n\nYou have one tool, `codemode`, which runs Python. These functions exist inside it, on the `tools` object, and nowhere else. Call them as written; no import and no `await` is needed. Arguments go by keyword or in the order shown. A function returns a string unless its entry says otherwise, and raises `RuntimeError` when the call fails, is refused or is cancelled. Do several steps in one run when the later steps do not depend on your judgement of the earlier ones.\n")
	for _, f := range fs {
		if len(fs) <= 12 {
			fmt.Fprintf(&out, "\n## %s\n%s\n", f.signature(), f.tool.Description)
		} else {
			fmt.Fprintf(&out, "\n- `%s`: %s", f.signature(), firstLine(f.tool.Description))
		}
	}
	if len(fs) > 12 {
		out.WriteByte('\n')
	}
	out.WriteString("\n## describe_tool(name: str)\nReturns a dict with the full description of the `tools` function of that name and the JSON schema of its parameters.\n\n## search_tools(query: str)\nReturns the functions whose name or description contains every word of the query, as a list of dicts with `name`, `signature` and `description`.\n")
	if slices.ContainsFunc(fs, func(f function) bool { return f.name == "read" }) {
		out.WriteString("\n`tools.read` on an image file (png, jpeg, gif, webp, bmp) returns a dict, not a string. To look at the image, make that dict the last expression of the run, alone or in a list.\n")
	}
	if slices.ContainsFunc(fs, func(f function) bool { return f.name == "exec" }) {
		out.WriteString("\n`tools.exec` returns a dict: `output` (stdout and stderr together), `exit_code`, `truncated`, `wall_time_seconds`, and `full_output_path` when the output was cut. A command that exits non-zero returns its dict; it does not raise.\n")
	}
	return out.String(), nil
}
