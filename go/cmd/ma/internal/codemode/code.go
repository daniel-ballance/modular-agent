// Package codemode runs Python in Monty and routes external functions through the agent.
package codemode

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/daniel-ballance/modular-agent/go/modular"
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
		return run(ctx, in.Code, defs, tc.Tools.Call, limits)
	})
}

type nestedFunc func(context.Context, string, any) (modular.ToolResult, error)

func failedOutput(reason, printed string) modular.ToolOutput {
	prefix := withNewline(printed)
	text := prefix + reason
	if cut := bounded(text); cut != text {
		last := strings.LastIndex(strings.TrimSuffix(reason, "\n"), "\n")
		text = bounded(utf8Prefix(strings.TrimSuffix(reason, "\n")[last+1:], 1024) + "\n" + prefix)
	}
	return modular.ToolOutput{Status: modular.Failed, Content: modular.Text(text)}
}

func withNewline(s string) string {
	if s != "" && !strings.HasSuffix(s, "\n") {
		return s + "\n"
	}
	return s
}

func utf8Prefix(s string, n int) string {
	n = min(n, len(s))
	for n > 0 && n < len(s) && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

func renderOutput(output any, made int, stream string) (modular.ToolOutput, error) {
	var printed strings.Builder
	printed.WriteString(withNewline(stream))
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
		var b bytes.Buffer
		enc := json.NewEncoder(&b)
		enc.SetEscapeHTML(false)
		enc.SetIndent("", "  ")
		if err := enc.Encode(v); err != nil {
			return modular.ToolOutput{}, err
		}
		printed.Write(b.Bytes()[:b.Len()-1])
	}
	if printed.Len() == 0 {
		printed.WriteString("(no output)")
	}
	return modular.ToolOutput{Content: append(modular.Text(bounded(printed.String())), images...), Value: map[string]int{"calls": made}}, nil
}

func raw(s string) json.RawMessage { b, _ := json.Marshal(s); return b }
func partString(p modular.Part, key string) string {
	var s string
	_ = json.Unmarshal(p.Fields[key], &s)
	return s
}
func bounded(s string) string {
	const maxLines, maxBytes = 2000, 50 * 1024
	lines := strings.Count(strings.TrimSuffix(s, "\n"), "\n") + 1
	if lines <= maxLines && len(s) <= maxBytes {
		return s
	}
	var kept strings.Builder
	n := 0
	for line := range strings.SplitSeq(strings.TrimSuffix(s, "\n"), "\n") {
		if n == maxLines || kept.Len()+len(line)+1 > maxBytes {
			break
		}
		kept.WriteString(line)
		kept.WriteByte('\n')
		n++
	}
	return fmt.Sprintf("%s\n[Output cut: showing the first %d of %d lines (%d of %d bytes). Return or print less, or write the rest to a file.]", kept.String(), n, lines, kept.Len(), len(s))
}
