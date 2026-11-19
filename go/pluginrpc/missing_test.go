package pluginrpc_test

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"modular/api"
	"modular/internal/runtimetest"
	"modular/pluginrpc"
	"modular/vanilla"
	"testing"
	"time"
)

func TestRPCMissingFileIdentityUsesCodeNotMessage(t *testing.T) {
	for _, tc := range []struct {
		code, message string
		missing       bool
	}{
		{"not_found", "archivo ausente", true},
		{"internal", "No such file or directory", false},
		{"internal", "not_found", false},
	} {
		t.Run(tc.code+"/"+tc.message, func(t *testing.T) {
			err := &pluginrpc.RPCError{Number: -32000, Message: tc.message}
			err.Data.Code = tc.code
			wrapped := fmt.Errorf("environment: %w", err)
			if errors.Is(wrapped, fs.ErrNotExist) != tc.missing || pluginrpc.Code(wrapped) != tc.code {
				t.Fatal("incorrect missing-file identity", wrapped)
			}
		})
	}
}

func TestMissingProjectInstructionsAcrossEnvironments(t *testing.T) {
	for _, environment := range []string{"local", "missing-environment", "broken-environment"} {
		t.Run(environment, func(t *testing.T) {
			specs := []any{childSpec("probe", "")}
			if environment != "local" {
				specs = append(specs, childSpec(environment, ""))
			}
			t.Setenv("MODULAR_AGENT_PLUGINS", string(api.JSON(specs)))
			runtimetest.Each(t, func(t *testing.T) {
				opt := options(t)
				opt.Runtime = runtimetest.Plugin(t)
				h, err := vanilla.New(opt)
				if err != nil {
					t.Fatal(err)
				}
				defer h.Close()
				a := h.API()
				capability, err := a.Get("working-environment")
				if err != nil {
					t.Fatal(err)
				}
				id, err := a.New(context.Background(), opt.Project)
				if err != nil {
					t.Fatal(err)
				}
				// The external fixture claims exists=true, then answers the read
				// with not_found: only the read's code is authoritative.
				ctx := api.WithExecution(context.Background(), api.Execution{Session: id})
				_, err = capability.(api.WorkingEnvironment).Read(ctx, opt.Project, "AGENTS.md")
				missing := environment != "broken-environment"
				if err == nil || errors.Is(err, fs.ErrNotExist) != missing {
					t.Error("local and external missing files must have the same identity", err)
				}
				// A different external process asks the host to read the same
				// file, exercising local and externally routed host/env/read.
				r, err := a.CallTool(context.Background(), id, api.Call{Name: "probe", Input: api.JSON(map[string]any{"readMissing": true})})
				wantCode := "not_found"
				if !missing {
					wantCode = "internal"
				}
				if err != nil || r.Status != "completed" || r.Content.Text() != wantCode {
					t.Error("host/env/read did not preserve the error code", r, err)
				}
				if _, err = a.Submit(context.Background(), id, api.Input{Content: api.Text("hello")}); err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				out, err := a.Wait(ctx, id)
				if err != nil {
					t.Fatal(err)
				}
				if missing {
					if out.Status != "completed" || out.Result.Text() != "echo: hello" {
						t.Fatal("missing AGENTS.md must not prevent a turn", out)
					}
				} else if out.Status != "failed" {
					t.Fatal("other instruction-read failures must not be ignored", out)
				}
			})
		})
	}
}
