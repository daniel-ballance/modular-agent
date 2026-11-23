package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

// The test process is a real writer. Its signal comes from inside the tool,
// after an external effect but before the tool can return a result.
func TestResumeOpenToolWriter(t *testing.T) {
	project := os.Getenv("MA_TEST_TOOL_WRITER")
	if project == "" {
		t.Skip("child process only")
	}
	d, err := directories()
	if err != nil {
		t.Fatal(err)
	}
	store, err := d.history()
	if err != nil {
		t.Fatal(err)
	}
	tool := modular.NewTool("mark", "Append one mark.", func(ctx context.Context, _ struct{}, tc *modular.ToolContext) (string, error) {
		f, err := os.OpenFile(filepath.Join(project, "marks"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
		if err != nil {
			return "", err
		}
		if _, err = f.WriteString("mark\n"); err != nil {
			f.Close()
			return "", err
		}
		if err = f.Close(); err != nil {
			return "", err
		}
		fmt.Println("marked")
		<-ctx.Done()
		return "", ctx.Err()
	})
	a, err := modular.New(t.Context(), modular.WithProject(project), modular.WithHistory(store), modular.WithDataDir(d.state), modular.WithDurability(modular.Durable), modular.WithSeveralActors(true), modular.WithTool(tool), modulartest.Script(`[{"toolCalls":[{"name":"mark","input":{}}]}]`))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close(context.Background())
	s, err := a.Session(t.Context(), modular.SessionOptions{Actors: []modular.Actor{modular.LocalACPActor()}})
	if err != nil {
		t.Fatal(err)
	}
	fmt.Println(s.ID())
	if _, err = s.Prompt(t.Context(), "private input"); err != nil {
		t.Fatal(err)
	}
	t.Fatal("tool returned before the crash")
}

func TestResumeOpenAtStartup(t *testing.T) {
	for _, tc := range []struct {
		name, setting, projectSetting, outcome, report string
		flag, held, transient, stdio                   bool
	}{
		{name: "durable flag", flag: true, outcome: "completed", report: "resumed"},
		{name: "global setting", setting: "true", projectSetting: "false", outcome: "completed", report: "resumed"},
		{name: "transient", flag: true, transient: true, outcome: "failed", report: "resumed"},
		{name: "held", flag: true, held: true, report: "skipped"},
		{name: "ACP attachment shares startup writer", flag: true, stdio: true, outcome: "completed", report: "resumed"},
		{name: "off"},
		{name: "project setting ignored", projectSetting: "true"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			d, project, log := isolated(t)
			t.Setenv("MODULAR_AGENT_ACTOR", "")
			// --token-file uses the local operator, not an environment actor.
			token := filepath.Join(d.config, "token")
			put(t, token, "startup-test-token-000000")
			if tc.setting != "" {
				put(t, filepath.Join(d.config, "settings.json"), `{"resume_open":`+tc.setting+`}`)
			}
			if tc.projectSetting != "" {
				put(t, filepath.Join(project, ".modular-agent.json"), `{"resume_open":`+tc.projectSetting+`}`)
			}
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestResumeOpenToolWriter$")
			cmd.Env = append(os.Environ(), "MA_TEST_TOOL_WRITER="+project)
			stdout, err := cmd.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			cmd.Stderr = os.Stderr
			if err = cmd.Start(); err != nil {
				t.Fatal(err)
			}
			kill := func() {
				if cmd.ProcessState == nil {
					_ = cmd.Process.Kill()
					_ = cmd.Wait()
				}
			}
			defer kill()
			scan := bufio.NewScanner(stdout)
			if !scan.Scan() {
				t.Fatal("writer did not publish a session ID")
			}
			id := scan.Text()
			if !scan.Scan() || scan.Text() != "marked" {
				t.Fatalf("writer did not reach its effect: %s", scan.Text())
			}
			if !tc.held {
				kill()
			}
			args := []string{"--agui", "--listen", "127.0.0.1:0", "--token-file", token, "--project", project}
			if tc.stdio {
				args = []string{"--acp", "--project", project}
				t.Setenv("MODULAR_AGENT_ACTOR", modular.LocalACPActor().ID)
			}
			if tc.flag {
				args = append(args, "--resume-open")
			}
			if tc.transient {
				args = append(args, "--runtime", "transient")
			}
			var stderr bytes.Buffer
			out, w := net.Pipe()
			defer out.Close()
			deadline, _ := ctx.Deadline()
			_ = out.SetDeadline(deadline)
			serving, stop := context.WithCancel(ctx)
			done := make(chan error, 1)
			go func() {
				err := run(serving, args, w, w, &stderr, nil)
				_ = w.Close()
				done <- err
			}()
			shutdown := sync.OnceFunc(func() {
				stop()
				out.Close()
				if err := <-done; err != nil {
					t.Error(err)
				}
			})
			defer shutdown()
			if !tc.stdio {
				if _, err = bufio.NewReader(out).ReadString('\n'); err != nil {
					t.Fatalf("start: %v", err)
				}
			}

			store, err := d.history()
			if err != nil {
				t.Fatal(err)
			}
			// Read the public store metadata. No client connects to ma.
			for {
				row, err := store.SessionInfo(ctx, id)
				if err != nil {
					t.Fatal(err)
				}
				if tc.outcome == "" {
					if !row.UnfinishedTurn {
						t.Fatal("startup changed an interrupted turn")
					}
					break
				}
				if !row.UnfinishedTurn {
					break
				}
				select {
				case <-ctx.Done():
					t.Fatal("recovery did not finish")
				case <-time.After(time.Millisecond * 10):
				}
			}
			if tc.stdio {
				// Only now connect. The factory must use the writer that
				// finished the turn, not compose a second agent for its ID.
				dec := json.NewDecoder(out)
				for i, method := range []string{"initialize", "session/resume"} {
					params := map[string]any{"protocolVersion": 1}
					if i != 0 {
						params = map[string]any{"cwd": project, "sessionId": id, "mcpServers": []any{}}
					}
					if err := json.NewEncoder(out).Encode(map[string]any{"jsonrpc": "2.0", "id": i + 1, "method": method, "params": params}); err != nil {
						t.Fatal(err)
					}
					for {
						var reply struct {
							ID            int
							Result, Error json.RawMessage
						}
						if err := dec.Decode(&reply); err != nil {
							t.Fatal(err)
						}
						if reply.ID != i+1 {
							continue
						}
						if reply.Error != nil || reply.Result == nil {
							t.Fatalf("%s: %s", method, reply.Error)
						}
						break
					}
				}
			}
			shutdown()
			expect := ""
			if tc.report != "" {
				expect = tc.report + " " + id + "\n"
			}
			if got := stderr.String(); got != expect {
				t.Fatalf("status lines: %q, want %q", got, expect)
			}
			raw, err := os.ReadFile(log)
			if tc.outcome == "completed" {
				lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
				if err != nil || len(lines) != 1 || !strings.Contains(lines[0], `"role":"toolResult"`) {
					t.Fatalf("wanted one recovery inference following the tool: %s (%v)", raw, err)
				}
			} else if !os.IsNotExist(err) {
				t.Fatalf("unexpected inference: %s (%v)", raw, err)
			}
			if b, err := os.ReadFile(filepath.Join(project, "marks")); err != nil || string(b) != "mark\n" {
				t.Fatalf("tool effect: %q (%v)", b, err)
			}
			if tc.outcome == "" {
				return
			}

			// Stop the service and verify its *already committed* outcome,
			// including that no second turn or tool attempt was recorded.
			a := modulartest.Agent(t, modular.WithProject(project), modular.WithDataDir(d.state), modular.WithDurability(modular.Durable), modular.WithHistory(store), modulartest.Script(`[]`))
			s, err := a.OpenSession(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			r, err := s.LastTurn(ctx)
			if err != nil || r == nil || r.Outcome == nil || r.Outcome.Kind != tc.outcome {
				t.Fatalf("last turn: %+v (%v)", r, err)
			}
			h, err := s.History(ctx)
			if err != nil {
				t.Fatal(err)
			}
			count := map[any]int{}
			for _, e := range h {
				count[e["kind"]]++
			}
			for _, kind := range []string{"turnStart", "toolStarted", "toolResult", "turnEnd"} {
				if count[kind] != 1 {
					t.Fatalf("expected one %s: %v", kind, count)
				}
			}
		})
	}
}
