package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/internal/fixtures"
)

func main() {
	if len(os.Args) < 2 {
		log.Fatal("usage: fixtures NAME [--listen ADDR --token-file FILE]")
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
	if err = modular.Serve(context.Background(), plugin); err != nil {
		log.Fatal(err)
	}
}
