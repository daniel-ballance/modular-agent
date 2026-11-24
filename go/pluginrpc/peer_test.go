package pluginrpc_test

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/pluginrpc"
	"net"
	"strings"
	"testing"
	"time"
)

func peers(t *testing.T) (*pluginrpc.Peer, *pluginrpc.Peer) {
	t.Helper()
	left, right := net.Pipe()
	a, b := pluginrpc.NewPeer(left, left), pluginrpc.NewPeer(right, right)
	doneA, doneB := make(chan struct{}), make(chan struct{})
	go func() { _ = a.Run(); close(doneA) }()
	go func() { _ = b.Run(); close(doneB) }()
	t.Cleanup(func() {
		a.Close()
		b.Close()
		select {
		case <-doneA:
		case <-time.After(5 * time.Second):
			t.Error("peer A leaked")
		}
		select {
		case <-doneB:
		case <-time.After(5 * time.Second):
			t.Error("peer B leaked")
		}
	})
	return a, b
}
func TestPeerBidirectionalLineageCancellationAndLoss(t *testing.T) {
	a, b := peers(t)
	started := make(chan struct{})
	cleaned := make(chan struct{})
	a.Handle = func(ctx context.Context, method string, raw json.RawMessage) (any, error) {
		var p struct {
			Parent json.RawMessage `json:"parentRequestId"`
		}
		_ = json.Unmarshal(raw, &p)
		parent, ok := a.Parent(p.Parent)
		if !ok {
			return nil, errors.New("lost lineage")
		}
		select {
		case <-parent.Done():
			return nil, parent.Err()
		default:
		}
		return map[string]any{"ok": true}, nil
	}
	b.Handle = func(ctx context.Context, method string, raw json.RawMessage) (any, error) {
		if method == "nested" {
			var response any
			err := b.Call(ctx, "host/probe", map[string]any{"parentRequestId": pluginrpc.RequestID(ctx)}, &response)
			return response, err
		}
		close(started)
		<-ctx.Done()
		close(cleaned)
		return nil, ctx.Err()
	}
	var response map[string]any
	if err := a.Call(context.Background(), "nested", map[string]any{}, &response); err != nil || response["ok"] != true {
		t.Fatal(response, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- a.Call(ctx, "cancel", map[string]any{}, nil) }()
	<-started
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation did not settle")
	}
	<-cleaned
	// A lost process/connection settles outstanding work without replay.
	b.Handle = func(ctx context.Context, method string, raw json.RawMessage) (any, error) {
		b.Close()
		return nil, ctx.Err()
	}
	if err := a.Call(context.Background(), "lost", map[string]any{}, nil); pluginrpc.Code(err) != "lost" {
		t.Fatal(err)
	}
}
func TestPeerDistinguishesFrameErrorsAndRetiresIntegerIDs(t *testing.T) {
	left, right := net.Pipe()
	defer right.Close()
	_ = right.SetDeadline(time.Now().Add(2 * time.Second))
	peer := pluginrpc.NewPeer(left, left)
	defer peer.Close()
	finished := make(chan error, 1)
	go func() { finished <- peer.Run() }()
	read := bufio.NewReader(right)
	send := func(frame string, want int, id string) {
		t.Helper()
		if _, err := right.Write([]byte(frame + "\n")); err != nil {
			t.Fatal(err)
		}
		line, err := read.ReadBytes('\n')
		if err != nil {
			t.Fatal(err)
		}
		var response struct {
			ID     json.RawMessage
			Error  pluginrpc.RPCError
			Result json.RawMessage
		}
		if err := json.Unmarshal(line, &response); err != nil || response.Error.Number != want || string(response.ID) != id || want == 0 && string(response.Result) != "{}" {
			t.Fatalf("unexpected frame: %s", line)
		}
	}
	send(`[{}]`, -32600, "null")
	send(`{"jsonrpc":"2.0","method":"$/ping","method":"duplicate"}`, -32700, "null")
	send(`{"jsonrpc":"2.0","id":-0,"method":"$/ping","params":{}}`, 0, "-0")
	send(`{"jsonrpc":"2.0","id":"0","method":"$/ping","params":{}}`, 0, `"0"`)
	if _, err := right.Write([]byte("{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"$/ping\"}\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-finished:
		if pluginrpc.Code(err) != "lost" {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("peer accepted a reused integer ID")
	}
}

func TestOversizedResultIsAnErrorAndConnectionRemainsUsable(t *testing.T) {
	a, b := peers(t)
	b.Handle = func(context.Context, string, json.RawMessage) (any, error) {
		return strings.Repeat("x", pluginrpc.MaxFrame), nil
	}
	err := a.Call(context.Background(), "large", map[string]any{}, nil)
	if pluginrpc.Code(err) != "result_too_large" {
		t.Fatal(err)
	}
	if err = a.Call(context.Background(), "$/ping", map[string]any{}, nil); err != nil {
		t.Fatal(err)
	}
}

type mirrorProvider struct{}

func (p mirrorProvider) Catalog() []api.Model {
	return []api.Model{{ID: "one", Provider: "mirror", Thinking: []string{"off"}}}
}
func (p mirrorProvider) Access(id string) (api.ModelAccess, error) {
	if id != "one" {
		return nil, errors.New("wrong native model identity")
	}
	return p, nil
}
func (p mirrorProvider) Model() api.Model { return p.Catalog()[0] }
func (p mirrorProvider) Generate(ctx context.Context, r api.Request, emit func(api.Part)) (api.Response, error) {
	if !strings.Contains(string(r.Wire), "futureRequest") || !strings.Contains(string(r.Tools[0].Wire), "futureHint") {
		return api.Response{}, errors.New("unknown request fields were discarded")
	}
	return api.Response{Content: r.Messages[0].Content, Stop: "finished", Wire: r.Messages[0].Wire}, nil
}
func TestGeneralServerPreservesUnknownSharedData(t *testing.T) {
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	server := &pluginrpc.Server{Registration: pluginrpc.Registration{Binding: pluginrpc.Binding, Name: "mirror"}, Providers: map[string]api.Provider{"mirror": mirrorProvider{}}}
	done := make(chan error, 1)
	go func() { done <- server.Serve(context.Background(), right, right) }()
	peer := pluginrpc.NewPeer(left, left)
	peer.Handle = func(ctx context.Context, method string, raw json.RawMessage) (any, error) {
		var p map[string]json.RawMessage
		_ = json.Unmarshal(raw, &p)
		return p["payload"], nil
	}
	peerDone := make(chan struct{})
	go func() { _ = peer.Run(); close(peerDone) }()
	defer func() { peer.Close(); <-peerDone; <-done }()
	err := peer.Call(context.Background(), "plugin/initialize", map[string]any{"binding": pluginrpc.Binding, "project": t.TempDir(), "home": t.TempDir()}, nil)
	if err != nil {
		t.Fatal(err)
	}
	request := json.RawMessage(`{"systemPrompt":"","futureRequest":true,"messages":[{"role":"user","futureMessage":9007199254740993123456789,"providerData":{"opaque":"secret-shaped-not-text"},"content":[{"type":"text","text":"hello","futureText":7},{"type":"futureContent","opaque":[1,2,3]},{"type":"reasoning","providerData":{"signature":"opaque-signature"}}]}],"tools":[{"name":"probe","parameters":{"type":"object"},"hints":{"futureHint":true}}],"settings":{"futureSetting":true}}`)
	var response json.RawMessage
	err = peer.Call(context.Background(), "provider/request", map[string]any{"provider": "mirror", "model": map[string]any{"provider": "mirror", "id": "one"}, "request": request}, &response)
	if err != nil {
		t.Fatal(err)
	}
	encoded := string(response)
	for _, want := range []string{"9007199254740993123456789", "futureMessage", "futureText", "futureContent", "signature", "providerData"} {
		if !strings.Contains(encoded, want) {
			t.Fatalf("lost %s: %s", want, encoded)
		}
	}
}
