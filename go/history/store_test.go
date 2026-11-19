package history_test

import (
	"errors"
	"modular/api"
	"modular/history"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestSessionsSurviveRestartAndUnusedLeavesNothing(t *testing.T) {
	dir := t.TempDir()
	s, err := history.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	l, err := s.Acquire("unused")
	if err != nil {
		t.Fatal(err)
	}
	if err = l.Close(); err != nil {
		t.Fatal(err)
	}
	files, _ := os.ReadDir(dir)
	if len(files) != 0 {
		t.Fatalf("unused left %v", files)
	}
	l, _ = s.Acquire("used")
	snap := api.Session{Version: 1, ID: "used", Project: "/one", Position: "entry", Entries: []api.Entry{{ID: "entry", Session: "used", Kind: "input", Content: api.Text("hello")}}}
	if err = l.Save(snap); err != nil {
		t.Fatal(err)
	}
	if err = l.Save(snap); err != nil {
		t.Fatal(err)
	}
	_ = l.Close()
	s2, _ := history.New(dir)
	l, err = s2.Acquire("used")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	got, err := l.Load()
	if err != nil || len(got.Entries) != 1 || got.Position != "entry" {
		t.Fatalf("%+v %v", got, err)
	}
	list, err := s2.List("/two")
	if err != nil || len(list) != 0 {
		t.Fatal(list, err)
	}
	list, err = s2.List("")
	if err != nil || len(list) != 1 {
		t.Fatal(list, err)
	}
	if _, err = s2.Acquire("../escape"); err == nil {
		t.Fatal("invalid identity allowed")
	}
}
func TestWriterLeaseAcrossProcesses(t *testing.T) {
	if os.Getenv("MODULAR_LOCK_CHILD") == "1" {
		s, err := history.New(os.Getenv("MODULAR_LOCK_DIR"))
		if err != nil {
			os.Exit(2)
		}
		l, err := s.Acquire("locked")
		if err == nil {
			_ = l.Close()
			os.Exit(3)
		}
		return
	}
	dir := t.TempDir()
	s, _ := history.New(dir)
	l, err := s.Acquire("locked")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestWriterLeaseAcrossProcesses$")
	cmd.Env = append(os.Environ(), "MODULAR_LOCK_CHILD=1", "MODULAR_LOCK_DIR="+dir)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%s %v", out, err)
	}
	_ = l.Close()
	l, err = s.Acquire("locked")
	if err != nil {
		t.Fatal(err)
	}
	_ = l.Close()
}
func TestErasureFollowsCopiesAcrossForks(t *testing.T) {
	dir := t.TempDir()
	s, _ := history.New(dir)
	for _, snap := range []api.Session{
		{Version: 1, ID: "one", Entries: []api.Entry{{ID: "a", Content: api.Text("sensitive")}, {ID: "b", Copies: []string{"a"}, Content: api.Text("paraphrased")}}},
		{Version: 1, ID: "two", Entries: []api.Entry{{ID: "c", Copies: []string{"b"}, Content: api.Text("forked")}}},
	} {
		l, _ := s.Acquire(snap.ID)
		if err := l.Save(snap); err != nil {
			t.Fatal(err)
		}
		_ = l.Close()
	}
	if err := s.Erase([]string{"a"}); err != nil {
		t.Fatal(err)
	}
	all, _ := s.List("")
	for _, snap := range all {
		for _, e := range snap.Entries {
			if e.Kind != "erasure" || len(e.Content) != 0 || len(e.Data) != 0 {
				t.Fatal(e)
			}
		}
	}
	b, err := os.ReadFile(filepath.Join(dir, "one.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(b) == "" {
		t.Fatal("empty store")
	}
}
func TestSaveDoesNotResurrectErasedContentFromItsCachedPrefix(t *testing.T) {
	s, err := history.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	l, err := s.Acquire("one")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	snap := api.Session{Version: 1, ID: "one", Entries: []api.Entry{{ID: "a", Session: "one", Kind: "model", Content: api.Text("original"), Data: api.JSON(api.Response{Stop: "finished"})}}}
	if err := l.Save(snap); err != nil {
		t.Fatal(err)
	}
	if err := s.Erase([]string{"a"}); err != nil {
		t.Fatal(err)
	}
	if err := l.Save(snap); err == nil {
		t.Fatal("stale writer restored erased history")
	}
	got, err := l.Load()
	if err != nil || len(got.Entries) != 1 || !got.Entries[0].IsErased() {
		t.Fatal(got, err)
	}
}

func TestStoreRefusesCorruptionAndMutation(t *testing.T) {
	dir := t.TempDir()
	s, _ := history.New(dir)
	l, _ := s.Acquire("one")
	defer l.Close()
	snap := api.Session{Version: 1, ID: "one", Entries: []api.Entry{{ID: "a", Session: "one", Kind: "model", Content: api.Text("original"), Data: api.JSON(api.Response{Stop: "finished"})}}}
	if err := l.Save(snap); err != nil {
		t.Fatal(err)
	}
	snap.Entries[0].Content[0].Text = "changed"
	if err := l.Save(snap); err == nil {
		t.Fatal("ordinary write changed history")
	}
	if _, err := l.Load(); errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "one.json"), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	snap.Entries[0].Content[0].Text = "original"
	if err := l.Save(snap); err == nil {
		t.Fatal("cached prefix masked invalid history on disk")
	}
	if _, err := s.List(""); err == nil {
		t.Fatal("corruption silently ignored")
	}
}
