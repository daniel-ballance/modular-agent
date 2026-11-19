// Package scenarios runs the shared SDK scenarios in every available placement.
package scenarios

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/history"
	"github.com/OWNER/modular-agent/go/modular"
	"github.com/OWNER/modular-agent/go/modular/internal/fixtures"
	"github.com/OWNER/modular-agent/go/modular/modulartest"
	"github.com/OWNER/modular-agent/go/portable"
)

type scenario struct {
	Name  string `json:"scenario"`
	Agent struct {
		Durability modular.Durability
		Plugins    []string
		Approval   modular.Approval
		Answers    []json.RawMessage
		Settings   modular.Settings
	}
	Model      json.RawMessage
	Placements []string
	Steps      []step
}
type step struct {
	Prompt    *string
	Reopen    bool
	CrashWhen *condition
	Expect    *expectation
}
type condition struct {
	Count  *int
	Record string
}
type expectation struct {
	Outcome, Text, Error *string
	ToolResults          []struct {
		Name           string
		Status         modular.ToolStatus
		Text, Contains *string
	}
	Records []string
	Count   *int
}
type placement struct {
	SDK     string
	Command []string
}

func (p placement) name() string {
	if p.SDK == "" {
		return "inProcess"
	}
	return "process:" + p.SDK
}
func (p placement) applies(s scenario) bool {
	return len(s.Placements) == 0 || slices.Contains(s.Placements, p.name()) || p.SDK != "" && slices.Contains(s.Placements, "process")
}

type run struct {
	dir       string
	placement placement
}

func (r run) countPath() string { return filepath.Join(r.dir, "count") }
func (r run) dataDir() string   { return filepath.Join(r.dir, "data") }

func load[T any](path string) (T, error) {
	var v T
	b, err := os.ReadFile(path)
	if err != nil {
		return v, err
	}
	err = json.Unmarshal(b, &v)
	return v, err
}
func (r run) agent(ctx context.Context, s scenario) (*modular.Agent, error) {
	project := filepath.Join(r.dir, "project")
	if err := os.MkdirAll(project, 0700); err != nil {
		return nil, err
	}
	durability := s.Agent.Durability
	if durability == "" {
		durability = modular.Ephemeral
	}
	opts := []modular.Option{modulartest.Script(string(s.Model)), modular.WithProject(project), modular.WithDataDir(r.dataDir()), modular.WithDurability(durability), modular.WithSettings(s.Agent.Settings)}
	config := map[string]any{"path": r.countPath()}
	for _, name := range s.Agent.Plugins {
		if r.placement.SDK == "" {
			p, err := fixtures.Plugin(name)
			if err != nil {
				return nil, err
			}
			p.Config = config
			opts = append(opts, modular.WithPlugin(p))
		} else {
			opts = append(opts, modular.WithProcessPlugin(modular.ProcessPlugin{Command: append(slices.Clone(r.placement.Command), name), Config: config}))
		}
	}
	if s.Agent.Approval != "" {
		opts = append(opts, modular.WithApproval(s.Agent.Approval))
	}
	if s.Agent.Answers != nil {
		var answers []modular.Answer
		for _, raw := range s.Agent.Answers {
			switch string(raw) {
			case `"allow"`:
				answers = append(answers, modular.Allow())
			case `"decline"`:
				answers = append(answers, modular.Decline(""))
			default:
				var a modular.Answer
				if err := json.Unmarshal(raw, &a); err != nil {
					return nil, err
				}
				answers = append(answers, a)
			}
		}
		opts = append(opts, modular.WithOnQuestion(modulartest.Answers(answers...)))
	}
	return modular.New(ctx, opts...)
}

func TestShared(t *testing.T) {
	t.Setenv("MODULAR_AGENT_PLUGINS", "")
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	files, err := filepath.Glob(filepath.Join(root, "conformance/sdk/scenarios/*.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("scenario files: %v %v", files, err)
	}
	regs, err := filepath.Glob(filepath.Join(root, "conformance/sdk/fixtures/*.json"))
	if err != nil {
		t.Fatal(err)
	}
	// MODULAR_AGENT_SDK_REQUIRE is `all` or a comma-separated list of SDKs (docs/sdk/testing.md).
	requireAll := false
	required := map[string]bool{}
	for _, name := range strings.Split(os.Getenv("MODULAR_AGENT_SDK_REQUIRE"), ",") {
		if name = strings.TrimSpace(name); name == "all" {
			requireAll = true
		} else if name != "" {
			required[name] = false
		}
	}
	// The runner always builds its own registered program, including when it was not built in advance.
	own := filepath.Join(root, "go/.bin/modular-agent-fixtures")
	cmd := exec.Command("go", "build", "-o", own, "./modular/cmd/fixtures")
	cmd.Dir = filepath.Join(root, "go")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build Go fixture: %v\n%s", err, b)
	}
	placements := []placement{{}}
	for _, path := range regs {
		f, err := load[struct {
			SDK, Build string
			Command    []string
		}](path)
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := required[f.SDK]; ok {
			required[f.SDK] = true
		}
		p := placement{SDK: f.SDK}
		var missing []string
		for _, arg := range f.Command {
			expanded := strings.ReplaceAll(arg, "{repo}", root)
			p.Command = append(p.Command, expanded)
			if strings.HasPrefix(arg, "{repo}") {
				if _, err := os.Stat(expanded); err != nil {
					missing = append(missing, expanded)
				}
			}
		}
		if len(p.Command) == 0 {
			t.Fatalf("%s: command is empty", path)
		}
		if len(missing) > 0 {
			if _, ok := required[f.SDK]; requireAll || ok {
				t.Errorf("%s not built (%v); build with: %s", f.SDK, missing, f.Build)
			} else {
				t.Logf("skip %s (not built); build with: %s", p.name(), f.Build)
			}
			continue
		}
		placements = append(placements, p)
	}
	for name, listed := range required {
		if !listed {
			t.Errorf("required SDK %q has no fixture registry", name)
		}
	}
	for _, path := range files {
		s, err := load[scenario](path)
		if err != nil {
			t.Fatal(err)
		}
		for _, p := range placements {
			if p.applies(s) {
				t.Run(s.Name+"/"+p.name(), func(t *testing.T) { run{dir: t.TempDir(), placement: p}.check(t, path, s) })
			}
		}
	}
}
func (r run) check(t *testing.T, path string, sc scenario) {
	ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
	defer cancel()
	var a *modular.Agent
	var s *modular.Session
	var id string
	closeAgent := func() {
		if a != nil {
			if err := a.Close(context.Background()); err != nil {
				t.Error(err)
			}
			a = nil
			s = nil
		}
	}
	defer closeAgent()
	for i, step := range sc.Steps {
		var result *modular.PromptResult
		var err error
		fail := func(format string, args ...any) { t.Errorf("step %d: %s", i, fmt.Sprintf(format, args...)) }
		switch {
		case step.Prompt != nil && step.CrashWhen != nil:
			closeAgent()
			id, err = r.crash(ctx, path, i, id, *step.CrashWhen)
		case step.Prompt != nil:
			if a == nil {
				a, err = r.agent(ctx, sc)
				if err == nil {
					s, err = a.Session(ctx)
					if err == nil {
						id = s.ID()
					}
				}
			}
			if err == nil {
				var p modular.PromptResult
				p, err = s.Prompt(ctx, *step.Prompt)
				result = &p
			}
		case step.Reopen:
			closeAgent()
			if id == "" {
				err = errors.New("no session to reopen")
				break
			}
			a, err = r.agent(ctx, sc)
			if err == nil {
				s, err = a.OpenSession(ctx, id)
				if err == nil {
					result, err = s.LastTurn(ctx)
				}
			}
		default:
			err = errors.New("unknown step")
		}
		w := step.Expect
		if err != nil {
			var got *modular.Error
			if w != nil && w.Error != nil {
				if !errors.As(err, &got) || string(got.Code) != *w.Error {
					fail("error: want %q, got %v", *w.Error, err)
				}
			} else {
				fail("unexpected error: %v", err)
			}
			if a == nil || s == nil && step.CrashWhen == nil {
				return
			}
			continue
		}
		if w == nil {
			continue
		}
		if w.Error != nil {
			fail("error: want %q, got success", *w.Error)
		}
		equal := func(field string, want, got any) {
			if !reflect.DeepEqual(want, got) {
				fail("%s: want %#v, got %#v", field, want, got)
			}
		}
		if w.Count != nil {
			equal("count", *w.Count, fixtures.Count(r.countPath()))
		}
		if w.Outcome != nil {
			got := ""
			if result != nil && result.Outcome != nil {
				got = result.Outcome.Kind
			}
			equal("outcome", *w.Outcome, got)
		}
		if w.Text != nil {
			if result == nil {
				fail("text: want %q, got no turn", *w.Text)
			} else {
				equal("text", *w.Text, result.Text)
			}
		}
		if w.ToolResults != nil {
			var got []modular.ToolResult
			if result != nil {
				got = result.ToolResults()
			}
			equal("toolResults length", len(w.ToolResults), len(got))
			for j := 0; j < min(len(w.ToolResults), len(got)); j++ {
				want, g := w.ToolResults[j], got[j]
				field := fmt.Sprintf("toolResults[%d]", j)
				equal(field+".name", want.Name, g.Name)
				equal(field+".status", want.Status, g.Status)
				if want.Text != nil {
					equal(field+".text", *want.Text, g.Text())
				}
				if want.Contains != nil && !strings.Contains(g.Text(), *want.Contains) {
					fail("%s.text: want substring %q, got %q", field, *want.Contains, g.Text())
				}
			}
		}
		if w.Records != nil {
			if s == nil {
				fail("records: want %v, got no open session", w.Records)
				continue
			}
			entries, err := s.History(ctx)
			if err != nil {
				fail("history: %v", err)
				continue
			}
			var got []string
			for _, e := range entries {
				k, _ := e["kind"].(string)
				got = append(got, k)
			}
			at := 0
			for _, want := range w.Records {
				n := slices.Index(got[at:], want)
				if n < 0 {
					fail("records: want %v in order, got %v", w.Records, got)
					break
				}
				at += n + 1
			}
		}
	}
}

// The helper runs only the crash step. Its stdout carries one session id, not trace output.
func TestCrashChild(t *testing.T) {
	if os.Getenv("MODULAR_AGENT_GO_SCENARIO_CHILD") == "" {
		return
	}
	args := os.Args[slices.Index(os.Args, "--")+1:]
	sc, err := load[scenario](args[0])
	if err != nil {
		t.Fatal(err)
	}
	i, err := strconv.Atoi(args[2])
	if err != nil {
		t.Fatal(err)
	}
	r := run{dir: args[1], placement: placement{SDK: args[4], Command: args[5:]}}
	a, err := r.agent(t.Context(), sc)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close(context.Background())
	var s *modular.Session
	if args[3] == "" {
		s, err = a.Session(t.Context())
	} else {
		s, err = a.OpenSession(t.Context(), args[3])
	}
	if err != nil {
		t.Fatal(err)
	}
	fmt.Printf("SESSION %s\n", s.ID())
	if _, err := s.Prompt(t.Context(), *sc.Steps[i].Prompt); err != nil {
		t.Fatal(err)
	}
	// A fast prompt may have already committed the record the parent is watching.
	time.Sleep(30 * time.Second)
}
func (r run) crash(ctx context.Context, path string, index int, id string, cond condition) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	args := []string{"-test.run=^TestCrashChild$", "--", path, r.dir, strconv.Itoa(index), id, r.placement.SDK}
	cmd := exec.Command(exe, append(args, r.placement.Command...)...)
	cmd.Env = append(os.Environ(), "MODULAR_AGENT_GO_SCENARIO_CHILD=1")
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	if err = cmd.Start(); err != nil {
		return "", err
	}
	pid := cmd.Process.Pid
	defer func() {
		if cmd.ProcessState == nil {
			_ = syscall.Kill(-pid, syscall.SIGKILL)
			_ = cmd.Wait()
		}
	}()
	lines := make(chan string, 1)
	go func() { line, _ := bufio.NewReader(stdout).ReadString('\n'); lines <- strings.TrimSpace(line) }()
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case line := <-lines:
		var ok bool
		id, ok = strings.CutPrefix(line, "SESSION ")
		if !ok || id == "" {
			return "", fmt.Errorf("no session id: %q", line)
		}
	}
	var store *history.Store
	if cond.Record != "" {
		store, err = history.New(filepath.Join(r.dataDir(), "sessions"))
		if err != nil {
			return "", err
		}
	}
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	for {
		reached := cond.Count != nil && fixtures.Count(r.countPath()) >= *cond.Count
		if store != nil {
			snaps, err := store.List("")
			if err != nil {
				return "", err
			}
			for _, s := range snaps {
				if s.ID == id && slices.ContainsFunc(s.Entries, func(e api.Entry) bool { return portable.Entry(e)["kind"] == cond.Record }) {
					reached = true
					break
				}
			}
		}
		if reached {
			break
		}
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("the crash condition never held: %w", ctx.Err())
		case <-tick.C:
		}
	}
	if err := syscall.Kill(-pid, syscall.SIGKILL); err != nil {
		return "", err
	}
	_ = cmd.Wait()
	for groupAlive(pid) {
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("crashed process group did not exit: %w", ctx.Err())
		case <-tick.C:
		}
	}
	return id, nil
}

// A zombie has exited. The parent cannot reap a grandchild reparented to init.
func groupAlive(group int) bool {
	entries, _ := os.ReadDir("/proc")
	for _, e := range entries {
		if _, err := strconv.Atoi(e.Name()); err != nil {
			continue
		}
		stat, err := os.ReadFile(filepath.Join("/proc", e.Name(), "stat"))
		if err != nil {
			continue
		}
		i := strings.LastIndexByte(string(stat), ')')
		if i < 0 {
			continue
		}
		fields := strings.Fields(string(stat[i+1:]))
		if len(fields) < 3 {
			continue
		}
		pg, _ := strconv.Atoi(fields[2])
		if pg == group && fields[0] != "Z" && fields[0] != "X" {
			return true
		}
	}
	return false
}
