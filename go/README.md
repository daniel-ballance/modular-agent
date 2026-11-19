# Modular Agent in Go

The clean-room Go build from the experiment (`modular-agent-go` at `7e4dbd5`), copied in unchanged. It implements [production edition 3](../docs/adr/0021-production-edition.md): the Harness, the transient and durable Runtimes, ACP, the plugin host and served plugins, local and HTTP history, and parts as HTTP services. It is the starting point for the Go SDK, third in [the SDK order](../docs/adr/0024-five-layers.md#choices). It is not yet an SDK, and it has no reference implementation yet.

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
