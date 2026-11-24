// Package scenarios runs the shared SDK scenarios in every available placement.
package scenarios

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/history"
	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/internal/fixtures"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
	"github.com/daniel-ballance/modular-agent/go/portable"
)

type scenario struct {
	ExpectDeclaration map[string]bool
	Fixture           struct{ RequestedApprovalMs int64 }
	Name              string `json:"scenario"`
	Agent             struct {
		MaxApprovalWaitMs *int64
		Durability        modular.Durability
		Plugins           []string
		Approval          modular.Approval
		Answers           []json.RawMessage
		Settings          modular.Settings
		SeveralActors     bool
		Actors            []modular.Actor
		History           string
	}
	ExpectCreateError *struct {
		Code            modular.Code
		MessageContains string
	}
	Model      json.RawMessage
	Placements []string
	Steps      []step
}
type step struct {
	Prompt    *string
	As        string
	Send      *string
	Timing    modular.Timing
	Answer    json.RawMessage
	Wait      bool
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
	Service bool
}

func (p placement) name() string {
	if p.SDK == "" {
		return "inProcess"
	}
	if p.Service {
		return "service:" + p.SDK
	}
	return "process:" + p.SDK
}
func (p placement) applies(s scenario) bool {
	return len(s.Placements) == 0 || slices.Contains(s.Placements, p.name()) || p.SDK != "" && (p.Service && slices.Contains(s.Placements, "service") || !p.Service && slices.Contains(s.Placements, "process"))
}

type run struct {
	waiting   *waitFixture
	dir       string
	placement placement
	services  []modular.ServicePlugin
	telemetry *telemetryRun
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
func (r run) agent(ctx context.Context, s scenario, checkAnswers func(*modulartest.AnswerScript)) (*modular.Agent, error) {
	project := filepath.Join(r.dir, "project")
	if err := os.MkdirAll(project, 0700); err != nil {
		return nil, err
	}
	durability := s.Agent.Durability
	if durability == "" {
		durability = modular.Ephemeral
	}
	opts := []modular.Option{modular.WithProject(project), modular.WithDataDir(r.dataDir()), modular.WithDurability(durability), modular.WithSettings(s.Agent.Settings), modular.WithSeveralActors(s.Agent.SeveralActors)}
	if r.telemetry == nil || r.telemetry.crash == nil {
		opts = append(opts, modulartest.Script(string(s.Model)))
	}
	if r.telemetry != nil {
		more, err := r.telemetryOptions(s, durability)
		if err != nil {
			return nil, err
		}
		opts = append(opts, more...)
	}
	switch s.Agent.History {
	case "":
	case "file":
		opts = append(opts, modular.WithHistory(modular.FileHistory(filepath.Join(r.dir, "explicit-history"))))
	case "service":
		url, err := os.ReadFile(filepath.Join(r.dir, "history-url"))
		if err != nil {
			return nil, fmt.Errorf("history fixture URL: %w", err)
		}
		opts = append(opts, modular.WithHistory(modular.HTTPHistory(string(url), filepath.Join(r.dir, "history-token"))))
	default:
		return nil, fmt.Errorf("unknown history fixture %q", s.Agent.History)
	}
	config := map[string]any{"path": r.countPath()}
	if r.waiting != nil {
		config["waitingCounter"] = true
	}
	for i, name := range s.Agent.Plugins {
		if r.waiting != nil && name == "counter" && r.placement.SDK != "" && r.placement.SDK != "go" && (s.Name == "waiting-approval-changed-source" || s.Name == "waiting-approval-changed-definition") {
			_, file, _, _ := runtime.Caller(0)
			args := []string{"node", filepath.Join(filepath.Dir(file), "counter-catalog.mjs")}
			if r.placement.Service {
				svc := r.services[i]
				args = append(args, "--service", svc.URL, svc.TokenFile)
			} else {
				args = append(args, r.placement.Command...)
				args = append(args, name)
			}
			opts = append(opts, modular.WithProcessPlugin(modular.ProcessPlugin{Command: args, Config: config}))
			continue
		}
		if r.placement.Service {
			opts = append(opts, modular.WithServicePlugin(r.services[i]))
		} else if r.placement.SDK == "" {
			choice := "yes"
			if r.telemetry != nil && s.Name == "question-answered" {
				choice = r.telemetry.Values.Answer
			}
			p, err := fixtures.PluginWithChoice(name, choice)
			if err != nil {
				return nil, err
			}
			p.Config = config
			opts = append(opts, modular.WithPlugin(p))
		} else if r.telemetry != nil {
			idx := slices.IndexFunc(r.telemetry.Fixtures, func(f fixtureSpec) bool { return f.Name == name })
			if idx < 0 {
				return nil, fmt.Errorf("telemetry request is missing fixture %q", name)
			}
			f := r.telemetry.Fixtures[idx]
			opts = append(opts, modular.WithProcessPlugin(modular.ProcessPlugin{Command: f.Command, Env: f.Env, Config: config}))
		} else {
			opts = append(opts, modular.WithProcessPlugin(modular.ProcessPlugin{Command: append(slices.Clone(r.placement.Command), name), Config: config}))
		}
	}
	if r.waiting != nil {
		opts = append(opts, r.waiting.options(s)...)
	}
	if s.Agent.MaxApprovalWaitMs != nil {
		opts = append(opts, modular.WithMaxApprovalWaitMs(*s.Agent.MaxApprovalWaitMs))
	}
	if s.Agent.Approval != "" {
		opts = append(opts, modular.WithApproval(s.Agent.Approval))
	}
	if s.Agent.Answers != nil {
		var answers []modular.Answer
		for _, raw := range s.Agent.Answers {
			a, err := readAnswer(raw)
			if err != nil {
				return nil, err
			}
			answers = append(answers, a)
		}
		script := modulartest.Answers(answers...)
		if checkAnswers != nil {
			checkAnswers(script)
		}
		opts = append(opts, modular.WithOnQuestion(script.Handle))
	}
	return modular.New(ctx, opts...)
}

func readAnswer(raw json.RawMessage) (modular.Answer, error) {
	switch string(raw) {
	case `"allow"`:
		return modular.Allow(), nil
	case `"decline"`:
		return modular.Decline(""), nil
	}
	var value struct{ Value *string }
	if err := json.Unmarshal(raw, &value); err != nil {
		return modular.Answer{}, err
	}
	if value.Value == nil {
		return modular.Answer{}, errors.New("answer needs a value")
	}
	return modular.Value(*value.Value), nil
}

func answerOpen(ctx context.Context, s *modular.Session, raw json.RawMessage) error {
	a, err := readAnswer(raw)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		qs, err := s.Questions(ctx)
		if err != nil {
			return err
		}
		if len(qs) == 1 {
			return s.Answer(ctx, qs[0].ID, a)
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("want one open question, got %d: %w", len(qs), ctx.Err())
		case <-ticker.C:
		}
	}
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
	var services []placement
	// An optional subset is for local development only; require=all always runs the matrix.
	serviceFilter := strings.Split(os.Getenv("MODULAR_AGENT_SDK_SERVICE"), ",")
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
		if requireAll || slices.Contains(serviceFilter, "") || slices.Contains(serviceFilter, "all") || slices.Contains(serviceFilter, p.SDK) {
			p.Service = true
			services = append(services, p)
		}
	}
	placements = append(placements, services...)
	for name, listed := range required {
		if !listed {
			t.Errorf("required SDK %q has no fixture registry", name)
		}
	}
	waitDir := filepath.Join(root, "conformance/sdk/fixtures/waiting-approval")
	names, err := load[[]string](filepath.Join(root, "conformance/sdk/waiting-scenarios.json"))
	if err != nil || len(names) == 0 {
		t.Fatalf("waiting manifest: %v", err)
	}
	extra, err := filepath.Glob(filepath.Join(waitDir, "*.json"))
	if err != nil || len(names) != len(extra) {
		t.Fatal("waiting fixture set differs from manifest", err)
	}
	for i := range names {
		names[i] += ".json"
	}
	slices.Sort(names)
	for i, name := range names {
		if filepath.Base(extra[i]) != name {
			t.Fatalf("waiting fixture %s missing from manifest", extra[i])
		}
	}
	for _, path := range append(files, extra...) {
		s, err := load[scenario](path)
		if err != nil {
			t.Fatal(err)
		}
		for _, p := range placements {
			if p.applies(s) {
				t.Run(s.Name+"/"+p.name(), func(t *testing.T) {
					r := run{dir: t.TempDir(), placement: p}
					if filepath.Dir(path) == waitDir {
						r.checkWaiting(t, path, s)
					} else {
						r.check(t, path, s)
					}
				})
			}
		}
	}
}
func (r run) check(t *testing.T, path string, sc scenario) {
	ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
	defer cancel()
	if sc.Agent.History == "service" {
		var token [32]byte
		if _, err := rand.Read(token[:]); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(r.dir, "history-token")
		if err := os.WriteFile(path, []byte(hex.EncodeToString(token[:])), 0600); err != nil {
			t.Fatal(err)
		}
		store := modular.FileHistory(filepath.Join(r.dir, "explicit-history"))
		service, err := modular.ListenHistory(ctx, store, modular.HistoryOptions{Address: "127.0.0.1:0", TokenFile: path})
		if err != nil {
			t.Fatalf("set up history fixture: %v", err)
		}
		defer func() {
			if err := service.Close(); err != nil {
				t.Error(err)
			}
		}()
		if err := os.WriteFile(filepath.Join(r.dir, "history-url"), []byte(service.URL), 0600); err != nil {
			t.Fatal(err)
		}
	}
	var a *modular.Agent
	var s *modular.Session
	var id string
	var answers *modulartest.AnswerScript
	var serviceGroups fixtureGroups
	remember := func(script *modulartest.AnswerScript) { answers = script }
	defer func() {
		if answers != nil {
			answers.AssertDone(t)
		}
	}()
	closeAgent := func() {
		if a != nil {
			if err := a.Close(context.Background()); err != nil {
				t.Error(err)
			}
			a = nil
			s = nil
		}
		if err := serviceGroups.stop(); err != nil {
			t.Error(err)
		}
	}
	defer closeAgent()
	startAgent := func() (*modular.Agent, error) {
		var err error
		r.services, err = serviceGroups.start(ctx, r, sc)
		if err != nil {
			return nil, err
		}
		return r.agent(ctx, sc, remember)
	}
	if want := sc.ExpectCreateError; want != nil {
		if len(sc.Steps) != 0 {
			t.Fatal("expectCreateError requires no steps")
		}
		var err error
		r.services, err = serviceGroups.start(ctx, r, sc)
		if err != nil {
			t.Fatalf("start fixture services: %v", err)
		}
		a, err = r.agent(ctx, sc, nil)
		var got *modular.Error
		if !errors.As(err, &got) || got.Code != want.Code || !strings.Contains(got.Message, want.MessageContains) {
			t.Fatalf("create: want %s with message containing %q, got %v", want.Code, want.MessageContains, err)
		}
		return
	}
	for i, step := range sc.Steps {
		var result *modular.PromptResult
		var err error
		fail := func(format string, args ...any) { t.Errorf("step %d: %s", i, fmt.Sprintf(format, args...)) }
		switch {
		case step.Prompt != nil && step.CrashWhen != nil:
			closeAgent()
			id, err = r.crash(ctx, path, sc, i, id, *step.CrashWhen)
		case step.Prompt != nil || step.Send != nil:
			if a == nil {
				a, err = startAgent()
				if err == nil {
					s, err = a.Session(ctx, modular.SessionOptions{Actors: sc.Agent.Actors})
					if err == nil {
						id = s.ID()
					}
				}
			}
			if err == nil {
				view := s
				if step.As != "" {
					view, err = s.As(step.As)
				}
				if err == nil && step.Send != nil {
					timing := step.Timing
					if timing == "" {
						timing = modular.Now
					}
					_, err = view.Send(ctx, *step.Send, timing)
				} else if err == nil {
					var p modular.PromptResult
					p, err = view.Prompt(ctx, *step.Prompt)
					result = &p
				}
			}
		case step.Answer != nil:
			if s == nil {
				err = errors.New("no open session")
			} else {
				err = answerOpen(ctx, s, step.Answer)
			}
		case step.Wait:
			if s == nil {
				err = errors.New("no open session")
			} else if err = s.WaitIdle(ctx); err == nil {
				result, err = s.LastTurn(ctx)
			}
		case step.Reopen:
			closeAgent()
			if id == "" {
				err = errors.New("no session to reopen")
				break
			}
			a, err = startAgent()
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
	if r.telemetry != nil {
		if answers != nil {
			answers.AssertDone(t)
			answers = nil
		}
		if !t.Failed() {
			if s == nil {
				t.Fatal("telemetry scenario has no session")
			}
			if err := r.writeEvidence(ctx, a, s); err != nil {
				t.Fatal(err)
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
	r := run{dir: args[1], placement: placement{SDK: args[4], Command: args[6:], Service: args[5] != ""}, telemetry: openTelemetryRun(t)}
	if r.placement.Service {
		if err := json.Unmarshal([]byte(args[5]), &r.services); err != nil {
			t.Fatal(err)
		}
	}
	a, err := r.agent(t.Context(), sc, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close(context.Background())
	var s *modular.Session
	if args[3] == "" {
		s, err = a.Session(t.Context(), modular.SessionOptions{Actors: sc.Agent.Actors})
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
func (r run) crash(ctx context.Context, path string, sc scenario, index int, id string, cond condition) (sessionID string, err error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	var groups fixtureGroups
	defer func() { err = errors.Join(err, groups.stop()) }()
	var encoded string
	if r.placement.Service {
		config, err := groups.start(ctx, r, sc)
		if err != nil {
			return "", err
		}
		b, err := json.Marshal(config)
		if err != nil {
			return "", err
		}
		encoded = string(b)
	}
	args := []string{"-test.run=^TestCrashChild$", "--", path, r.dir, strconv.Itoa(index), id, r.placement.SDK, encoded}
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
	// Kill the agent before the services so it cannot record a graceful
	// connection-loss settlement in the interval between kill signals.
	groups = append(fixtureGroups{cmd}, groups...)
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
	if r.telemetry != nil {
		if err := r.crashEvidence(id); err != nil {
			return "", err
		}
	}
	return id, groups.stop()
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
