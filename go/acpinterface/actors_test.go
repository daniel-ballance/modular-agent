package acpinterface_test

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/conformancemodel"
	"github.com/daniel-ballance/modular-agent/go/durable"
	"github.com/daniel-ballance/modular-agent/go/vanilla"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	acp "github.com/caelis-labs/acp-go-sdk"
)

func TestACPProposalKeepsProposerAuthorityAfterReopening(t *testing.T) {
	t.Setenv("MODULAR_AGENT_ACP_REPRESENTS", `["guest"]`)
	root, state := t.TempDir(), t.TempDir()
	options := vanilla.Options{Project: root, History: state, Provider: conformancemodel.Plugin(), Model: conformancemodel.ID, Runtime: durable.Plugin()}
	ctx := timeout(t)
	first, err := vanilla.New(options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { first.Close() })
	conn, _ := connection(t, first.API(), &client{})
	initClient(t, conn, false)
	start, err := conn.NewSession(ctx, acp.NewSessionRequest{Cwd: root})
	if err != nil {
		t.Fatal(err)
	}
	call := func(method string, args map[string]any) map[string]any {
		t.Helper()
		args["sessionId"] = start.SessionId
		raw, err := conn.CallExtension(ctx, "_modular-agent/"+method, args)
		if err != nil {
			t.Fatal(method, err)
		}
		return api.Decode[map[string]any](raw)
	}
	call("join", map[string]any{"actor": api.Actor{ID: "guest", Kind: "user", Rights: []string{"watch", "propose"}}})
	const content = `tool:bash {"command":"echo should-not-run > guest.txt"}`
	proposal := call("input", map[string]any{"actorId": "guest", "when": "propose", "content": content, "key": "proposal"})
	if proposal["taken"] != "proposed" || proposal["inputId"] == "" {
		t.Fatalf("bad proposal receipt: %+v", proposal)
	}
	if _, err = conn.CloseSession(ctx, acp.CloseSessionRequest{SessionId: start.SessionId}); err != nil {
		t.Fatal(err)
	}
	if err = first.Close(); err != nil {
		t.Fatal(err)
	}

	second, err := vanilla.New(options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { second.Close() })
	conn, _ = connection(t, second.API(), &client{})
	initClient(t, conn, false)
	if _, err = conn.ResumeSession(ctx, acp.ResumeSessionRequest{SessionId: start.SessionId, Cwd: root}); err != nil {
		t.Fatal(err)
	}
	if out, err := second.API().Wait(ctx, string(start.SessionId)); err != nil || out.Status != "" {
		t.Fatalf("proposal ran before release: %+v %v", out, err)
	}
	// The delegate still can't submit ordinary input, even using a known key.
	_, err = conn.CallExtension(ctx, "_modular-agent/input", map[string]any{"sessionId": start.SessionId, "actorId": "guest", "when": "now", "content": content, "key": "proposal"})
	var invalid *acp.RequestError
	if !errors.As(err, &invalid) || invalid.Code != -32602 {
		t.Fatal("input authorization was bypassed", err)
	}
	if r := call("release", map[string]any{"inputId": proposal["inputId"], "when": "now"}); r["taken"] != "now" || r["inputId"] != proposal["inputId"] {
		t.Fatalf("bad release receipt: %+v", r)
	}
	if out, err := second.API().Wait(ctx, string(start.SessionId)); err != nil || out.Status != "completed" {
		t.Fatalf("released input failed: %+v %v", out, err)
	}
	if _, err = os.Stat(filepath.Join(root, "guest.txt")); !os.IsNotExist(err) {
		t.Fatal("host authority widened the guest's rights", err)
	}
	view := call("history", map[string]any{})
	sawRelease, sawInput := false, false
	for _, item := range view["entries"].([]any) {
		e := item.(map[string]any)
		if e["actorId"] != "guest" {
			continue
		}
		switch e["kind"] {
		case "inputAccepted":
			d := e["data"].(map[string]any)
			if d["releasedBy"] == "local-user" && e["inputId"] == proposal["inputId"] {
				sawRelease = true
			}
		case "input":
			sawInput = true
		}
	}
	if !sawRelease || !sawInput {
		t.Fatal("proposal/release provenance missing", sawRelease, sawInput)
	}
}

func TestACPPromptQueuesBehindReleasedActorTurn(t *testing.T) {
	t.Setenv("MODULAR_AGENT_ACP_REPRESENTS", `["guest"]`)
	root := t.TempDir()
	h, err := vanilla.New(vanilla.Options{Project: root, History: t.TempDir(), Provider: conformancemodel.Plugin(), Model: conformancemodel.ID, Runtime: durable.Plugin()})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	ending, unblock := make(chan struct{}), make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(unblock) }) }
	defer release()
	if err := h.Load(api.Plugin{Name: "test-turn-ending", Setup: func(a api.API) error {
		return a.Handle("runtime.turn.end", "", func(_ context.Context, value any) (api.Decision, error) {
			if value.(api.Outcome).Result.Text() == "echo: guest" {
				close(ending)
				<-unblock
			}
			return api.Decision{}, nil
		})
	}}); err != nil {
		t.Fatal(err)
	}
	conn, _ := connection(t, h.API(), &client{})
	initClient(t, conn, false)
	ctx := timeout(t)
	start, err := conn.NewSession(ctx, acp.NewSessionRequest{Cwd: root})
	if err != nil {
		t.Fatal(err)
	}
	call := func(method string, params map[string]any) map[string]any {
		t.Helper()
		params["sessionId"] = start.SessionId
		raw, err := conn.CallExtension(ctx, "_modular-agent/"+method, params)
		if err != nil {
			t.Fatal(method, err)
		}
		return api.Decode[map[string]any](raw)
	}
	call("join", map[string]any{"actor": api.Actor{ID: "guest", Kind: "user", Rights: []string{"propose"}}})
	guest := call("input", map[string]any{"actorId": "guest", "when": "propose", "content": "guest"})
	call("release", map[string]any{"inputId": guest["inputId"], "when": "now"})
	select {
	case <-ending:
	case <-ctx.Done():
		t.Fatal("released turn did not reach its end hook")
	}

	done := make(chan error, 1)
	go func() {
		r, e := conn.Prompt(ctx, acp.PromptRequest{SessionId: start.SessionId, Prompt: []acp.ContentBlock{acp.TextBlock("host reply")}, Meta: map[string]json.RawMessage{"modular-agent": api.JSON(map[string]string{"key": "host-reply"})}})
		if e == nil && r.StopReason != acp.StopReasonEndTurn {
			e = errors.New("queued prompt did not complete")
		}
		done <- e
	}()
	for {
		select {
		case err := <-done:
			t.Fatalf("prompt returned before the earlier turn finished: %v", err)
		case <-ctx.Done():
			t.Fatal("prompt was not queued")
		case <-time.After(5 * time.Millisecond):
		}
		snap, err := h.API().Snapshot(string(start.SessionId))
		if err != nil {
			t.Fatal(err)
		}
		queued := false
		for _, e := range snap.Entries {
			if e.Kind == "input.accepted" && api.Decode[api.Input](e.Data).Key == "host-reply" {
				queued = true
				break
			}
		}
		if queued {
			break
		}
	}
	release()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
