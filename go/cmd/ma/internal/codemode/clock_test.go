package codemode

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	pb "github.com/daniel-ballance/modular-agent/go/cmd/ma/internal/codemode/protocol"
	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/files"
)

func TestComputeBudgetAcrossSuspensions(t *testing.T) {
	call := func(name, arg string) *pb.WorkerEvent {
		return &pb.WorkerEvent{Kind: &pb.WorkerEvent_FunctionCall{FunctionCall: &pb.FunctionCall{
			FunctionName: name, Values: &pb.Arena{Nodes: []*pb.MontyNode{stringNode(arg)}}, Args: []uint32{0},
		}}}
	}
	complete := &pb.WorkerEvent{Kind: &pb.WorkerEvent_Complete{Complete: &pb.Complete{
		Values: &pb.Arena{Nodes: []*pb.MontyNode{stringNode("done")}},
	}}, FeedExecutionMicros: 31_000_000}
	failure := &pb.WorkerEvent{Kind: &pb.WorkerEvent_Error{Error: &pb.Error{
		Exception: &pb.RaisedException{ExcType: "ValueError"},
	}}, FeedExecutionMicros: 31_000_000}
	fs, err := catalog([]modular.ToolDefinition{files.Tools("")[0].Definition()})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name       string
		suspension *pb.WorkerEvent
		end        *pb.WorkerEvent
		reset      bool
	}{
		{"import", &pb.WorkerEvent{Kind: &pb.WorkerEvent_OsCall{OsCall: &pb.OsCall{Call: &pb.OsCall_Import_{
			Import: &pb.OsCall_Import{Module: "tools"},
		}}}}, complete, false},
		{"name lookup", &pb.WorkerEvent{Kind: &pb.WorkerEvent_NameLookup{NameLookup: &pb.NameLookup{Name: "describe_tool"}}}, complete, false},
		{"describe_tool", call("describe_tool", "read"), complete, false},
		{"search_tools", call("search_tools", "read"), complete, false},
		{"bad arguments", call("tools.read", ""), failure, false},
		{"nested call", call("tools.read", "fixture"), complete, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.name == "bad arguments" {
				tc.suspension.GetFunctionCall().Args = nil
			}
			tc.suspension.FeedExecutionMicros = 25_000_000
			w := &worker{ctx: t.Context()}
			var printed strings.Builder
			step := 0
			value, made, err := w.drive("", fs, func(context.Context, string, any) (modular.ToolResult, error) {
				return modular.ToolResult{Status: modular.Completed}, nil
			}, StandardLimits(), &printed, func(req *pb.ClientRequest, timeout time.Duration, _ *strings.Builder, _ int) (*pb.WorkerEvent, error) {
				step++
				switch step {
				case 1:
					cfg := req.GetConfigure()
					if cfg.ExecutionClock == nil || cfg.GetExecutionClock() != pb.ExecutionClock_WALL || cfg.GetLimits().GetMaxTurnDurationMicros() != 30_000_000 {
						t.Fatalf("expected a 30-second wall-clock budget, got %v", cfg)
					}
					return &pb.WorkerEvent{Kind: &pb.WorkerEvent_Ok{Ok: &pb.Ok{}}, ExecutionClock: pb.ExecutionClock_WALL.Enum()}, nil
				case 2:
					return tc.suspension, nil
				case 3:
					want := 5 * time.Second
					if tc.reset {
						want = 30 * time.Second
					}
					if timeout-pipeAllowance != want {
						t.Fatalf("remaining active time: %v, want %v", timeout-pipeAllowance, want)
					}
					return tc.end, nil
				default:
					t.Fatal("unexpected request after run completed")
					return nil, nil
				}
			})
			if tc.reset {
				if err != nil || made != 1 || value.text() != "done" {
					t.Fatalf("after nested call: value=%v calls=%d error=%v", value, made, err)
				}
			} else if !errors.Is(err, errCompute) || made != 0 {
				t.Fatalf("after suspension: calls=%d error=%v, want timeout", made, err)
			}
		})
	}
}
