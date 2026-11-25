# Modular Agent in Go

The [Go SDK](modular/README.md) builds agents, sessions, tools, Providers and plugins from the [SDK specification](../docs/sdk/README.md). Import `github.com/daniel-ballance/modular-agent/go/modular`. Tests can use `modular/modulartest` without a real model. The SDK README has the shared scenario and cross-language checks and implementation status.

[`ma`](cmd/ma/README.md) is the Go reference implementation of the standard configuration. It uses only the Go SDK and its official plugins.

The SDK wraps the clean-room Go build from the experiment (`modular-agent-go` at `7e4dbd5`). The base implements [production edition 3](../docs/adr/0021-production-edition.md): the Harness, transient and durable Runtimes, ACP, the plugin binding, local and HTTP history, and parts as HTTP services.

The build's own notes, including how to run it and its services, are in [docs/clean-room](docs/clean-room/README.md). Paths in those notes are relative to the old repository root. `conformance` links to this repository's kits.

## Build and check

Go is pinned with mise. The kit tests need the ACP kit's dependencies: run `npm ci` in `../conformance/acp` first.

```sh
mise exec -- go build ./...
mise exec -- go vet ./...
mise exec -- go test -count=1 ./...
mise exec -- go test -race -count=1 ./...
```

Commands need Linux with unprivileged user, PID and mount namespaces. The service sandbox also needs Bubblewrap.

From the repository root, run `scripts/websocket-kits.sh go` after building `go/.bin/modular` and `go/.bin/ma`. Run `go/scripts/check-named-callers.sh` for callers sharing one authenticated plugin listener. Run `go/scripts/check-agui.sh` for the AG-UI listener, wait closures and kept run receipts. The [SDK README](modular/README.md#ag-ui-on-http-and-sse) lists the Go host reads and their limits.
