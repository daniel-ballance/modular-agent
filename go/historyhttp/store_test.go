package historyhttp_test

import (
	"errors"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/historyhttp"
	"github.com/daniel-ballance/modular-agent/go/servicehttp"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func TestSharedStorePersistenceAndErasure(t *testing.T) {
	dir := t.TempDir()
	s, err := historyhttp.New(dir, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.Handler("token"))
	a := historyhttp.NewClient(servicehttp.NewClient(ts.URL, "token"))
	b := historyhttp.NewClient(servicehttp.NewClient(ts.URL, "token"))
	l, err := a.Acquire("unused")
	if err != nil {
		t.Fatal(err)
	}
	if err = l.Save(api.Session{ID: "unused", Version: 1, Project: "project"}); err != nil {
		t.Fatal("empty save", err)
	}
	if _, err = l.Load(); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing history: %v", err)
	}
	l.Close()
	all, err := a.List("")
	if err != nil || len(all) != 0 {
		t.Fatal("unused session persisted", err)
	}
	one, err := a.Acquire("one")
	if err != nil {
		t.Fatal(err)
	}
	two, err := b.Acquire("two")
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range []struct {
		l               api.Lease
		id, entry, copy string
	}{{one, "one", "source", ""}, {two, "two", "derived", "source"}} {
		e := api.Entry{ID: v.entry, Kind: "input", Content: api.Text("erase me"), Data: api.JSON(v.entry + "-input")}
		if v.copy != "" {
			e.Copies = []string{v.copy}
		}
		if err = v.l.Save(api.Session{ID: v.id, Version: 1, Project: "project", Entries: []api.Entry{e}}); err != nil {
			t.Fatal(err)
		}
	}
	if err = a.Erase([]string{"source"}); err == nil {
		t.Fatal("erased across another active writer")
	}
	two.Close()
	if err = a.Erase([]string{"source"}); err != nil {
		t.Fatal(err)
	}
	a.Close()
	b.Close()
	ts.Close()
	s.Close()
	s, err = historyhttp.New(dir, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ts = httptest.NewServer(s.Handler("token"))
	defer ts.Close()
	a = historyhttp.NewClient(servicehttp.NewClient(ts.URL, "token"))
	defer a.Close()
	all, err = a.List("project")
	if err != nil || len(all) != 2 {
		t.Fatalf("restart/list: %+v %v", all, err)
	}
	for _, snap := range all {
		if snap.Entries[0].Kind != "erasure" || len(snap.Entries[0].Content) != 0 {
			t.Fatal("copy not erased", snap)
		}
	}
}
