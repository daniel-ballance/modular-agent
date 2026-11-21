package codemode

import (
	"context"
	"fmt"
	"strings"
	"unicode/utf8"

	monty "github.com/ewhauser/gomonty"
)

func drive(ctx context.Context, r *monty.Runner, functions map[string]callback, l Limits, out *strings.Builder) (monty.Value, error) {
	tools := monty.DataclassValue(monty.Dataclass{Name: "tools", TypeID: 1, Frozen: true})
	function := func(name string) monty.Value { return monty.FunctionValue(monty.Function{Name: name}) }
	p, err := r.Start(ctx, monty.StartOptions{Inputs: map[string]monty.Value{"tools": tools, "__ma_print": function("print")}, Limits: &monty.ResourceLimits{MaxDuration: l.Compute, MaxRecursionDepth: l.Recursion, MaxMemory: 256 * 1024 * 1024}})
	for err == nil {
		if ctx.Err() != nil {
			return monty.None(), ctx.Err()
		}
		switch s := p.(type) {
		case *monty.Complete:
			return s.Output, nil
		case *monty.NameLookupSnapshot:
			if s.VariableName == "describe_tool" || s.VariableName == "search_tools" {
				p, err = s.ResumeValue(ctx, function(s.VariableName))
			} else {
				p, err = s.ResumeUndefined(ctx)
			}
		case *monty.Snapshot:
			var result reply
			switch {
			case s.IsOSFunction:
				result, _ = raised("RuntimeError", "the sandbox has no direct access to files, the network, the clock or the environment; use the provided functions")
			case s.IsMethodCall:
				var receiver monty.Dataclass
				var ok bool
				if len(s.Args) > 0 {
					receiver, ok = s.Args[0].Dataclass()
				}
				f, found := functions[s.FunctionName]
				if !ok || receiver.TypeID != 1 || !found {
					result, _ = raised("AttributeError", fmt.Sprintf("'tools' object has no attribute '%s'", s.FunctionName))
					break
				}
				result, err = f(ctx, monty.Call{FunctionName: s.FunctionName, Args: s.Args[1:], Kwargs: s.Kwargs, CallID: s.CallID})
				if err != nil {
					return monty.None(), err
				}
				// The native tracker starts a fresh clock on deserialization. Host wait
				// time does not consume the next computation allowance.
				snapshot, e := s.Dump()
				if e != nil {
					return monty.None(), e
				}
				restored, e := monty.LoadSnapshot(snapshot)
				if e != nil {
					return monty.None(), e
				}
				s = restored.(*monty.Snapshot)
			case s.FunctionName == "print":
				result = collectPrint(out, l.PrintBytes, s.Args, s.Kwargs)
			case s.FunctionName == "describe_tool" || s.FunctionName == "search_tools":
				result, err = functions[s.FunctionName](ctx, monty.Call{FunctionName: s.FunctionName, Args: s.Args, Kwargs: s.Kwargs})
				if err != nil {
					return monty.None(), err
				}
			default:
				result, _ = raised("NameError", fmt.Sprintf("name '%s' is not defined", s.FunctionName))
			}
			if result.exception != nil {
				p, err = s.ResumeException(ctx, *result.exception)
			} else {
				p, err = s.ResumeReturn(ctx, result.value)
			}
		default:
			return monty.None(), fmt.Errorf("awaited something that never resolves")
		}
	}
	return monty.None(), err
}

func collectPrint(out *strings.Builder, cap int, args []monty.Value, kwargs monty.Dict) reply {
	sep, end := " ", "\n"
	for _, kw := range kwargs {
		var dest *string
		switch kw.Key.Raw() {
		case "sep":
			dest = &sep
		case "end":
			dest = &end
		case "flush":
			continue
		default:
			r, _ := raised("TypeError", "invalid keyword for print()")
			return r
		}
		if kw.Value.Raw() == nil {
			continue
		}
		v, ok := kw.Value.Raw().(string)
		if !ok {
			r, _ := raised("TypeError", "print() sep and end must be strings or None")
			return r
		}
		*dest = v
	}
	appendText := func(s string) {
		n := min(cap-out.Len(), len(s))
		if n <= 0 {
			return
		}
		for n < len(s) && n > 0 && !utf8.RuneStart(s[n]) {
			n--
		}
		out.WriteString(s[:n])
	}
	for i, arg := range args {
		if out.Len() >= cap {
			break
		}
		if i > 0 {
			appendText(sep)
		}
		if s, ok := arg.Raw().(string); ok {
			appendText(s)
		} else {
			appendText(arg.String())
		}
	}
	appendText(end)
	return reply{}
}
