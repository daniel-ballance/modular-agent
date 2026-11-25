package modular_test

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
)

func TestNamedCallersValidateBeforeListening(t *testing.T) {
	file := func(name string, mode os.FileMode) string {
		path := filepath.Join(t.TempDir(), name)
		if err := os.WriteFile(path, []byte("a-disposable-caller-test-token"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, mode); err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != mode {
			t.Fatalf("token file %s has mode %04o, want %04o", path, got, mode)
		}
		return path
	}
	good := modular.PluginCaller{CallerID: "a", TokenFile: file("token", 0600)}
	factory := func(string) modular.Plugin { t.Fatal("factory before upgrade"); return modular.Plugin{} }
	for _, tc := range []struct {
		name      string
		callers   []modular.PluginCaller
		single    string
		noFactory bool
	}{
		{"nil table", nil, "", false}, {"empty table", []modular.PluginCaller{}, "", false}, {"missing factory", []modular.PluginCaller{good}, "", true},
		{"empty id", []modular.PluginCaller{{TokenFile: good.TokenFile}}, "", false}, {"unreadable", []modular.PluginCaller{{CallerID: "a", TokenFile: filepath.Join(t.TempDir(), "absent")}}, "", false},
		{"unsafe file", []modular.PluginCaller{{CallerID: "a", TokenFile: file("shared", 0644)}}, "", false}, {"duplicate id", []modular.PluginCaller{good, good}, "", false},
		{"duplicate bearer", []modular.PluginCaller{good, {CallerID: "A", TokenFile: file("copy", 0600)}}, "", false}, {"mixed options", []modular.PluginCaller{good}, good.TokenFile, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := factory
			if tc.noFactory {
				f = nil
			}
			s, err := modular.ServeNamedServiceFactory(t.Context(), f, modular.ServeOptions{Listen: "127.0.0.1:0", TokenFile: tc.single, Callers: tc.callers})
			var failure *modular.Error
			if s != nil {
				s.Close()
				t.Fatal("listener started")
			}
			if !errors.As(err, &failure) || failure.Code != modular.InvalidComposition {
				t.Fatalf("got %v, want invalid_composition", err)
			}
		})
	}
	if s, err := modular.ServeService(t.Context(), modular.Plugin{Name: "shared"}, modular.ServeOptions{Listen: "127.0.0.1:0", Callers: []modular.PluginCaller{good}}); s != nil || err == nil {
		t.Fatal("table accepted without a caller-aware factory")
	}
}
