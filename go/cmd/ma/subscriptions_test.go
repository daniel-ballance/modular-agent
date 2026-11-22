package main

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/subscription"
)

func TestSubscriptionModelAliases(t *testing.T) {
	d, project, _ := isolated(t)
	t.Setenv("MODULAR_AGENT_SCRIPT", "")
	// Read the legacy configuration without an authentication file or a model request.
	put(t, filepath.Join(d.config, "models.json"), `{"openai-codex":[{"id":"old-chat","contextWindow":8192,"maxTokens":2048,"effort":{"high":"high"}}],"xai":[{"id":"old-grok","contextWindow":8192,"maxTokens":2048}]}`)
	for _, tc := range []struct{ old, current string }{{"openai-codex/old-chat", "chatgpt/old-chat"}, {"xai/old-grok", "grok/old-grok"}} {
		put(t, filepath.Join(d.config, "settings.json"), `{"model":"`+tc.old+`"}`)
		settings, err := d.settings(project)
		if err != nil || chosenModel(settings) != tc.current {
			t.Fatal("settings.json model alias was not resolved", err)
		}
		execute := func(args ...string) string {
			t.Helper()
			var out, stderr bytes.Buffer
			if err := run(t.Context(), append([]string{"--project", project}, args...), io.NopCloser(strings.NewReader("")), &out, &stderr, nil); err != nil {
				t.Fatal(err, stderr.String())
			}
			return out.String()
		}
		if out := execute("--model", tc.old, "models"); !strings.Contains(out, tc.current) || strings.Contains(out, tc.old) {
			t.Fatal("--model or models.json alias was not resolved", out)
		}
	}
}

func TestLoginAndLogoutAliasesMigrateTheFile(t *testing.T) {
	for _, tc := range []struct{ old, current, otherOld, other string }{{"openai-codex", "chatgpt", "xai", "grok"}, {"xai", "grok", "openai-codex", "chatgpt"}} {
		t.Run(tc.old, func(t *testing.T) {
			d, project, _ := isolated(t)
			path := filepath.Join(d.config, "auth.json")
			seed := func() {
				put(t, path, `{"logins":{"openai-codex":{"type":"oauth","access":"chat-old","refresh":"old","expires":1},"xai":{"type":"oauth","access":"grok-old","refresh":"old","expires":1}},"answers":{"example":"fixture"},"extension":true}`)
			}
			seed()
			direct := subscription.SubscriptionLogins(path)
			if login, err := d.auth().Login(tc.current); err != nil || login == nil {
				t.Fatal("canonical read did not find old login", err)
			}
			if login, err := direct.Login(tc.old); err != nil || login == nil {
				t.Fatal("read prematurely migrated old login", err)
			}
			o, err := parse([]string{"login", tc.old, "--device"})
			if err != nil {
				t.Fatal(err)
			}
			fixture := subscription.Login{Type: "oauth", Access: "new-fixture", Refresh: "fixture", Expires: 1}
			custom := "alias-test_1"
			o.clientIdentity = &custom
			t.Setenv("MA_NO_BROWSER", "1")
			signIn := func(ctx context.Context, id string, logins subscription.Logins, opts subscription.SignInOptions) error {
				if id != tc.current || !opts.Device || opts.ClientIdentity == nil || *opts.ClientIdentity != custom {
					t.Fatal("login alias did not dispatch to the SDK with its canonical id and options")
				}
				opts.OnStep(subscription.SignInStep{Kind: subscription.DeviceCode, URL: "https://example.test/device", Code: "fixture-code"})
				opts.OnStep(subscription.SignInStep{Kind: subscription.Waiting})
				return logins.Set(ctx, id, &fixture)
			}
			var stderr bytes.Buffer
			if err := d.signInUsing(t.Context(), o, strings.NewReader(""), io.Discard, &stderr, signIn); err != nil {
				t.Fatal(err)
			}
			want := "Open this address in a browser:\n\n  https://example.test/device\n\nand enter the code: fixture-code\n\nWaiting for the sign-in to finish...\nSigned in to " + planLabel(tc.current) + " (" + tc.current + ").\n"
			if stderr.String() != want {
				t.Fatalf("unexpected login output: %q", stderr.String())
			}
			if login, err := direct.Login(tc.current); err != nil || login == nil || login.Access != fixture.Access {
				t.Fatal("login did not write the new slot", err)
			}
			seed()
			if err := run(t.Context(), []string{"--project", project, "logout", tc.old}, io.NopCloser(strings.NewReader("")), io.Discard, io.Discard, nil); err != nil {
				t.Fatal(err)
			}
			for _, gone := range []string{tc.old, tc.otherOld, tc.current} {
				if l, err := direct.Login(gone); err != nil || l != nil {
					t.Fatal("stale login slot", gone, err)
				}
			}
			if l, err := direct.Login(tc.other); err != nil || l == nil {
				t.Fatal("logout did not move the other login", err)
			}
			if answer, err := d.auth().CredentialStore().Get(t.Context(), "example"); err != nil || answer != "fixture" {
				t.Fatal("logout lost a named answer", err)
			}
			if b, err := os.ReadFile(path); err != nil || !bytes.Contains(b, []byte(`"extension": true`)) {
				t.Fatal("logout lost an unrelated field", err)
			}
		})
	}
}

func TestReopenSessionWithFormerProviderID(t *testing.T) {
	d, project, _ := isolated(t)
	t.Setenv("MODULAR_AGENT_SCRIPT", "")
	ctx := t.Context()
	store := modular.FileHistory(filepath.Join(d.state, "sessions"))
	for _, tc := range []struct{ old, current, model string }{{"openai-codex", "chatgpt", "gpt-6.1-sol"}, {"xai", "grok", "grok-4.7"}} {
		t.Run(tc.old, func(t *testing.T) {
			ref := modular.ModelRef{Provider: tc.old, ID: tc.model}
			oldProvider := modular.Provider{ID: tc.old, Models: func() []modular.ModelInfo {
				return []modular.ModelInfo{{ModelRef: ref, ContextWindow: 500000, MaxOutput: 128000, Input: []string{"text"}}}
			}, Request: func(context.Context, modular.ModelRef, modular.ModelRequest, *modular.ProviderContext) (modular.AssistantMessage, error) {
				return modular.AssistantMessage{Content: modular.Text("stored fixture"), Stop: "finished"}, nil
			}}
			a, err := modular.New(ctx, modular.WithProject(project), modular.WithDataDir(d.state), modular.WithHistory(store), modular.WithDurability(modular.Durable), modular.WithProvider(oldProvider), modular.WithModel(ref))
			if err != nil {
				t.Fatal(err)
			}
			s, err := a.Session(ctx)
			if err != nil {
				t.Fatal(err)
			}
			out, err := s.Prompt(ctx, "store an old model id")
			if err != nil || out.Text != "stored fixture" {
				t.Fatalf("could not seed history: %+v, %v", out.Outcome, err)
			}
			id := s.ID()
			if err := a.Close(ctx); err != nil {
				t.Fatal(err)
			}
			info, err := store.SessionInfo(ctx, id)
			if err != nil || info.Model != ref.String() {
				t.Fatal("old model was not saved", err)
			}
			var stdout bytes.Buffer
			if err := run(ctx, []string{"--project", project, "--session", id, "--history"}, io.NopCloser(strings.NewReader("")), &stdout, io.Discard, nil); err != nil || !strings.Contains(stdout.String(), "stored fixture") {
				t.Fatal("ma did not reopen saved history", err)
			}
			next, err := d.compose(ctx, options{project: project}, modular.Settings{}, store, io.Discard)
			if err != nil {
				t.Fatal(err)
			}
			defer next.Close(ctx)
			reopened, err := next.OpenSession(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			settings, err := reopened.Settings(ctx)
			if err != nil || chosenModel(settings) != tc.current+"/"+tc.model {
				t.Fatalf("wrong model after reopening: %v, %v", settings, err)
			}
		})
	}
}
