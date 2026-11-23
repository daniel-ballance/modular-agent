package modular_test

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

type listedThread struct {
	ThreadID  string
	UpdatedAt time.Time
	Waiting   struct {
		Questions, ToolCalls int
		Turn                 string
	}
}

type threadPage struct {
	Threads []listedThread
	Next    string
}

func listThreads(t *testing.T, base, token, query string) threadPage {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), "GET", base+"/threads"+query, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var page threadPage
	d := json.NewDecoder(res.Body)
	d.DisallowUnknownFields() // No title, prompt, call ID, arguments, or actor metadata.
	if err = d.Decode(&page); err != nil || res.StatusCode != 200 || page.Threads == nil {
		t.Fatalf("listing: HTTP %d, %+v (%v)", res.StatusCode, page, err)
	}
	return page
}

func listClient(t *testing.T, actor modular.Actor, client, token string) modular.ACPActor {
	t.Helper()
	file := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(file, []byte(token), 0600); err != nil {
		t.Fatal(err)
	}
	return modular.ACPActor{Actor: actor, ClientID: client, TokenFile: file}
}

func TestAGUIListsEligibleQuestionsAndPagesVisibleThreads(t *testing.T) {
	ctx := t.Context()
	reader := modular.Actor{ID: "observer", Kind: "user", Rights: []string{"watch"}}
	tool := modular.NewTool("ask", "Ask.", func(ctx context.Context, _ struct{}, tc *modular.ToolContext) (string, error) {
		answer, err := tc.Ask(ctx, modular.Question{Kind: "text", Question: "private question"}, modular.AskOptions{Wait: time.Millisecond, Then: "leaveOpen"})
		return answer.Value, err
	})
	a := modulartest.Agent(t, modular.WithDataDir(t.TempDir()), modular.WithDurability(modular.Durable), modular.WithSeveralActors(true), modular.WithLateAnswersStartTurns(true), modular.WithTool(tool),
		modulartest.Script(`[{"toolCalls":[{"name":"ask","input":{}}]}]`))
	var ids []string
	for _, actors := range [][]modular.Actor{nil, {reader}, {reader}} {
		s, err := a.Session(ctx, modular.SessionOptions{Actors: actors})
		if err != nil {
			t.Fatal(err)
		}
		r, err := s.Prompt(ctx, "private input")
		if err != nil || len(r.OpenToolCalls) != 1 {
			t.Fatalf("expected an open question: %+v (%v)", r, err)
		}
		ids = append(ids, s.ID())
	}
	owner := agActor(t)
	owner.Actor.ID = "user"
	const readerToken = "test-only-agui-reader"
	clients := []modular.ACPActor{owner, listClient(t, reader, "reader", readerToken)}
	listener, err := a.ServeAGUI(ctx, modular.ServeAGUIOptions{Listen: "127.0.0.1:0", Actors: clients})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	url := listener.URL + "/agui/v1"
	page := listThreads(t, url, testAGToken, "")
	if len(page.Threads) != 3 {
		t.Fatal(page)
	}
	for i, row := range page.Threads {
		if row.ThreadID != ids[2-i] || row.Waiting.Questions != 1 || row.Waiting.ToolCalls != 0 || row.Waiting.Turn != "none" {
			t.Fatalf("owner: %+v", row)
		}
	}
	first := listThreads(t, url, readerToken, "?limit=1")
	if len(first.Threads) != 1 || first.Threads[0].ThreadID != ids[2] || first.Threads[0].Waiting.Questions != 0 || first.Next == "" {
		t.Fatalf("reader page 1: %+v", first)
	}
	last := listThreads(t, url, readerToken, "?limit=1&after="+first.Next)
	if len(last.Threads) != 1 || last.Threads[0].ThreadID != ids[1] || last.Threads[0].Waiting.Questions != 0 || last.Next != "" {
		t.Fatalf("reader page 2: %+v", last)
	}
	bad := func(base, token, query string) {
		t.Helper()
		res := agRequest(t, "GET", base+"/threads"+query, "", token, nil)
		if body := agReadBody(t, res); res.StatusCode != 400 || !strings.Contains(body, `"invalid_request"`) {
			t.Fatalf("query: HTTP %d: %s", res.StatusCode, body)
		}
	}
	for _, q := range []string{"?limit=0", "?limit=501", "?limit=2&limit=3", "?limit=1.5", "?after=unknown", "?after="} {
		bad(url, readerToken, q)
	}
	bad(url, testAGToken, "?after="+first.Next)
	// Listener metadata expires on restart. No clock manipulation or sleep.
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	url = agURL(t, a, modular.ServeAGUIOptions{Actors: clients})
	bad(url, readerToken, "?after="+first.Next)
}

func TestPublicThreadListReturnsOnlyWatchableMetadata(t *testing.T) {
	project, dir := t.TempDir(), t.TempDir()
	opts := []modular.Option{modular.WithProject(project), modular.WithDataDir(dir), modular.WithDurability(modular.Durable)}
	p := modulartest.ScriptedProvider([]modulartest.Reply{{Text: "done"}})
	started, release := make(chan struct{}), make(chan struct{})
	request := p.Request
	p.Request = func(ctx context.Context, model modular.ModelRef, r modular.ModelRequest, pc *modular.ProviderContext) (modular.AssistantMessage, error) {
		close(started)
		select {
		case <-release:
			return request(ctx, model, r, pc)
		case <-ctx.Done():
			return modular.AssistantMessage{}, ctx.Err()
		}
	}
	writer := modulartest.Agent(t, append(opts, modular.WithProvider(p))...)
	s, err := writer.Session(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Send(t.Context(), "Start.", modular.Now); err != nil {
		t.Fatal(err)
	}
	<-started
	defer close(release)
	reader := modulartest.Agent(t, append(opts, modulartest.Script(`[]`))...)
	opt := modular.ListThreadsOptions{Actor: modular.Actor{ID: "user", Kind: "user", Rights: []string{"watch"}}}
	rows, more, err := reader.ListThreads(t.Context(), opt)
	if err != nil || more || len(rows) != 1 || rows[0].ThreadID != s.ID() || rows[0].Waiting.Turn != "running" {
		t.Fatalf("another writer's live turn: %+v, more=%t, err=%v", rows, more, err)
	}
	opt.Actor.Rights = []string{"input"}
	rows, more, err = reader.ListThreads(t.Context(), opt)
	if err != nil || more || len(rows) != 0 {
		t.Fatalf("without watch: %+v, more=%t, err=%v", rows, more, err)
	}
}

func TestAGUIListingDoesNotJoinAProspectiveWatcher(t *testing.T) {
	a := modulartest.Agent(t, modular.WithDataDir(t.TempDir()), modular.WithDurability(modular.Kept), modular.WithSeveralActors(true), modulartest.Script(`[{"text":"ok"}]`))
	s, err := a.Session(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Prompt(t.Context(), "Hi."); err != nil {
		t.Fatal(err)
	}
	watcher := listClient(t, modular.Actor{ID: "visitor", Kind: "user", Rights: []string{"watch"}}, "visit", testAGToken)
	join := true
	url := agURL(t, a, modular.ServeAGUIOptions{Actors: []modular.ACPActor{watcher}, JoinOnOpen: &join})
	rows := listThreads(t, url, testAGToken, "").Threads
	if len(rows) != 1 || rows[0].ThreadID != s.ID() {
		t.Fatal(rows)
	}
	if _, err = s.As("visitor"); err == nil {
		t.Fatal("listing granted membership")
	}
}

func TestAGUIListsCallsOnlyOnTheirExecutorRoute(t *testing.T) {
	ctx := t.Context()
	a := modulartest.Agent(t, append(interfaceOptions(60_000), modular.WithDataDir(t.TempDir()), modular.WithDurability(modular.Durable))...)
	s := interfaceSession(t, ctx, a)
	conn := interfaceConnect(t, a, s)
	if err := conn.Advertise("pick_color"); err != nil {
		t.Fatal(err)
	}
	r, err := s.Prompt(ctx, "Pick.")
	if err != nil || len(r.OpenToolCalls) != 1 {
		t.Fatalf("call: %+v (%v)", r, err)
	}
	conn.Close()
	// The listener has never seen this call. Only its committed handoff
	// identifies the route; sharing the executor's actor ID is not enough.
	editor := modular.Actor{ID: "editor", Kind: "program", Rights: []string{"watch", "tools"}}
	const other = "test-only-other-editor"
	url := agURL(t, a, modular.ServeAGUIOptions{Actors: []modular.ACPActor{
		listClient(t, editor, "editor-primary", testAGToken), listClient(t, editor, "other", other),
	}})
	for token, n := range map[string]int{testAGToken: 1, other: 0} {
		rows := listThreads(t, url, token, "").Threads
		if len(rows) != 1 || rows[0].Waiting.ToolCalls != n || rows[0].Waiting.Questions != 0 || rows[0].Waiting.Turn != "none" {
			t.Fatalf("expected %d calls: %+v", n, rows)
		}
	}
}

func TestAGUIListsRunningThenInterruptedWithoutRecovery(t *testing.T) {
	entered := make(chan struct{})
	tool := modular.NewTool("block", "Block.", func(ctx context.Context, _ struct{}, _ *modular.ToolContext) (string, error) {
		close(entered)
		<-ctx.Done()
		return "", ctx.Err()
	})
	a := modulartest.Agent(t, modular.WithDataDir(t.TempDir()), modular.WithDurability(modular.Durable), modular.WithTool(tool), modulartest.Script(`[{"toolCalls":[{"name":"block","input":{}}]}]`))
	s, err := a.Session(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Send(t.Context(), "Start.", modular.Now); err != nil {
		t.Fatal(err)
	}
	<-entered
	owner := agActor(t)
	owner.Actor.ID = "user"
	check := func(a *modular.Agent, turn string) {
		t.Helper()
		url := agURL(t, a, modular.ServeAGUIOptions{Actors: []modular.ACPActor{owner}})
		rows := listThreads(t, url, testAGToken, "").Threads
		if len(rows) != 1 || rows[0].Waiting.Turn != turn {
			t.Fatalf("want %s: %+v", turn, rows)
		}
	}
	check(a, "running")
	fresh := modulartest.Restart(t, a)
	check(fresh, "interrupted")
}

func TestAGUIDoesNotListEphemeralThreads(t *testing.T) {
	a := modulartest.Agent(t, modulartest.Script(`[{"text":"done"}]`))
	url := agURL(t, a, modular.ServeAGUIOptions{})
	id := agThread(t, url)
	agPost(t, url+"/run", `{"threadId":"`+id+`","runId":"one","protocolVersion":"1.0","messages":[{"role":"user","id":"a","content":"Hi!"}]}`, 200)
	if rows := listThreads(t, url, testAGToken, "").Threads; len(rows) != 0 {
		t.Fatal(rows)
	}
}

func TestAGUIListsKeptThreadsWithoutOpeningThem(t *testing.T) {
	a := modulartest.Agent(t, modular.WithDataDir(t.TempDir()), modular.WithDurability(modular.Kept), modulartest.Script(`[{"text":"private reply"}]`))
	s, err := a.Session(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Prompt(t.Context(), "private input"); err != nil {
		t.Fatal(err)
	}
	if err = s.Close(t.Context()); err != nil {
		t.Fatal(err)
	}
	client := agActor(t)
	client.Actor.ID = "user" // the SDK actor that created the session
	server, err := a.ServeAGUI(t.Context(), modular.ServeAGUIOptions{Listen: "127.0.0.1:0", Actors: []modular.ACPActor{client}})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	base := server.URL + "/agui/v1"
	agThread(t, base) // provisional, not kept
	p := listThreads(t, base, testAGToken, "")
	if len(p.Threads) != 1 || p.Threads[0].ThreadID != s.ID() || p.Threads[0].UpdatedAt.IsZero() || p.Threads[0].Waiting.Turn != "none" || p.Next != "" {
		t.Fatalf("wrong page: %+v", p)
	}
	if _, err = a.OpenSession(t.Context(), s.ID()); err != nil {
		t.Fatalf("listing took the writer: %v", err)
	}
}
