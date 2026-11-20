// Package configuration merges global settings and then project settings.
package configuration

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/api"
	"os"
	"path/filepath"
)

type Files struct {
	Global   string
	Defaults api.Settings
	DataDir  string
}

func Plugin(global string, defaults api.Settings) api.Plugin {
	return PluginAt(global, defaults, "")
}

// StateProject places project-specific settings inside an isolated data root.
func StateProject(root, project string) string {
	if root == "" {
		return project
	}
	canonical, err := Canonical(project)
	if err == nil {
		project = canonical
	}
	return filepath.Join(root, "projects", fmt.Sprintf("%x", sha256.Sum256([]byte(project))))
}
func PluginAt(global string, defaults api.Settings, dataDir string) api.Plugin {
	return api.Plugin{Name: "configuration", Setup: func(a api.API) error {
		return a.Provide("configuration", &Files{Global: global, Defaults: defaults, DataDir: dataDir})
	}}
}
func (f *Files) Settings(project string) (api.Settings, error) {
	project = StateProject(f.DataDir, project)
	s := f.Defaults
	for _, path := range []string{f.Global, filepath.Join(project, ".modular-agent", "settings.json")} {
		if path == "" {
			continue
		}
		b, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return s, err
		}
		if err = json.Unmarshal(b, &s); err != nil {
			return s, err
		}
	}
	if s.MaxSteps <= 0 || s.MaxOutput <= 0 || s.ContextLimit < 0 {
		return s, errors.New("settings require positive max_steps/max_output and nonnegative context_limit")
	}
	return s, nil
}
