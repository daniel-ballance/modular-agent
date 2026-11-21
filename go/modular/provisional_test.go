package modular_test

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"syscall"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

// A persistent test backend records the calls across a SIGKILL. Each Save is
// one atomic commit of a snapshot, so its journal also exposes batch boundaries.
type recordingHistory struct{ *snapshotBackend }

type historyMutation struct {
	Operation string
	Entries   []modular.HistoryRecord
}

func (b recordingHistory) record(id string, mutation historyMutation) error {
	f, err := os.OpenFile(filepath.Join(b.dir, id+".writes"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	return errors.Join(json.NewEncoder(f).Encode(mutation), f.Sync(), f.Close())
}

func (b recordingHistory) Acquire(id string) (modular.HistoryLease, error) {
	return b.AcquireService(id)
}

func (b recordingHistory) AcquireService(id string) (modular.ServiceHistoryLease, error) {
	if err := b.record(id, historyMutation{Operation: "acquire"}); err != nil {
		return nil, err
	}
	l, err := b.snapshotBackend.AcquireService(id)
	if err != nil {
		return nil, err
	}
	return recordingHistoryLease{l, b, id}, nil
}

type recordingHistoryLease struct {
	modular.ServiceHistoryLease
	store recordingHistory
	id    string
}

func (l recordingHistoryLease) Save(s modular.SessionRecord) error {
	if err := l.ServiceHistoryLease.Save(s); err != nil {
		return err
	}
	return l.store.record(l.id, historyMutation{Operation: "save", Entries: s.Entries})
}

type provisionalFixture struct{ root, store, placement, url string }

func (f provisionalFixture) options(t *testing.T) []modular.Option {
	opts := []modular.Option{
		modular.WithProject(f.root), modular.WithDataDir(filepath.Join(f.root, "data")),
		modular.WithDurability(modular.Kept), modular.WithSeveralActors(true),
		modular.WithTenants(map[string]modular.Tenant{"demo": {Rights: []string{"watch", "input", "settings", "grant"}}}),
		modular.WithEnvironment(modulartest.MemoryEnvironment(nil)), modulartest.Script(`[{"text":"done"}]`),
	}
	switch f.store {
	case "file":
		opts = append(opts, modular.WithHistory(modular.FileHistory(filepath.Join(f.root, "store"))))
	case "http":
		opts = append(opts, modular.WithHistory(modular.HTTPHistory(f.url, filepath.Join(f.root, "token"))))
	case "custom":
		backend := f.backend(t)
		opts = append(opts, modular.WithPlugin(modular.Plugin{Name: "recording-history", Replaces: []string{"history"}, Setup: func(r *modular.Registrar) error {
			return r.HistoryStore(modular.NewHistoryStore(backend, true, true))
		}}))
	default:
		t.Fatalf("unknown store: %q", f.store)
	}
	if f.placement == "served" {
		exe, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		opts = append(opts, modular.WithProcessPlugin(modular.ProcessPlugin{
			Command: []string{exe, "-test.run=^TestProvisionalRuntimeProgram$"},
			Env:     map[string]string{"MA_TEST_PROVISIONAL_RUNTIME": "1"},
		}))
	}
	return opts
}

func (f provisionalFixture) backend(t *testing.T) recordingHistory {
	dir := filepath.Join(f.root, "store")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	return recordingHistory{&snapshotBackend{dir: dir, held: map[string]bool{}}}
}

const provisionalToken = "offline-provisional-history-128bit"

func (f *provisionalFixture) startService(t *testing.T) {
	if f.store != "http" {
		return
	}
	token := filepath.Join(f.root, "token")
	if err := os.WriteFile(token, []byte(provisionalToken), 0600); err != nil {
		t.Fatal(err)
	}
	svc, err := modular.ListenHistory(context.WithoutCancel(t.Context()), modular.NewHistoryStore(f.backend(t), true, true), modular.HistoryOptions{
		Address: "127.0.0.1:0", TokenFile: token, StateDir: filepath.Join(f.root, "service"),
	})
	if err != nil {
		t.Fatal(err)
	}
	f.url = svc.URL
	t.Cleanup(func() {
		if err := svc.Close(); err != nil {
			t.Error(err)
		}
	})
}

func isHistoryCode(err error, code modular.Code) bool {
	var e *modular.Error
	return errors.As(err, &e) && e.Code == code
}

func (f provisionalFixture) unpublished(t *testing.T, a *modular.Agent, id string) {
	t.Helper()
	rows, err := a.Sessions(t.Context())
	if err != nil || len(rows) != 0 {
		t.Errorf("listed unused session: %+v, %v", rows, err)
	}
	if _, err := a.SessionInfo(t.Context(), id); !isHistoryCode(err, modular.NotFound) {
		t.Errorf("SessionInfo for unused session: %v", err)
	}
	if f.store == "http" {
		// List hides metadata-only sessions; GET by ID distinguishes an
		// early PUT from a genuinely unpublished session.
		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, f.url+"/v1/sessions/"+id, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+provisionalToken)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var body struct{ Code string }
		if err := json.NewDecoder(res.Body).Decode(&body); err != nil || res.StatusCode != 404 || body.Code != "unknown_session" {
			t.Errorf("raw GET for unused session: %s, %+v, %v", res.Status, body, err)
		}
	}
	files, err := os.ReadDir(filepath.Join(f.root, "store"))
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if name := file.Name(); name != ".pending-erasure" && name != ".pending-erasure.lock" {
			t.Errorf("unused session left %s in the store", name)
		}
	}
}

func (f provisionalFixture) firstSave(t *testing.T, id string) []modular.HistoryRecord {
	t.Helper()
	file, err := os.Open(filepath.Join(f.root, "store", id+".writes"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	dec := json.NewDecoder(file)
	var acquired bool
	for {
		var mutation historyMutation
		if err := dec.Decode(&mutation); err != nil {
			t.Fatalf("no initial save for %s: %v", id, err)
		}
		if mutation.Operation == "acquire" {
			acquired = true
		}
		if mutation.Operation == "save" && len(mutation.Entries) != 0 {
			if !acquired {
				t.Fatal("saved without a writer")
			}
			return mutation.Entries
		}
	}
}

func provisionalSession(t *testing.T, a *modular.Agent) *modular.Session {
	t.Helper()
	s, err := a.Session(t.Context(), modular.SessionOptions{Tenant: "demo", Settings: modular.Settings{"maxSteps": 4}, Actors: []modular.Actor{
		{ID: "guest", Kind: "user", Rights: []string{"watch"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetSetting(t.Context(), "maxSteps", 3); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestProvisionalSessionLifecycle(t *testing.T) {
	t.Setenv("MODULAR_AGENT_PLUGINS", "")
	for _, placement := range []string{"native", "served"} {
		for _, store := range []string{"file", "http", "custom"} {
			t.Run(placement+"/"+store, func(t *testing.T) {
				t.Run("close", func(t *testing.T) {
					f := provisionalFixture{root: t.TempDir(), store: store, placement: placement}
					f.startService(t)
					a := modulartest.Agent(t, f.options(t)...)
					s := provisionalSession(t, a)
					f.unpublished(t, a, s.ID())
					if err := s.Close(t.Context()); err != nil {
						t.Fatal(err)
					}
					f.unpublished(t, a, s.ID())
				})
				t.Run("kill", func(t *testing.T) {
					f := provisionalFixture{root: t.TempDir(), store: store, placement: placement}
					f.startService(t)
					id := f.killBeforeInput(t)
					a := modulartest.Agent(t, f.options(t)...)
					f.unpublished(t, a, id)
					if _, err := a.OpenSession(t.Context(), id); !isHistoryCode(err, modular.NotFound) {
						t.Fatalf("reopened unused session after SIGKILL: %v", err)
					}
				})
				t.Run("admit-and-fork", func(t *testing.T) {
					f := provisionalFixture{root: t.TempDir(), store: store, placement: placement}
					f.startService(t)
					f.admitAndFork(t)
				})
			})
		}
	}
}

func lifecycleHistory(t *testing.T, s *modular.Session) []modular.HistoryEntry {
	t.Helper()
	rows, err := s.History(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	return rows
}

func assertLifecycleKinds(t *testing.T, rows []modular.HistoryEntry, want ...string) {
	t.Helper()
	var got []string
	for _, row := range rows {
		got = append(got, row["kind"].(string))
	}
	if !slices.Equal(got, want) {
		t.Fatalf("history kinds %v, want %v", got, want)
	}
}

func (f provisionalFixture) assertFirstSave(t *testing.T, id string, want []modular.HistoryEntry) {
	t.Helper()
	if f.store == "file" {
		return // The reopened snapshot is checked below; this store has no append port.
	}
	got := f.firstSave(t, id)
	if len(got) != len(want) {
		t.Fatalf("initial batch kept %d entries, want %d", len(got), len(want))
	}
	for i, e := range got {
		if e.ID != want[i]["id"] {
			t.Fatalf("initial batch entry %d = %s, want %s", i, e.ID, want[i]["id"])
		}
	}
}

func (f provisionalFixture) admitAndFork(t *testing.T) {
	ctx := t.Context()
	a := modulartest.Agent(t, f.options(t)...)
	s := provisionalSession(t, a)
	guest, err := s.As("guest")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := guest.Send(ctx, "refused", modular.Now); !isHistoryCode(err, modular.Forbidden) {
		t.Fatalf("watch-only actor admitted input: %v", err)
	}
	f.unpublished(t, a, s.ID())
	setup := lifecycleHistory(t, s)
	assertLifecycleKinds(t, setup, "tenant", "actorJoined", "actorJoined", "plugins", "setting")
	if turn, err := s.Prompt(ctx, "keep this"); err != nil || turn.Text != "done" {
		t.Fatalf("first turn: %+v, %v", turn, err)
	}
	if err := s.WaitIdle(ctx); err != nil {
		t.Fatal(err)
	}
	entries := lifecycleHistory(t, s)
	if len(entries) < len(setup)+2 || !reflect.DeepEqual(entries[:len(setup)], setup) {
		t.Fatalf("initial setup was not retained verbatim: setup=%v, history=%v", setup, entries)
	}
	assertLifecycleKinds(t, entries[len(setup):len(setup)+2], "inputAccepted", "turnStart")
	if entries[len(setup)]["parentId"] != setup[len(setup)-1]["id"] {
		t.Fatal("first receipt does not follow provisional setup")
	}
	f.assertFirstSave(t, s.ID(), entries[:len(setup)+1])
	fork, err := s.Fork(ctx)
	if err != nil {
		t.Fatal(err)
	}
	copied := lifecycleHistory(t, fork)
	var prefix int
	for _, e := range entries {
		if e["kind"] == "tenant" {
			continue // Authority is re-established by the fresh setup.
		}
		if prefix >= len(copied) {
			t.Fatalf("missing copied entry %s", e["id"])
		}
		entry := copied[prefix]
		// HistoryEntry is a JSON object; normalize the sources array for comparison.
		sources, _ := json.Marshal(entry["sources"])
		want, _ := json.Marshal([]any{e["id"]})
		if string(sources) != string(want) || entry["id"] == e["id"] {
			t.Fatalf("invalid copy of %s: %v", e["id"], entry)
		}
		prefix++
	}
	assertLifecycleKinds(t, copied[prefix:], "tenant", "actorJoined", "actorJoined", "setting", "plugins")
	f.assertFirstSave(t, fork.ID(), copied)
	for _, check := range []struct {
		s    *modular.Session
		rows []modular.HistoryEntry
	}{{s, entries}, {fork, copied}} {
		if err := check.s.Close(ctx); err != nil {
			t.Fatal(err)
		}
		reopened, err := a.OpenSession(ctx, check.s.ID())
		if err != nil {
			t.Fatal(err)
		}
		got := lifecycleHistory(t, reopened)
		if len(got) < len(check.rows) {
			t.Fatalf("reopen kept %d entries, want at least %d", len(got), len(check.rows))
		}
		for _, row := range got[len(check.rows):] {
			if row["kind"] != "plugins" { // Reopen can record a changed plugin set.
				t.Fatalf("unexpected entry on reopen: %v", row)
			}
		}
		for i, e := range got[:len(check.rows)] {
			for _, field := range []string{"id", "kind", "time", "parentId"} {
				if e[field] != check.rows[i][field] {
					t.Fatalf("reopened entry %d changed %s: %v vs %v", i, field, e[field], check.rows[i][field])
				}
			}
		}
	}
}

func (f provisionalFixture) killBeforeInput(t *testing.T) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := json.Marshal([]string{f.root, f.store, f.placement, f.url})
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(ctx, exe, "-test.run=^TestProvisionalSessionProgram$")
	cmd.Env = append(os.Environ(), "MA_TEST_PROVISIONAL_SESSION="+string(cfg))
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	in, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if cmd.ProcessState == nil {
			_ = cmd.Cancel()
			_ = cmd.Wait()
		}
	}()
	var id string
	if err := json.NewDecoder(bufio.NewReader(out)).Decode(&id); err != nil || id == "" {
		t.Fatalf("child did not announce a session: %q, %v", id, err)
	}
	if err := cmd.Cancel(); err != nil {
		t.Fatal(err)
	}
	var exit *exec.ExitError
	if err := cmd.Wait(); !errors.As(err, &exit) || exit.Sys().(syscall.WaitStatus).Signal() != syscall.SIGKILL || ctx.Err() != nil {
		t.Fatalf("child did not die at the requested crash point: %v (context %v)", err, ctx.Err())
	}
	return id
}

func TestProvisionalSessionProgram(t *testing.T) {
	cfg := os.Getenv("MA_TEST_PROVISIONAL_SESSION")
	if cfg == "" {
		t.Skip("only run in the crash child")
	}
	var args [4]string
	if err := json.Unmarshal([]byte(cfg), &args); err != nil {
		t.Fatal(err)
	}
	f := provisionalFixture{args[0], args[1], args[2], args[3]}
	a := modulartest.Agent(t, f.options(t)...)
	s := provisionalSession(t, a)
	if err := json.NewEncoder(os.Stdout).Encode(s.ID()); err != nil {
		t.Fatal(err)
	}
	// A pipe keeps the process alive without cleanup until the parent kills it.
	_, _ = bufio.NewReader(os.Stdin).ReadByte()
	t.Fatal("crash child was not killed")
}

func TestProvisionalRuntimeProgram(t *testing.T) {
	if os.Getenv("MA_TEST_PROVISIONAL_RUNTIME") == "" {
		t.Skip("only run in the served Runtime child")
	}
	p := modular.Plugin{Name: "provisional-runtime", Replaces: []string{"runtime"}, Setup: func(r *modular.Registrar) error {
		return r.Runtime(modular.TransientRuntime())
	}}
	if err := modular.Serve(t.Context(), p); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(0)
}
