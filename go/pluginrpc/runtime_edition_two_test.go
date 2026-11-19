package pluginrpc_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"modular/api"
	"modular/fake"
	"modular/portable"
	"modular/resultcheck"
	"modular/vanilla"
)

func TestHostedResultFeedbackIsCommittedAndProjectedOnce(t *testing.T) {
	t.Setenv("MODULAR_AGENT_PLUGINS", string(api.JSON([]any{childSpec("conformance", "runtime")})))
	response := func(s string) fake.Script {
		return fake.Script{Response: api.Response{Stop: "finished", Content: api.Text(s), Usage: api.Usage{Input: 2}}}
	}
	provider := fake.New(response("first"), response("revised"))
	opt := options(t)
	opt.Provider, opt.Model = provider.Plugin(), "fake"
	h, err := vanilla.New(opt)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	const reason = "revise the fixture result"
	if err := h.Load(resultcheck.Plugin(func(c api.Content) string {
		if c.Text() == "first" {
			return reason
		}
		return ""
	})); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	a := h.API()
	id, err := a.New(ctx, opt.Project)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.Submit(ctx, id, api.Input{Content: api.Text("begin fixture")}); err != nil {
		t.Fatal(err)
	}
	out, err := a.Wait(ctx, id)
	if err != nil || out.Status != "completed" || out.Result.Text() != "revised" || out.Steps != 2 || out.Usage.Input != 4 {
		t.Fatal(out, err)
	}
	req := provider.Requests()
	if len(req) != 2 {
		t.Fatalf("requests: %d", len(req))
	}
	found := 0
	for _, m := range req[1].Messages {
		if strings.Contains(m.Content.Text(), reason) && m.Role == "user" {
			found++
		}
	}
	if found != 1 {
		t.Fatalf("got %d feedback messages", found)
	}
	snap, err := a.Snapshot(id)
	if err != nil {
		t.Fatal(err)
	}
	var feedback string
	for _, e := range snap.Branch() {
		if e.Kind == "resultFeedback" {
			if feedback != "" || portable.Entry(e)["kind"] != "resultFeedback" {
				t.Fatal(e)
			}
			feedback = e.ID
		}
		if e.Kind == "model.request" && feedback != "" {
			for _, source := range e.Copies {
				if source == feedback {
					return
				}
			}
			t.Fatal("retry is not linked to its feedback")
		}
	}
	t.Fatal("no committed feedback before the retry intent")
}
