# Modular Agent in Go

The [Go SDK](modular/README.md) builds agents, sessions, tools, Providers and plugins from [SDK draft 0.1](../docs/sdk/README.md). Import `github.com/OWNER/modular-agent/go/modular`. Tests can use `modular/modulartest` without a real model. The SDK README has the shared scenario and cross-language checks, implementation status and specification findings.

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
