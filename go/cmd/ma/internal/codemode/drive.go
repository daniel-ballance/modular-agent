package codemode

import (
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	pb "github.com/daniel-ballance/modular-agent/go/cmd/ma/internal/codemode/protocol"
	"github.com/daniel-ballance/modular-agent/go/modular"
)

const osDenied = "the sandbox has no direct access to files, the network, the clock or the environment; use the provided functions"

func stringNode(s string) *pb.MontyNode {
	return &pb.MontyNode{Kind: &pb.MontyNode_Str{Str: s}}
}

func functionNode(name string, doc *string) *pb.MontyNode {
	return &pb.MontyNode{Kind: &pb.MontyNode_Function{Function: &pb.Function{Name: name, Docstring: doc}}}
}

func toolModule(fs []function) (*pb.Arena, uint32) {
	a := new(pb.Arena)
	attrs := new(pb.NodePairs)
	for _, f := range fs {
		key := appendNode(a, stringNode(f.name))
		// A qualified dispatch name cannot be a bare unresolved Python name.
		value := appendNode(a, functionNode("tools."+f.name, &f.tool.Description))
		attrs.Pairs = append(attrs.Pairs, &pb.NodePair{Key: key, Value: value})
	}
	// Use the same boundary module identity for the global and each import.
	// Monty 1.6.0 still allocates a Python object per import.
	id := [16]byte{15: 1}
	root := appendNode(a, &pb.MontyNode{Kind: &pb.MontyNode_Module{Module: &pb.ModuleNode{
		Name: "tools", Id: &pb.Uuid{Data: id[:]}, Attrs: attrs,
	}}})
	return a, root
}

func returnValue(id uint32) *pb.ExtFunctionResult {
	return &pb.ExtFunctionResult{Kind: &pb.ExtFunctionResult_ReturnValue{ReturnValue: id}}
}

func resume(id uint32, r *pb.ExtFunctionResult, a *pb.Arena) *pb.ClientRequest {
	return &pb.ClientRequest{Kind: &pb.ClientRequest_ResumeCall{ResumeCall: &pb.ResumeCall{CallId: id, Result: r, Values: a}}}
}

func raise(kind, message string) *pb.ExtFunctionResult {
	return &pb.ExtFunctionResult{Kind: &pb.ExtFunctionResult_Error{Error: &pb.RaisedException{ExcType: kind, Message: &message}}}
}

func lookup(name string, receiver *pb.Uuid) *pb.ClientRequest {
	answer := &pb.ResumeNameLookup{Kind: &pb.ResumeNameLookup_Undefined{Undefined: &pb.Unit{}}}
	if receiver == nil {
		switch name {
		case "describe_tool", "search_tools":
			answer.Values = &pb.Arena{NodeCount: 1, Nodes: []*pb.MontyNode{functionNode(name, nil)}}
			answer.Kind = &pb.ResumeNameLookup_Value{Value: 0}
		}
	}
	return &pb.ClientRequest{Kind: &pb.ClientRequest_ResumeNameLookup{ResumeNameLookup: answer}}
}

func (w *worker) drive(code string, fs []function, nested nestedFunc, l Limits, printed *strings.Builder) (any, int, error) {
	if l.Compute < time.Microsecond || l.Calls < 0 || l.Recursion < 1 || l.PrintBytes < 0 {
		return nil, 0, errors.New("invalid codemode limits")
	}
	ack, err := w.exchange(configuration(l), openingTimeout, nil, 0)
	if err != nil {
		return nil, 0, fmt.Errorf("Monty %s worker did not accept protocol %d: %w", workerVersion, protocolVersion, err)
	}
	if ack.GetOk() == nil || ack.ExecutionClock == nil || *ack.ExecutionClock != pb.ExecutionClock_WALL {
		if refusal := ack.GetSessionRefused(); refusal != nil {
			return nil, 0, protocolError("Monty worker refused protocol %d configuration: %s", protocolVersion, refusal.Message)
		}
		return nil, 0, protocolError("Monty worker did not acknowledge protocol %d configuration", protocolVersion)
	}
	tools, moduleID := toolModule(fs)
	request := &pb.ClientRequest{Kind: &pb.ClientRequest_Feed{Feed: &pb.Feed{
		Code: code, Values: tools, Inputs: []*pb.NamedRef{{Name: "tools", Value: moduleID}},
	}}}
	made := 0
	var last, checkpoint uint64
	budget := uint64(l.Compute.Microseconds())
	for {
		if w.ctx.Err() != nil {
			return nil, made, w.ioError(io.EOF)
		}
		// The VM clock tracks only execution. Give the pipe watchdog a small
		// allowance for a final exception frame, so the VM error wins when
		// it reaches a checkpoint on time. Neither clock runs in nested().
		remaining := time.Duration(budget-(last-checkpoint)) * time.Microsecond
		event, err := w.exchange(request, remaining+250*time.Millisecond, printed, l.PrintBytes)
		if err != nil {
			return nil, made, err
		}
		if x := event.GetError(); x != nil {
			return nil, made, raisedError(x.Exception)
		}
		if event.FeedExecutionMicros < last {
			return nil, made, protocolError("worker execution clock went backwards")
		}
		last = event.FeedExecutionMicros
		if last-checkpoint >= budget {
			return nil, made, errCompute
		}
		switch e := event.Kind.(type) {
		case *pb.WorkerEvent_Complete:
			a, err := validateArena(e.Complete.Values)
			if err == nil {
				err = a.roots([]uint32{e.Complete.Value})
			}
			if err != nil {
				return nil, made, protocolError("%v", err)
			}
			return a.jsonValue(e.Complete.Value), made, nil
		case *pb.WorkerEvent_NameLookup:
			if e.NameLookup.ObjectId != nil && len(e.NameLookup.ObjectId.Data) != 16 {
				return nil, made, protocolError("invalid name lookup receiver")
			}
			request = lookup(e.NameLookup.Name, e.NameLookup.ObjectId)
		case *pb.WorkerEvent_OsCall:
			c := e.OsCall
			a, err := validateArena(c.Values)
			if getenv := c.GetGetenv(); err == nil && getenv != nil {
				err = a.roots([]uint32{getenv.Default})
			}
			if c.Call == nil {
				err = errors.New("missing OS operation")
			}
			if err != nil {
				return nil, made, protocolError("%v", err)
			}
			result := raise("RuntimeError", osDenied)
			var values *pb.Arena
			if c.GetImport().GetModule() == "tools" {
				result, values = returnValue(moduleID), tools
			}
			if c.AllowEagerAwait {
				if c.GetAsyncSleep() == nil {
					return nil, made, protocolError("unexpected eager OS call")
				}
				request = &pb.ClientRequest{Kind: &pb.ClientRequest_ResumeFutures{ResumeFutures: &pb.ResumeFutures{
					Results: []*pb.FutureResult{{CallId: c.CallId, Result: result}},
				}}}
			} else {
				request = resume(c.CallId, result, values)
			}
		case *pb.WorkerEvent_FunctionCall:
			prior := made
			request, err = w.functionCall(e.FunctionCall, fs, nested, &made, l.Calls)
			if err != nil {
				return nil, made, err
			}
			if made != prior {
				checkpoint = last // Only a dispatched tool starts a new compute interval.
			}
		case *pb.WorkerEvent_ResolveFutures:
			return nil, made, errors.New("RuntimeError: awaited something that never resolves")
		default:
			return nil, made, protocolError("unexpected event %T", event.Kind)
		}
	}
}

type keyword struct {
	name  string
	value any
}

func arguments(c *pb.FunctionCall) ([]any, []keyword, error) {
	a, err := validateArena(c.Values)
	if err != nil {
		return nil, nil, err
	}
	kw := make([]uint32, 0, 2*len(c.Kwargs))
	for _, pair := range c.Kwargs {
		kw = append(kw, pair.Key, pair.Value)
	}
	if err := a.roots(c.Args, kw); err != nil {
		return nil, nil, err
	}
	args := make([]any, len(c.Args))
	for i, id := range c.Args {
		args[i] = a.jsonValue(id)
	}
	kwargs := make([]keyword, len(c.Kwargs))
	for i, pair := range c.Kwargs {
		key, ok := a.nodes[pair.Key].Kind.(*pb.MontyNode_Str)
		if !ok {
			return nil, nil, errors.New("worker keyword name is not a string")
		}
		kwargs[i] = keyword{key.Str, a.jsonValue(pair.Value)}
	}
	return args, kwargs, nil
}

func (w *worker) callNested(nested nestedFunc, name string, input any) (modular.ToolResult, error) {
	type reply struct {
		result modular.ToolResult
		err    error
	}
	answered := make(chan reply, 1)
	go func() {
		result, err := nested(w.ctx, name, input)
		answered <- reply{result, err}
	}()
	select {
	case r := <-answered:
		return r.result, r.err
	case <-w.ctx.Done():
		return modular.ToolResult{}, w.ctx.Err()
	}
}

func exceptionName(s string) bool {
	if s == "" || len(s) > 128 {
		return false
	}
	for _, name := range strings.Split(s, ".") {
		if name == "" || identifier(name) != name {
			return false
		}
	}
	return true
}

func raisedError(e *pb.RaisedException) error {
	if e == nil || !exceptionName(e.ExcType) {
		return protocolError("missing or invalid worker exception")
	}
	// Keep the reason last, as Monty does, so truncation can put it first.
	var out strings.Builder
	if len(e.Traceback) > 1 {
		out.WriteString("Traceback (most recent call last):\n")
	}
	for _, frame := range e.Traceback {
		if frame.Start == nil || frame.End == nil {
			return protocolError("missing exception location")
		}
		fmt.Fprintf(&out, "  File %q, line %d", frame.Filename, frame.Start.Line)
		if !frame.HideFrameName {
			name := "<module>"
			if frame.FrameName != nil {
				name = *frame.FrameName
			}
			fmt.Fprintf(&out, ", in %s", name)
		}
		out.WriteByte('\n')
		if frame.PreviewLine != nil {
			fmt.Fprintf(&out, "    %s\n", *frame.PreviewLine)
		}
	}
	out.WriteString(e.ExcType)
	if e.GetMessage() != "" {
		out.WriteString(": ")
		out.WriteString(e.GetMessage())
	}
	return errors.New(out.String())
}
