// Package local provides local files and supervised commands, not a sandbox.
package local

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
)

type Environment struct {
	mu        sync.Mutex
	guards    []*guardian
	root      string
	initErr   error
	closed    bool
	active    sync.WaitGroup
	pointsMu  sync.Mutex
	gitPoints bool
	stateDirs []string
	confined  bool
}
type guardian struct {
	session string
	cmd     *exec.Cmd
	control *os.File
	done    chan struct{}
}

func defaultRoot() string {
	return filepath.Join(os.TempDir(), fmt.Sprintf("modular-go-commands-%d", os.Getuid()))
}
func New() *Environment { return NewAt(defaultRoot()) }
func NewAt(root string, stateDirs ...string) *Environment {
	e := &Environment{root: root, stateDirs: append([]string{root}, stateDirs...)}
	e.initErr = e.cleanup()
	return e
}
func NewGitAt(root string, stateDirs ...string) *Environment {
	e := NewAt(root, stateDirs...)
	e.gitPoints = true
	return e
}

// StopsOnCrash is the strong containment check used by recovery.
func (e *Environment) StopsOnCrash() bool { return runtime.GOOS == "linux" && e.initErr == nil }

func (e *Environment) Containment() string {
	if e.StopsOnCrash() {
		return "strong"
	}
	if runtime.GOOS == "darwin" && e.initErr == nil {
		return "processGroup"
	}
	return "none"
}
func (e *Environment) Platforms() []string { return []string{runtime.GOOS} }

func Plugin() api.Plugin { return PluginAt(defaultRoot()) }
func PluginAt(root string, stateDirs ...string) api.Plugin {
	return environmentPlugin(NewAt(root, stateDirs...))
}

func GitPluginAt(root string, stateDirs ...string) api.Plugin {
	return environmentPlugin(NewGitAt(root, stateDirs...))
}

// ConfinedPluginAt keeps file operations within the session project.
func ConfinedPluginAt(root string, stateDirs ...string) api.Plugin {
	e := NewAt(root, stateDirs...)
	e.confined = true
	return environmentPlugin(e)
}

func (e *Environment) ConfinesFiles() bool { return e.confined }

// NeedsDataDir reports that the environment keeps command recovery bookkeeping.
func (e *Environment) NeedsDataDir() bool { return true }

func environmentPlugin(e *Environment) api.Plugin {
	return api.Plugin{Name: "local", Setup: func(a api.API) error {
		if e.initErr != nil {
			return e.initErr
		}
		if err := a.Provide("working-environment", e); err != nil {
			return err
		}
		for _, point := range []string{"session.stop", "session.end"} {
			if err := a.Handle(point, "last", func(ctx context.Context, v any) (api.Decision, error) {
				return api.Decision{}, e.SessionEnded(ctx, v.(string))
			}); err != nil {
				return err
			}
		}
		return nil
	}, Close: e.Close}
}
func path(project, name string) string {
	if filepath.IsAbs(name) {
		return name
	}
	return filepath.Join(project, name)
}
func (e *Environment) Exists(ctx context.Context, project, name string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	var err error
	if e.confined {
		var root *os.Root
		var rel string
		root, rel, err = confinedPath(project, name)
		if err == nil {
			defer root.Close()
			_, err = root.Stat(rel)
		}
	} else {
		_, err = os.Stat(path(project, name))
	}
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}
func (e *Environment) Read(ctx context.Context, project, name string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if e.confined {
		root, rel, err := confinedPath(project, name)
		if err != nil {
			return nil, err
		}
		defer root.Close()
		return root.ReadFile(rel)
	}
	return os.ReadFile(path(project, name))
}
func (e *Environment) Write(ctx context.Context, project, name string, data []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if e.confined {
		root, rel, err := confinedPath(project, name)
		if err != nil {
			return err
		}
		defer root.Close()
		if err = root.MkdirAll(filepath.Dir(rel), 0755); err != nil {
			return err
		}
		return root.WriteFile(rel, data, 0644)
	}
	p := path(project, name)
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		return err
	}
	return os.WriteFile(p, data, 0644)
}

func confinedPath(project, name string) (*os.Root, string, error) {
	rel, err := filepath.Rel(project, path(project, name))
	if err != nil || !filepath.IsLocal(rel) {
		return nil, "", errors.New("path is outside the project")
	}
	root, err := os.OpenRoot(project)
	return root, rel, err
}

type commandRequest struct{ Project, Command string }

// Output and the final exit travel on a single ordered pipe. Otherwise an
// exit on a separate pipe can overtake a short command's last output.
type commandFrame struct {
	Chunk    []byte `json:",omitempty"`
	ExitCode *int   `json:",omitempty"`
	Error    string `json:",omitempty"`
}
type commandOutput struct{ encoder *json.Encoder }

func (w *commandOutput) Write(b []byte) (int, error) {
	if err := w.encoder.Encode(commandFrame{Chunk: b}); err != nil {
		return 0, err
	}
	return len(b), nil
}

type commandResult struct {
	commandFrame
	Text    string
	Unknown bool
}

func (e *Environment) Bash(ctx context.Context, project, command string, progress func(string)) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	e.mu.Lock()
	if e.closed || e.initErr != nil {
		e.mu.Unlock()
		return "", errors.Join(errors.New("working environment unavailable"), e.initErr)
	}
	e.active.Add(1)
	defer e.active.Done()
	defer e.mu.Unlock() // released explicitly before waiting, reacquired before return
	controlR, controlW, err := os.Pipe()
	if err != nil {
		return "", err
	}
	resultR, resultW, err := os.Pipe()
	if err != nil {
		controlR.Close()
		controlW.Close()
		return "", err
	}
	defer resultR.Close()
	exe, err := os.Executable()
	if err != nil {
		controlR.Close()
		controlW.Close()
		resultW.Close()
		return "", err
	}
	cmd := exec.Command(exe, "--modular-command-supervisor")
	cmd.ExtraFiles = []*os.File{controlR, resultW}
	release, err := e.startSupervisor(cmd)
	controlR.Close()
	resultW.Close()
	if err != nil {
		controlW.Close()
		return "", err
	}
	g := &guardian{session: api.Executing(ctx).Session, cmd: cmd, control: controlW, done: make(chan struct{})}
	e.guards = append(e.guards, g)
	go func() {
		_ = cmd.Wait()
		_ = controlW.Close()
		release()
		close(g.done)
		e.mu.Lock()
		for i, current := range e.guards {
			if current == g {
				e.guards = append(e.guards[:i], e.guards[i+1:]...)
				break
			}
		}
		e.mu.Unlock()
	}()
	err = json.NewEncoder(controlW).Encode(commandRequest{project, command})
	e.mu.Unlock()
	resultCh := make(chan commandResult, 1)
	go func() {
		decoder := json.NewDecoder(resultR)
		var output bytes.Buffer
		for {
			var frame commandFrame
			if err := decoder.Decode(&frame); err != nil {
				<-g.done
				resultCh <- commandResult{commandFrame: commandFrame{Error: "Call did not finish. Check outside state before relying on it. Command supervisor stopped: " + err.Error()}, Text: output.String(), Unknown: true}
				return
			}
			if len(frame.Chunk) == 0 {
				resultCh <- commandResult{commandFrame: frame, Text: output.String()}
				return
			}
			output.Write(frame.Chunk)
			if progress != nil {
				progress(string(frame.Chunk))
			}
		}
	}()
	var result commandResult
	if err != nil {
		controlW.Close()
		<-resultCh
		result.Error = err.Error()
	} else {
		select {
		case result = <-resultCh:
		case <-ctx.Done():
			controlW.Close()
			<-g.done
			<-resultCh // Let the decoder drain before the caller can return.
			result.Error = ctx.Err().Error()
		}
	}
	e.mu.Lock()
	if result.Error != "" {
		if result.Unknown {
			return result.Text, fmt.Errorf("%w: %s", api.ErrUnknownOutcome, result.Error)
		}
		if result.ExitCode != nil {
			return result.Text, &ExitError{Code: *result.ExitCode, Message: result.Error}
		}
		return result.Text, errors.New(result.Error)
	}
	return result.Text, nil
}

// SessionEnded signals only the guardians started by this session, including
// those whose foreground command already returned.
func (e *Environment) SessionEnded(_ context.Context, session string) error {
	e.mu.Lock()
	var ended []*guardian
	for _, g := range e.guards {
		if g.session == session {
			_ = g.control.Close()
			ended = append(ended, g)
		}
	}
	e.mu.Unlock()
	for _, g := range ended {
		<-g.done
	}
	return nil
}

func (e *Environment) Close() error {
	e.mu.Lock()
	e.closed = true
	guards := append([]*guardian(nil), e.guards...)
	for _, g := range guards {
		_ = g.control.Close()
	}
	e.mu.Unlock()
	e.active.Wait()
	for _, g := range guards {
		<-g.done
	}
	return nil
}
