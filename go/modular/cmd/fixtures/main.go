package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/internal/fixtures"
	"github.com/daniel-ballance/modular-agent/go/pluginrpc"
)

func main() {
	if len(os.Args) < 2 {
		log.Fatal("usage: fixtures NAME [--listen ADDR --token-file FILE]")
	}
	if os.Args[1] == "named-callers" {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := serveNamedFixture(ctx); err != nil {
			log.Fatal(err)
		}
		return
	}
	flags := flag.NewFlagSet("fixtures", flag.ExitOnError)
	addr := flags.String("listen", "", "WebSocket listen address")
	token := flags.String("token-file", "", "bearer token file")
	_ = flags.Parse(os.Args[2:])
	if flags.NArg() != 0 || (*addr == "") != (*token == "") {
		log.Fatal("usage: fixtures NAME [--listen ADDR --token-file FILE]")
	}
	plugin, err := fixtures.Plugin(os.Args[1])
	if err != nil {
		log.Fatal(err)
	}
	if *addr != "" {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		svc, err := modular.ServeService(ctx, plugin, modular.ServeOptions{Listen: *addr, TokenFile: *token})
		if err != nil {
			log.Fatal(err)
		}
		fmt.Println(svc.URL)
		<-svc.Done()
		if err := svc.Close(); err != nil {
			log.Fatal(err)
		}
		return
	}
	ctx := context.Background()
	if os.Getenv(fixtures.HandshakeEnv) == "no-acceptance" {
		ctx = pluginrpc.WithoutTraceHandshake(ctx)
	}
	if endpoint := os.Getenv(fixtures.EndpointEnv); endpoint != "" {
		flush, err := fixtures.InstallTelemetry(ctx, endpoint)
		if err != nil {
			log.Fatal(err)
		}
		// The host closes stdin after plugin/shutdown and waits for this
		// process (or its wire proxy) to exit, including this flush.
		err = errors.Join(modular.Serve(ctx, plugin), flush())
		if err != nil {
			log.Fatal(err)
		}
		return
	}
	if err := modular.Serve(ctx, plugin); err != nil {
		log.Fatal(err)
	}
}
