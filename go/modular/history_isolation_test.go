package modular_test

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func TestHistoryServicesUseSeparateCredentialsAndNamespaces(t *testing.T) {
	ctx := t.Context()
	project := t.TempDir()
	launch := func(i int) (string, string, string) {
		dir := t.TempDir()
		path := filepath.Join(dir, "token")
		token := fmt.Sprintf("disposable-test-token-at-least-128-bits-%d", i)
		if err := os.WriteFile(path, []byte(token), 0600); err != nil {
			t.Fatal(err)
		}
		svc, err := modular.ListenHistory(context.Background(), modular.HistoryServiceFiles(filepath.Join(dir, "records")), modular.HistoryOptions{Address: "127.0.0.1:0", TokenFile: path})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = svc.Close() })
		return svc.URL, path, token
	}
	one, file, token := launch(1)
	two, _, second := launch(2)
	a := modulartest.Agent(t, modular.WithProject(project), modular.WithHistory(modular.HTTPHistory(one, file)), modular.WithDurability(modular.Kept), modular.WithDataDir(t.TempDir()), modulartest.Script(`[{"text":"only on first"}]`))
	s, err := a.Session(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Prompt(ctx, "seed"); err != nil {
		t.Fatal(err)
	}
	if err := s.WaitIdle(ctx); err != nil {
		t.Fatal(err)
	}
	request := func(method, url, secret, body string, status int) {
		t.Helper()
		req, err := http.NewRequestWithContext(ctx, method, url, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+secret)
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != status {
			t.Fatalf("%s %s: got status %d, want %d", method, url, res.StatusCode, status)
		}
	}
	request(http.MethodGet, two+"/v1", token, "", http.StatusUnauthorized)
	path := "/v1/sessions/" + s.ID()
	request(http.MethodGet, two+path, second, "", http.StatusNotFound)
	request(http.MethodPost, two+path+"/lease", second, `{"owner":"other"}`, http.StatusNotFound)
	request(http.MethodGet, one+path, token, "", http.StatusOK)
}
