package codemode

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	pb "github.com/daniel-ballance/modular-agent/go/cmd/ma/internal/codemode/protocol"
	"github.com/daniel-ballance/modular-agent/go/modular"
)

func (w *worker) functionCall(c *pb.FunctionCall, fs []function, nested nestedFunc, made *int, cap int) (*pb.ClientRequest, error) {
	if c.ObjectId != nil || c.AllowEagerAwait {
		return nil, protocolError("unexpected host method or asynchronous function call")
	}
	args, kwargs, err := arguments(c)
	if err != nil {
		return nil, protocolError("%v", err)
	}
	fail := func(kind, message string) (*pb.ClientRequest, error) {
		return resume(c.CallId, raise(kind, message), nil), nil
	}
	answer := func(v any) (*pb.ClientRequest, error) {
		a, root, err := encodeValue(v)
		if err != nil {
			return fail("RuntimeError", err.Error())
		}
		return resume(c.CallId, returnValue(root), a), nil
	}
	name := c.FunctionName
	if name == "describe_tool" || name == "search_tools" {
		key := "name"
		if name == "search_tools" {
			key = "query"
		}
		var arg any
		if len(args) > 0 {
			arg = args[0]
		} else {
			for _, kw := range kwargs {
				if kw.name == key {
					arg = kw.value
					break
				}
			}
		}
		s, ok := arg.(string)
		if !ok {
			return fail("TypeError", name+"() takes one string")
		}
		if name == "search_tools" {
			return answer(search(fs, s))
		}
		for _, f := range fs {
			if f.name == s {
				return answer(f.describe(true))
			}
		}
		return fail("KeyError", "no function named "+s)
	}
	short, qualified := strings.CutPrefix(name, "tools.")
	for _, f := range fs {
		if !qualified || f.name != short {
			continue
		}
		in, err := f.bind(args, kwargs)
		if err != nil {
			return fail("TypeError", f.name+"(): "+err.Error())
		}
		if *made >= cap {
			return fail("RuntimeError", fmt.Sprintf("this run made more than %d function calls", cap))
		}
		if w.ctx.Err() != nil {
			return nil, w.ioError(io.EOF)
		}
		input, err := json.Marshal(in)
		if err != nil {
			return fail("TypeError", f.name+"(): "+err.Error())
		}
		*made = *made + 1
		res, err := w.callNested(nested, f.tool.Name, json.RawMessage(input))
		if w.ctx.Err() != nil {
			return nil, w.ioError(io.EOF)
		}
		if err != nil {
			return fail("RuntimeError", fmt.Sprintf("%s() could not run: %v", f.name, err))
		}
		if res.Status == modular.Completed && len(res.Value) == 0 {
			for _, p := range res.Content {
				if p.Type == "image" {
					return answer(map[string]any{"type": "image", "mimeType": partString(p, "mimeType"), "data": partString(p, "data"), "note": res.Text()})
				}
			}
			return answer(res.Text())
		}
		if (res.Status == modular.Completed || res.Status == modular.Failed && f.tool.Name == "exec") && len(res.Value) > 0 {
			if len(res.Value) > maxFrame {
				return fail("RuntimeError", "tool result exceeds worker value budget")
			}
			var value any
			decoder := json.NewDecoder(bytes.NewReader(res.Value))
			decoder.UseNumber()
			if err := decoder.Decode(&value); err != nil || decoder.Decode(new(any)) != io.EOF {
				return fail("RuntimeError", "invalid structured tool result")
			}
			if res.Status == modular.Completed || commandExitedNonzero(value) {
				return answer(value)
			}
		}
		status := map[modular.ToolStatus]string{modular.Refused: "was refused", modular.Cancelled: "was cancelled", modular.NotStarted: "did not start", modular.OutcomeUnknown: "was interrupted, outcome unknown"}[res.Status]
		if status == "" {
			status = "failed"
		}
		return fail("RuntimeError", fmt.Sprintf("%s() %s: %s", f.name, status, res.Text()))
	}
	return fail("NameError", fmt.Sprintf("name '%s' is not defined", name))
}

func commandExitedNonzero(value any) bool {
	obj, _ := value.(map[string]any)
	code, _ := obj["exit_code"].(json.Number)
	n, err := code.Int64()
	return err == nil && n != 0 && obj["timed_out"] != true
}
