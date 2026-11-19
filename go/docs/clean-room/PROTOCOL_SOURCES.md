# Protocol sources

Read on 2026-11-16 and 2026-11-17. These are library and published protocol sources, not another build of this agent.

## MCP

- Official Go SDK, pinned to v1.8.0: https://github.com/modelcontextprotocol/go-sdk/tree/v1.8.0
- SDK lifecycle, transport and cancellation guidance: https://github.com/modelcontextprotocol/go-sdk/blob/v1.8.0/docs/protocol.md
- SDK tool listing, annotations, errors, structured content and pagination: https://github.com/modelcontextprotocol/go-sdk/blob/v1.8.0/docs/server.md
- Published tools specification: https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- Published transport specification: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports

The SDK negotiates supported MCP versions. `Client.Connect`, `ClientSession.Tools`, `CallTool`, `CommandTransport` and `StreamableClientTransport` own the wire behavior. Tests use official SDK servers over actual subprocess stdio and local HTTP, both JSON and SSE response framing. Legacy SSE transport is different and is not enabled.

## ACP

- ACP's list of community Go libraries: https://agentclientprotocol.com/libraries/community
- Caelis Labs' maintained Go SDK, pinned to v1.7.0: https://github.com/caelis-labs/acp-go-sdk/tree/v1.7.0
- Library documentation, stable wire v1, official schema 1.31.0: https://github.com/caelis-labs/acp-go-sdk/blob/v1.7.0/README.md
- Initialization and optional declarations: https://agentclientprotocol.com/protocol/v1/initialization
- New, load and resume, with load replay before its response: https://agentclientprotocol.com/protocol/v1/session-setup
- Configuration selectors and complete responses: https://agentclientprotocol.com/protocol/v1/session-config-options
- Permission requests and tool updates: https://agentclientprotocol.com/protocol/v1/tool-calls
- Elicitation, explicit form capability and prohibition on collecting secrets in forms: https://agentclientprotocol.com/protocol/v1/elicitation
- Cancellation: https://agentclientprotocol.com/protocol/v1/cancellation
- Namespaced metadata and extension methods: https://agentclientprotocol.com/protocol/v1/extensibility

## Round two shared bindings

- The authoritative shared host and service agreements are `docs/bindings/acp.md` and `docs/bindings/history-http.md`. The frozen description was not edited.
- The supplied kit uses official `@agentclientprotocol/sdk` 2.7.0, pinned in `conformance/acp/package.json` and its npm lockfile. The kit itself is unchanged. Source: https://www.npmjs.com/package/@agentclientprotocol/sdk/v/2.7.0
- ACP response metadata, generated stop reasons, selectors and permissions were checked against the installed Caelis v1.7.0 generated wire types (`types_gen.go`) and exercised through both SDKs. The top-level InitializeResponse.Meta, rather than AgentCapabilities.Meta, holds the binding declaration.
- Opaque history JSON equality uses exact numeric comparison, and atomic persistence uses synced files plus rename. Standard-library sources: https://pkg.go.dev/encoding/json, https://pkg.go.dev/math/big#Rat.SetString and https://pkg.go.dev/os#Rename.

ACP v2 is a draft. This build uses stable v1 and the library's generated types and bidirectional dispatcher. It does not invent a parallel JSON-RPC implementation. See `GAPS.md` for translation and unsupported-feature decisions.
