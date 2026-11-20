package environmenthttp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/local"
	"io"
	"os"
	"os/exec"
	"sync"
)

type workRequest struct{ ID, Op, Project, Command string }
type workFrame struct {
	ID    string
	Frame frame
}

// The worker lives inside Bubblewrap for the entire agent connection. Keeping
// its supervised shells there preserves bare-shell backgrounding after return.
func init() {
	if len(os.Args) == 2 && os.Args[1] == "--modular-sandbox-worker" {
		sandboxWorker()
		os.Exit(0)
	}
}
func sandboxWorker() {
	e := local.NewAt("/tmp/commands")
	defer e.Close()
	var writeMu, mu sync.Mutex
	running := map[string]context.CancelFunc{}
	send := func(id string, f frame) {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = json.NewEncoder(os.Stdout).Encode(workFrame{id, f})
	}
	var wg sync.WaitGroup
	d := json.NewDecoder(bufio.NewReader(os.Stdin))
	for {
		var q workRequest
		if d.Decode(&q) != nil {
			break
		}
		mu.Lock()
		if q.Op == "cancel" {
			if cancel := running[q.ID]; cancel != nil {
				cancel()
			}
			mu.Unlock()
			continue
		}
		ctx, cancel := context.WithCancel(context.Background())
		running[q.ID] = cancel
		mu.Unlock()
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer cancel()
			text, err := e.Bash(ctx, q.Project, q.Command, func(text string) { send(q.ID, frame{Kind: "output", Text: text}) })
			f := frame{Kind: "done", Text: text}
			if err != nil {
				f.Error = err.Error()
			}
			send(q.ID, f)
			mu.Lock()
			delete(running, q.ID)
			mu.Unlock()
		}()
	}
	mu.Lock()
	for _, cancel := range running {
		cancel()
	}
	mu.Unlock()
	_ = e.Close()
	wg.Wait()
}

type worker struct {
	cmd         *exec.Cmd
	in          io.WriteCloser
	writeMu, mu sync.Mutex
	pending     map[string]chan frame
	done        chan struct{}
	once        sync.Once
}

func (s *Server) startWorker() (*worker, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	args := []string{"--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--bind", s.path, s.path, "--ro-bind", exe, "/modular-worker", "--chdir", s.path, "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", s.path, "--", "/modular-worker", "--modular-sandbox-worker"}
	cmd := exec.Command(s.bwrap, args...)
	cmd.Env = []string{}
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		in.Close()
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		in.Close()
		out.Close()
		return nil, err
	}
	w := &worker{cmd: cmd, in: in, pending: map[string]chan frame{}, done: make(chan struct{})}
	go func() {
		d := json.NewDecoder(out)
		for {
			var f workFrame
			if d.Decode(&f) != nil {
				break
			}
			w.mu.Lock()
			ch := w.pending[f.ID]
			w.mu.Unlock()
			if ch != nil {
				select {
				case ch <- f.Frame:
				case <-w.done:
				}
			}
		}
		_ = cmd.Wait()
		close(w.done)
	}()
	// Verify sandbox creation, rather than silently advertising unavailable commands.
	if _, err = w.Bash(context.Background(), s.path, "true", nil); err != nil {
		w.Close()
		return nil, err
	}
	return w, nil
}
func (w *worker) send(q workRequest) error {
	w.writeMu.Lock()
	defer w.writeMu.Unlock()
	return json.NewEncoder(w.in).Encode(q)
}
func (w *worker) Bash(ctx context.Context, project, command string, emit func(string)) (string, error) {
	id := api.ID()
	ch := make(chan frame, 32)
	w.mu.Lock()
	w.pending[id] = ch
	w.mu.Unlock()
	defer func() { w.mu.Lock(); delete(w.pending, id); w.mu.Unlock() }()
	if err := w.send(workRequest{id, "run", project, command}); err != nil {
		return "", err
	}
	cancelled := ctx.Done()
	for {
		select {
		case f := <-ch:
			if f.Kind == "output" {
				if emit != nil {
					emit(f.Text)
				}
			} else {
				if f.Error != "" {
					return f.Text, errors.New(f.Error)
				}
				return f.Text, nil
			}
		case <-cancelled:
			cancelled = nil
			_ = w.send(workRequest{ID: id, Op: "cancel"})
		case <-w.done:
			return "", fmt.Errorf("%w: sandbox worker lost", api.ErrUnknownOutcome)
		}
	}
}
func (w *worker) Close() error { w.once.Do(func() { _ = w.in.Close(); <-w.done }); return nil }
