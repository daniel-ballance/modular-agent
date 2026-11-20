package main

import (
	"context"
	"log"
	"os"

	"github.com/daniel-ballance/modular-agent/go/modular"
	"github.com/daniel-ballance/modular-agent/go/modular/internal/fixtures"
)

func main() {
	if len(os.Args) != 2 {
		log.Fatal("usage: fixtures NAME")
	}
	plugin, err := fixtures.Plugin(os.Args[1])
	if err != nil {
		log.Fatal(err)
	}
	if err = modular.Serve(context.Background(), plugin); err != nil {
		log.Fatal(err)
	}
}
