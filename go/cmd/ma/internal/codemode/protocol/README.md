# Monty wire types

`monty.proto` and `LICENSE` are copied without changes from [Monty v1.6.0](https://github.com/pydantic/monty/tree/v1.6.0), commit `3f89dcbf82071896efb5e3ded507db4191e8d829`. The schema is at `crates/monty-proto/proto/monty/v1/monty.proto` upstream.

The Go types use the standard pure-Go protobuf runtime, with no gRPC dependency. Generate them in this directory with `protoc` 33.5 and `protoc-gen-go` v1.36.11:

```sh
protoc --go_out=. --go_opt=paths=source_relative \
  --go_opt=Mmonty.proto=github.com/daniel-ballance/modular-agent/go/cmd/ma/internal/codemode/protocol monty.proto
```
