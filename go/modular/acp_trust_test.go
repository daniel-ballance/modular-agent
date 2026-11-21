package modular_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
)

type projectTrust struct {
	project string
	allow   bool
}

func (p projectTrust) Trusted(project string) (bool, error) {
	return p.allow && p.project == project, nil
}
func (projectTrust) Settings(string) (modular.Settings, error) { return nil, nil }

func TestConfigurationTrustControlsACPProjectMCP(t *testing.T) {
	t.Setenv("MODULAR_AGENT_PLUGINS", "")
	for _, trusted := range []bool{false, true} {
		name := "untrusted"
		if trusted {
			name = "trusted"
		}
		t.Run(name, func(t *testing.T) {
			ctx := t.Context()
			project := t.TempDir()
			configuration := modular.Plugin{Name: "trust", Replaces: []string{"configuration"}, Setup: func(r *modular.Registrar) error { return r.Configuration(projectTrust{project, trusted}) }}
			a, err := modular.New(ctx, modular.WithProject(project), modular.WithPluginHost(true), modular.WithPlugin(configuration))
			if err != nil {
				t.Fatal(err)
			}
			defer a.Close(ctx)
			token := "offline-project-trust-test-128-bit"
			file := filepath.Join(t.TempDir(), "token")
			if err = os.WriteFile(file, []byte(token), 0600); err != nil {
				t.Fatal(err)
			}
			resolved := make(chan string, 1)
			svc, err := a.ListenACP(ctx, modular.ServeACPOptions{Listen: "127.0.0.1:0", Actors: []modular.ACPActor{{TokenFile: file, Actor: modular.LocalACPActor()}}, ProjectMCP: func(project string) ([]modular.MCPServer, error) { resolved <- project; return nil, nil }})
			if err != nil {
				t.Fatal(err)
			}
			defer svc.Close()
			call := acpSocket(t, svc.URL, token)
			result := call("session/new", map[string]any{"cwd": project, "mcpServers": []any{}})
			if result["error"] != nil {
				t.Fatal(result)
			}
			select {
			case got := <-resolved:
				if !trusted || got != project {
					t.Fatalf("resolved MCP for %q with trusted=%v", got, trusted)
				}
			default:
				if trusted {
					t.Fatal("trusted project MCP was not resolved")
				}
			}
		})
	}
}
