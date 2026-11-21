package modular_test

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"sync/atomic"
	"testing"
	"time"

	acp "github.com/caelis-labs/acp-go-sdk"
	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

type interruptibleBackend struct {
	*snapshotBackend
	acquired chan *interruptibleLease
}

func (b interruptibleBackend) Acquire(id string) (modular.HistoryLease, error) {
	lease, err := b.snapshotBackend.Acquire(id)
	if err != nil {
		return nil, err
	}
	wrapped := &interruptibleLease{HistoryLease: lease, lost: make(chan struct{})}
	b.acquired <- wrapped
	return wrapped, nil
}

type interruptibleLease struct {
	modular.HistoryLease
	lost       chan struct{}
	failAppend atomic.Bool
}

func (l *interruptibleLease) WriterLost() <-chan struct{} { return l.lost }
func (l *interruptibleLease) CheckWriter() error {
	select {
	case <-l.lost:
		return modular.ErrHistoryWriterLost
	default:
		return nil
	}
}
func (l *interruptibleLease) Save(s modular.SessionRecord) error {
	if err := l.CheckWriter(); err != nil {
		return err
	}
	if l.failAppend.Load() {
		return errors.New("injected append failure")
	}
	return l.HistoryLease.Save(s)
}

type interruptionACPClient struct {
	guideACPClient
	interrupt chan interruptionNotice
}

type interruptionNotice struct {
	Session string
	Data    modular.SessionInterruptedData
}

func (c *interruptionACPClient) HandleExtensionMethod(_ context.Context, method string, b json.RawMessage) (any, error) {
	var p struct{ SessionID, Reason string }
	if method == "_modular-agent/interrupted" && json.Unmarshal(b, &p) == nil {
		e := interruptionNotice{Session: p.SessionID}
		e.Data.Reason = modular.SessionInterruptionReason(p.Reason)
		c.interrupt <- e
	}
	return nil, nil
}

func takeInterruptionCheck[T any](t *testing.T, ctx context.Context, ch <-chan T, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-ctx.Done():
		t.Fatalf("waiting for %s: %v", what, ctx.Err())
		panic("unreachable")
	}
}

func requireLost(t *testing.T, err error) {
	t.Helper()
	var e *modular.Error
	if !errors.As(err, &e) || e.Code != modular.Lost {
		t.Fatalf("want lost, got %v", err)
	}
}

func TestSessionInterruptionReachesFollowersAndWaitingPrompts(t *testing.T) {
	for _, reason := range []modular.SessionInterruptionReason{modular.CommitFailed, modular.WriterLost} {
		for _, surface := range []string{"prompt", "promptStream", "ACP"} {
			t.Run(string(reason)+"/"+surface, func(t *testing.T) {
				checkSessionInterruption(t, reason, surface)
			})
		}
	}
}

func checkSessionInterruption(t *testing.T, reason modular.SessionInterruptionReason, surface string) {
	t.Helper()
	t.Setenv("MODULAR_AGENT_PLUGINS", "")
	t.Setenv("MODULAR_AGENT_ACTOR", "acp-user")
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	store := interruptibleBackend{&snapshotBackend{dir: t.TempDir(), held: map[string]bool{}}, make(chan *interruptibleLease, 2)}
	started, stopped := make(chan struct{}), make(chan struct{})
	var runs atomic.Int32
	tool := modular.NewTool("hold", "Wait for cancellation", func(ctx context.Context, _ struct{}, _ *modular.ToolContext) (string, error) {
		if runs.Add(1) != 1 {
			return "unexpected redispatch", nil
		}
		close(started)
		<-ctx.Done()
		close(stopped)
		return "", ctx.Err()
	})
	project := t.TempDir()
	script := `[{"toolCalls":[{"name":"hold","input":{}}]}]`
	if surface == "ACP" {
		script = `[{"text":"prime history"},{"toolCalls":[{"name":"hold","input":{}}]}]`
	}
	options := []modular.Option{modular.WithProject(project), modular.WithHistory(modular.NewHistoryStore(store, true, false)),
		modular.WithDurability(modular.Kept), modular.WithPluginHost(true), modular.WithTool(tool),
		modular.WithSeveralActors(true),
		modulartest.Script(script)}
	a := modulartest.Agent(t, options...)
	s, err := a.Session(ctx, modular.SessionOptions{Actors: []modular.Actor{{ID: "acp-user", Kind: "user", Rights: []string{"watch", "input", "tools"}}}})
	if err != nil {
		t.Fatal(err)
	}
	if surface == "ACP" {
		if _, err := s.Prompt(ctx, "prime history"); err != nil {
			t.Fatal(err)
		}
	}
	lease := takeInterruptionCheck(t, ctx, store.acquired, "lease")
	following := make(chan struct{})
	followed := make(chan modular.TypedEvent[modular.SessionInterruptedData], 1)
	go func() {
		ready := false
		for ev, err := range s.Events(ctx) {
			if err != nil {
				return
			}
			if !ready {
				ready = true
				close(following)
			}
			if event, ok := ev.(modular.TypedEvent[modular.SessionInterruptedData]); ok {
				followed <- event
				return
			}
		}
	}()
	takeInterruptionCheck(t, ctx, following, "follower registration")
	finished := make(chan error, 1)
	streamed := make(chan modular.TypedEvent[modular.SessionInterruptedData], 1)
	client := &interruptionACPClient{interrupt: make(chan interruptionNotice, 1)}
	switch surface {
	case "prompt":
		go func() { _, err := s.Prompt(ctx, "wait"); finished <- err }()
	case "promptStream":
		go func() {
			for ev, err := range s.PromptStream(ctx, "wait") {
				if err != nil {
					finished <- err
					return
				}
				if event, ok := ev.(modular.TypedEvent[modular.SessionInterruptedData]); ok {
					streamed <- event
				}
			}
			finished <- nil
		}()
	case "ACP":
		server, peer := net.Pipe()
		done := make(chan error, 1)
		go func() { done <- a.ServeACP(ctx, modular.ServeACPOptions{Input: server, Output: server}) }()
		conn := acp.NewClientSideConnection(client, peer, peer)
		defer func() {
			_ = conn.Close()
			if err := takeInterruptionCheck(t, ctx, done, "ACP shutdown"); err != nil {
				t.Error(err)
			}
		}()
		if _, err := conn.Initialize(ctx, acp.InitializeRequest{ProtocolVersion: 1}); err != nil {
			t.Fatal(err)
		}
		if _, err := conn.ResumeSession(ctx, acp.ResumeSessionRequest{Cwd: project, SessionId: acp.SessionId(s.ID())}); err != nil {
			t.Fatal(err)
		}
		go func() {
			_, err := conn.Prompt(ctx, acp.PromptRequest{SessionId: acp.SessionId(s.ID()), Prompt: []acp.ContentBlock{acp.TextBlock("wait")}})
			finished <- err
		}()
	}
	select {
	case <-started:
	case err := <-finished:
		t.Fatalf("prompt returned before dispatch: %v", err)
	case <-ctx.Done():
		t.Fatal("tool did not start")
	}
	if reason == modular.CommitFailed {
		lease.failAppend.Store(true)
		_, err := s.Send(ctx, "trigger a failed append", modular.Now)
		requireLost(t, err)
	} else {
		close(lease.lost) // No mutations after revocation are needed to notice it.
	}
	e := takeInterruptionCheck(t, ctx, followed, "follower interruption event")
	if e.Header().Type != "sessionInterrupted" || e.Header().SessionID != s.ID() || e.Data.Reason != reason {
		t.Fatalf("unexpected event: %+v", e)
	}
	err = takeInterruptionCheck(t, ctx, finished, "lost prompt reply")
	if surface == "ACP" {
		var rpc *acp.RequestError
		if !errors.As(err, &rpc) || rpc.Code != -32000 {
			t.Fatalf("expected ACP lost, got %v", err)
		}
		data, _ := json.Marshal(rpc.Data)
		if string(data) != `{"code":"lost"}` {
			t.Fatalf("expected ACP lost, got %s", data)
		}
		acpEvent := takeInterruptionCheck(t, ctx, client.interrupt, "ACP interruption notification")
		if acpEvent.Session != s.ID() || acpEvent.Data.Reason != reason {
			t.Fatalf("unexpected ACP event: %+v", acpEvent)
		}
	} else {
		requireLost(t, err)
		if surface == "promptStream" {
			if event := takeInterruptionCheck(t, ctx, streamed, "promptStream interruption event"); event.Data.Reason != reason {
				t.Fatalf("unexpected stream event: %+v", event)
			}
		}
	}
	takeInterruptionCheck(t, ctx, stopped, "tool cancellation")
	if _, err := s.Send(ctx, "must not start", modular.Now); err == nil {
		t.Fatal("interrupted session admitted fresh work")
	} else {
		requireLost(t, err)
	}
	if err := s.Close(ctx); err != nil {
		t.Fatal(err)
	}
	reopened, err := a.OpenSession(ctx, s.ID())
	if err != nil {
		t.Fatal(err)
	}
	result, err := reopened.LastTurn(ctx)
	if err != nil || result == nil || result.Outcome == nil || result.Outcome.Kind != "failed" {
		t.Fatalf("unexpected recovery: %+v, %v", result, err)
	}
	if calls := result.ToolResults(); len(calls) != 1 || calls[0].Status != modular.OutcomeUnknown || runs.Load() != 1 {
		t.Fatalf("recovered calls: %+v; runs: %d", calls, runs.Load())
	}
	history, err := reopened.History(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range history {
		if row["kind"] == "sessionInterrupted" || row["kind"] == "session.interrupted" {
			t.Fatalf("interruption was recorded: %+v", row)
		}
	}
}
