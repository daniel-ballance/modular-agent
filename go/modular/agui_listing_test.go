package modular_test

import (
	"encoding/json"
	"net/http"
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
