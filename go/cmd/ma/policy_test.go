package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestTraceTrustOnWorkRequests(t *testing.T) {
	ma := filepath.Join(t.TempDir(), "ma")
	if output, err := exec.Command("go", "build", "-o", ma, ".").CombinedOutput(); err != nil {
		t.Fatalf("build ma: %v\n%s", err, output)
	}
	if output, err := exec.Command("node", "../../../conformance/reference/trace-trust.mjs", ma).CombinedOutput(); err != nil {
		t.Fatalf("trace trust: %v\n%s", err, output)
	}
}

func TestOperatorPolicyLimitsAndStartupDiagnostics(t *testing.T) {
	d, project, _ := isolated(t)
	policy := filepath.Join(d.config, "policy.json")
	put(t, policy, `{"limits":{"session":{"inputs":2,"storageBytes":16777216}},"stdio":{"actor":{"id":"operator","kind":"program","rights":["watch"]},"projects":[],"tenants":[null]}}`)
	var out, stderr bytes.Buffer
	if err := run(t.Context(), []string{"--project", project, "--declaration"}, os.Stdin, &out, &stderr, make(chan os.Signal)); err != nil {
		t.Fatal(err)
	}
	var declaration struct {
		Limits struct {
			Session struct{ Inputs, Calls, StorageBytes, ControlBytes int64 }
		}
		ResourceReservations struct{ Session struct{ Inputs int64 } }
	}
	if err := json.Unmarshal(out.Bytes(), &declaration); err != nil {
		t.Fatal(err)
	}
	l := declaration.Limits.Session
	if l.Inputs != 2 || l.Calls != 64 || l.StorageBytes != 16<<20 || l.ControlBytes != 8<<20 || declaration.ResourceReservations.Session.Inputs != 2 {
		t.Fatalf("unexpected policy projection: %s", out.String())
	}
	if strings.Contains(out.String(), "operator") {
		t.Fatal("principal was included in declaration")
	}
	for _, raw := range []string{
		`{"stdio":{"actor":{"id":"host","kind":"host","rights":["watch"]},"projects":false}}`,
		`{"stdio":{"actor":{"id":"host","kind":"host","rights":[]},"represents":["guest"]}}`,
		`{"stdio":{"actor":{"id":"host","kind":"host","rights":[]},"traceTrusted":null}}`,
		`{"limits":{"agent":{"bufferedBytes":-1}}}`,
		`{"limits":{"session":{"storageBytes":0}}}`,
	} {
		put(t, policy, raw)
		err := run(t.Context(), []string{"--project", project, "--declaration"}, os.Stdin, &out, &stderr, make(chan os.Signal))
		if err == nil || !strings.Contains(err.Error(), policy) {
			t.Fatalf("want named policy error, got %v", err)
		}
	}
}
