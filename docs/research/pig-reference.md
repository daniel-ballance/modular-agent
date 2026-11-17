# PiG: prior art for plugins in other languages

**Source:** PiG ("Pi in Go"), `github.com/MichaelKinsy/PiG`, commit `7b2669de`, 2026-11-17, cloned read-only to `~/Code/_ref/pig`. Read:
- `docs/extensions.md`, `docs/extension-runtime-cells.md` and `docs/runtime-cell-reload.md`;
- the opening of `docs/extension-sdk-consistency.md`;
- `coding/extension/host/subprocess/protocol.go`, the wire types;
- `test/extension-conformance/`, its layout and scenario table.

PiG is a parity-bound Go port of Pi. Unlike Pi, it hosts extensions written in Go, Rust, Python, Node and Lisp, each as a subprocess over one wire protocol. That is the problem a cross-language plugin binding has to solve, already solved once for Pi's extension API.

## How it works

- **Every extension is a subprocess.** There is no WASM, embedded JavaScript or dynamic Go plugin. Compatible factories in one language may share a process (a "packed cell"). Compatible Go factories may be linked into the host. Both are optimizations that "must be observationally identical" to one extension in one process.
- **The wire is length-prefixed JSON frames, each an envelope with a `type`.**
  - The extension sends `register`, `response`, `call`, `pong` and `request_state`.
  - The host sends `ready`, `request`, `notify`, `cancel`, `call_result`, `shutdown` and `ping`.
- **Registration is the only source of capabilities.** At start the extension sends one `register` message naming what it provides:
  - tools, with schemas, annotations and an execution mode (`sequential` or `parallel`);
  - commands, and handlers as an event name plus a numeric handler id;
  - providers, MCP servers, renderers and flags.

  Unknown fields are refused. The host answers `ready` with the working directory and context. Its identity must match what selected it.
- **The host's requests** name a method (`tool_call`, `event`, `command`, render methods), with `handler_id` for events and `tool_call_id` for tools. A response is a result or a structured error `{ code, message }`.
- **The extension's calls to the host** (`call`) name a host method, such as `sendMessage`, `appendEntry` or `ui.notify`. They carry `parent_request_id`, so the host knows which request a call belongs to, and `origin_tool_call_id`.
- **Cancelling** is `cancel { request_id, reason }`. A heartbeat (`ping`/`pong`) proves the transport is alive. Tools, commands and events have no timeout: the caller's cancellation owns them. `shutdown` carries a reason: quit, reload or disable.
- **Limits:** frames are capped at 128 MB. A result over the cap is replaced by a small `result_too_large` error, so the host never writes a frame the extension can't read. Panics at the boundary become structured errors.
- **History is read only on demand,** in ordered pages of at most 4 MB. It is never pushed to every extension.
- **After a crash,** interrupted callbacks are never replayed. A failing member of a packed process is found by bisecting the group, and isolated.
- **The wire has no independent version.** It moves with PiG, which also ships every SDK.

## How PiG keeps four languages consistent

PiG ports one API, Pi's `ExtensionAPI`, to every language. It writes an SDK per language and enforces parity mechanically.
- A generated consistency matrix lists 225 surfaces across five runtimes. A surface reached by no conformance fixture is a listed hole with an owner, and the generator fails on an unlisted hole.
- A table of behavioural scenarios runs once per SDK through the real host.
- The cost is large. `extension-api-parity.md` alone is about 51,000 words, and `extension-sdk-surface.md` about 35,000.

## What it means for us

| PiG does | For a Modular Agent plugin binding |
|---|---|
| A register handshake is the only source of capabilities | Adopt it. A remote plugin declares the capabilities it provides and the hook points it handles when it connects, which is our `provide` and `on`. |
| Host requests and extension calls are separate, and calls carry `parent_request_id` | Adopt it. The lineage is what lets authority follow work, and lets cancelling reach a call's nested work. |
| History is read on demand, in pages | Adopt it. It removes the gap [ADR 0014](../adr/0014-plugins-in-other-processes.md) left: a remote plugin couldn't read history, because our call for it answers at once. |
| Frame cap, `result_too_large`, heartbeat, shutdown reasons, structured error codes | Adopt them. All are things our TypeScript `plugin-rpc` lacks. |
| No replay of interrupted callbacks | Already our rule for lost parts. |
| Packed and fused must match the subprocess | Already our swap test for plugins in other processes. |
| One canonical API, ported per language, with a parity matrix | Don't copy it. We have four independent builds, each with its own plugin API, which is the point of the experiment. Standardize the messages in [Contracts](../contracts.md#interactions), not any one build's API. A conformance kit plus a scenario table run per build gives parity without a 225-row matrix. |
| No version on the wire | Don't copy it. PiG ships every SDK; we don't. Our binding needs a version, as the ACP and history bindings have. |
| Length-prefixed frames on a socket | Optional. JSON-RPC 2.0 over newline-delimited stdio matches ACP and MCP, which every build already speaks. Adopt the frame cap either way. |

PiG also has a durable package and a Runtime type, but its Runtime is a session and extension host, not our turn-running Runtime. Its extensions can't replace the loop, so it offers no prior art for a Runtime in another language.
