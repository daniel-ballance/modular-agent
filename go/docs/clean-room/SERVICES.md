# Parts as services

Milestone 5 uses four independent processes: history, working environment, model gateway and agent. The agent contains plugins standing for the three services. Either Runtime works without modification. The CLI and ACP can also use the gateway, with `--model-gateway URL --service-token-file PATH`.

## Build and launch

Linux user/PID/mount namespaces and Bubblewrap are required. This build tested Bubblewrap 0.12.0. Install it using the operating system package manager if missing. Sandbox setup fails closed.

```sh
mise exec -- go build -o bin/modular-service ./cmd/modular-service
mise exec -- go build -o bin/modular ./cmd/modular
```

Create a private token file outside the repository, for example with `umask 077; openssl rand -hex 32 > /tmp/modular-service.token`. Never use the Anthropic key as a service token. Launch each command in a separate terminal. Each prints one readiness JSON line with its actual URL and PID. The examples use fixed loopback ports for clarity.

```sh
bin/modular-service --role history --listen 127.0.0.1:8301 \
  --state /tmp/modular-history --token-file /tmp/modular-service.token
bin/modular-service --role environment --listen 127.0.0.1:8302 \
  --project /absolute/project \
  --token-file /tmp/modular-service.token
bin/modular-service --role gateway --listen 127.0.0.1:8303 \
  --token-file /tmp/modular-service.token
bin/modular-service --role agent --listen 127.0.0.1:8304 \
  --project /absolute/project --runtime durable \
  --history-url http://127.0.0.1:8301 \
  --environment-url http://127.0.0.1:8302 \
  --model-gateway http://127.0.0.1:8303 \
  --token-file /tmp/modular-service.token
```

Only the gateway reads `~/.config/modular-agent-experiment/anthropic.key`, at request time. `--key-file PATH` is a gateway-only alternative for deployment and dummy-key tests. Do not put key bytes on a command line. The agent has no model credential capability. It has service authentication tokens, as required to call the other services. `--upstream-token-file` can separate the agent's upstream token from its incoming host token. These are single-operator services, not independent tenant authorization domains.

The gateway alone accepts `--script examples/offline.json` for offline runs. Set the agent's `--model fake` then. Ordinary tests never run inference or read the experiment key.

All standalone listeners require loopback. For separate machines, put authenticated HTTPS proxies in front of them. The agent's Harness/configuration still require the project folder to be locally visible at the same absolute path as in the sandbox; arbitrary remote project mapping is not offered. Clients refuse redirects and non-loopback plaintext HTTP. Tokens are sent in `Authorization: Bearer TOKEN`. The examples below show JSON bodies, not commands that expose tokens in process arguments.

## Agent API

All operations are `POST /v1/agent` with a JSON object. Field names are case-insensitive on input; documented names match Go's JSON output. Success is HTTP 200 and a JSON `Response`. Missing history is 404, authentication failure is 401, and refusals are 409 with `{Error, Kind}`. Malformed or over-32-MiB request bodies are 400 or 413. There is no cross-origin browser policy or cookie authentication.

The configured token authenticates one host actor, recorded as `local-user` of kind `host`. The wire cannot choose an actor, forwarding chain, job provenance or child authority. Project scope is fixed by launch configuration. Process-local plugins are trusted, just as before.

| Op | Other fields | Response field |
| --- | --- | --- |
| `new` | none | `Session` |
| `list` | none | `Sessions` summaries for the launch project |
| `open` | `Session` | `Session`, reopening is harmless if already open |
| `close`, `stop` | `Session` | close cancels jobs; stop only interrupts |
| `input` | `Session`, `Content`, optional `Key`, `When` | `Receipt` |
| `wait` | `Session` | gated `Outcome`, waits until current work settles |
| `cancel` | `Session` | cancellation requested |
| `questions` | `Session` | gated `Questions`, including `Answerable` |
| `answer` | `Session`, `Request`, `Value`, optional `Declined` | accepted or refused |
| `settings` | `Session`, `Settings` | accepted or refused |
| `command` | `Session`, `Command` | gated `Result` |
| `support` | `Session` | `Support` declaration and base support `Result` |
| `withdraw` | `Session`, `Input` receipt ID | returned `Input` |
| `tool` | `Session`, `Call` | gated `ToolResult`, with normal checks, no model |
| `jobs` | `Session` | gated `Jobs` |
| `job_cancel` | `Session`, `Job` | cancellation requested |
| `move` | `Session`, `Position`, optional `Rewind` | moved or refused before changes |
| `fork` | `Session`, optional `Position` | new `Session` |
| `erase` | `Session`, `IDs` of entries | erased or refused |

For example:

```json
{"Op":"new"}
{"Op":"input","Session":"ID","Key":"host-request-1","Content":[{"type":"text","text":"Read fact.txt and answer from it."}]}
{"Op":"questions","Session":"ID"}
{"Op":"answer","Session":"ID","Request":"QUESTION_ID","Value":"allow"}
{"Op":"cancel","Session":"ID"}
```

`When` is `now`, `steer` or `after`. Input keys survive restart and return the original receipt. Changed payloads with the same key do not replace earlier input. Erasing a receipt removes its key, as in the existing binding. Do not automatically retry `new`, settings, tools or commands. Only input has the required cross-restart keyed intake guarantee. A lost answer to a tool call is an unknown outside effect, not permission to run it again.

An event follower counts as an available responder. A mere open session does not. Approval fails closed without a follower. A brief event reconnect does not cancel the turn; the host can still answer an open request after reconnecting. Secret answers are explicitly refused because this agent has no credential destination. Existing model/thinking changes apply to the next turn.

### Following and reconnecting

`POST /v1/agent/events` with `{Session, After}` opens flushed NDJSON. `After` is the last recorded entry ID received, or empty to start at the beginning. An unknown cursor is refused before streaming.

- `{Kind:"ready", Cursor}` starts the stream.
- `{Kind:"entry", Cursor, Entry}` carries each gated recorded entry after the cursor, in append order, including audit entries off the selected branch. Save its cursor only after receiving the entire frame.
- `{Kind:"event", Event}` carries gated live events, including model pieces, command output and questions. These have no replay cursor and can be missed by a slow/disconnected client.
- `{Kind:"heartbeat", Cursor}` keeps the stream alive. Its cursor never advances beyond an entry sent on this connection.

Reconnect with the saved entry cursor. Every later recorded entry is sent, including entries which never produced a `history.added` event. Missed model/tool pieces are not replayed; their complete recorded model/tool entries are. Replay polls the gated snapshot every 25 ms rather than maintaining an unbounded second event log. Live events use a bounded queue; overflow can drop only ephemeral events. Slow writes have a five-second deadline and close that follower. A closing/unauthorized session closes the stream. Erasure changes the original entry to its erasure record without changing its ID, not already delivered output.

The provided short-call client retries transport failures only for caller-declared keyed operations, up to three times with a five-second attempt deadline. Unkeyed operations are not automatically retried. Use event following for long turns, or a caller-owned HTTP client/deadline for a long `wait`. The agent does not cancel detached work when an input acknowledgement or event connection is lost. Use explicit `cancel` or `close`.

## History API

The history role implements [modular-agent-history/1](docs/bindings/history-http.md), not the earlier private `/v1/history` RPC. Use a fresh service state folder for this round. Its files are not the old Go snapshot format.

Every request needs Bearer authentication. Bodies, responses and errors use the binding's lowercase JSON fields. `GET /v1` identifies the binding. The resource paths are:

- `PUT /v1/sessions/{id}`: `{project,created,parentSessionId?,forkedFrom?}`; harmless resends, project conflicts refused.
- `GET /v1/sessions?project=...`: nonempty sessions, newest first; omit project for all.
- `GET /v1/sessions/{id}?after=...`: session metadata and opaque entries in append order; unknown session/entry is 404.
- `POST /v1/sessions/{id}/lease`: `{owner}` returns `{lease,ttlMs}`. Same live owner gets the same token; another owner gets `409 held`.
- `POST /v1/sessions/{id}/lease/{lease}/renew`: returns `{ttlMs}`; expired/released tokens get `409 lost`.
- `DELETE /v1/sessions/{id}/lease/{lease}`: harmless repeated release.
- `POST /v1/sessions/{id}/entries`: `{lease,entries}` returns `{kept}`. Atomic append, equal-ID/content resends skipped, different content gets `409 conflict`. JSON key order is irrelevant.
- `POST /v1/sessions/{id}/erase`: `{entryIds,lease?}`. Another current lease refuses erasure with `409 held`. Tombstones keep only id, parentId, original kind and erased:true.

Default TTL is 3000 ms. The client chooses one owner per process and renews every quarter TTL. A renewal failure permanently disables writes on that handle, without reacquiring. Restart invalidates tokens, not kept data. Every transport request is retry-safe and retried up to three times after a lost answer; entry IDs supply idempotency, not a private response cache. The service atomically syncs replacements and removes stale crash-left temporary files. It does not interpret entry payloads or follow copies.

The Go agent stores separate opaque metadata checkpoints without duplicating history content. It computes copy closure and lists all entries to erase. Cross-session erasure is preflighted but cannot be transactional through this per-session binding. Unused new IDs are created/leased remotely only on first save. Another language's agent can use the service with its own opaque entries. Swapping the service does not require another language to decode Go-private session contents.

To use any compatible history service from the terminal or ACP agent:

```sh
bin/modular --mode acp --project /absolute/project \
  --history-url http://127.0.0.1:8301 \
  --history-token-file /tmp/history.token \
  --model-gateway http://127.0.0.1:8303 \
  --service-token-file /tmp/gateway.token
```

`--history-token-file` defaults to `--service-token-file`. Only the gateway has model credentials. For a fully offline launch, use `MODULAR_AGENT_CONFORMANCE=1` instead of gateway flags, or use an offline script. For an HTTP-served agent, the existing `--history-url` and `--upstream-token-file` select the service and outgoing token. The history-only service command at the top of this document accepts any requested loopback port and a token file, without a model or gateway.

## Working environment API

`POST /v1/environment/connect` with `{Owner}` opens a persistent authenticated NDJSON lifetime stream. It creates a private Bubblewrap worker and reports ready only after a command succeeds. The connection must stay open while its agent uses this service. It is not automatically reconnected after loss.

`POST /v1/environment/read`, `/write` and `/bash` take `{Owner, Project, Name, Data, Command}` as applicable. Files return JSON with base64 `Data`. Bash flushes `{Kind:"ready"}`, `{Kind:"output", Text}` and a final `{Kind:"done", Text, Error}`. The command request's disconnect/cancellation stops that command's descendants. Closing the lifetime connection stops every command, including earlier background shells and `setsid` descendants. Agent SIGKILL closes the connection; service death closes worker pipes and tears down its namespace. No unsafe command/write retries are automatic.

Only the root tree is writable host storage. File tools reject outside absolute paths, `..` escapes and outside symlinks. Shells also see read-only `/usr`, the worker executable and private virtual filesystems, but no host credentials, home, `/etc`, inherited environment or network. The folder must not contain operator-mounted sensitive filesystems, host device nodes or sensitive hard-link aliases. Resource limits and protection against kernel exploits are outside this experiment. Background commands still return from bash and live until cancellation or agent lifetime ends. Normal local environments remain available in earlier compositions.

## Model gateway API

`POST /v1/model/catalog` returns the normal Provider catalog, including state/tool declarations. `POST /v1/model/generate` takes `{Model, Request}` and streams ready, part, done or error NDJSON. The full response retains tool calls, opaque parts, usage and stop reason. Model error kinds survive the wire. Transport interruption is unknown, never an automatic vendor retry. Runtime recovery still obeys Provider declarations. The real gateway catalog contains only `claude-haiku-5-5`.
