package modular_test

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

type bumpInput struct {
	N int `json:"n"`
}

const bumpScript = `[{"toolCalls":[{"name":"bump","input":{"n":1}}]},{"text":"finished"}]`

func bumpOptions(t *testing.T, dir string, mode modular.Durability, served bool, source, description string, afterEffect func()) []modular.Option {
	t.Helper()
	tool := modular.NewTool("bump", description, func(ctx context.Context, in bumpInput, _ *modular.ToolContext) (string, error) {
		f, err := os.OpenFile(filepath.Join(dir, "effects"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
		if err != nil {
			return "", err
		}
		_, err = fmt.Fprintln(f, in.N)
		if e := f.Close(); err == nil {
			err = e
		}
		if afterEffect != nil {
			afterEffect()
		}
		return "bumped", err
	})
	opts := []modular.Option{modular.WithProject(dir), modular.WithDataDir(filepath.Join(dir, "store")), modular.WithEnvironment(modulartest.MemoryEnvironment()), modular.WithDurability(mode), modular.WithLateAnswersStartTurns(true), modular.WithMaxApprovalWaitMs(120000), modular.WithApproval(modular.All), modular.WithSeveralActors(true), modulartest.Script(bumpScript), modular.WithPlugin(modular.Plugin{Name: source, Setup: func(r *modular.Registrar) error { return r.Tool(tool) }})}
	if served {
		opts = append(opts, interfaceServedRuntime(t, mode == modular.Durable))
	}
	return opts
}
func effectCount(t *testing.T, dir string) int {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "effects"))
	if errors.Is(err, os.ErrNotExist) {
		return 0
	}
	if err != nil {
		t.Fatal(err)
	}
	return len(strings.Fields(string(b)))
}
func approvalAgent(t *testing.T, opts []modular.Option) *modular.Agent {
	t.Helper()
	a, err := modular.New(t.Context(), opts...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := a.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	return a
}
func parkBump(t *testing.T, a *modular.Agent, actors ...modular.Actor) (*modular.Session, string) {
	t.Helper()
	ctx := t.Context()
	if a.Declaration()["approvalsOutlastTurns"] != true {
		t.Fatal("no waiting declaration")
	}
	s, err := a.Session(ctx, modular.SessionOptions{Settings: modular.Settings{"approvalWait": "untilDeadline"}, Actors: actors})
	if err != nil {
		t.Fatal(err)
	}
	r, err := s.Prompt(ctx, "Bump.")
	if err != nil || r.Outcome == nil || r.Outcome.Kind != "completed" || len(r.OpenToolCalls) != 1 || len(r.ToolResults()) != 0 {
		t.Fatalf("origin: %+v %v", r, err)
	}
	if err = s.WaitIdle(ctx); err != nil {
		t.Fatal(err)
	}
	return s, r.OpenToolCalls[0]
}
func pollOne(t *testing.T, s *modular.Session) modular.Question {
	t.Helper()
	qs, err := s.Questions(t.Context(), modular.QuestionsOptions{Present: true})
	if err != nil || len(qs) != 1 || qs[0].Call == nil || qs[0].Deadline == nil {
		t.Fatalf("poll: %+v %v", qs, err)
	}
	return qs[0]
}
func records(t *testing.T, s *modular.Session) map[string][]modular.HistoryEntry {
	t.Helper()
	rows, err := s.History(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	out := map[string][]modular.HistoryEntry{}
	for _, e := range rows {
		k, _ := e["kind"].(string)
		out[k] = append(out[k], e)
	}
	return out
}
func fields(v any) map[string]any {
	b, _ := json.Marshal(v)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return m
}
func checkWaitingSettlement(t *testing.T, s *modular.Session, call, status string, starts int) {
	t.Helper()
	if err := s.WaitIdle(t.Context()); err != nil {
		t.Fatal(err)
	}
	r := records(t, s)
	for k, n := range map[string]int{"inputAccepted": 1, "input": 1, "turnEnd": 2, "turnStart": 2, "inputRequest": 1, "toolPending": 1, "inputAnswer": 1, "toolStarted": starts, "toolResult": 1} {
		if len(r[k]) != n {
			t.Fatalf("%s: %d, want %d; results %v, ends %v", k, len(r[k]), n, r["toolResult"], r["turnEnd"])
		}
	}
	q, a, res := r["inputRequest"][0], r["inputAnswer"][0], r["toolResult"][0]
	if fields(res["data"])["status"] != status || fields(a["data"])["approvalView"] != nil || res["toolCallId"] != call || res["stepId"] != q["stepId"] {
		t.Fatalf("wrong settlement or public answer: %v %v", res, a)
	}
	if r["turnStart"][1]["continuesTurnId"] != q["turnId"] || fields(fields(r["turnStart"][1]["data"])["startedBy"])["id"] != q["requestId"] {
		t.Fatalf("continuation: %v", r["turnStart"][1])
	}
	if starts > 0 {
		st := r["toolStarted"][0]
		var sources []string
		b, _ := json.Marshal(st["sources"])
		_ = json.Unmarshal(b, &sources)
		if st["turnId"] == q["turnId"] || st["stepId"] != q["stepId"] || !slices.Contains(sources, q["id"].(string)) || !slices.Contains(sources, a["id"].(string)) {
			t.Fatalf("start lost approval lineage: %v", st)
		}
	}
}
func TestWaitingApprovalOptIn(t *testing.T) {
	for _, tc := range []struct {
		name           string
		ms             int64
		mode           modular.Durability
		late, approval bool
	}{
		{"zero", 0, modular.Kept, true, true}, {"negative", -1, modular.Kept, true, true}, {"unsafe integer", 9007199254740992, modular.Kept, true, true}, {"ephemeral", 100, modular.Ephemeral, true, true}, {"no late answers", 100, modular.Kept, false, true}, {"no gate", 100, modular.Kept, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			opts := []modular.Option{modular.WithProject(t.TempDir()), modular.WithDataDir(t.TempDir()), modular.WithDurability(tc.mode), modular.WithLateAnswersStartTurns(tc.late), modular.WithMaxApprovalWaitMs(tc.ms)}
			if tc.approval {
				opts = append(opts, modular.WithApproval(modular.All))
			}
			a, err := modular.New(t.Context(), opts...)
			if a != nil {
				defer a.Close(t.Context())
			}
			var got *modular.Error
			if !errors.As(err, &got) || got.Code != modular.InvalidComposition {
				t.Fatal(err)
			}
		})
	}
	for _, policy := range []modular.Approval{modular.Off, modular.Never, modular.Ask, modular.All} {
		t.Run(string(policy), func(t *testing.T) {
			tool := modular.NewTool("bump", "Inspect.", func(context.Context, bumpInput, *modular.ToolContext) (string, error) { return "no write", nil }, modular.ReadOnly())
			a := modulartest.Agent(t, modular.WithDurability(modular.Kept), modular.WithDataDir(t.TempDir()), modular.WithLateAnswersStartTurns(true), modular.WithMaxApprovalWaitMs(5000), modular.WithApproval(policy), modular.WithTool(tool), modulartest.Script(bumpScript))
			s, err := a.Session(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			settings, err := s.Settings(t.Context())
			if err != nil || settings["approvalWait"] != "live" {
				t.Fatal(settings, err)
			}
			if policy != modular.All {
				if err = s.SetSetting(t.Context(), "approvalWait", "untilDeadline"); err != nil {
					t.Fatal(err)
				}
			}
			r, err := s.Prompt(t.Context(), "Inspect.")
			if err != nil || len(r.OpenToolCalls) != 0 || len(r.ToolResults()) != 1 {
				t.Fatal(r, err)
			}
			status := modular.Completed
			if policy == modular.All || policy == modular.Never {
				status = modular.Refused
			}
			if r.ToolResults()[0].Status != status {
				t.Fatal(r.ToolResults())
			}
			if hist := records(t, s); len(hist["toolPending"]) != 0 || policy != modular.All && len(hist["inputRequest"]) != 0 {
				t.Fatal("policy opened a wait")
			}
		})
	}
	a := modulartest.Agent(t, modular.WithLateAnswersStartTurns(true), modular.WithApproval(modular.All))
	if _, ok := a.Declaration()["approvalsOutlastTurns"]; ok {
		t.Fatal("unsupported declaration")
	}
	_, err := a.Session(t.Context(), modular.SessionOptions{Settings: modular.Settings{"approvalWait": "untilDeadline"}})
	var bad *modular.Error
	if !errors.As(err, &bad) || bad.Code != modular.NotSupported {
		t.Fatal(err)
	}
}

func TestWaitingApprovalDecisionAndHandoff(t *testing.T) {
	for _, served := range []bool{false, true} {
		for _, scenario := range []string{"allow", "decline", "expire-open", "expire-allowed", "changed-input", "revoke-worker", "revoke-approver", "disable", "never-after-allow", "gate-after-allow"} {
			t.Run(fmt.Sprintf("%s/served=%t", scenario, served), func(t *testing.T) {
				dir := t.TempDir()
				ctx := t.Context()
				clock := modulartest.UseClock(t, time.Now().UTC().Truncate(time.Millisecond))
				entered, release := make(chan struct{}), make(chan struct{})
				var once sync.Once
				done := func() { once.Do(func() { close(release) }) }
				defer done()
				var passes atomic.Int32
				var blockView atomic.Bool
				gate := modular.Plugin{Name: "handoff-barrier", Setup: func(r *modular.Registrar) error {
					if err := r.OnToolBefore(func(ctx context.Context, b modular.ToolBefore) (modular.Gate, error) {
						if passes.Add(1) == 2 {
							close(entered)
							select {
							case <-release:
							case <-ctx.Done():
								return modular.Gate{}, ctx.Err()
							}
							if scenario == "changed-input" {
								return modular.Gate{Input: json.RawMessage(`{"n":2}`)}, nil
							}
						}
						return modular.Gate{}, nil
					}); err != nil {
						return err
					}
					return r.OnOutput(func(_ context.Context, b modular.OutputBatch) (modular.OutputDecision, error) {
						return modular.OutputDecision{Block: blockView.Load() && b.Recipient == "reviewer"}, nil
					})
				}}
				opts := bumpOptions(t, dir, modular.Kept, served, "counter", "Bump.", nil)
				if scenario == "expire-open" {
					opts = append(opts, modular.WithMaxApprovalWaitMs(1250))
				}
				a := approvalAgent(t, append(opts, modular.WithPlugin(gate)))
				reviewer := modular.Actor{ID: "reviewer", Kind: "user", Rights: []string{"watch", "approve"}}
				s, call := parkBump(t, a, reviewer)
				v, err := s.As("reviewer")
				if err != nil {
					t.Fatal(err)
				}
				if effectCount(t, dir) != 0 {
					t.Fatal("effect before decision")
				}
				q := pollOne(t, v)
				wait := time.Minute
				if scenario == "expire-open" {
					wait = 1250 * time.Millisecond
				}
				if !q.Deadline.Equal(clock.Now().Add(wait)) {
					t.Fatalf("deadline %v, want %v", q.Deadline, clock.Now().Add(wait))
				}
				status, starts := "refused", 0
				switch scenario {
				case "decline":
					err = v.Answer(ctx, q.ID, modular.Decline("no"))
				case "expire-open":
					clock.Advance(wait)
					status = "notStarted"
					if v.Answer(ctx, q.ID, modular.Allow()) == nil {
						t.Fatal("expired approval accepted")
					}
				case "disable":
					err = s.SetSetting(ctx, "approvalWait", "live")
				default:
					if scenario == "expire-allowed" {
						clock.Advance(wait - time.Millisecond)
					}
					if err = v.Answer(ctx, q.ID, modular.Allow()); err != nil {
						t.Fatal(err)
					}
					select {
					case <-entered:
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					}
					switch scenario {
					case "allow":
						status, starts = "completed", 1
					case "revoke-worker":
						err = s.Join(ctx, modular.Actor{ID: "user", Kind: "user", Rights: []string{"watch", "input", "approve"}})
					case "revoke-approver":
						err = s.Join(ctx, modular.Actor{ID: "reviewer", Kind: "user", Rights: []string{"watch"}})
					case "never-after-allow":
						err = s.SetSetting(ctx, "approval", "never")
					case "gate-after-allow":
						blockView.Store(true)
					case "expire-allowed":
						clock.Advance(time.Millisecond)
						status = "notStarted"
					}
				}
				done()
				if err != nil {
					t.Fatal(err)
				}
				checkWaitingSettlement(t, s, call, status, starts)
				if n := effectCount(t, dir); n != starts {
					t.Fatalf("%d counter effects, want %d", n, starts)
				}
				if scenario == "expire-open" && fields(records(t, s)["inputAnswer"][0]["data"])["reason"] != "timeLimit" {
					t.Fatal("missing timeLimit")
				}
				if scenario == "expire-allowed" && fields(records(t, s)["inputAnswer"][0]["data"])["value"] != "allow" {
					t.Fatal("expiry overwrote committed allow")
				}
			})
		}
	}
}

func TestWaitingApprovalNavigationAndErasure(t *testing.T) {
	for _, served := range []bool{false, true} {
		t.Run(fmt.Sprint(served), func(t *testing.T) {
			dir := t.TempDir()
			ctx := t.Context()
			a := approvalAgent(t, bumpOptions(t, dir, modular.Kept, served, "counter", "Bump.", nil))
			s, _ := parkBump(t, a)
			q := pollOne(t, s)
			if _, err := s.Fork(ctx); err == nil {
				t.Fatal("fork accepted open approval")
			}
			if err := s.MoveTo(ctx, records(t, s)["inputAccepted"][0]["id"].(string)); err == nil {
				t.Fatal("moved with open approval")
			}
			r, err := s.Erase(ctx, []string{q.ID})
			if err != nil || len(r.Erased) == 0 {
				t.Fatal(r, err)
			}
			if err := s.Answer(ctx, q.ID, modular.Allow()); err == nil || effectCount(t, dir) != 0 {
				t.Fatal("erased request authorized an effect")
			}
		})
	}
}

// The child publishes a barrier only after the corresponding observable fact.
// The parent kills the agent, waits for process exit, and takes a new writer.
func TestWaitingApprovalAgentProcess(t *testing.T) {
	dir := os.Getenv("MA_WAIT_CHILD_DIR")
	if dir == "" {
		t.Skip("child process only")
	}
	phase := os.Getenv("MA_WAIT_CHILD_PHASE")
	mode := modular.Durability(os.Getenv("MA_WAIT_CHILD_MODE"))
	var session, call string
	hold := func() { fmt.Printf("CHECKPOINT %s %s\n", session, call); select {} }
	opts := bumpOptions(t, dir, mode, false, "counter", "Bump.", func() {
		if phase == "effect" {
			hold()
		}
	})
	if phase == "allowed" {
		opts = append(opts, modular.WithPlugin(modular.Plugin{Name: "barrier", Setup: func(r *modular.Registrar) error {
			var n atomic.Int32
			return r.OnTurnBefore(func(context.Context, modular.TurnBefore) (modular.TurnContribution, error) {
				if n.Add(1) == 2 {
					hold()
				}
				return modular.TurnContribution{}, nil
			})
		}}))
	}
	a := approvalAgent(t, opts)
	s, c := parkBump(t, a)
	session, call = s.ID(), c
	q := pollOne(t, s)
	if phase == "allowed" || phase == "effect" {
		if err := s.Answer(t.Context(), q.ID, modular.Allow()); err != nil {
			t.Fatal(err)
		}
		select {}
	}
	hold()
}
func TestWaitingApprovalProcessLoss(t *testing.T) {
	for _, served := range []bool{false, true} {
		testApprovalProcessLoss(t, served)
	}
}
func testApprovalProcessLoss(t *testing.T, served bool) {
	for _, mode := range []modular.Durability{modular.Kept, modular.Durable} {
		for _, phase := range []string{"open", "allowed", "effect", "source", "definition", "unsupported", "shorter"} {
			t.Run(fmt.Sprintf("%s/%s/served=%t", mode, phase, served), func(t *testing.T) {
				dir := t.TempDir()
				exe, err := os.Executable()
				if err != nil {
					t.Fatal(err)
				}
				cmd := exec.CommandContext(t.Context(), exe, "-test.run=^TestWaitingApprovalAgentProcess$")
				cmd.Env = append(os.Environ(), "MA_WAIT_CHILD_DIR="+dir, "MA_WAIT_CHILD_PHASE="+phase, "MA_WAIT_CHILD_MODE="+string(mode))
				pipe, err := cmd.StdoutPipe()
				if err != nil {
					t.Fatal(err)
				}
				cmd.Stderr = cmd.Stdout
				if err = cmd.Start(); err != nil {
					t.Fatal(err)
				}
				defer func() {
					if cmd.ProcessState == nil {
						_ = cmd.Process.Kill()
						_ = cmd.Wait()
					}
				}()
				var id, call string
				scan := bufio.NewScanner(pipe)
				for scan.Scan() {
					if _, err = fmt.Sscanf(scan.Text(), "CHECKPOINT %s %s", &id, &call); err == nil {
						break
					}
					t.Log(scan.Text())
				}
				if id == "" {
					t.Fatal("no committed checkpoint", scan.Err())
				}
				if err = cmd.Process.Kill(); err != nil {
					t.Fatal(err)
				}
				if cmd.Wait() == nil {
					t.Fatal("agent was not killed")
				}
				source, description := "counter", "Bump."
				if phase == "source" {
					source = "other-counter"
				} else if phase == "definition" {
					description = "Changed description."
				}
				opts := bumpOptions(t, dir, mode, served, source, description, nil)
				if phase == "unsupported" {
					opts = []modular.Option{modular.WithProject(dir), modular.WithDataDir(filepath.Join(dir, "store")), modular.WithEnvironment(modulartest.MemoryEnvironment()), modular.WithDurability(mode), modulartest.Script(`[{"text":"done"}]`)}
				}
				if phase == "shorter" {
					opts = append(opts, modular.WithMaxApprovalWaitMs(10))
				}
				a := approvalAgent(t, opts)
				s, err := a.OpenSession(t.Context(), id)
				if err != nil {
					t.Fatal(err)
				}
				if phase == "open" || phase == "definition" || phase == "source" {
					qs, err := s.Questions(t.Context())
					if err != nil || len(qs) != 1 || qs[0].Call.ID != call {
						t.Fatal(qs, err)
					}
					if s.Answer(t.Context(), qs[0].ID, modular.Allow()) == nil {
						t.Fatal("restored delivery across process loss")
					}
					q := pollOne(t, s)
					if err = s.Answer(t.Context(), q.ID, modular.Allow()); err != nil {
						t.Fatal(err)
					}
				}
				if err = s.WaitIdle(t.Context()); err != nil {
					t.Fatal(err)
				}
				status := "completed"
				want := 1
				switch phase {
				case "source", "definition", "shorter":
					status, want = "refused", 0
				case "unsupported":
					status, want = "notStarted", 0
				case "effect":
					status = "outcomeUnknown"
				}
				r := records(t, s)
				results := r["toolResult"]
				if len(results) != 1 || fields(results[0]["data"])["status"] != status || effectCount(t, dir) != want || len(r["inputRequest"]) != 1 {
					t.Fatalf("reopen: %d effects, results %v, questions %d, ends %v", effectCount(t, dir), results, len(r["inputRequest"]), r["turnEnd"])
				}
			})
		}
	}
}
