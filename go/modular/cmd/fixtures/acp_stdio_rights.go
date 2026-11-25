package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/modulartest"
)

func serveStdioRights(ctx context.Context) error {
	dir := os.Getenv("MODULAR_AGENT_DATA_DIR")
	if os.Getenv("MODULAR_AGENT_CONFORMANCE") != "1" || dir == "" {
		return errors.New("acp-stdio-rights requires a disposable conformance directory")
	}
	actor := modular.Actor{ID: "rights-fixture", Kind: "host", Rights: []string{"watch", "input", "settings"}}
	opt := modular.ServeACPOptions{StdioActor: &actor}
	if raw, ok := os.LookupEnv("MA_ACP_STDIO_RIGHTS"); ok {
		if err := json.Unmarshal([]byte(raw), &opt.Rights); err != nil {
			return err
		}
	}
	provider := modulartest.ScriptedProvider([]modulartest.Reply{{Text: "First turn."}, {Text: "Second turn."}})
	a, err := modular.New(ctx, modular.WithDataDir(dir), modular.WithDurability(modular.Kept), modular.WithPluginHost(true), modular.WithProvider(provider))
	if err != nil {
		return err
	}
	return errors.Join(a.ServeACP(ctx, opt), a.Close(ctx))
}
