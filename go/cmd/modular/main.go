package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"github.com/OWNER/modular-agent/go/acpinterface"
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/configuration"
	"github.com/OWNER/modular-agent/go/conformancemodel"
	"github.com/OWNER/modular-agent/go/durable"
	"github.com/OWNER/modular-agent/go/fake"
	"github.com/OWNER/modular-agent/go/gateway"
	"github.com/OWNER/modular-agent/go/history"
	"github.com/OWNER/modular-agent/go/historyhttp"
	"github.com/OWNER/modular-agent/go/pluginrpc"
	"github.com/OWNER/modular-agent/go/servicehttp"
	"github.com/OWNER/modular-agent/go/terminal"
	"github.com/OWNER/modular-agent/go/vanilla"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], os.Stdin, os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run(ctx context.Context, args []string, input io.ReadCloser, stdout, stderr io.Writer) error {
	if len(args) == 1 && args[0] == "--serve-plugin" {
		return pluginrpc.ConformanceServer().Serve(ctx, input, stdout)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	project, err := os.Getwd()
	if err != nil {
		return err
	}
	flags := flag.NewFlagSet("modular", flag.ContinueOnError)
	flags.SetOutput(stderr)
	opt := terminal.Options{}
	state := flags.String("state", filepath.Join(home, ".local", "share", "modular-agent-go", "history"), "history store folder")
	global := flags.String("settings", filepath.Join(home, ".config", "modular-agent-go", "settings.json"), "global settings file")
	runtimeName := flags.String("runtime", "transient", "transient or durable")
	subagentName := flags.String("subagents", "transient", "transient or durable subagent recovery")
	flags.BoolVar(&opt.WaitJobs, "wait-jobs", false, "wait for jobs and their parent report turns in print/json mode")
	trust := flags.Bool("trust-project", false, "trust this project's plugins and plugin options for this invocation")
	script := flags.String("script", "", "offline fake Provider JSON script; no credentials are read")
	gatewayURL := flags.String("model-gateway", "", "model gateway URL (required for real inference)")
	tokenFile := flags.String("service-token-file", "", "private file containing the gateway service token")
	historyURL := flags.String("history-url", os.Getenv("MODULAR_AGENT_HISTORY_URL"), "shared history service URL (otherwise local history)")
	historyTokenFile := flags.String("history-token-file", os.Getenv("MODULAR_AGENT_HISTORY_TOKEN_FILE"), "history token file (falls back to --service-token-file)")
	flags.StringVar(&opt.Project, "project", project, "project folder for a new session")
	flags.StringVar(&opt.Session, "session", "", "reopen a session (keeps its project)")
	flags.StringVar(&opt.Mode, "mode", "line", "line, print, json, or acp (stdio)")
	flags.StringVar(&opt.Prompt, "prompt", "", "one prompt (print/json), or initial line-mode input")
	flags.StringVar(&opt.Key, "key", "", "idempotency key for model input")
	if err = flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() > 0 {
		return fmt.Errorf("unexpected positional arguments")
	}
	dataDir := os.Getenv("MODULAR_AGENT_DATA_DIR")
	if dataDir != "" {
		dataDir, err = filepath.Abs(dataDir)
		if err != nil {
			return err
		}
		*state, *global = filepath.Join(dataDir, "history"), filepath.Join(dataDir, "settings.json")
	}
	var remote *historyhttp.Client
	if *historyURL != "" {
		if *historyTokenFile == "" {
			*historyTokenFile = *tokenFile
		}
		token, err := historyhttp.TokenFile(*historyTokenFile)
		if err != nil {
			return err
		}
		remote = historyhttp.NewClient(servicehttp.NewClient(*historyURL, token))
		defer remote.Close()
		if err := remote.Verify(); err != nil {
			return err
		}
	}
	if opt.Session != "" {
		var store api.Store = remote
		if remote == nil {
			local, e := history.New(*state)
			if e != nil {
				return e
			}
			store = local
		}
		sessions, e := store.List("")
		if e != nil {
			return e
		}
		found := false
		for _, s := range sessions {
			if s.ID == opt.Session {
				if *trust {
					p, e := configuration.Canonical(opt.Project)
					if e != nil {
						return e
					}
					q, e := configuration.Canonical(s.Project)
					if e != nil {
						return e
					}
					if p != q {
						return fmt.Errorf("--trust-project requires --project matching the saved session")
					}
				}
				opt.Project = s.Project
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("session not found")
		}
	}
	options := vanilla.Options{Project: opt.Project, TrustProject: *trust, History: *state, Global: *global, DataDir: dataDir}
	if remote != nil {
		options.Store = api.Plugin{Name: "history-http", Setup: func(a api.API) error { return a.Provide("history", remote) }}
	}
	switch *runtimeName {
	case "transient":
	case "durable":
		options.Runtime = durable.Plugin()
	default:
		return fmt.Errorf("runtime must be transient or durable")
	}
	switch *subagentName {
	case "transient":
	case "durable":
		options.DurableSubagents = true
	default:
		return fmt.Errorf("subagents must be transient or durable")
	}
	conformance := os.Getenv("MODULAR_AGENT_CONFORMANCE") == "1"
	if conformance {
		options.Provider, options.Model = conformancemodel.Plugin(), conformancemodel.ID
		options.Conformance = true
	} else if *gatewayURL != "" {
		if *script != "" {
			return fmt.Errorf("choose a model gateway or an offline script, not both")
		}
		token, err := servicehttp.TokenFile(*tokenFile)
		if err != nil {
			return err
		}
		options.Provider = gateway.Plugin(servicehttp.NewClient(*gatewayURL, token))
	}
	if *script != "" && !conformance {
		b, err := os.ReadFile(*script)
		if err != nil {
			return err
		}
		var scripts []fake.Script
		if err = json.Unmarshal(b, &scripts); err != nil {
			return err
		}
		options.Provider = fake.New(scripts...).Plugin()
		options.Model = "fake"
	}
	h, err := vanilla.New(options)
	if err != nil {
		return err
	}
	defer h.Close()
	if opt.Mode == "acp" {
		v, err := h.API().Get("interface.acp")
		if err != nil {
			return err
		}
		return v.(*acpinterface.Interface).Serve(ctx, input, stdout)
	}
	v, err := h.API().Get("interface.terminal")
	if err != nil {
		return err
	}
	return v.(*terminal.Terminal).Run(ctx, opt, input, stdout, stderr)
}
