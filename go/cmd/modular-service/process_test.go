package main_test

import (
	"bufio"
	"context"
	"encoding/json"
	"github.com/daniel-ballance/modular-agent/go/agenthttp"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/fake"
	"github.com/daniel-ballance/modular-agent/go/internal/proctest"
	"github.com/daniel-ballance/modular-agent/go/internal/runtimetest"
	"github.com/daniel-ballance/modular-agent/go/servicehttp"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

type part struct {
	cmd  *exec.Cmd
	url  string
	once sync.Once
	log  *os.File
}

func (p *part) stop(kill bool) {
	p.once.Do(func() {
		if kill {
			_ = p.cmd.Process.Kill()
		} else {
			_ = p.cmd.Process.Signal(syscall.SIGTERM)
		}
		_ = p.cmd.Wait()
		_ = p.log.Close()
	})
}
func start(t *testing.T, bin, root, token, role string, args ...string) *part {
	t.Helper()
	log, err := os.CreateTemp(root, role+"-stderr-")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bin, append([]string{"--role", role, "--token-file", token}, args...)...)
	cmd.Stderr = log
	cmd.Env = append(os.Environ(), "HOME="+root)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	p := &part{cmd: cmd, log: log}
	t.Cleanup(func() { p.stop(false) })
	ready := make(chan string, 1)
	go func() {
		var v struct{ URL string }
		_ = json.NewDecoder(bufio.NewReader(stdout)).Decode(&v)
		ready <- v.URL
		_, _ = io.Copy(io.Discard, stdout)
	}()
	select {
	case p.url = <-ready:
		if p.url == "" {
			b, _ := os.ReadFile(log.Name())
			t.Fatalf("%s did not start: %s", role, b)
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("%s readiness timeout", role)
	}
	return p
}
func host(t *testing.T, p *part, token string) func(agenthttp.Request) (agenthttp.Response, error) {
	t.Helper()
	c := servicehttp.NewClient(p.url, token)
	return func(q agenthttp.Request) (agenthttp.Response, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		var out agenthttp.Response
		err := c.Call(ctx, "/v1/agent", q.Key, q, &out)
		return out, err
	}
}
func need(t *testing.T, call func(agenthttp.Request) (agenthttp.Response, error), q agenthttp.Request) agenthttp.Response {
	t.Helper()
	out, err := call(q)
	if err != nil {
		t.Fatal(err)
	}
	return out
}
func follow(t *testing.T, p *part, token, id string) (*json.Decoder, io.Closer) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	c := servicehttp.NewClient(p.url, token)
	res, err := c.Open(ctx, "/v1/agent/events", "", agenthttp.Request{Session: id})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	return json.NewDecoder(res.Body), res.Body
}
func awaitProgress(t *testing.T, d *json.Decoder, marker string) {
	t.Helper()
	for {
		var f agenthttp.Frame
		if err := d.Decode(&f); err != nil {
			t.Fatal(err)
		}
		if f.Event != nil && f.Event.Kind == "tool.progress" && strings.Contains(string(f.Event.Data), marker) {
			return
		}
	}
}
func stable(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		a, _ := os.ReadFile(path)
		time.Sleep(150 * time.Millisecond)
		b, _ := os.ReadFile(path)
		if len(a) > 0 && string(a) == string(b) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("command still running or never ran", path)
		}
	}
}
func TestSeparateServicesOwnershipSIGKILLAndRecovery(t *testing.T) {
	root := t.TempDir()
	bin := filepath.Join(root, "modular-service")
	if out, err := exec.Command("go", "build", "-race", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatal(string(out), err)
	}
	runtimetest.Each(t, func(t *testing.T) {
		proctest.Subreaper(t)
		dir := t.TempDir()
		project := filepath.Join(dir, "project")
		os.Mkdir(project, 0700)
		os.WriteFile(filepath.Join(project, "fact"), []byte("process-marker"), 0600)
		tokenValue := "offline-service-token-123456"
		token := filepath.Join(dir, "token")
		os.WriteFile(token, []byte(tokenValue), 0600)
		shell := func(id, command string) fake.Script {
			return fake.Script{Response: api.Response{Stop: "tools", Content: api.Content{{Type: "tool_call", Call: &api.Call{ID: id, Name: "bash", Input: api.JSON(map[string]string{"command": command})}}}}}
		}
		script := []fake.Script{shell("initial", "cat fact; printf created > made"), {Require: "process-marker", Response: api.Response{Content: api.Text("process answer"), Stop: "finished"}}, shell("crash", "setsid bash -c 'while :; do echo tick >> escaped; sleep .03; done' >/dev/null 2>&1 & printf crash-ready; while :; do echo tick >> ticking; sleep .03; done"), {Require: "outcome is unknown", Response: api.Response{Content: api.Text("durably resumed"), Stop: "finished"}}}
		scriptPath := filepath.Join(dir, "script")
		os.WriteFile(scriptPath, api.JSON(script), 0600)
		h := start(t, bin, dir, token, "history", "--state", filepath.Join(dir, "history"))
		e := start(t, bin, dir, token, "environment", "--project", project)
		g := start(t, bin, dir, token, "gateway", "--script", scriptPath, "--key-file", filepath.Join(dir, "nonexistent-key"))
		args := []string{"--project", project, "--runtime", runtimetest.Plugin(t).Name, "--model", "fake", "--history-url", h.url, "--environment-url", e.url, "--model-gateway", g.url}
		a := start(t, bin, dir, token, "agent", args...)
		b := start(t, bin, dir, token, "agent", args...)
		ac, bc := host(t, a, tokenValue), host(t, b, tokenValue)
		id := need(t, ac, agenthttp.Request{Op: "new"}).Session
		need(t, bc, agenthttp.Request{Op: "new"}) // distinct session coexists on the same history service
		if _, err := bc(agenthttp.Request{Op: "open", Session: id}); err == nil {
			t.Fatal("second agent acquired live session")
		}
		need(t, ac, agenthttp.Request{Op: "input", Session: id, Key: "original", Content: api.Text("go")})
		out := need(t, ac, agenthttp.Request{Op: "wait", Session: id}).Outcome
		if out.Result.Text() != "process answer" {
			t.Fatal(out)
		}
		made, _ := os.ReadFile(filepath.Join(project, "made"))
		if string(made) != "created" {
			t.Fatal("sandbox effect missing")
		}
		need(t, ac, agenthttp.Request{Op: "stop", Session: id})
		need(t, bc, agenthttp.Request{Op: "open", Session: id})
		if !need(t, bc, agenthttp.Request{Op: "input", Session: id, Key: "original", Content: api.Text("resend")}).Receipt.Duplicate {
			t.Fatal("input key lost across agents")
		}
		need(t, bc, agenthttp.Request{Op: "stop", Session: id})
		need(t, ac, agenthttp.Request{Op: "open", Session: id})
		d, body := follow(t, a, tokenValue, id)
		need(t, ac, agenthttp.Request{Op: "input", Session: id, Key: "crash-input", Content: api.Text("crash now")})
		awaitProgress(t, d, "crash-ready")
		proctest.Await(t, func() bool { x, _ := os.ReadFile(filepath.Join(project, "escaped")); return len(x) > 0 })
		a.stop(true)
		body.Close()
		stable(t, filepath.Join(project, "ticking"))
		stable(t, filepath.Join(project, "escaped"))
		deadline := time.Now().Add(6 * time.Second)
		for {
			_, err := bc(agenthttp.Request{Op: "open", Session: id})
			if err == nil {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("dead writer not released", err)
			}
			time.Sleep(40 * time.Millisecond)
		}
		out = need(t, bc, agenthttp.Request{Op: "wait", Session: id}).Outcome
		if runtimetest.Plugin(t).Name == "durable" {
			if out.Result.Text() != "durably resumed" {
				t.Fatal(out)
			}
		} else if out.Status != "failed" || !out.Interrupted {
			t.Fatal(out)
		}
		if !need(t, bc, agenthttp.Request{Op: "input", Session: id, Key: "crash-input", Content: api.Text("resend after crash")}).Receipt.Duplicate {
			t.Fatal("crash intake repeated")
		}
		// Replay verifies exactly one result for the interrupted unsafe call.
		d, body = follow(t, b, tokenValue, id)
		results := 0
		lastTurn := ""
		for {
			var f agenthttp.Frame
			if err := d.Decode(&f); err != nil {
				t.Fatal(err)
			}
			if f.Entry != nil {
				if f.Entry.Call == "crash" && f.Entry.Kind == "tool.result" {
					results++
					if api.Decode[api.ToolResult](f.Entry.Data).Status != "unknown" {
						t.Fatal("unsafe call repeated")
					}
				}
				if f.Entry.Kind == "turn.end" && results > 0 {
					lastTurn = f.Entry.Turn
					break
				}
			}
		}
		body.Close()
		if results != 1 || lastTurn == "" {
			t.Fatal("missing result")
		}
		// Explicit service death also stops commands, and returns unknown rather than a fabricated failure.
		d, body = follow(t, b, tokenValue, id)
		toolDone := make(chan agenthttp.Response, 1)
		toolErr := make(chan error, 1)
		go func() {
			q := agenthttp.Request{Op: "tool", Session: id, Call: api.Call{ID: "service-death", Name: "bash", Input: api.JSON(map[string]string{"command": "echo service-ready; while :; do echo tick >> service-ticks; sleep .03; done"})}}
			o, err := bc(q)
			if err != nil {
				toolErr <- err
			} else {
				toolDone <- o
			}
		}()
		awaitProgress(t, d, "service-ready")
		e.stop(true)
		select {
		case result := <-toolDone:
			if result.ToolResult.Status != "unknown" {
				t.Fatal(result)
			}
		case err := <-toolErr:
			t.Fatal(err)
		case <-time.After(6 * time.Second):
			t.Fatal("lost service did not settle")
		}
		body.Close()
		stable(t, filepath.Join(project, "service-ticks"))
		b.stop(false)
		g.stop(false)
		h.stop(false)
		// Reap orphaned Bubblewrap monitor/worker children after abrupt service death.
		for {
			var status syscall.WaitStatus
			pid, err := syscall.Wait4(-1, &status, syscall.WNOHANG, nil)
			if pid <= 0 || err != nil {
				break
			}
		}
	})
}
