package pluginrpc

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/conformancemodel"
	"io"
	"net"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestHistoryPageLimitsAndCursors(t *testing.T) {
	entries := []api.Entry{{ID: "root"}, {ID: "off-branch", Parent: "root"}, {ID: "head", Parent: "root"}}
	s := api.Session{Position: "head", Entries: entries}
	for _, raw := range []string{`{"limit":0}`, `{"limit":-1}`, `{"limit":501}`, `{"limit":1.5}`, `{"limit":"1"}`, `{"after":"off-branch"}`, `{"after":""}`, `{"after":4}`} {
		if _, err := historyPage(s, obj([]byte(raw))); Code(err) != "invalid_request" {
			t.Errorf("%s: %v", raw, err)
		}
	}
	page, err := historyPage(s, obj([]byte(`{"limit":1}`)))
	if err != nil || str(asObject(page), "next") != "root" {
		t.Fatal(page, err)
	}
	page, err = historyPage(s, obj([]byte(`{"all":true,"after":"off-branch"}`)))
	if err != nil || has(asObject(page), "next") || !strings.Contains(string(mustJSON(page)), `"id":"head"`) {
		t.Fatal(page, err)
	}
}

func TestHistoryPageMeasuresActualJSONAndDoesNotSkipAnEntry(t *testing.T) {
	entries := []api.Entry{{ID: "small"}, {ID: "long", Data: api.JSON(strings.Repeat("<", 700000))}, {ID: "also-small"}}
	s := api.Session{Entries: entries}
	page, err := historyPage(s, object{"all": true})
	if err != nil || str(asObject(page), "next") != "small" || len(mustJSON(page)) > maxHistoryPage {
		t.Fatal(page, err)
	}
	if _, err := historyPage(s, object{"all": true, "after": "small"}); Code(err) != "result_too_large" {
		t.Fatal(err)
	}
}

func TestHistoryPageCountsResultAndCursorNotEnvelope(t *testing.T) {
	e := api.Entry{ID: "cursor-\"界", Kind: "test.payload", Data: json.RawMessage(`""`)}
	cursorSize := len(mustJSON(object{"entries": []object{entryOut(e)}, "next": e.ID}))
	e.Data = mustJSON(strings.Repeat("x", maxHistoryPage-cursorSize))
	s := api.Session{Entries: []api.Entry{e, {ID: "tail", Parent: e.ID}}, Position: "tail"}
	page, err := historyPage(s, obj([]byte(`{"limit":1}`)))
	if err != nil || len(mustJSON(page)) != maxHistoryPage || str(asObject(page), "next") != e.ID {
		t.Fatalf("exact boundary: size %d, error %v", len(mustJSON(page)), err)
	}
	s.Entries[0].Data = mustJSON(strings.Repeat("x", maxHistoryPage-cursorSize+1))
	page, err = historyPage(s, object{})
	if err != nil || len(mustJSON(page)) != maxHistoryPage+1 || str(asObject(page), "next") != e.ID {
		t.Fatalf("one byte over with cursor: %v", err)
	}
}

type probeStateProvider struct {
	api.Provider
	calls chan string
}

func (p *probeStateProvider) Discard(_ context.Context, session string) error {
	p.calls <- "discard " + session
	return nil
}
func (p *probeStateProvider) EraseState(_ context.Context, session string, entries []string) (api.ProviderErasure, error) {
	p.calls <- "erase " + session + " " + strings.Join(entries, ",")
	return api.ProviderErasure{Pending: entries[:1], OutOfReach: []string{"vendor logs"}}, nil
}

func TestServerProviderEraseAndCompleteResponseHook(t *testing.T) {
	provider := &probeStateProvider{Provider: conformancemodel.New(), calls: make(chan string, 2)}
	s := &Server{Registration: Registration{Binding: Binding, Name: "test"}, Providers: map[string]api.Provider{"conformance": provider}}
	left, right := net.Pipe()
	p := NewPeer(left, left)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.Serve(ctx, right, right) }()
	defer func() { p.Close(); <-done }()
	events := make(chan string, 50)
	p.Notify = func(method string, raw json.RawMessage) {
		if method == "provider/event" {
			events <- str(asObject(obj(raw)["event"]), "delta")
		}
	}
	p.requestBarrier = hostRequestBarrier
	hookCalls := make(chan object, 4)
	p.Handle = func(_ context.Context, method string, raw json.RawMessage) (any, error) {
		if method != "host/hook" {
			return nil, unknownMethod(method)
		}
		v := obj(raw)
		switch str(v, "hook") {
		case "provider.request":
			return v["payload"], nil
		case "provider.response":
			payload := asObject(v["payload"])
			pieces := ""
			for len(events) != 0 {
				pieces += <-events
			}
			if len(payload) != 4 || !has(payload, "sessionId") || !has(payload, "provider") || !has(payload, "model") || !has(payload, "message") {
				return nil, fault("invalid_request", "noncanonical provider.response")
			}
			payload["testStreamedText"] = pieces
			hookCalls <- payload
			return nil, nil
		}
		return nil, unknownMethod(str(v, "hook"))
	}
	go func() { _ = p.Run() }()
	if err := p.Call(ctx, "plugin/initialize", object{"binding": Binding, "data": DataBinding, "project": t.TempDir(), "home": t.TempDir()}, nil); err != nil {
		t.Fatal(err)
	}
	params := object{"provider": "conformance", "sessionId": "s1"}
	if err := p.Call(ctx, "provider/discard", params, nil); err != nil {
		t.Fatal(err)
	}
	params["erase"] = true
	if err := p.Call(ctx, "provider/discard", params, nil); Code(err) != "invalid_request" {
		t.Fatalf("expected missing entryIds to be refused: %v", err)
	}
	params["entryIds"] = []string{"copy1", "copy2"}
	var report api.ProviderErasure
	if err := p.Call(ctx, "provider/discard", params, &report); err != nil {
		t.Fatal(err)
	}
	if len(provider.calls) != 2 || <-provider.calls != "discard s1" || <-provider.calls != "erase s1 copy1,copy2" || !slices.Equal(report.Pending, []string{"copy1"}) || !slices.Equal(report.OutOfReach, []string{"vendor logs"}) {
		t.Fatal(report)
	}
	params = object{"provider": "conformance", "sessionId": "s1", "model": object{"provider": "conformance", "id": "echo"}, "request": object{"messages": []any{object{"role": "user", "content": contentOut(api.Text("héllo"))}}}}
	var result object
	if err := p.Call(ctx, "provider/request", params, &result); err != nil {
		t.Fatal(err)
	}
	if len(hookCalls) != 1 {
		t.Fatal("expected one response hook before the result", len(hookCalls))
	}
	payload := <-hookCalls
	if !slices.Equal(mustJSON(payload["message"]), mustJSON(result)) || str(payload, "testStreamedText") != "echo: héllo" {
		t.Fatal(payload, result)
	}
}

func TestServerExitsOnEOFWithAHandlerStillRunning(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	defer close(release)
	s := &Server{Registration: Registration{Binding: Binding, Name: "test"}, Commands: map[string]func(context.Context, object) (any, error){
		"hold": func(context.Context, object) (any, error) {
			close(started)
			<-release
			return nil, nil
		},
	}}
	left, right := net.Pipe()
	defer right.Close()
	p := NewPeer(left, left)
	defer p.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.Serve(ctx, right, right) }()
	go func() { _ = p.Run() }()
	if err := p.Call(ctx, "plugin/initialize", object{"binding": Binding, "data": DataBinding, "project": t.TempDir(), "home": t.TempDir()}, nil); err != nil {
		t.Fatal(err)
	}
	go func() { _ = p.Call(ctx, "command/run", object{"name": "hold"}, nil) }()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("handler did not start")
	}
	p.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("server did not return on EOF")
	}
}

func TestPeerReadsCancellationAndTracksParentsWhileNotificationsRun(t *testing.T) {
	left, right := net.Pipe()
	defer right.Close()
	p := NewPeer(left, left)
	defer p.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = right.SetDeadline(time.Now().Add(5 * time.Second))
	pause, resume := make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-resume:
		default:
			close(resume)
		}
	}()
	p.notify = func(ctx context.Context, method string, raw json.RawMessage) {
		close(pause)
		<-resume
	}
	p.Handle = func(ctx context.Context, method string, raw json.RawMessage) (any, error) {
		if method == "host/cancel-this" {
			<-ctx.Done()
			return nil, ctx.Err()
		}
		if _, live := p.requestParent(ctx, mustJSON(obj(raw)["parentRequestId"])); !live {
			return nil, fault("invalid_request", "stale parent")
		}
		return "live parent", nil
	}
	go func() { _ = p.Run() }()
	result := make(chan error, 1)
	go func() { result <- p.Call(ctx, "parent", nil, nil) }()
	scan := bufio.NewScanner(right)
	if !scan.Scan() {
		t.Fatal(scan.Err())
	}
	id := string(mustJSON(obj(scan.Bytes())["id"]))
	frames := []string{
		fmt.Sprintf(`{"jsonrpc":"2.0","method":"pause","params":{"parentRequestId":%s}}`, id),
		fmt.Sprintf(`{"jsonrpc":"2.0","id":"before","method":"host/check","params":{"parentRequestId":%s}}`, id),
		fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"result":null}`, id),
		fmt.Sprintf(`{"jsonrpc":"2.0","id":"after","method":"host/check","params":{"parentRequestId":%s}}`, id),
		`{"jsonrpc":"2.0","id":"cancelled","method":"host/cancel-this"}`,
		`{"jsonrpc":"2.0","method":"$/cancel","params":{"id":"cancelled"}}`,
		`{"jsonrpc":"2.0","id":"tail","method":"$/ping"}`,
	}
	if _, err := io.WriteString(right, strings.Join(frames, "\n")+"\n"); err != nil {
		t.Fatal("reader stopped behind the notification", err)
	}
	<-pause
	// Independent callbacks, ping and cancellation must complete even while
	// the answer belonging to the paused stream is held at its barrier.
	answers := map[string]envelope{}
	for i := 0; i < 4; i++ {
		if !scan.Scan() {
			t.Fatal(scan.Err())
		}
		var m envelope
		if err := json.Unmarshal(scan.Bytes(), &m); err != nil {
			t.Fatal(err)
		}
		answers[string(m.ID)] = m
	}
	select {
	case <-result:
		t.Fatal("answer was delivered ahead of its preceding notification")
	default:
	}
	close(resume)
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	if m := answers[`"before"`]; m.Error != nil || string(m.Result) != `"live parent"` {
		t.Fatal(m)
	}
	if m := answers[`"after"`]; Code(m.Error) != "invalid_request" || m.Error.Number != -32602 {
		t.Fatal(m)
	}
	if m := answers[`"cancelled"`]; Code(m.Error) != "cancelled" || m.Error.Number != -32000 {
		t.Fatal(m)
	}
}
