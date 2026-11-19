package configuration

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/OWNER/modular-agent/go/api"
	"os"
	"path/filepath"
)

// PluginSpec names a compiled-in plugin factory, not executable source to fetch.
type PluginSpec struct {
	Name    string                     `json:"name"`
	Options map[string]json.RawMessage `json:"options,omitempty"`
}
type Factory func(json.RawMessage) (api.Plugin, error)

// Plugins merges options by name, preserving first appearance order. Project
// plugin data is not even decoded until trust was explicitly granted.
func Plugins(global, project string, trusted bool) ([]PluginSpec, error) {
	var out []PluginSpec
	paths := []string{global}
	if trusted && project != "" {
		paths = append(paths, filepath.Join(project, ".modular-agent", "settings.json"))
	}
	for _, path := range paths {
		if path == "" {
			continue
		}
		b, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		var file struct {
			Plugins []PluginSpec `json:"plugins"`
		}
		if err = json.Unmarshal(b, &file); err != nil {
			return nil, err
		}
		seen := map[string]bool{}
		for _, spec := range file.Plugins {
			if spec.Name == "" || seen[spec.Name] {
				return nil, fmt.Errorf("empty or duplicate configured plugin %q", spec.Name)
			}
			seen[spec.Name] = true
			index := -1
			for i := range out {
				if out[i].Name == spec.Name {
					index = i
					break
				}
			}
			if index < 0 {
				out = append(out, PluginSpec{Name: spec.Name, Options: map[string]json.RawMessage{}})
				index = len(out) - 1
			}
			for k, v := range spec.Options {
				out[index].Options[k] = v
			}
		}
	}
	return out, nil
}

func Canonical(project string) (string, error) {
	p, err := filepath.Abs(project)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(p)
}

// BoundProject prevents trusted registrations leaking into a different project.
// A process has a fixed plugin composition. Use another process for another root.
func BoundProject(project string) api.Plugin {
	return api.Plugin{Name: "project-boundary", Setup: func(a api.API) error { return a.Provide("project-policy", boundary(project)) }}
}

type boundary string

func (b boundary) CheckProject(project string) error {
	p, err := Canonical(project)
	if err != nil || p != string(b) {
		return errors.New("session project differs from configured process project")
	}
	return nil
}
