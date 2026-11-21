# `@modular-agent/core`: the TypeScript SDK

The TypeScript SDK implements the [SDK specification](../../../docs/sdk/README.md) over the TypeScript build with [edition 4](../../../docs/adr/0027-sdk-0-1-and-edition-4.md) and [ADR 0029](../../../docs/adr/0029-sdk-decisions-after-four-builds.md). An app uses `Agent` and `Session`, not a Harness. Plugins register parts once and get contexts for individual calls.

```ts
import { testAgent } from "@modular-agent/core/testing";

const agent = await testAgent({ script: [{ text: "Hello." }] });
try {
  const session = await agent.session();
  console.log((await session.prompt("Say hello.")).text);
} finally {
  await agent.close();
}
```

## What is checked

Run from `typescript/` with Node 26. Install kit dependencies with `npm ci --prefix ../conformance/acp` and `npm ci --prefix ../conformance/tools`.

```sh
npm ci
npm run build
MODULAR_AGENT_SDK_REQUIRE=all npm test
MODULAR_AGENT_SDK_REQUIRE=all MA_REMOTE=provider-pi-ai,runtime-transient,tools-files,env-local npm test
(cd sidecars/claude && npm ci && npm test)
```

- **TypeScript suites:** Normal and `MA_REMOTE` each passed **400/400** offline tests; both compiled and skipped the two live Provider tests. `npm ci`, `tsc -b` and `git diff --check` passed. The workspace has no separate lint or formatter script. The Claude sidecar passed **44/44**.
- **Reference and kits:** TypeScript `ma` passed **18/18** reference checks and the ACP kit with crash, probe and job checks: **188/188** on stdio and **193/193** directly on WebSocket. The plugin kit passed **146/146** on stdio and **153/153** directly on WebSocket, including separate transient and durable Runtime services. No bridge was used. The suite also passed ACP on the base CLI (116/116), with HTTP history (117/117), with fixture plugins served (203/203), and with the served durable Runtime (140/140). The history kit passed 39/39 for each of the base, SDK file, test-only memory, upstream HTTP relay and custom lease-aware store placements.
- **SDK coverage:** The offline guide tests cover approvals, Providers, hook placements, process plugins, ACP stdio, and history handoff. Four tests kill a child process at specific secret-answer boundaries and reopen without leaking the value. Public API tests cover raw tool history and gated events in process, over stdio and over WebSocket, context lifetime and credential scope, and typed errors. The live Provider file compiles and skips both cases by default. Run live checks by hand only with `MODULAR_AGENT_LIVE=1`; each Provider test also requires its own API key. No live requests were made for this change.
- **Shared scenarios:** **153/153** with `MODULAR_AGENT_SDK_REQUIRE=all`: 17 each in-process, over stdio from each of the four SDKs, and over WebSocket from each of the four. The runner starts explicit history fixtures before checking composition failures. Crash scenarios kill and reap the agent and fixture groups before reopening.

Build all fixture programs and run the TypeScript matrix from the repo root:

```sh
(cd rust && mise exec -- cargo build -p sdk-scenarios --bin modular-agent-fixtures)
(cd go && mise exec -- go build -o .bin/modular-agent-fixtures ./modular/cmd/fixtures)
(cd python && uv sync --python 3.13)
(cd typescript && npm ci && npm run build)
(cd typescript && MODULAR_AGENT_SDK_REQUIRE=all node --test packages/fixtures/dist/test/shared.test.js)
node conformance/reference/run.mjs --agent typescript
agent="$PWD/typescript/packages/ma/dist/src/main.js"
(cd conformance/acp && MODULAR_AGENT_CONFORMANCE=1 node run.mjs --crash-checks --probe-checks --job-checks -- node "$agent" --acp)
scripts/websocket-kits.sh typescript
```

The SDK adds Ajv 8 (its [2020-12 entry point](https://ajv.js.org/json-schema.html#draft-2020-12)) to validate plain schemas and the JSON Schema exported by validators. The base already uses `json-schema-to-ts`, used here for plain-schema inference, and Zod 4, used by fixtures and tests. The OpenAI and Anthropic packages use the base's Pi AI adapter, not another vendor SDK.

## Built so far

| Milestone | State |
|---|---|
| 1. Agent composition | Checks the effective Runtime and history store. Ephemeral persistent history raises `invalid_composition` naming `kept`. Ephemeral local command bookkeeping goes in agent-owned scratch; recoverable bookkeeping needs `dataDir`. Nonempty process and service lists enable hosting; empty lists do not. `credentials` defaults to read-only environment credentials; `fileCredentials(path)` stages secret answers in a private file and publishes only the stored name after activation and commit. |
| 2. Sessions | Create, reopen, inspect `lastTurn()`, prompt or send Content, follow typed events, call tools directly, fork, move, erase and close. Actor views can list, withdraw and release proposals. Bounded streams fail with `lost` and the last delivered kept entry cursor (or null); replay starts strictly after the cursor. Structured results are checked at `turn.result`; refusal records feedback before retry. |
| 3. Questions and authority | `session.questions()` lists open questions and `session.answer()` settles them by ID. `session.onQuestion()` overrides the agent handler. A decline is not the text `declined`. The local `user` is present with a handler; approvals otherwise refuse if nobody else can answer. Opt into `severalActors`, `sessionLimits` and `tenants` to use actor views, join and leave, proposals, ceilings and tenant selection. |
| 4. Tools | Standard Schema JSON Schema export and plain JSON Schema. The Harness checks `parameters` before dispatch, and `returns` after `tool.after`; `hints` are nested on the wire. Local and served tools share result wording. `context.history(cursor)` reads raw pages and `context.emit(type, data)` sends custom events through the output gate in both placements. `context.credential(name)` is in-process only. `PromptResult.toolResults()` lists only the model's calls. |
| 5. Errors | `AgentError` with a string-union code and structured data. Known history, state and authority failures have stable codes, including `held` with `data.retryAfterMs` and `turn_limit` with `data.limit`. Unclassified plugin failures use `internal`. |
| 6. Plugins | Registrar adapters for Runtime, environment, history, credentials, configuration and Interfaces. `defineToolSource` supplies `changed()`. Job owners register cancel and resume. Typed core hooks include local pending gates and Provider pieces; plugin-defined points use `defineHook`, `onHook` and the handle's `call()`. Commands have a scoped environment, can ask questions in process, and can declare `usesModel` with `inProcessOnly` to send auxiliary requests through the session Provider. Those attempts are recorded and metered under a command step, without a turn or tool dispatch. |
| 7. Serve | Plugin `/1` on stdio or authenticated `ws:`/`wss:`. Port `0` returns the bound URL. Registration runs once per connection; `serve(() => plugin, options)` creates fresh per-connection state. `close()` stops the instances. Explicit in-process-only registrations are rejected. State is under `<tokenFile>.state` by default (`stateDir` overrides it), namespaced by token and host home. |
| 8. Remote plugins | Loads in-process, explicit process, explicit service, then `MODULAR_AGENT_PLUGINS` entries in array order. Invalid startup fails composition. Connection loss settles a dispatched tool as `outcomeUnknown`. `pingIntervalMs` and `controlTimeoutMs` default to 30,000 and 5,000 ms. |
| 9. Testing | Scripted Provider driven by the final request, test agent, `answers().assertDone()`, memory environment, `overWire`, and seven shared fixtures, including `note`. `restart(agent)` interrupts an in-process agent without recording graceful settlement or running session or plugin shutdown hooks, releases writer leases, and rebuilds over the same store. The shared suite kills a real process group. |
| 10. Guides | Offline equivalents of the TypeScript examples in guides 01–09 are checked. Guide 03's production example uses a deployed Python program; its offline test loads the TypeScript fixture over the same binding. |
| 11. Providers | Core interface and `@modular-agent/openai`, `@modular-agent/anthropic`. API-key catalogs and reasoning payloads come from the shipped byte-identical model table; the loopback tests exercise each mapping. `models` can enroll an unlisted model without levels. Local catalog changes notify subscribers; served catalogs refresh with `provider/models`, not a private notification. Unknown models fail before admission; admitted failures become typed AssistantMessages. `context.credential()` reads the Provider's own credential in either placement. Passing a name is in-process only. |
| 12. Nested calls | `context.tools.list()` and `.call()` work in process and over `/1`. The Harness supports **eight child levels** under a top-level invocation; deeper requests settle refused. The Harness authorizes, commits and settles children, including on cancellation or recovery. `modelTools` narrows only the model offer. ACP declares `nestedToolCalls` and identifies the parent on the child's first update. |
| 13. Declaration and ACP | Declaration reflects the store, environment, Runtime and host, including queue policies and output holding. `serveAcp` supports project composition, new-session settings and trusted MCP configuration. WebSocket listeners answer `$/ping` before and after initialization, apply the control deadline, and use exact project scopes and per-token tenant and rights ceilings without rewriting grants. Client-supplied MCP servers default to stdio only. Embedded `openSession` can wait for idle; ACP only installs recovery before returning. |
| 14. History over HTTP | `serveHistory` serves `fileHistory(dir)` or a custom `HistoryServiceStore`, relays a trusted `httpHistory(url, tokenFile)`, and allows `memoryHistory()` only with `{ testOnly: true }`. Default kept/durable data directories still use base JSONL for compatibility. |

### Serving a custom history store

Pass a `HistoryServiceStore` to `serveHistory(store, { address, tokenFile })`. It implements the [history binding](../../../docs/bindings/history-http.md) operations and owns lease generations, expiry, restart exclusion, durable atomic mutations, paging and tombstones. A writer-oriented Registrar store does not by itself provide those guarantees. The adapter handles authentication, request validation and response encoding.

Use `encodeHistoryJson`, `parseHistoryJson` and `equalHistoryJson` to preserve opaque fields and exact numeric values, and `historyTombstone` for the standard erasure projection. Throw `HistoryServiceError` for a confirmed refusal; include the remaining `retryAfterMs` for `held`. If a mutation's commit is uncertain, throw another error so the adapter closes the request without an acknowledgement.

## Findings

- **Part replacement selectors.** In [API: Plugins](../../../docs/sdk/api.md#plugins), replace the `replaces` description with: “Items of its own that replace an earlier plugin's: `runtime`, `working-environment`, `history-store`, `credential-store`, `configuration`, `provider:<id>`, `tool:<name>` or `command:<name>`. The last three include the registered name. Interfaces are additive.” The current list omits the store and configuration singletons even though a default is installed before explicit plugins.
- **Custom history adapter and leases.** Replace the `History store` operations cell in [API: The other parts](../../../docs/sdk/api.md#the-other-parts) with: “A store used by the agent creates a session header, opens it for writing, appends atomically, loads its header and entries, lists, erases where supported, and closes. A store that acquires a time-limited lease must renew it and signal loss until it closes. A custom store passed to `serveHistory` implements the history binding's create, acquire, renew, release, append, read, list and erase operations, including their leases and opaque JSON values. A refused lease carries `held` with `retryAfterMs`; an unequal entry with a kept id raises `conflict`.” The current row conflates the agent's writer handle with a service's explicit lease operations.
- **Proposal methods.** In [API: Sessions and turns](../../../docs/sdk/api.md#sessions-and-turns), add: “With `severalActors`, `proposals()` lists visible proposals. `release(inputId, timing?)` takes an open proposal with `now`, `steer` or `after` (`now` by default); `withdraw(inputId)` withdraws it. Release requires `input`; withdrawal requires the proposer or `input`. An already settled proposal raises `conflict`.” The core and ACP specify these dispositions but the SDK operation table names neither method.
- **Model output events.** In [API: Events](../../../docs/sdk/api.md#events), replace the Model output row with: “`text`, `reasoning`, `toolInput`. A plugin may emit audio as a namespaced extension until shared data defines a standard audio payload.” The linked binding does not define a standard audio event.
- **Hosted command paths.** Replace the `command/run` params in the [plugin binding](../../../docs/bindings/plugin.md#the-host-asks-a-command) with: “`{ name: string, args: string, sessionId: Id, project?: string, actorId: Id }`. A host supplying a command's `host/env/*` callbacks sends the session's canonical `project`. If absent, use the initialization project; do not attempt an environment call for another project.” Currently, the command request lacks a project even though `host/env/*` requires `cwd`.

## Remaining

- Served command environment calls use the composition's initialization project. A command in a session whose project differs cannot discover that path on `/1`; this needs the binding change described above.
