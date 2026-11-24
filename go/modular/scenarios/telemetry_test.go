package scenarios

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/acpinterface"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/history"
	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/internal/fixtures"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
	"github.com/daniel-ballance/modular-agent/go/portable"
)

const telemetryRunEnv = "MODULAR_AGENT_TELEMETRY_RUN"

type telemetryRequest struct {
	Host, Scenario, Placement, AgentName, ScenarioPath, WorkDir, ReportPath, Handshake, ParkedURL string
	SDK                                                                                           bool
	Fixtures                                                                                      []fixtureSpec
	Values                                                                                        struct{ Answer string }
}

type fixtureSpec struct {
	Name    string
	Command []string
	Env     map[string]string
}

type telemetryRun struct {
	telemetryRequest
	mu             sync.Mutex
	crash          *crashEvidence
	commits        []commitEvidence
	observationErr error
}

type crashEvidence struct {
	Signal        string           `json:"signal"`
	CountBefore   int              `json:"countBefore"`
	CountAfter    int              `json:"countAfter"`
	TurnStart     map[string]any   `json:"turnStart"`
	AfterRestart  []map[string]any `json:"afterRestart"`
	preCrashSteps map[string]bool
}

type writerEvidence struct {
	Name   string `json:"name"`
	TurnID string `json:"turnId,omitempty"`
	StepID string `json:"stepId,omitempty"`
}
type commitEvidence struct {
	Count  int            `json:"count"`
	Status string         `json:"status"`
	TurnID string         `json:"turnId,omitempty"`
	StepID string         `json:"stepId,omitempty"`
	Parent writerEvidence `json:"parent"`
}

func openTelemetryRun(t *testing.T) *telemetryRun {
	t.Helper()
	path := os.Getenv(telemetryRunEnv)
	if path == "" {
		return nil
	}
	req, err := load[telemetryRequest](path)
	if err != nil {
		t.Fatal(err)
	}
	if req.Host != "go" || os.Getenv(fixtures.EndpointEnv) == "" {
		t.Fatal("Go telemetry adapter needs a Go host request and receiver endpoint")
	}
	if req.SDK {
		flush, err := fixtures.InstallTelemetry(t.Context(), os.Getenv(fixtures.EndpointEnv))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if err := flush(); err != nil {
				t.Error(err)
			}
		})
	}
	return &telemetryRun{telemetryRequest: req}
}

// Build with go test -c. The kit passes one request to this test process.
func TestTelemetryScenario(t *testing.T) {
	runCase := openTelemetryRun(t)
	if runCase == nil {
		t.Skip("not a telemetry kit invocation")
	}
	sc, err := load[scenario](runCase.ScenarioPath)
	if err != nil {
		t.Fatal(err)
	}
	var p placement
	if runCase.Placement != "inProcess" {
		var ok bool
		p.SDK, ok = strings.CutPrefix(runCase.Placement, "process:")
		if !ok || p.SDK == "" {
			t.Fatalf("unsupported telemetry placement %q", runCase.Placement)
		}
	}
	if sc.Name != runCase.Scenario || !p.applies(sc) {
		t.Fatal("telemetry request does not match the shared scenario")
	}
	r := run{dir: runCase.WorkDir, placement: p, telemetry: runCase}
	if sc.Requires["approvalsOutlastTurns"] {
		r.checkWaiting(t, runCase.ScenarioPath, sc)
	} else {
		r.check(t, runCase.ScenarioPath, sc)
	}
}

func (r run) telemetryOptions(sc scenario, durability modular.Durability) ([]modular.Option, error) {
	o := r.telemetry
	opts := []modular.Option{modular.WithAgentName(o.AgentName)}
	if sc.Name == "first-turn" {
		opts = append(opts, modular.WithPluginHost(true)) // read the ACP session declaration
	}
	if !o.SDK || !(sc.Name == "first-turn" || o.crash != nil) {
		return opts, nil
	}
	store, err := history.New(filepath.Join(r.dataDir(), "sessions"))
	if err != nil {
		return nil, err
	}
	opts = append(opts, modular.WithHistory(modular.NewHistoryStore(observedStore{store, o}, durability != modular.Ephemeral, false)))
	if o.crash != nil {
		var replies []modulartest.Reply
		if err := json.Unmarshal(sc.Model, &replies); err != nil {
			return nil, err
		}
		provider := modulartest.ScriptedProvider(replies)
		request := provider.Request
		provider.Request = func(ctx context.Context, model modular.ModelRef, req modular.ModelRequest, pc *modular.ProviderContext) (modular.AssistantMessage, error) {
			o.mu.Lock()
			if n := len(o.crash.AfterRestart); n == 0 || o.crash.AfterRestart[n-1]["kind"] != "effect" {
				o.crash.AfterRestart = append(o.crash.AfterRestart, map[string]any{"kind": "effect"})
			}
			o.mu.Unlock()
			return request(ctx, model, req, pc)
		}
		opts = append(opts, modular.WithProvider(provider))
	}
	return opts, nil
}

type observedStore struct {
	*history.Store
	run *telemetryRun
}

func (s observedStore) Acquire(id string) (api.Lease, error) {
	lease, err := s.Store.Acquire(id)
	if err != nil {
		return nil, err
	}
	return &observedLease{Lease: lease, run: s.run}, nil
}

type observedLease struct {
	api.Lease
	run *telemetryRun
}

func (l *observedLease) Save(next api.Session) error {
	previous, err := l.Load()
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	l.run.mu.Lock()
	defer l.run.mu.Unlock()
	if err := l.Lease.Save(next); err != nil {
		return err
	}
	batch := next.Entries[len(previous.Entries):]
	if l.run.crash != nil {
		for _, e := range batch {
			if e.Kind == "modular-agent.turnTrace" {
				l.run.crash.AfterRestart = append(l.run.crash.AfterRestart, portable.Entry(e))
			}
		}
	} else {
		commit, err := firstTurnCommit(batch)
		l.run.observationErr = errors.Join(l.run.observationErr, err)
		l.run.commits = append(l.run.commits, commit)
	}
	return nil
}

func firstTurnCommit(batch []api.Entry) (commitEvidence, error) {
	// The records identify which operation wrote the batch. In particular,
	// the step-start record belongs to turn setup; model intent and its
	// response are written by the step. The recorded batch size is the delta
	// between the actual snapshots, not an assumed size for these records.
	c := commitEvidence{Count: len(batch), Status: "committed"}
	for _, e := range batch {
		var writer writerEvidence
		switch e.Kind {
		case "setting", "actor.set", "plugins.set", "tenant", "limit":
			continue // initial records staged before the first input
		case "input.accepted":
			writer.Name = "modular_agent.input.admit"
		case "turn.start", "input", "step.start", "turn.end":
			writer = writerEvidence{Name: "invoke_agent", TurnID: e.Turn}
		case "model.request":
			writer = writerEvidence{Name: "chat", TurnID: e.Turn, StepID: e.Step}
		case "model", "step.end", portable.StepAfterKind:
			writer = writerEvidence{Name: "modular_agent.step", TurnID: e.Turn, StepID: e.Step}
		default:
			return c, fmt.Errorf("unexpected first-turn commit kind %q", e.Kind)
		}
		if c.Parent.Name != "" && c.Parent != writer {
			return c, fmt.Errorf("first-turn batch has multiple writers: %v and %v", c.Parent, writer)
		}
		c.Parent = writer
		c.TurnID, c.StepID = e.Turn, e.Step
	}
	return c, nil
}

func rawHistory(dir, session string) ([]api.Entry, error) {
	store, err := history.New(filepath.Join(dir, "sessions"))
	if err != nil {
		return nil, err
	}
	snaps, err := store.List("")
	if err != nil {
		return nil, err
	}
	for _, snap := range snaps {
		if snap.ID == session {
			return snap.Entries, nil
		}
	}
	return nil, fmt.Errorf("no committed history for %s", session)
}

func (r run) crashEvidence(id string) error {
	o := r.telemetry
	entries, err := rawHistory(r.dataDir(), id)
	if err != nil {
		return err
	}
	c := &crashEvidence{Signal: "SIGKILL", CountBefore: fixtures.Count(r.countPath()), AfterRestart: []map[string]any{}, preCrashSteps: map[string]bool{}}
	for _, e := range entries {
		switch e.Kind {
		case "turn.start":
			c.TurnStart = portable.Entry(e)
		case "model.request":
			c.preCrashSteps[e.Step] = true
		}
	}
	if c.TurnStart == nil {
		return fmt.Errorf("counter fired without a committed turn start")
	}
	o.crash = c
	return nil
}

type stepEvidence struct {
	ID          string `json:"id"`
	Model       string `json:"model"`
	BeforeCrash bool   `json:"beforeCrash,omitempty"`
}
type callEvidence struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	StepID         string `json:"stepId"`
	Status         string `json:"status"`
	ParentCallID   string `json:"parentCallId,omitempty"`
	ProviderCallID string `json:"providerCallId,omitempty"`
}

func (r run) writeEvidence(ctx context.Context, a *modular.Agent, s *modular.Session) error {
	o := r.telemetry
	if o.observationErr != nil {
		return o.observationErr
	}
	result, err := s.LastTurn(ctx)
	if err != nil {
		return err
	}
	if result == nil || result.Outcome == nil {
		return fmt.Errorf("shared scenario has no settled turn")
	}
	entries, err := s.History(ctx)
	if err != nil {
		return err
	}
	var kinds []string
	for _, entry := range entries {
		if kind, ok := entry["kind"].(string); ok {
			kinds = append(kinds, kind)
		}
	}
	report := map[string]any{"scenario": o.Scenario, "placement": o.Placement, "passed": true, "sessionId": s.ID(), "turnId": result.TurnID, "outcome": result.Outcome.Kind, "historyKinds": kinds}
	if o.Scenario == "first-turn" {
		declaration, err := r.sessionDeclaration(ctx, a, s.ID())
		if err != nil {
			return err
		}
		// Probe a compatible kept session separately; the first-turn case itself
		// remains ephemeral. Only report a real session's ACP declaration.
		probe, err := modular.New(ctx, modular.WithProject(filepath.Join(r.dir, "project")), modular.WithDataDir(filepath.Join(r.dir, "probe")), modular.WithDurability(modular.Kept), modular.WithLateAnswersStartTurns(true), modular.WithMaxApprovalWaitMs(5000), modular.WithApproval(modular.All), modular.WithSeveralActors(true), modular.WithPluginHost(true), modulartest.Script(`[{"text":"probe"}]`))
		if err != nil {
			return err
		}
		defer probe.Close(ctx)

		// A separate writer can be live on this unused provisional session;
		// no prompt, model work, or trace-bearing admission is needed.
		waitingDecl, err := r.sessionDeclaration(ctx, probe, "")
		if err != nil {
			return err
		}
		report["declarations"] = map[string]any{"agent": a.Declaration(), "session": declaration, "waitingSession": waitingDecl}
		if o.SDK {
			report["commits"] = o.commits
		}
	}
	if o.SDK {
		steps := []stepEvidence{}
		calls := []callEvidence{}
		observedCalls := map[string]api.Call{}
		modelCalls := map[string]string{}
		if o.crash != nil {
			o.crash.CountAfter = fixtures.Count(r.countPath())
			report["crash"] = o.crash
		}
		for _, public := range entries {
			e, err := entryFromHistory(public)
			if err != nil {
				return err
			}
			switch e.Kind {
			case "model.request":
				model := api.Decode[api.Model](e.Data)
				modelID := strings.TrimPrefix(model.ID, model.Provider+"/")
				steps = append(steps, stepEvidence{ID: e.Step, Model: modelID, BeforeCrash: o.crash != nil && o.crash.preCrashSteps[e.Step]})
			case "model":
				for _, part := range e.Content {
					if call := part.Call; call != nil {
						// Scripted replies supply their call IDs. The Harness
						// preserves the original as Reference if it remaps one.
						id := call.Reference
						if id == "" {
							id = call.ID
						}
						modelCalls[call.ID] = id
					}
				}
			case "tool.call", "tool.started":
				call := api.Decode[api.Call](e.Data)
				if call.ID != "" {
					observedCalls[call.ID] = call
				}
			case "tool.result":
				res := api.Decode[api.ToolResult](e.Data)
				call := observedCalls[res.Call]
				status := res.Status
				if status == "unknown" {
					status = "outcomeUnknown"
				}
				calls = append(calls, callEvidence{res.Call, res.Name, e.Step, status, call.ParentCall, modelCalls[res.Call]})
			case "question.open":
				q := api.Decode[struct{ Question api.Question }](e.Data).Question
				report["question"] = map[string]string{"id": q.ID, "kind": q.Kind}
			}
		}
		report["steps"], report["calls"] = steps, calls
	}
	b, err := json.Marshal(report)
	if err != nil {
		return err
	}
	return os.WriteFile(o.ReportPath, b, 0600)
}

func entryFromHistory(e modular.HistoryEntry) (api.Entry, error) {
	wire, err := json.Marshal(e)
	if err != nil {
		return api.Entry{}, err
	}
	return portable.ReadEntry(wire)
}

func (r run) sessionDeclaration(ctx context.Context, a *modular.Agent, id string) (json.RawMessage, error) {
	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()
	if end, ok := ctx.Deadline(); ok {
		_ = client.SetDeadline(end)
	}
	done := make(chan error, 1)
	go func() {
		actor := modular.LocalACPActor()
		actor.ID = "user" // The SDK runner opens its session as the local user.
		done <- a.ServeACP(ctx, modular.ServeACPOptions{Input: server, Output: server, StdioActor: &actor})
		_ = server.Close()
	}()
	defer func() { _ = client.Close(); <-done }()
	enc, dec := json.NewEncoder(client), json.NewDecoder(client)
	// Use the real session projection on the ACP binding, not a copy of
	// the Agent declaration. Resume attaches the settled session without replay.
	method := "session/resume"
	params := map[string]any{"sessionId": id, "cwd": filepath.Join(r.dir, "project"), "mcpServers": []any{}}
	if id == "" {
		method = "session/new"
		delete(params, "sessionId")
	}
	for i, req := range []struct {
		method string
		params any
	}{{"initialize", map[string]any{"protocolVersion": 1}}, {method, params}} {
		if err := enc.Encode(map[string]any{"jsonrpc": "2.0", "id": i + 1, "method": req.method, "params": req.params}); err != nil {
			return nil, err
		}
		for {
			var reply struct {
				ID     int
				Error  json.RawMessage
				Result struct {
					Meta map[string]struct{ Declaration json.RawMessage } `json:"_meta"`
				}
			}
			if err := dec.Decode(&reply); err != nil {
				return nil, err
			}
			if reply.ID != i+1 {
				continue // session updates
			}
			if reply.Error != nil {
				return nil, fmt.Errorf("ACP %s: %s", req.method, reply.Error)
			}
			if i == 1 {
				return reply.Result.Meta[acpinterface.Namespace].Declaration, nil
			}
			break
		}
	}
	return nil, fmt.Errorf("no session declaration")
}
