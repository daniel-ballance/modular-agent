package guardrail_test

import (
	"context"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/configuration"
	"github.com/daniel-ballance/modular-agent/go/contextview"
	"github.com/daniel-ballance/modular-agent/go/fake"
	"github.com/daniel-ballance/modular-agent/go/guardrail"
	"github.com/daniel-ballance/modular-agent/go/harness"
	"github.com/daniel-ballance/modular-agent/go/internal/runtimetest"
	"github.com/daniel-ballance/modular-agent/go/modelselect"
	"strings"
	"sync"
	"testing"
)

func TestSecretSplitAcrossChunksIsHeldAndRedactedButRecordStaysRaw(t *testing.T) {
	runtimetest.Each(t, testSecretSplitAcrossChunksIsHeldAndRedactedButRecordStaysRaw)
}
func testSecretSplitAcrossChunksIsHeldAndRedactedButRecordStaysRaw(t *testing.T) {
	h := harness.New()
	defer h.Close()
	p := fake.New(fake.Script{Chunks: []api.Part{{Type: "text", Text: "token: sec"}, {Type: "text", Text: "ret-value!"}}, Response: api.Response{Content: api.Text("token: secret-value!"), Stop: "finished"}})
	for _, plugin := range []api.Plugin{configuration.Plugin("", api.Settings{Model: "fake", Thinking: "off", MaxSteps: 3, MaxOutput: 100}), p.Plugin(), modelselect.Plugin(), runtimetest.Plugin(t), contextview.Plugin(), guardrail.Plugin([]string{"secret-value"})} {
		if err := h.Load(plugin); err != nil {
			t.Fatal(err)
		}
	}
	id, err := h.API().New(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var received []api.Event
	h.API().Subscribe(func(e api.Event) { mu.Lock(); received = append(received, e); mu.Unlock() })
	_, err = h.API().Submit(context.Background(), id, api.Input{Content: api.Text("hello")})
	if err != nil {
		t.Fatal(err)
	}
	out, err := h.API().Wait(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.Result.Text(), "secret-value") {
		t.Fatal("outcome bypassed gate")
	}
	mu.Lock()
	for _, e := range received {
		b := string(api.JSON(e))
		if strings.Contains(b, "secret-value") || strings.Contains(b, "token: sec") {
			mu.Unlock()
			t.Fatal("event leaked", b)
		}
	}
	mu.Unlock()
	raw, _ := h.API().Snapshot(id)
	found := false
	for _, e := range raw.Entries {
		if e.Kind == "model" && e.Content.Text() == "token: secret-value!" {
			found = true
		}
	}
	if !found {
		t.Fatal("raw record changed")
	}
	view, err := h.API().View(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(api.JSON(view)), "secret-value") {
		t.Fatal("view bypassed gate")
	}
}
