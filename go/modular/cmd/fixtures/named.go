package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"

	"github.com/daniel-ballance/modular-agent/go/local"
	"github.com/daniel-ballance/modular-agent/go/modular"
)

// The managed plugin kit supplies disposable state and projects. Nothing in
// initialization or a tool call selects a directory or the factory's ID.
type callerScope struct {
	CallerID, Project, StateDir string
	mu                          sync.Mutex
}

type probeInput struct {
	CallerID string  `json:"callerId"`
	Write    *string `json:"write,omitempty"`
}
type probeValue struct {
	CallerID string  `json:"callerId"`
	Previous *string `json:"previous"`
}

func serveNamedFixture(ctx context.Context) error {
	var config struct {
		Listen, TokenFile, AuditFile string
		Callers                      []modular.PluginCaller
		Scopes                       []*callerScope
	}
	b, err := os.ReadFile(os.Getenv("MA_PLUGIN_FIXTURE"))
	if err != nil {
		return err
	}
	if err := json.Unmarshal(b, &config); err != nil {
		return err
	}
	scopes := map[string]*callerScope{}
	for _, scope := range config.Scopes {
		scopes[scope.CallerID] = scope
	}
	for i, entry := range config.Callers {
		if scope := scopes[entry.CallerID]; scope != nil {
			config.Callers[i].Projects = []string{scope.Project}
		}
	}
	audit := func(event, caller string) error {
		f, err := os.OpenFile(config.AuditFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		return errors.Join(json.NewEncoder(f).Encode(map[string]string{"event": event, "callerId": caller}), f.Close())
	}
	factory := func(id string) modular.Plugin {
		factoryErr := audit("factory", id)
		scope := scopes[id]
		var dir string
		return modular.Plugin{Name: "named-kit", Replaces: []string{"working-environment", "tool:bash"}, Setup: func(r *modular.Registrar) error {
			if factoryErr != nil {
				return factoryErr
			}
			if err := audit("setup", id); err != nil {
				return err
			}
			if scope == nil {
				return errors.New("no assigned caller scope")
			}
			// Live commands and points belong to this instance. Only the
			// marker below is retained across connections for the caller.
			var err error
			dir, err = os.MkdirTemp(scope.StateDir, "instance-")
			if err != nil {
				return err
			}
			if err = r.Environment(local.NewAt(dir)); err != nil {
				return err
			}
			if err = r.Tool(modular.NewTool("bash", "Call the connecting host's environment.", func(ctx context.Context, in struct {
				Command string `json:"command"`
			}, tc *modular.ToolContext) (string, error) { res, err := tc.Environment.Exec(ctx, in.Command, 0, nil); return res.Output, err })); err != nil {
				return err
			}
			return r.Tool(modular.NewTool("caller_probe", "Read or replace this caller's fixture marker.", func(_ context.Context, in probeInput, _ *modular.ToolContext) (probeValue, error) {
				scope.mu.Lock()
				defer scope.mu.Unlock()
				v := probeValue{CallerID: id}
				file := filepath.Join(scope.StateDir, "marker")
				b, err := os.ReadFile(file)
				if err == nil {
					s := string(b)
					v.Previous = &s
				} else if !errors.Is(err, os.ErrNotExist) {
					return v, err
				}
				if in.Write != nil {
					return v, os.WriteFile(file, []byte(*in.Write), 0600)
				}
				return v, nil
			}, modular.Output[probeValue]()))
		}, Stop: func() error {
			if dir != "" {
				return os.RemoveAll(dir)
			}
			return nil
		}}
	}
	s, err := modular.ServeNamedServiceFactory(ctx, factory, modular.ServeOptions{Listen: config.Listen, TokenFile: config.TokenFile, Callers: config.Callers})
	if err != nil {
		var failure *modular.Error
		if errors.As(err, &failure) {
			_ = json.NewEncoder(os.Stdout).Encode(map[string]modular.Code{"error": failure.Code})
		}
		return err
	}
	defer s.Close()
	if err := json.NewEncoder(os.Stdout).Encode(map[string]string{"url": s.URL}); err != nil {
		return err
	}
	<-s.Done()
	return nil
}
