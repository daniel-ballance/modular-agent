package modular_test

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestJobOwnerResumesBeforeReopenReturns(t *testing.T) {
	for _, name := range []string{"inProcess", "service"} {
		t.Run(name, func(t *testing.T) { testJobResume(t, name == "service") })
	}
}

func testJobResume(t *testing.T, remote bool) {
	ctx := t.Context()
	started, resumed := make(chan string, 1), make(chan string, 1)
	tool := modular.NewTool("background", "Start work outside a turn.", func(ctx context.Context, _ struct{}, c *modular.ToolContext) (string, error) {
		j, err := c.Jobs.Start(ctx, "background", nil, "stable-key")
		if err != nil {
			return "", err
		}
		started <- j.ID
		return "started", nil
	})
	p := modular.Plugin{Name: "worker", Setup: func(r *modular.Registrar) error {
		return errors.Join(r.Tool(tool), r.Jobs(modular.JobOwner{
			Cancel: func(ctx context.Context, j *modular.Job) error {
				return j.End(ctx, modular.Outcome{Kind: "cancelled"}, nil, false)
			},
			Resume: func(ctx context.Context, j *modular.Job) error {
				resumed <- j.ID
				return j.End(ctx, modular.Outcome{Kind: "completed"}, modular.Text("finished"), false)
			},
		}))
	}}
	var placement modular.Option = modular.WithPlugin(p)
	dataDir, project := t.TempDir(), t.TempDir()
	var url, file string
	if remote {
		file = filepath.Join(t.TempDir(), "token")
		if err := os.WriteFile(file, []byte("offline-job-resume-128-bits"), 0600); err != nil {
			t.Fatal(err)
		}
		svc, err := modular.ServeService(ctx, p, modular.ServeOptions{Listen: "127.0.0.1:0", TokenFile: file})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = svc.Close() })
		url = svc.URL
		placement = modular.WithServicePlugin(modular.ServicePlugin{URL: url, TokenFile: file})
	}
	opts := []modular.Option{modular.WithDurability(modular.Kept), modular.WithDataDir(dataDir), modular.WithProject(project), placement, modulartest.Script(`[{"text":"ready"}]`)}
	var id string
	var a *modular.Agent
	if remote {
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestRemoteJobCrashHost$")
		cmd.Env = append(os.Environ(), "MA_TEST_JOB_CRASH=1", "MA_TEST_JOB_URL="+url, "MA_TEST_JOB_TOKEN="+file, "MA_TEST_JOB_PROJECT="+project, "MA_TEST_JOB_DATA="+dataDir)
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			t.Fatal(err)
		}
		cmd.Stderr = os.Stderr
		if err = cmd.Start(); err != nil {
			t.Fatal(err)
		}
		lines := bufio.NewScanner(stdout)
		if lines.Scan() {
			id = strings.TrimPrefix(lines.Text(), "session:")
		}
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		if id == "" || len(started) != 1 {
			t.Fatalf("child did not commit a job: %q", id)
		}
		a = modulartest.Agent(t, opts...)
	} else {
		a = modulartest.Agent(t, opts...)
		s, err := a.Session(ctx)
		if err != nil {
			t.Fatal(err)
		}
		id = s.ID()
		if _, err := s.Prompt(ctx, "initialize the session"); err != nil {
			t.Fatal(err)
		}
		if err := s.WaitIdle(ctx); err != nil {
			t.Fatal(err)
		}
		if got, err := s.CallTool(ctx, "background", struct{}{}); err != nil || got.Text() != "started" {
			t.Fatalf("call: %+v %v", got, err)
		}
		a = modulartest.Restart(t, a)
	}
	job := <-started
	s, err := a.OpenSession(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case j := <-resumed:
		if j != job {
			t.Fatalf("resumed %q, expected %q", j, job)
		}
	default:
		t.Fatal("resume not dispatched before reopen returned")
	}
	entries, err := s.History(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e["kind"] == "jobEnded" {
			return
		}
	}
	t.Fatal("resumed job did not commit its end")
}

func TestRemoteJobCrashHost(t *testing.T) {
	if os.Getenv("MA_TEST_JOB_CRASH") != "1" {
		t.Skip("subprocess helper")
	}
	ctx := t.Context()
	a, err := modular.New(ctx, modular.WithDurability(modular.Kept), modular.WithDataDir(os.Getenv("MA_TEST_JOB_DATA")), modular.WithProject(os.Getenv("MA_TEST_JOB_PROJECT")), modulartest.Script(`[{"text":"ready"}]`), modular.WithServicePlugin(modular.ServicePlugin{URL: os.Getenv("MA_TEST_JOB_URL"), TokenFile: os.Getenv("MA_TEST_JOB_TOKEN")}))
	if err != nil {
		t.Fatal(err)
	}
	s, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Prompt(ctx, "initialize the session"); err != nil {
		t.Fatal(err)
	}
	if err := s.WaitIdle(ctx); err != nil {
		t.Fatal(err)
	}
	if got, err := s.CallTool(ctx, "background", struct{}{}); err != nil || got.Text() != "started" {
		t.Fatalf("start: %+v %v", got, err)
	}
	fmt.Println("session:" + s.ID())
	// Keep the writer and job alive until the parent kills this process.
	<-ctx.Done()
}
