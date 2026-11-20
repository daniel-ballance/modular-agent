// Package codemode runs Python in Monty and routes external functions through the agent.
package codemode

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	monty "github.com/ewhauser/gomonty"
)

const Name = "codemode"
const description = `Run Python in a sandbox. The functions listed under "Functions in codemode" in the system prompt are the only way to reach files, commands and other tools. Call them on ` + "`tools`" + `, for example ` + "`text = tools.read(path=\"README.md\")`" + `. The value of the last expression and anything printed come back as the result. Each run starts fresh: no variables carry over. The sandbox runs a subset of Python: no classes with inheritance, no third-party packages, and no direct file, network or process access.`

type Limits struct {
	Compute                      time.Duration
	Calls, Recursion, PrintBytes int
}

func StandardLimits() Limits { return Limits{30 * time.Second, 500, 200, 1024 * 1024} }

type input struct {
	Code string `json:"code" jsonschema:"Python source to run"`
}

func Tool(limits Limits) modular.Tool {
	return modular.NewTool(Name, description, func(ctx context.Context, in input, tc *modular.ToolContext) (modular.ToolOutput, error) {
		defs, err := tc.Tools.List(ctx)
		if err != nil {
			return modular.ToolOutput{}, err
		}
		fs, err := catalog(defs)
		if err != nil {
			return modular.ToolOutput{}, err
		}
		return run(ctx, in.Code, fs, tc.Tools.Call, limits)
	})
}

type nestedFunc func(context.Context, string, any) (modular.ToolResult, error)

type reply struct {
	value     monty.Value
	exception *monty.Exception
}
type callback func(context.Context, monty.Call) (reply, error)

func raised(kind, message string) (reply, error) {
	return reply{exception: &monty.Exception{Type: kind, Arg: &message}}, nil
}
func run(ctx context.Context, code string, fs []function, nested nestedFunc, l Limits) (modular.ToolOutput, error) {
	// A Python assignment shadows the native print builtin so the host can
	// bound each write before accumulating it.
	compiled, err := monty.New("print = __ma_print\n"+code, monty.CompileOptions{ScriptName: "main.py", Inputs: []string{"tools", "__ma_print"}})
	if err != nil {
		return modular.ToolOutput{Status: modular.Failed, Content: modular.Text(err.Error())}, nil
	}
	funcs := map[string]callback{}
	made := 0
	for _, f := range fs {
		funcs[f.name] = func(ctx context.Context, c monty.Call) (reply, error) {
			in, err := f.bind(c.Args, c.Kwargs)
			if err != nil {
				return raised("TypeError", f.name+"(): "+err.Error())
			}
			if made >= l.Calls {
				return raised("RuntimeError", fmt.Sprintf("this run made more than %d function calls", l.Calls))
			}
			made++
			res, err := nested(ctx, f.tool.Name, in)
			if err != nil {
				return raised("RuntimeError", fmt.Sprintf("%s() could not run: %v", f.name, err))
			}
			var value any
			if res.Status == modular.Completed {
				if len(res.Value) > 0 {
					if err := json.Unmarshal(res.Value, &value); err != nil {
						return reply{}, err
					}
				} else {
					value = res.Text()
					for _, p := range res.Content {
						if p.Type == "image" {
							value = map[string]any{"type": "image", "mimeType": partString(p, "mimeType"), "data": partString(p, "data"), "note": res.Text()}
							break
						}
					}
				}
			} else if res.Status == modular.Failed && f.tool.Name == "exec" && len(res.Value) > 0 {
				if err := json.Unmarshal(res.Value, &value); err != nil {
					return reply{}, err
				}
			} else {
				status := map[modular.ToolStatus]string{modular.Refused: "was refused", modular.Cancelled: "was cancelled", modular.NotStarted: "did not start", modular.OutcomeUnknown: "was interrupted, outcome unknown"}[res.Status]
				if status == "" {
					status = "failed"
				}
				return raised("RuntimeError", fmt.Sprintf("%s() %s: %s", f.name, status, res.Text()))
			}
			v, err := monty.ValueOf(value)
			return reply{value: v}, err
		}
	}
	// Dispatch method syntax through the same adapters as function values.
	// The wire representation does not carry host method closures.
	for _, def := range []struct {
		name, key string
		search    bool
	}{{"describe_tool", "name", false}, {"search_tools", "query", true}} {
		funcs[def.name] = func(_ context.Context, c monty.Call) (reply, error) {
			var arg monty.Value
			if len(c.Args) > 0 {
				arg = c.Args[0]
			} else {
				for _, kv := range c.Kwargs {
					if kv.Key.Raw() == def.key {
						arg = kv.Value
						break
					}
				}
			}
			s, ok := arg.Raw().(string)
			if !ok {
				return raised("TypeError", def.name+"() takes one string")
			}
			if def.search {
				v, err := monty.ValueOf(search(fs, s))
				return reply{value: v}, err
			}
			for _, f := range fs {
				if f.name == s {
					v, err := monty.ValueOf(f.describe(true))
					return reply{value: v}, err
				}
			}
			return raised("KeyError", "no function named "+s)
		}
	}
	var printed strings.Builder
	value, err := drive(ctx, compiled, funcs, l, &printed)
	if ctx.Err() != nil {
		return modular.ToolOutput{}, ctx.Err()
	}
	if printed.Len() > 0 && !strings.HasSuffix(printed.String(), "\n") {
		printed.WriteByte('\n')
	}
	if err != nil {
		printed.WriteString(err.Error())
		return modular.ToolOutput{Status: modular.Failed, Content: modular.Text(bounded(printed.String()))}, nil
	}
	var images modular.Content
	takeImage := func(v any) bool {
		m, ok := v.(map[string]any)
		if !ok || m["type"] != "image" {
			return false
		}
		mime, mok := m["mimeType"].(string)
		data, dok := m["data"].(string)
		if !mok || !dok {
			return false
		}
		if note, ok := m["note"].(string); ok {
			printed.WriteString(note)
			printed.WriteByte('\n')
		}
		images = append(images, modular.Part{Type: "image", Fields: map[string]json.RawMessage{"mimeType": raw(mime), "data": raw(data)}})
		return true
	}
	output := toJSON(value)
	switch v := output.(type) {
	case []any:
		rest := make([]any, 0, len(v))
		for _, item := range v {
			if !takeImage(item) {
				rest = append(rest, item)
			}
		}
		output = rest
		if len(rest) == 0 && len(images) > 0 {
			output = nil
		}
	default:
		if takeImage(v) {
			output = nil
		}
	}
	switch v := output.(type) {
	case nil:
	case string:
		printed.WriteString(v)
	default:
		b, err := json.MarshalIndent(v, "", "  ")
		if err != nil {
			return modular.ToolOutput{}, err
		}
		printed.Write(b)
	}
	if printed.Len() == 0 {
		printed.WriteString("(no output)")
	}
	return modular.ToolOutput{Content: append(modular.Text(bounded(printed.String())), images...), Value: map[string]int{"calls": made}}, nil
}

func toJSON(v monty.Value) any {
	switch x := v.Raw().(type) {
	case nil:
		return nil
	case string, bool, int64:
		return x
	case float64:
		if !math.IsInf(x, 0) && !math.IsNaN(x) {
			return x
		}
	case monty.Dict:
		m := map[string]any{}
		for _, pair := range x {
			k, ok := pair.Key.Raw().(string)
			if !ok {
				k = pair.Key.String()
			}
			m[k] = toJSON(pair.Value)
		}
		return m
	case []monty.Value:
		out := make([]any, 0, len(x))
		for _, v := range x {
			out = append(out, toJSON(v))
		}
		return out
	case monty.Tuple:
		out := make([]any, 0, len(x))
		for _, v := range x {
			out = append(out, toJSON(v))
		}
		return out
	}
	return v.String()
}
func raw(s string) json.RawMessage { b, _ := json.Marshal(s); return b }
func partString(p modular.Part, key string) string {
	var s string
	_ = json.Unmarshal(p.Fields[key], &s)
	return s
}
func bounded(s string) string {
	const maxLines, maxBytes = 2000, 50 * 1024
	lines := strings.Split(strings.TrimSuffix(s, "\n"), "\n")
	if len(lines) <= maxLines && len(s) <= maxBytes {
		return s
	}
	var kept strings.Builder
	n := 0
	for _, line := range lines[:min(maxLines, len(lines))] {
		if kept.Len()+len(line)+1 > maxBytes {
			break
		}
		kept.WriteString(line)
		kept.WriteByte('\n')
		n++
	}
	return fmt.Sprintf("%s\n[Output cut: showing the first %d of %d lines (%d of %d bytes). Return or print less, or write the rest to a file.]", kept.String(), n, len(lines), kept.Len(), len(s))
}
