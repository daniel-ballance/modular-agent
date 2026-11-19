# ACP hosts, MCP tools and configured plugins

## Launching an ACP agent

Build with `mise exec -- go build -o bin/modular ./cmd/modular`. For real inference, first start the model gateway as described in [SERVICES.md](SERVICES.md), then have the host launch:

```sh
bin/modular --mode acp --project /absolute/project/path --runtime durable \
  --model-gateway http://127.0.0.1:8303 --service-token-file /tmp/modular-service.token
```

The Interface follows [modular-agent-acp/1](docs/bindings/acp.md), over ACP v1 newline-delimited JSON-RPC on stdin/stdout. Diagnostics go only to stderr. The maintained Caelis Labs Go SDK supplies the transport; see [protocol sources](PROTOCOL_SOURCES.md).

One process has one fixed plugin composition and canonical project root. New/load/resume must use that root. Launch another process for another root. The declaration's extra `projectRoot` field states this limit. The connection acts for `{id:"local-user",kind:"host"}`; wire input cannot select an actor or widen rights. New/load/resume must first attach a session. Subagent sessions are not exposed as independently owned ACP sessions.

Supported standard methods: initialize; session new/load/resume/list/close/prompt/cancel/set_config_option. Configuration selectors are:

- `model`: `anthropic/claude-haiku-5-5` for the real gateway, or the offline Provider's namespaced models.
- `thinking`: the selected model's supported levels.
- `approval`: `off`, `ask`, `all`, `never`.

Model, thinking and approval changes apply from the next turn. A running or recovered turn retains its recorded selection and approval policy. Other settings still require an idle turn.

Text and resource links are accepted. Rich prompt types, client system prompts and additional roots are refused. Tools use the agent's working environment, not client filesystem/terminal callbacks. Permissions offer exactly Allow/allow_once and Refuse/reject_once. Only a selected `allow` permits the call. Forms have a single `answer` field and require client form support. Without forms, or for questions left open past their turn, use requests/answer. Invalid form replies refuse safely. Secrets are never collected in forms.

Load replays the gated branch before answering; resume does not replay. EOF interrupts for Runtime recovery. Explicit close cancels and waits for session work/jobs, releases history ownership and closes its private MCP connections. Cancelling a turn leaves jobs running.

## Host extensions

Initialization returns `_meta["modular-agent"]` containing binding, the complete declaration, extensions (unprefixed names) and actor. New/load/resume return the session declaration under the same key.

A keyed standard prompt uses:

```json
{"sessionId":"SESSION_ID","prompt":[{"type":"text","text":"Read the instructions."}],"_meta":{"modular-agent":{"key":"input-123"}}}
```

The response's metadata contains `inputId`, `duplicate`, `outcome.kind`, `openToolCalls`, and on cancellation `handedBack`. A resend returns the original input/turn without another admission or streamed message. Failed turns return `refusal` with an error; output/step limits map to `max_tokens`/`max_turn_requests`. Commands cannot use input keys.

Every request below carries `sessionId`, and every method uses the prefix `_modular-agent/`:

| Name | Other fields | Result |
|---|---|---|
| history | optional `after`, `all` | `{entries}`, normalized binding entries; branch by default |
| input | `content`: string or ACP blocks; `when`: now/steer/after; optional `key` | `{inputId,taken,duplicate?}`, without waiting |
| requests | none | `{requests}`, currently answerable questions |
| answer | `requestId`, optional `value` (string), `declined` | `{accepted,reason?}` |
| fork | `entryId` | `{sessionId}`, new session attached to this connection |
| move | `entryId` | `{}` |
| erase | `entryIds` | `{erased,pending,outOfReach}` |
| jobs | none | `{jobs:[{id,kind,state}]}` |
| cancel-job | `jobId` | `{}` |
| support | none | active declaration |
| command | `command`, such as `/usage` | gated command result |
| withdraw | `inputId` | withdrawn native input, or refusal |
| call_tool | `call:{name,input}` | checked native UI tool result, without a model |

History has milliseconds, parentId (including null), standard entry kinds and messages. A turnEnd has `data.outcome`. The cursor belongs to the selected view; an unknown/off-branch cursor is `-32602`, unless `all:true` includes it. All history and request output passes the gate. Erasure follows controlled copies; already delivered output and working-environment effects are reported out of reach.

Concurrent standard prompts are refused. Use input to steer or queue instead. Input, answers and UI calls cannot forge actor, provenance, job, replay-call or forwarding identities. For optional gated live native events, initialize with `clientCapabilities._meta["modular-agent"]={events:true}`; the agent emits `_modular-agent/event`. Reconnect using load/resume and history, deduplicating recorded IDs.

## Offline conformance mode

```sh
cd conformance/acp && npm ci
node run.mjs -- /absolute/path/to/bin/modular --mode acp
```

The kit supplies `MODULAR_AGENT_CONFORMANCE=1` and a fresh `MODULAR_AGENT_DATA_DIR`. Echo inference uses no network, gateway or credential, reports zero usage, and supports the binding's tool syntax with the ordinary read/bash tools. The Go suite runs the unchanged kit against a race-instrumented binary with both Runtimes. Result: **43/43 checks** for each.

When DATA_DIR is set, it overrides --state/--settings: history and command cleanup records go under DATA_DIR/history, global settings under DATA_DIR/settings.json, and project settings under DATA_DIR/projects/SHA256(canonical-project)/.modular-agent/settings.json. Trust remains invocation-only. Project instructions and tool effects remain in the project, not in the agent's state directory. An explicitly selected remote history service owns its own state.

## Configured plugins and trust

Global settings load plugins automatically. Project settings can supply session defaults without trust, but their plugins and options for global plugins remain inactive until explicitly enabled:

```sh
bin/modular --project /absolute/project/path --trust-project --mode acp
```

The same flag works in terminal modes. Trust lasts only for this invocation and exact canonical root. It is not inferred from repository files or accepted over ACP. For `--session`, a trust grant requires an explicitly matching `--project`.

Example global or trusted project settings:

```json
{
  "model": "claude-haiku-5-5",
  "thinking": "off",
  "plugins": [
    {
      "name": "mcp",
      "options": {
        "servers": [
          {"name": "files", "command": "/absolute/path/to/server", "args": ["--stdio"]},
          {"name": "catalog", "url": "https://example.invalid/mcp"}
        ]
      }
    },
    {"name": "guardrail", "options": {"secrets": ["example-sensitive-value"]}}
  ]
}
```

The example URL is a placeholder, not a built-in endpoint. HTTP servers may specify a `headers` map; stdio servers may specify an `env` map. Do not commit real credentials. These options are not saved in session history. Redirects are refused, so headers are not forwarded to a redirected host.

Plugins are named compiled-in factories. The default catalog contains `mcp` and `guardrail`. Embedders can add factories with `vanilla.Options.Factories`. There is no source downloading, package installation or Go shared-object ABI. Plugins run with the agent's full permissions. Trust is not a sandbox.

Global entries retain first-appearance order. Trusted project options merge over global options by top-level key, without recursively merging nested objects or arrays. A trusted project can add a plugin. Duplicates within a file, unknown names and malformed active options fail startup. Untrusted executable plugin data is not decoded at all.

## MCP visibility and hints

Configured MCP servers serve every session in the process. Servers supplied by an ACP client belong only to that session and must be supplied again on load/resume. Their names cannot shadow configured servers. Attachment is all-or-nothing.

The official MCP Go SDK handles subprocess stdio and Streamable HTTP. Both JSON and SSE response framing work; legacy SSE transport is not offered. Tool names are `mcp_SERVER__TOOL`, with no `__` in the server name, and must fit this Provider's 64-character identifier space.

Annotations map to read-only, destructive, safe-repeat and external hints. Read-only or idempotent means safe repeat; missing destructive and open-world hints default true. MCP has no standard parallel hint, so these tools run serially. These are trusted server hints, not proof of safety. Tool-list changes refresh the source for subsequent turns. Rich result content, structured output, full metadata and output schemas are preserved in the record. Transport loss yields an explicit unknown outcome, not a false claim of failure before execution.

No MCP sampling, remote elicitation or OAuth flow is offered. Stdio servers are trusted plugin programs, not working-environment commands. The direct process dies with the agent; orderly close also terminates its process group and waits for it. This is not a filesystem or hostile-plugin sandbox.
