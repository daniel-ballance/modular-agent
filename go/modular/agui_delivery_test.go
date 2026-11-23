package modular_test

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

func agURL(t *testing.T, a *modular.Agent, opt modular.ServeAGUIOptions) string {
	t.Helper()
	opt.Listen = "127.0.0.1:0"
	if len(opt.Actors) == 0 {
		opt.Actors = []modular.ACPActor{agActor(t)}
	}
	s, err := a.ServeAGUI(t.Context(), opt)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Error(err)
		}
	})
	return strings.TrimRight(s.URL, "/") + "/agui/v1"
}
func agRequest(t *testing.T, method, url, body, token string, headers map[string]string) *http.Response {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	return res
}
func agReadBody(t *testing.T, res *http.Response) string {
	t.Helper()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
func TestAGUIBrowserOriginAndJoinOnOpen(t *testing.T) {
	a := modulartest.Agent(t, modular.WithSeveralActors(true))
	one := agActor(t)
	other := modular.ACPActor{TokenFile: filepath.Join(t.TempDir(), "peer"), Actor: modular.Actor{ID: "peer", Kind: "program", Rights: []string{"watch"}}, ClientID: "peer"}
	token := "disposable-agui-peer-token"
	if err := os.WriteFile(other.TokenFile, []byte(token), 0600); err != nil {
		t.Fatal(err)
	}
	const origin = "https://editor.example"
	url := agURL(t, a, modular.ServeAGUIOptions{Actors: []modular.ACPActor{one, other}, Origins: []string{origin}})
	headers := map[string]string{"Origin": origin, "Access-Control-Request-Method": "POST"}
	res := agRequest(t, "OPTIONS", url+"/threads/unknown", "", "", headers)
	if res.StatusCode != 204 || res.Header.Get("Access-Control-Allow-Origin") != origin || agReadBody(t, res) != "" {
		t.Fatal("allowed preflight must not resolve the thread")
	}
	res = agRequest(t, "POST", url+"/threads", "{}", testAGToken, map[string]string{"Origin": "https://not-allowed.example"})
	if res.StatusCode != 403 {
		t.Fatal("unexpected origin created a thread")
	}
	id := agThread(t, url)
	res = agRequest(t, "GET", url+"/threads/"+id, "", token, nil)
	if res.StatusCode != 404 {
		t.Fatal("unrecorded principal joined without joinOnOpen")
	}
	if res = agRequest(t, "GET", url+"/threads/"+id, "", testAGToken, map[string]string{"Origin": origin}); res.StatusCode != 200 || res.Header.Get("Access-Control-Allow-Origin") != origin {
		t.Fatal("allowed origin cannot use its token")
	}
}
func TestAGUICannotRotateAcrossRightsOrBindAnotherExecutor(t *testing.T) {
	a := modulartest.Agent(t, interfaceOptions(60000)...)
	one := agActor(t)
	two := one
	two.TokenFile = filepath.Join(t.TempDir(), "new-token")
	if err := os.WriteFile(two.TokenFile, []byte("other-offline-test-token"), 0600); err != nil {
		t.Fatal(err)
	}
	two.Actor.Rights = []string{"watch"}
	for _, actors := range [][]modular.ACPActor{{one, two}, {{ClientID: "editor-primary", TokenFile: one.TokenFile, Actor: one.Actor}}} {
		s, err := a.ServeAGUI(t.Context(), modular.ServeAGUIOptions{Listen: "127.0.0.1:0", Actors: actors})
		if err == nil {
			s.Close()
			t.Fatal("conflicting client policy accepted")
		}
	}
}
func TestAGUIWithheldTextStaysOutOfSnapshots(t *testing.T) {
	gate := modular.Plugin{Name: "hide", Setup: func(r *modular.Registrar) error {
		return r.OnOutput(func(ctx context.Context, b modular.OutputBatch) (modular.OutputDecision, error) {
			for _, e := range b.Events {
				if b.Recipient == "browser" && e.Type == "text" {
					return modular.OutputDecision{Block: true}, nil
				}
			}
			return modular.OutputDecision{}, nil
		})
	}}
	a := modulartest.Agent(t, modular.WithPlugin(gate), modulartest.Script(`[{"text":"withheld-assistant"}]`))
	url := agURL(t, a, modular.ServeAGUIOptions{})
	id := agThread(t, url)
	stream := agPost(t, url+"/run", fmt.Sprintf(`{"protocolVersion":"1.0","runId":"one","threadId":%q,"messages":[{"id":"new","role":"user","content":"prompt"}]}`, id), 200)
	if strings.Contains(stream, "withheld-assistant") || strings.Contains(stream, "TEXT_MESSAGE_CONTENT") {
		t.Fatal("withheld text reached the run")
	}
	res := agRequest(t, "GET", url+"/threads/"+id, "", testAGToken, nil)
	if res.StatusCode != 200 || strings.Contains(agReadBody(t, res), "withheld-assistant") {
		t.Fatal("snapshot reopened a withheld stream")
	}
}
func TestAGUIQueuedInputKeepsTraceAndSurvivesDisconnect(t *testing.T) {
	tp := otel.GetTracerProvider()
	otel.SetTracerProvider(sdktrace.NewTracerProvider())
	t.Cleanup(func() { otel.SetTracerProvider(tp) })
	first := make(chan struct{})
	release := make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	got := make(chan trace.SpanContext, 1)
	p := modulartest.ScriptedProvider([]modulartest.Reply{{Text: "first reply"}, {Text: "second reply"}})
	request := p.Request
	p.Request = func(ctx context.Context, m modular.ModelRef, r modular.ModelRequest, c *modular.ProviderContext) (modular.AssistantMessage, error) {
		if r.Messages[len(r.Messages)-1].Content.Text() == "one" {
			close(first)
			select {
			case <-release:
			case <-ctx.Done():
				return modular.AssistantMessage{}, ctx.Err()
			}
		} else {
			got <- trace.SpanContextFromContext(ctx)
		}
		return request(ctx, m, r, c)
	}
	a := modulartest.Agent(t, modular.WithProvider(p))
	s, err := a.Session(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	actor := agActor(t)
	actor.Actor.ID = "user" // the recorded embedded principal
	actor.TrustTrace = true
	url := agURL(t, a, modular.ServeAGUIOptions{Actors: []modular.ACPActor{actor}, TraceStateKeys: []string{"kit"}})
	if _, err = s.Send(t.Context(), "one", modular.Now); err != nil {
		t.Fatal(err)
	}
	<-first
	var snapshot struct{ Messages []map[string]any }
	res := agRequest(t, "GET", url+"/threads/"+s.ID(), "", testAGToken, nil)
	if res.StatusCode != 200 {
		t.Fatalf("snapshot HTTP %d", res.StatusCode)
	}
	if err = json.NewDecoder(res.Body).Decode(&snapshot); err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	snapshot.Messages = append(snapshot.Messages, map[string]any{"role": "user", "id": "client", "content": "two"})
	data, _ := json.Marshal(map[string]any{"threadId": s.ID(), "protocolVersion": "1.0", "runId": "queued", "messages": snapshot.Messages})
	const tid = "1234567890abcdef1234567890abcdef"
	res = agRequest(t, "POST", url+"/run", string(data), testAGToken, map[string]string{"traceparent": "00-" + tid + "-aaaaaaaaaaaaaaaa-01", "tracestate": "kit=safe,nope=private", "baggage": "secret=discard"})
	line, err := bufio.NewReader(res.Body).ReadString('\n')
	if err != nil || !strings.Contains(line, "RUN_STARTED") {
		t.Fatalf("queued run: %s %v", line, err)
	}
	res.Body.Close()
	close(release)
	if err = s.WaitIdle(t.Context()); err != nil {
		t.Fatal(err)
	}
	sc := <-got
	if sc.TraceID().String() != tid || sc.TraceState().String() != "kit=safe" {
		t.Fatalf("queued invocation did not retain just its allowed HTTP context: %s, %s", sc.TraceID(), sc.TraceState())
	}
	turn, err := s.LastTurn(t.Context())
	if err != nil || turn.Text != "second reply" {
		t.Fatalf("disconnect cancelled queued input: %+v %v", turn, err)
	}
}
