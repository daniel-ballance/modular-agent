# Library and API sources

## Plugin shared binding round

Wire behavior comes from the supplied `docs/bindings/plugin.md`, `data.md` and unchanged conformance kits, not from another build. The new transport uses pinned Tokio 1.54.1. Its downloaded official source for bounded AsyncRead::take, cancellation-safe read_until, process kill_on_drop and explicit child waits was checked. Base64 0.23.1's official crate examples specify BASE64_STANDARD with Engine::encode/decode.

- https://docs.rs/tokio/1.54.1/tokio/io/trait.AsyncReadExt.html#method.take
- https://docs.rs/tokio/1.54.1/tokio/io/trait.AsyncBufReadExt.html#method.read_until
- https://docs.rs/tokio/1.54.1/tokio/process/struct.Command.html#method.kill_on_drop
- https://docs.rs/tokio/1.54.1/tokio/process/struct.Child.html#method.wait
- https://docs.rs/base64/0.23.1/base64/
- https://docs.rs/futures-util/0.3.34/futures_util/future/trait.FutureExt.html#method.catch_unwind (downloaded official source checked for AssertUnwindSafe and boundary panic handling)

Cancellation does not drop the running environment future. It signals the token and joins cleanup before returning. No live inference is needed.

## Milestone 5 OpenAI state

Read the published conversation-state page directly and checked the related reference through Context7:

- https://developers.openai.com/api/docs/guides/conversation-state documents store=true and previous_response_id for chained responses, passing only new items, response retention, and the fact that chained input is still billed.
- https://developers.openai.com/api/docs/guides/text says instructions apply only to the current response and are not inherited through previous_response_id. This adapter sends current instructions and tools each time.
- https://developers.openai.com/api/reference/resources/responses/methods/delete documents DELETE /v1/responses/{response_id} and the deleted=true acknowledgement. The adapter inventories and deletes every response, not only the last pointer.
- https://developers.openai.com/api/docs/guides/your-data distinguishes application state from other retention, including logs, and notes that Zero Data Retention forces store=false. Stateful mode needs an account that permits stored responses.

The existing reqwest 0.13.5 streaming client is retained. No OpenAI SDK or additional inference model is used. Tests use loopback HTTP with a fake credential, never the real key.

## Milestone 4 protocols

Published ACP and MCP specifications were fetched directly and read, along with the downloaded official SDK source/examples. These are protocol/library sources, not another independent build:

- ACP v1 overview, initialization and extension conventions: https://agentclientprotocol.com/protocol/v1/overview and https://agentclientprotocol.com/protocol/v1/initialization
- Session create/load/replay/resume/close and MCP server scope: https://agentclientprotocol.com/protocol/v1/session-setup
- Model/thinking configuration selectors: https://agentclientprotocol.com/protocol/v1/session-config-options
- Permission request options and cancelled outcomes: https://agentclientprotocol.com/protocol/v1/tool-calls
- Explicit elicitation mode capabilities and the prohibition on secrets in forms: https://agentclientprotocol.com/protocol/v1/elicitation
- Local launch-user trust and untrusted clientInfo: https://agentclientprotocol.com/protocol/v1/security
- Official ACP Rust SDK, pinned to 5.3.0: https://github.com/agentclientprotocol/rust-sdk and https://docs.rs/agent-client-protocol/5.3.0
- SDK callback ordering and connection-owned task spawning, verified in jsonrpc.rs: https://docs.rs/agent-client-protocol/5.3.0/agent_client_protocol/struct.ConnectionTo.html#method.spawn
- Current MCP transports and tool definitions: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports and https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- Legacy handshake/transport compatibility and tool annotations: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports and https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- Official MCP Rust SDK, pinned to rmcp 3.10.0: https://github.com/modelcontextprotocol/rust-sdk and https://docs.rs/rmcp/3.10.0
- SDK child shutdown/termination/reaping, checked in transport/child_process.rs: https://docs.rs/rmcp/3.10.0/rmcp/transport/child_process/struct.TokioChildProcess.html#method.graceful_shutdown

The official ACP client drives all ACP acceptance tests and the live demonstration. MCP HTTP fixtures use the official SDK server. A deliberately small Python stdio fixture tests the legacy wire path and cleanup without an external service.

## ACP shared binding round

The authoritative wire source for this round is the supplied `docs/bindings/acp.md`, version `modular-agent-acp/1`, plus its unchanged official-client conformance kit in `conformance/acp/run.mjs`. The history HTTP binding was read for context, not implemented. No independent build was inspected.

The existing official Rust ACP SDK remains pinned to 5.3.0, with schema 1.18.0. Its published source was checked for InitializeResponse metadata placement, select options and PromptResponse/StopReason semantics: https://docs.rs/agent-client-protocol-schema/1.18.0/agent_client_protocol_schema/v1/struct.InitializeResponse.html and https://docs.rs/agent-client-protocol-schema/1.18.0/agent_client_protocol_schema/v1/enum.StopReason.html . In particular, ACP's documented refusal context semantics differ from the binding's general failed-to-refusal mapping; GAPS.md B-06 records that conflict. The kit pins the official JavaScript SDK to 2.7.0; package-lock.json records its dependency tree.

## Earlier milestones

Milestone 3 re-read the official OpenAI function-calling guide through Context7 for strict mode: every object needs additionalProperties=false, and all fields must be required, with optional fields nullable. The adapter translates optional definitions to strict schemas and removes optional nulls on the standard side, while retaining the raw response. Source: https://developers.openai.com/api/docs/guides/function-calling#strict-mode

Milestone 3 checked Tokio 1.54.1's downloaded `sync/notify.rs` documentation. Register a pinned Notified with enable before checking the ledger, so an answer between the check and await cannot be lost: https://docs.rs/tokio/1.54.1/tokio/sync/futures/struct.Notified.html#method.enable

These sources support library calls, not agent behavior. Agent behavior comes only from docs/ and GLOSSARY.md. No other independent build was read.

Versions are pinned in Cargo.lock. Rust is 1.100.0, Tokio 1.54.1 and reqwest 0.13.5.

- OpenAI Responses streaming: https://developers.openai.com/api/docs/guides/streaming-responses
- Function definitions, calls and results: https://developers.openai.com/api/docs/guides/function-calling
- Stateless encrypted reasoning: https://developers.openai.com/api/docs/guides/reasoning
- OpenAI endpoint used by this build: https://api.openai.com/v1/responses
- Tokio process groups, explicit waits and kill-on-drop caveats: https://docs.rs/tokio/1.54.1/tokio/process/struct.Command.html
- Tokio child waits: https://docs.rs/tokio/1.54.1/tokio/process/struct.Child.html#method.wait
- reqwest bearer authentication and JSON: https://docs.rs/reqwest/0.13.5/reqwest/struct.RequestBuilder.html
- reqwest streaming response: https://docs.rs/reqwest/0.13.5/reqwest/struct.Response.html#method.bytes_stream
- Linux abstract socket addresses: https://doc.rust-lang.org/std/os/linux/net/trait.SocketAddrExt.html
- Linux child subreaper behavior: https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html
- File locking: https://docs.rs/fs2/0.4.3/fs2/trait.FileExt.html
- Concurrent ordered futures, checked in the downloaded source: https://docs.rs/futures-util/0.3.34/futures_util/future/fn.join_all.html

OpenAI, Tokio and reqwest documentation was retrieved through Context7. Tokio process documentation and reqwest API definitions were also checked in the downloaded crate source.

The original stateless mode sends store=false, full input items, encrypted reasoning and function-call results, with no previous_response_id. Milestone 5 adds the separate stateful mode described above. Both retain unknown response items as opaque data and restrict the model to gpt-6-luna, including after middleware.

Milestone 2 uses Linux tracing on a dedicated agent thread, not process groups or a separate supervisor service. The Linux ptrace and parent-death-signal manual pages were retrieved and read for exit-kill, inherited descendant tracing, exec events, per-thread waits and the initial parent-death race.

- Linux ptrace, PTRACE_O_EXITKILL, TRACEFORK/VFORK/CLONE/EXEC: https://man7.org/linux/man-pages/man2/ptrace.2.html
- Initial parent-death signal, including the creating-thread lifetime: https://man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html
- PID-pinned signaling: https://man7.org/linux/man-pages/man2/pidfd_send_signal.2.html

A shell is stopped before arbitrary code runs. Tracing is installed and identity records are synced before it continues. The tracer explicitly reaps all tracked descendants; the kernel kills tracees if the tracer dies. Startup cleanup checks boot identity and process start times, opens a pidfd, checks identity again, and signals only that pinned process. This requires Linux with ptrace and pidfd support. It is not a security sandbox.
