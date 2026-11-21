// Package codemode runs Python in Monty and routes external functions through the agent.
package codemode

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	pb "github.com/daniel-ballance/modular-agent/go/cmd/ma/internal/codemode/protocol"
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

func failedOutput(err error, printed string) modular.ToolOutput {
	reason := err.Error()
	var over printLimitError
	if errors.As(err, &over) {
		return modular.ToolOutput{Status: modular.Failed, Content: modular.Text(bounded(reason + "\n" + printed))}
	}
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

func renderOutput(value finalValue, made int, stream string) modular.ToolOutput {
	var printed strings.Builder
	printed.WriteString(withNewline(stream))
	var images modular.Content
	takeImage := func(id uint32) bool {
		var kind string
		var mime, data, note *pb.MontyNode_Str
		for _, pair := range value.nodes[id].GetDict().GetPairs() {
			s, _ := value.nodes[pair.Value].Kind.(*pb.MontyNode_Str)
			switch value.nodes[pair.Key].GetStr() {
			case "type":
				kind = value.nodes[pair.Value].GetStr()
			case "mimeType":
				mime = s
			case "data":
				data = s
			case "note":
				note = s
			}
		}
		if kind != "image" || mime == nil || data == nil {
			return false
		}
		if note != nil {
			printed.WriteString(note.Str)
			printed.WriteByte('\n')
		}
		images = append(images, modular.Part{Type: "image", Fields: map[string]json.RawMessage{"mimeType": raw(mime.Str), "data": raw(data.Str)}})
		return true
	}
	showValue := true
	switch value.nodes[value.id].Kind.(type) {
	case *pb.MontyNode_List, *pb.MontyNode_Tuple:
		original := items(value.nodes[value.id])
		rest := slices.DeleteFunc(slices.Clone(original), takeImage)
		if len(rest) != len(original) {
			showValue = len(rest) != 0
			node := &pb.MontyNode{Kind: &pb.MontyNode_List{List: &pb.Indexes{Items: rest}}}
			value.id, value.nodes = uint32(len(value.nodes)), append(value.nodes, node)
		}
	default:
		showValue = !takeImage(value.id)
	}
	if showValue {
		printed.WriteString(value.text())
	}
	if printed.Len() == 0 {
		printed.WriteString("(no output)")
	}
	return modular.ToolOutput{Content: append(modular.Text(bounded(printed.String())), images...), Value: map[string]int{"calls": made}}
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
