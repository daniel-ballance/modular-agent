// modular-service runs exactly one part in its own process. Only role=gateway
// installs the Anthropic Provider and can read the experiment key.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"github.com/daniel-ballance/modular-agent/go/agenthttp"
	"github.com/daniel-ballance/modular-agent/go/anthropic"
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/credentials"
	"github.com/daniel-ballance/modular-agent/go/durable"
	"github.com/daniel-ballance/modular-agent/go/environmenthttp"
	"github.com/daniel-ballance/modular-agent/go/fake"
	"github.com/daniel-ballance/modular-agent/go/gateway"
	"github.com/daniel-ballance/modular-agent/go/harness"
	"github.com/daniel-ballance/modular-agent/go/historyhttp"
	"github.com/daniel-ballance/modular-agent/go/servicehttp"
	"github.com/daniel-ballance/modular-agent/go/vanilla"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run(ctx context.Context, args []string) error {
	f := flag.NewFlagSet("modular-service", flag.ContinueOnError)
	role := f.String("role", "", "history, environment, gateway, or agent")
	listen := f.String("listen", "127.0.0.1:0", "loopback HTTP listen address")
	tokenFile := f.String("token-file", "", "incoming service-token file")
	upstreamTokenFile := f.String("upstream-token-file", "", "outgoing service-token file (defaults to incoming file)")
	state := f.String("state", "", "service-owned state folder")
	historyTTL := f.Duration("history-ttl", 3*time.Second, "history service lease length")
	project := f.String("project", "", "canonical project folder (agent), sandbox root (environment)")
	historyURL := f.String("history-url", "", "history service URL")
	environmentURL := f.String("environment-url", "", "working environment service URL")
	gatewayURL := f.String("model-gateway", "", "model gateway URL")
	settings := f.String("settings", "", "global agent settings file")
	runtimeName := f.String("runtime", "transient", "transient or durable")
	children := f.String("subagents", "transient", "transient or durable")
	model := f.String("model", anthropic.ModelID, "chosen model (fake for offline gateway)")
	script := f.String("script", "", "gateway only: offline fake Provider script")
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	keyFile := f.String("key-file", filepath.Join(home, ".config", "modular-agent-experiment", "anthropic.key"), "gateway only: model credential file")
	if err = f.Parse(args); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("unexpected arguments")
	}
	host, _, err := net.SplitHostPort(*listen)
	if err != nil {
		return err
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return errors.New("standalone HTTP services listen only on loopback; use an authenticated TLS proxy for remote access")
	}
	token, err := servicehttp.TokenFile(*tokenFile)
	if err != nil {
		return err
	}
	if *upstreamTokenFile == "" {
		*upstreamTokenFile = *tokenFile
	}
	var handler http.Handler
	var closePart func() error
	switch *role {
	case "history":
		if *state == "" {
			return errors.New("history requires --state")
		}
		s, e := historyhttp.New(*state, *historyTTL)
		if e != nil {
			return e
		}
		handler = s.Handler(token)
		closePart = s.Close
	case "environment":
		if *project == "" {
			return errors.New("environment requires --project")
		}
		s, e := environmenthttp.New(*project)
		if e != nil {
			return e
		}
		handler = s.Handler(token)
		closePart = s.Close
	case "gateway":
		if *script != "" {
			b, e := os.ReadFile(*script)
			if e != nil {
				return e
			}
			var scripts []fake.Script
			if e = json.Unmarshal(b, &scripts); e != nil {
				return e
			}
			handler = gateway.New(fake.New(scripts...)).Handler(token)
			closePart = func() error { return nil }
		} else {
			h := harness.New()
			closePart = h.Close
			for _, p := range []api.Plugin{credentials.Plugin(*keyFile), anthropic.Plugin("", nil)} {
				if e := h.Load(p); e != nil {
					h.Close()
					return e
				}
			}
			v, _ := h.API().Get("provider.anthropic")
			handler = gateway.New(v.(api.Provider)).Handler(token)
		}
	case "agent":
		if *historyURL == "" || *environmentURL == "" || *gatewayURL == "" || *project == "" {
			return errors.New("agent requires --history-url, --environment-url, --model-gateway and --project")
		}
		if *script != "" {
			return errors.New("offline scripts belong in the gateway, not the agent")
		}
		upstream, e := servicehttp.TokenFile(*upstreamTokenFile)
		if e != nil {
			return e
		}
		opt := vanilla.Options{History: *state, Project: *project, Global: *settings, Model: *model, Store: historyhttp.Plugin(servicehttp.NewClient(*historyURL, upstream)), Environment: environmenthttp.Plugin(servicehttp.NewClient(*environmentURL, upstream)), Provider: gateway.Plugin(servicehttp.NewClient(*gatewayURL, upstream))}
		switch *runtimeName {
		case "transient":
		case "durable":
			opt.Runtime = durable.Plugin()
		default:
			return errors.New("invalid Runtime")
		}
		switch *children {
		case "transient":
		case "durable":
			opt.DurableSubagents = true
		default:
			return errors.New("invalid subagent variant")
		}
		h, e := vanilla.New(opt)
		if e != nil {
			return e
		}
		closePart = h.Close
		if e = h.Load(agenthttp.Plugin(*project)); e != nil {
			h.Close()
			return e
		}
		v, _ := h.API().Get("interface.http")
		handler = v.(*agenthttp.Interface).Handler(token)
	default:
		return errors.New("--role must be history, environment, gateway, or agent")
	}
	defer closePart()
	listener, err := net.Listen("tcp", *listen)
	if err != nil {
		return err
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, BaseContext: func(net.Listener) context.Context { return ctx }}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	// A readiness line contains no tokens or model credentials.
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"role": *role, "url": "http://" + listener.Addr().String(), "pid": os.Getpid()})
	select {
	case <-ctx.Done():
		_ = server.Close()
		err = <-done
	case err = <-done:
	}
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
