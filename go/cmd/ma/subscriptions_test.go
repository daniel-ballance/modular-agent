package main

import (
	"bytes"
	"context"
	"io"
	"path/filepath"
	"strings"
	"testing"

	"github.com/daniel-ballance/modular-agent/go/modular/subscription"
)

func TestSubscriptionIDsAreDistinct(t *testing.T) {
	d, project, _ := isolated(t)
	put(t, filepath.Join(d.config, "auth.json"), `{"logins":{"xai":{"type":"api_key","key":"fixture"}}}`)
	put(t, filepath.Join(d.config, "models.json"), `{"openai-codex":[{"id":"other"}]}`)
	if l, err := d.auth().Login("grok"); l != nil || err != nil {
		t.Fatal("read a different provider's login", err)
	}
	if overrides, err := d.modelOverrides(); err != nil || len(overrides) != 0 {
		t.Fatal("imported a different provider's catalog", err)
	}
	for _, id := range []string{"openai-codex", "xai"} {
		err := run(t.Context(), []string{"--project", project, "logout", id}, io.NopCloser(strings.NewReader("")), io.Discard, io.Discard, nil)
		if err == nil || !strings.Contains(err.Error(), "unknown provider") {
			t.Fatalf("logout %s: %v", id, err)
		}
	}
}

func TestDeviceSignInInstructions(t *testing.T) {
	d, _, _ := isolated(t)
	t.Setenv("MA_NO_BROWSER", "1")
	o, err := parse([]string{"login", "chatgpt", "--device"})
	if err != nil {
		t.Fatal(err)
	}
	custom := "fixture_1"
	o.clientIdentity = &custom
	signIn := func(_ context.Context, id string, _ subscription.Logins, opts subscription.SignInOptions) error {
		if id != "chatgpt" || !opts.Device || opts.ClientIdentity == nil || *opts.ClientIdentity != custom {
			t.Fatal("wrong device sign-in options")
		}
		opts.OnStep(subscription.SignInStep{Kind: subscription.DeviceCode, URL: "https://example.test/device", Code: "fixture-code"})
		opts.OnStep(subscription.SignInStep{Kind: subscription.Waiting})
		return nil
	}
	var stderr bytes.Buffer
	if err := d.signInUsing(t.Context(), o, strings.NewReader(""), io.Discard, &stderr, signIn); err != nil {
		t.Fatal(err)
	}
	want := "Open this address in a browser:\n\n  https://example.test/device\n\nand enter the code: fixture-code\n\nWaiting for the sign-in to finish...\nSigned in to " + planLabel("chatgpt") + " (chatgpt).\n"
	if stderr.String() != want {
		t.Fatalf("device sign-in instructions: %q", stderr.String())
	}
}
