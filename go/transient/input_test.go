package transient_test

import (
	"context"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/fake"
	"github.com/OWNER/modular-agent/go/internal/runtimetest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSteeringJoinsNextStepAndFollowUpStartsAnotherTurn(t *testing.T) {
	runtimetest.Each(t, testSteeringJoinsNextStepAndFollowUpStartsAnotherTurn)
}
func testSteeringJoinsNextStepAndFollowUpStartsAnotherTurn(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	a, p, id := setup(t, fake.Script{Run: func(ctx context.Context, _ api.Request, _ func(api.Part)) (api.Response, error) {
		close(started)
		select {
		case <-release:
		case <-ctx.Done():
			return api.Response{}, ctx.Err()
		}
		return api.Response{Content: api.Text("first"), Stop: "finished"}, nil
	}},
		fake.Script{Response: api.Response{Content: api.Text("steered"), Stop: "finished"}},
		fake.Script{Response: api.Response{Content: api.Text("followed"), Stop: "finished"}})
	_, err := a.Submit(context.Background(), id, api.Input{Key: "original", Content: api.Text("start")})
	if err != nil {
		t.Fatal(err)
	}
	<-started
	steer, err := a.Submit(context.Background(), id, api.Input{Key: "steer", When: "steer", Content: api.Text("change direction")})
	if err != nil {
		t.Fatal(err)
	}
	duplicate, err := a.Submit(context.Background(), id, api.Input{Key: "steer", When: "steer", Content: api.Text("different retry")})
	if err != nil || !duplicate.Duplicate || duplicate.ID != steer.ID {
		t.Fatal(duplicate, err)
	}
	_, err = a.Submit(context.Background(), id, api.Input{When: "after", Content: api.Text("follow up")})
	if err != nil {
		t.Fatal(err)
	}
	close(release)
	out, err := a.Wait(context.Background(), id)
	if err != nil || out.Result.Text() != "followed" {
		t.Fatal(out, err)
	}
	req := p.Requests()
	if len(req) != 3 {
		t.Fatal(len(req))
	}
	text := ""
	for _, m := range req[1].Messages {
		text += m.Content.Text()
	}
	if !strings.Contains(text, "change direction") || strings.Contains(text, "follow up") {
		t.Fatal(text)
	}
	snap, _ := a.Snapshot(id)
	turns := 0
	for _, e := range snap.Entries {
		if e.Kind == "turn.start" {
			turns++
		}
	}
	if turns != 2 {
		t.Fatal(turns)
	}
}
func TestCancelSettlesAllCallsAndReturnsQueuedInput(t *testing.T) {
	runtimetest.Each(t, testCancelSettlesAllCallsAndReturnsQueuedInput)
}
func testCancelSettlesAllCallsAndReturnsQueuedInput(t *testing.T) {
	a, _, id := setup(t, fake.Script{Response: api.Response{Content: api.Content{
		{Type: "tool_call", Call: &api.Call{ID: "foreground", Name: "bash", Input: api.JSON(map[string]string{"command": "printf ready; exec sleep 60"})}},
		{Type: "tool_call", Call: &api.Call{ID: "not-yet", Name: "write", Input: api.JSON(map[string]string{"path": "must-not-exist", "content": "wrong"})}},
	}, Stop: "tools"}})
	ready := make(chan struct{}, 1)
	stop := a.Subscribe(func(e api.Event) {
		if e.Kind == "tool.progress" {
			select {
			case ready <- struct{}{}:
			default:
			}
		}
	})
	defer stop()
	_, err := a.Submit(context.Background(), id, api.Input{Content: api.Text("go")})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-ready:
	case <-time.After(3 * time.Second):
		snap, _ := a.Snapshot(id)
		t.Fatal("command not started", string(api.JSON(snap)))
	}
	for _, when := range []string{"steer", "after"} {
		if _, err = a.Submit(context.Background(), id, api.Input{When: when, Content: api.Text(when)}); err != nil {
			t.Fatal(err)
		}
	}
	if err = a.Cancel(id); err != nil {
		t.Fatal(err)
	}
	out, err := a.Wait(context.Background(), id)
	if err != nil || out.Status != "cancelled" || len(out.Returned) != 2 {
		t.Fatal(out, err)
	}
	snap, _ := a.Snapshot(id)
	results := map[string]int{}
	for _, e := range snap.Entries {
		if e.Kind == "tool.result" {
			r := api.Decode[api.ToolResult](e.Data)
			if r.Status != "cancelled" {
				t.Fatal(r)
			}
			results[r.Call]++
		}
	}
	if results["foreground"] != 1 || results["not-yet"] != 1 {
		t.Fatal(results)
	}
	if _, err = os.Stat(filepath.Join(snap.Project, "must-not-exist")); !os.IsNotExist(err) {
		t.Fatal("cancelled call ran")
	}
}
func TestWithdrawQueuedInputAndCancelDoesNotKillEarlierBackgroundWork(t *testing.T) {
	runtimetest.Each(t, testWithdrawQueuedInputAndCancelDoesNotKillEarlierBackgroundWork)
}
func testWithdrawQueuedInputAndCancelDoesNotKillEarlierBackgroundWork(t *testing.T) {
	started := make(chan struct{})
	a, _, id := setup(t,
		fake.Script{Response: api.Response{Content: api.Content{{Type: "tool_call", Call: &api.Call{ID: "background", Name: "bash", Input: api.JSON(map[string]string{"command": "(sleep 0.2; printf survived > survived.txt) &"})}}}, Stop: "tools"}},
		fake.Script{Run: func(ctx context.Context, _ api.Request, _ func(api.Part)) (api.Response, error) {
			close(started)
			<-ctx.Done()
			return api.Response{}, ctx.Err()
		}})
	_, err := a.Submit(context.Background(), id, api.Input{Content: api.Text("go")})
	if err != nil {
		t.Fatal(err)
	}
	<-started
	receipt, err := a.Submit(context.Background(), id, api.Input{When: "after", Content: api.Text("withdraw me")})
	if err != nil {
		t.Fatal(err)
	}
	in, err := a.Withdraw(context.Background(), id, receipt.ID)
	if err != nil || in.Content.Text() != "withdraw me" {
		t.Fatal(in, err)
	}
	_ = a.Cancel(id)
	out, err := a.Wait(context.Background(), id)
	if err != nil || len(out.Returned) != 0 {
		t.Fatal(out, err)
	}
	snap, _ := a.Snapshot(id)
	deadline := time.Now().Add(2 * time.Second)
	for {
		b, err := os.ReadFile(filepath.Join(snap.Project, "survived.txt"))
		if err == nil {
			if string(b) != "survived" {
				t.Fatal(string(b))
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("background work was killed by turn cancellation")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
func TestWriteEditReadAndBashThroughRuntime(t *testing.T) {
	runtimetest.Each(t, testWriteEditReadAndBashThroughRuntime)
}
func testWriteEditReadAndBashThroughRuntime(t *testing.T) {
	var parts api.Content
	for i, item := range []struct {
		name string
		args map[string]string
	}{
		{"write", map[string]string{"path": "file", "content": "old"}},
		{"edit", map[string]string{"path": "file", "old": "old", "new": "new"}},
		{"read", map[string]string{"path": "file"}},
		{"bash", map[string]string{"command": "pwd"}},
	} {
		parts = append(parts, api.Part{Type: "tool_call", Call: &api.Call{ID: string(rune('a' + i)), Name: item.name, Input: api.JSON(item.args)}})
	}
	a, p, id := setup(t, fake.Script{Response: api.Response{Content: parts, Stop: "tools"}}, fake.Script{Response: api.Response{Content: api.Text("done"), Stop: "finished"}})
	out := run(t, a, id, "go")
	if out.Status != "completed" {
		t.Fatal(out)
	}
	req := p.Requests()[1]
	var results []api.ToolResult
	for _, m := range req.Messages {
		if m.Result != nil {
			results = append(results, *m.Result)
		}
	}
	if len(results) != 4 || results[2].Content.Text() != "new" {
		t.Fatal(results)
	}
	snap, _ := a.Snapshot(id)
	if strings.TrimSpace(results[3].Content.Text()) != snap.Project {
		t.Fatal(results[3])
	}
}
