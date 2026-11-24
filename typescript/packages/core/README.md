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

The ADR 0035 run passed 647 workspace tests in each of the default and remote-parts configurations; five live tests were skipped in each. The AG-UI kit passed 48/48, including 14 host-read cases. Additional SDK tests kill a real writer on each side of recording the released class and between the first and second decisions of a batch. The named-caller kit passed 29/29. Run it from the repository root with `node conformance/plugin/run.mjs --named-callers -- "$(command -v node)" "$PWD/typescript/scripts/named-callers.mjs"` after building the workspace.

Project-notes passed both cases. Ops-desk passed five of six; `host-restart` failed with `ECONNREFUSED`. A lifecycle-only check reproduced the race without any model request: send `stop` and then `start` for triage on the station socket before stop completes. The station returns the old origin for start; after stop completes, that origin refuses connections. The station needs to serialize start and stop for each agent. This is in `demos/ops-desk/host/station.ts`, not the SDK. No timeout or retry was added.

The covered-approval run passed 640 workspace tests in each of the default and remote-parts configurations. Five live tests were skipped in each. Both demos passed without a model service. The [ma results](../ma/README.md#what-is-checked) give the binding counts and fixture limits.

The [waiting approval tests](test/waiting-approval.test.ts) use a scripted Provider, a file counter and a clock controlled by the test. They run with the Runtime embedded and served. They check the default, the maximum, the bound view, refusal after changes to input, registration or rights, expiry on either side of an allow, erasure, and refusal to fork or move. Twelve process-group kills cover three cutoffs (ended origin, committed allow, counter effect) in both placements with kept and durable history. Reopen never increments the counter twice. The listener tests check fresh ACP polling and AG-UI presence opened after the turn.

The ADR 0034 shared runner supports `poll`, `decide`, `clock`, `barrier`, `change` and `stop`. With the incoming shared definitions, all 28 scenarios passed with TypeScript tools embedded, on stdio and on WebSocket (84 runs). The extended AG-UI kit passed 34/34, including a race against ACP and mixed waits in both settlement orders. The in-process telemetry check passed 16/16 with the extended kit, including the eight waiting cases with and without export.

The Interface tool tests use the public SDK with embedded and served Runtimes. They check exact offers, denied approval, output withholding, delayed release, reconnect, racing reports, early reports, expiry before and after turn end, checked results, cancellation, erasure, branch and close guards, and metadata-only spans. The crash tests kill the agent process group with `SIGKILL` before or after the originating turn ends and reopen kept or durable history. No Runtime executes the same handoff twice. The existing shared-scenario format has no operations for advertising or reporting through an authenticated executor route, so these tests are TypeScript-only.

With waiting approvals, the full suite passed 540 tests with 5 live tests skipped in each of the default and `MA_REMOTE` configurations. The Claude sidecar passed 51 tests with 1 skipped. `ma` passed the reference suite before it grew to 28 checks and 190/190 stdio ACP checks. The WebSocket kits passed 153/153 plugin checks, 14/14 separate-listener checks and 195/195 ACP checks. The AG-UI kit at the branch base passed 26/26. The ops-desk demo passed all six cases. The project-notes demo passed its scripted and crash-and-reopen cases.

The telemetry tests use an OpenTelemetry in-memory span exporter and metric reader. They check the span tree, overlapping nested calls, question and refusal events, one measurement per inference, metadata-only export, both plugin handshake omissions, exporter failure, and a `SIGKILL` over durable history. The crash check matches the resumed trace, parent, link and checkpoint against the saved segment. A turn also completes with no registered OpenTelemetry SDK.

The subscription tests use loopback fixtures and the public SDK. They cover both ChatGPT sign-ins and the Grok device sign-in, including polling backoff and rejection of a non-HTTPS address. The request tests run in process and over the plugin binding. They check the shared catalog, headers, output limits, encrypted reasoning replay, refresh under the lock and a refused refresh. The `ma` tests cover both old ids at each accepted entry point. See [the `ma` check results](../ma/README.md#what-is-checked). No live checks ran.

ADR 0030 checks include SDK calls, fixture barriers, and separate processes. The current opt-in results are:

| Kit option | ma stdio | Base stdio | ma WebSocket | Base WebSocket |
|---|---:|---:|---:|---:|
| ACP `--isolation-checks` | 15/15 | 16/17 | 17/17 | 18/19 |
| ACP `--capacity-checks` | 28/28 | 28/28 | 28/28 | 28/28 |
| ACP `--erasure-checks` (shared history) | 18/18 | 18/18 | 18/18 | 18/18 |

The history deployment profile passed **42/42**. The TypeScript conformance plugin's multi-host profile passed **7/7**. History and plugin profiles exercise the services, not either ACP launcher. Each of Rust, TypeScript, Go and Python passed **146/146** stdio and **153/153** WebSocket plugin checks after the process-lifetime fix. The Rust WebSocket script then reported an unrelated ACP catalog refresh failure (192/193); the other three passed that ACP run (193/193).

Earlier ADR 0030 check runs: The SDK tests race the last tenant slot, settle a rejected call list with its usage intact, reopen with a lower count limit, check configured representation over ACP, and reopen a fork of a fork whose erasure was pending. They also check loss of the registry and refusal without disclosure. The stdio ACP kit with crash, probe, job, isolation and capacity checks passed **231/231**. The WebSocket ACP isolation and capacity profile passed **141/141**. The HTTP erasure profile passed **106/106**, including withheld replies after bookkeeping and tombstone commits. The history kit against two services passed **42/42**. The reference checks passed **23/23**. The WebSocket kits passed **153/153** for plugins and **193/193** for ACP. The Claude sidecar passed **44/44**.

Run from `typescript/` with Node 26. Install kit dependencies with `npm ci --prefix ../conformance/acp`, `npm ci --prefix ../conformance/tools` and `npm ci --prefix ../conformance/telemetry`.

```sh
npm ci
npm run build
MODULAR_AGENT_SDK_REQUIRE=all npm test
MODULAR_AGENT_SDK_REQUIRE=all MA_REMOTE=provider-pi-ai,runtime-transient,tools-files,env-local npm test
npm test --workspace=@modular-agent/claude
```

An earlier TypeScript-only run used Node 26.13.1 on Apple silicon macOS 27.2 and on Linux. Both workspaces include the base CLI, SDK and `ma`, and run 51 shared scenarios across embedded, TypeScript stdio and TypeScript WebSocket placements. The other SDK fixtures were not built for this run.

| Check | macOS | Linux |
|---|---:|---:|
| `npm test` | 346 passed, 6 skipped | 351 passed, 2 skipped |
| `MA_REMOTE` suite | 346 passed, 6 skipped | 351 passed, 2 skipped |
| Claude sidecar | 44/44 | 44/44 |
| `ma` reference | 23/23 | 23/23 |
| `ma` stdio ACP with crash, probe and job checks | 188/188 | 188/188 |

The two API-key and three subscription live tests are disabled by default. macOS also skips four tests that read Linux `/proc`: two check cleanup after watcher or agent death, and two find the Monty worker PID. macOS tests still check process-group cleanup and declare no safe repeat for interrupted local commands. Earlier full shared-matrix runs passed **446/446** offline tests in both workspace configurations. The workspace has no separate lint or formatter script.
- **Base kits:** The stdio runs cover local and HTTP history, an external Provider and tool source, and a served durable Runtime. The history kit also exercises an SDK file store, test-only memory, a relay, and a custom lease-aware store.
- **SDK coverage:** The offline guide tests cover approvals, Providers, hook placements, process plugins, ACP stdio, and history handoff. Four tests kill a child process at specific secret-answer boundaries and reopen without leaking the value. Public API tests cover raw tool history and gated events in process, over stdio and over WebSocket, context lifetime and credential scope, and typed errors. The live Provider file compiles and skips both cases by default. Run live checks by hand only with `MODULAR_AGENT_LIVE=1`; each Provider test also requires its own API key. No live requests were made for this change.
- **Same-connection callbacks:** The Go job-progress deadlock did not reproduce. The host registers notifications in arrival order without waiting for gated delivery. Public SDK tests over stdio and WebSocket check that the job owner's gate sees and redacts two ordered image-bearing progress events and that an `events()` follower receives both. Tests also cover tool progress, environment and nested tool callbacks, a served Runtime calling its own Provider, tools and hooks, model pieces, scoped and unscoped catalog changes, and custom events. A WebSocket test covers gated diagnostics. An output hook can read raw history under its live request but cannot use that scope to emit more output.
- **Deferred session setup:** File history and a custom Registrar writer previously persisted setup at session creation. The Harness now keeps setup in memory and appends it with the first admitted input. Public SDK tests cover file, HTTP and Registrar history with local and served Runtimes: no record after an unused close or a process kill, original setup before the first receipt, and immediate fork publication. The HTTP and Registrar tests check both initial append batches on their respective boundaries. Tests also drive `ma` over ACP with local and HTTP history: `session/new` leaves no record until a prompt is admitted, and closing an unused session leaves nothing to list.
- **Writer interruption:** Public API tests inject a store append failure and revoke a lease during a running call and while idle. They check live-only delivery without another write, `lost` for waiting prompts and recovery on reopen, including two simultaneous ACP followers. The HTTP test checks that the interruption has no SSE cursor and ends the stream without replaying on reconnect.
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
| 2. Sessions | Create, reopen, inspect `lastTurn()`, prompt or send Content, follow typed events, call tools directly, fork, move, erase and close. Actor views can list and withdraw proposals or release them with a timing or `{ declined: true }`; a second settlement raises `conflict`. Bounded streams fail with `lost` and the last delivered kept entry cursor (or null); replay starts strictly after the cursor. A failed commit or lost writer cancels running work and emits live-only `sessionInterrupted` to followers; waiting prompts fail with `lost`. Reopen to recover from the last committed state. Structured results are checked at `turn.result`; refusal records feedback before retry. |
| 3. Questions and authority | `session.questions()` lists open questions and `session.answer()` settles them by ID. `session.onQuestion()` overrides the agent handler. A decline is not the text `declined`. The local `user` is present with a handler. Live approvals refuse if nobody present can answer. Opt into `severalActors`, `sessionLimits` and `tenants` to use actor views, join and leave, proposals, ceilings and tenant selection. |
| 4. Tools | Standard Schema JSON Schema export and plain JSON Schema. The Harness checks `parameters` before dispatch, and `returns` after `tool.after`; `hints` are nested on the wire. Local and served tools share result wording. `toolOutput` includes the text `chunk` and preserves the reported Content, including images. Job progress also retains Content. `context.history(cursor)` reads raw pages and `context.emit(type, data)` sends custom events through the output gate in both placements. `context.credential(name)` is in-process only. `PromptResult.toolResults()` lists only the model's calls. |
| 5. Errors | `AgentError` with a string-union code and structured data. Known history, state and authority failures have stable codes, including `held` with `data.retryAfterMs` and `turn_limit` with `data.limit`. Unclassified plugin failures use `internal`. |
| 6. Plugins | Registrar adapters for Runtime, environment, history, credentials, configuration and Interfaces. `defineToolSource` supplies `changed()`. Job owners register cancel and resume. Typed core hooks include local pending gates and Provider pieces; plugin-defined points use `defineHook`, `onHook` and the handle's `call()`. Commands have a scoped environment, can ask questions in process, and can declare `usesModel` with `inProcessOnly` to send auxiliary requests through the session Provider. Those attempts are recorded and metered under a command step, without a turn or tool dispatch. |
| 7. Serve | Plugin `/1` on stdio or authenticated `ws:`/`wss:`. Port `0` returns the bound URL. Registration runs once per connection; `serve(() => plugin, options)` creates fresh per-connection state. `close()` stops the instances. Explicit in-process-only registrations are rejected. State is under `<tokenFile>.state` by default (`stateDir` overrides it), namespaced by token and host home. |
| 8. Remote plugins | Loads in-process, explicit process, explicit service, then `MODULAR_AGENT_PLUGINS` entries in array order. Invalid startup fails composition. Connection loss settles a dispatched tool as `outcomeUnknown`. `pingIntervalMs` and `controlTimeoutMs` default to 30,000 and 5,000 ms. |
| 9. Testing | Scripted Provider driven by the final request, test agent, `answers().assertDone()`, memory environment, `overWire`, and seven shared fixtures, including `note`. `restart(agent)` interrupts an in-process agent without recording graceful settlement or running session or plugin shutdown hooks, releases writer leases, and rebuilds over the same store. The shared suite kills a real process group. |
| 10. Guides | Offline equivalents of the TypeScript examples in guides 01–09 are checked. Guide 03's production example uses a deployed Python program; its offline test loads the TypeScript fixture over the same binding. |
| 11. Providers | Core interface and `@modular-agent/openai`, `@modular-agent/anthropic`. API-key catalogs and reasoning payloads come from the shipped byte-identical model table; the loopback tests exercise each mapping. `models` can enroll an unlisted model without levels. `@modular-agent/subscription` adds `chatgpt`, `grok`, `subscriptionLogins`, `signIn` and `signOut`. `@modular-agent/claude` adds `claude` and the Claude process plugin. Local catalog changes notify subscribers; served catalogs refresh with `provider/models`, not a private notification. Unknown models fail before admission; admitted failures become typed AssistantMessages. `context.credential()` reads the Provider's own credential in either placement. Passing a name is in-process only. |
| 12. Nested calls | `context.tools.list()` and `.call()` work in process and over `/1`. The Harness supports **eight child levels** under a top-level invocation; deeper requests settle refused. The Harness authorizes, commits and settles children, including on cancellation or recovery. `modelTools` narrows only the model offer. ACP declares `nestedToolCalls` and identifies the parent on the child's first update. |
| 13. Declaration and ACP | Declaration reflects the store, environment, Runtime and host, including queue policies and output holding. The SDK Provider port can declare kept state but not Provider-run tools or live sessions. `serveAcp` supports project composition, new-session settings and trusted MCP configuration. WebSocket listeners answer `$/ping` before and after initialization, apply the control deadline, and use exact project scopes and per-token tenant and rights ceilings without rewriting grants. Client-supplied MCP servers default to stdio only. Embedded `openSession` can wait for idle; ACP only installs recovery before returning. ACP sends writer interruption as the `_modular-agent/interrupted` notification and fails waiting `session/prompt` calls with `lost`; the HTTP Interface delivers the live interruption over SSE and ends that stream. |
| 14. History over HTTP | `serveHistory` serves `fileHistory(dir)` or a custom `HistoryServiceStore`, relays a trusted `httpHistory(url, tokenFile)`, and allows `memoryHistory()` only with `{ testOnly: true }`. Default kept/durable data directories still use base JSONL. Each `/1` credential gives raw access to its entire namespace. Use separate listeners, stores and credentials for separate trust scopes. |
| 15. Connection policy | ACP stdio takes `projects`, `tenants`, `rights` and `represents` in `serveAcp`. WebSocket credentials can also name represented actors. The connection checks the stored scope before composition and keeps presence separate from grants. A plugin listener normally serves one host trust scope. Supply a private token and exact `projects` for that scope. The conformance fixture also accepts explicit host profiles with distinct tokens, state namespaces and project grants. |
| 16. Reservations | `createAgent({ resourceReservations })` sets finite `session`, `tenant` and `agent` bounds. Each has `inputs`, `calls`, `jobs`, `bufferedBytes`, `storageBytes` and `controlBytes`. `entryBytes`, `batchBytes` and `settlementBytes` bound write and result sizes. `agent.resourceLimits()` reports configured bounds, not occupancy. The count ceilings are included in the declaration. A backed-up admission returns `busy`; a model attempt or call list that does not fit ends the turn at `capacity`. |
| 17. Pending erasure | `httpHistory(url, tokenFile)` discovers the [pending-erasure registry profile](../../../docs/bindings/history-http.md#pending-erasure-registry-profile-pendingerasure-1). Without version `1` the composition declares `erasure: false`. With it, the agent checks plans before handoff and a later writer completes them under its lease. `Session.erase()` reports confirmed and pending pairs and out-of-reach descriptions. Local history still uses its own SQLite registry. `fileHistory(dir, { pendingErasureDir })` can keep that local registry outside history backups. |
| 18. ma policy | `ma` reads the default `policy.json` or `--policy FILE` before protected project setup, applies principals and exact scope on both ACP transports, and keeps the one-token shorthand. `ma --declaration` prints operator byte bounds under `limits`. |
| 19. Telemetry | The Harness declares `telemetry: 1` on the agent and session. It records metadata only through `@opentelemetry/api`. Set `createAgent({ agentName })` to a stable, non-sensitive name. The app registers its tracer and meter providers and an async context manager before composition, and owns export and shutdown. The SDK installs none of them. |
| 20. Interface-run tools | `createAgent({ interfaceTools })` registers model-only sources for configured actors and routes. An embedded Interface attaches to an open session, advertises exact definitions and receives executable calls only after the Harness commits the start and checkpoint. A valid report settles once through `tool.after` and queues a continuation without a new input. Embedded and served Runtimes opt in. ACP projects `interfaceTools: true` when supported but has no executor or reporting methods. AG-UI uses the deferred connection at run end. |
| 21. Approvals that wait | An opted-in session can leave an unstarted server tool call open after its turn. The answer binds the exact delivered view. Only the continuation can dispatch, before the original deadline. |

### Approvals that cover nested calls

Pass `{ approval: "ask", approvalCoversNested: true }` to `createAgent`. The option is operator-set, not a session setting. The default is false. Without the approval plugin or without the option, the declaration omits `approvalCoversNested`.

A top-level approval question has `coversNested: true` and the exact call. Show both to the approver. An explicit allow answers the approval check for all nested calls in that dispatch. Each child's `toolStarted.data.approvalCoveredBy` records the top-level `toolCallId` and its `requestId`. A read-only parent that ran without asking grants no coverage. A refusal, `never`, missing rights, invalid input and a refusal from another gate still stop the call. Recovery of a live parent needs a fresh allow.

This also works for an approval that waits. Only the original request's view counts: enabling the option on reopen cannot upgrade a request that omitted `coversNested`. The [covered approval tests](test/covered-approval.test.ts) check children, grandchildren, unmarked views and interrupted dispatch.

### Approvals that wait

Pass `durability: "kept"`, `dataDir`, `approval: "all"`, `questionsOutlastTurns: true` and `maxApprovalWaitMs: 60_000` to `createAgent` with a portable history store. `"durable"` also works. The operator maximum is a positive safe integer in milliseconds, not a project setting. An incompatible composition raises `invalid_composition`. Look for `agent.declaration().approvalsOutlastTurns === true`. This does not opt a session in.

```ts
const session = await agent.session({ settings: { approvalWait: "untilDeadline" } });
// Or: await session.setSetting("approvalWait", "untilDeadline");
const result = await session.prompt(input);
// result.openToolCalls identifies unstarted calls. No provisional tool result.
await session.waitIdle();
await session.close();

// Later, possibly in a new process with the same store and operator policy:
const reopened = await agent.openSession(session.id);
const [question] = await reopened.questions({ present: true });
if (question?.approvalWait === "untilDeadline") {
  // Present question.question, question.call (including id, name and input),
  // and question.deadline (absolute milliseconds). Use the person's decision.
  await reopened.answer(question.id, decision); // "allow" or "decline"
  await reopened.waitIdle();
}
```

With several actors, retain the handle returned by `session.as(actorId)` for both delivery and answer. A plain `questions()` listing does not authorize a decision. ACP uses `_modular-agent/requests` and `_modular-agent/answer` on the same connection, never `session/request_permission` for a parked call. An AG-UI client opens presence, fetches the thread snapshot and sends `resume`. No tool report is needed. The default is `approvalWait: "live"`. Nested, direct and already started calls keep their existing rules. `ma` loads the plugin only when the operator configures [approval](../ma/README.md#approval).

### Interface-run tools

Use `agent.connectInterfaceTools(sessionId, { actor, routeId, onHandoff, defer? })` in a trusted embedding binding. Authenticate each connection independently, apply its rights ceiling in `actor.rights`, and check access to the session's project and tenant before attaching. Do not accept an actor or route from a result body. The handle is bound to that session, actor and route. It does not join the actor or grant rights.

- Call `connection.advertise(definitions)` with the exact registered definitions. An empty list clears the advertisement. An advertisement is not authority.
- `onHandoff({ sessionId, turnId, call, deadline })` is the synchronous delivery boundary, not a queue for later delivery. For a delayed send set `defer: true` and call `connection.release(callId)` when ready; the Harness checks the request again before calling `onHandoff`. Do not execute calls copied from events or history.
- Call `connection.reportInterfaceToolResult({ callId, status, content, value? })` after the originating turn ends. It returns `{ status: "accepted" }`, `{ status: "alreadySettled" }` or `{ status: "refused", reason?: "notReady" }`. An early report can be sent again after turn end. If result processing fails, the SDK commits a minimal result and raises the processing error. A report does not run a tool or grant authority.
- Call `connection.disconnect()` when the connection ends. This clears the advertisement without settling the call. A new authenticated connection to the same actor and route may report without advertising, but it cannot receive the executable request again. No reconnect changes the deadline.

### Serving AG-UI

```ts
const listener = await agent.serveAgui({
  listen: "127.0.0.1:0",
  actors: [{ tokenFile, actor, clientId: "editor" }],
  acp: true, // also accept ACP WebSocket upgrades on /
});
console.log(listener.url); // HTTP origin
await listener.close(); // detach; close the agent separately when finished
```

Send a bearer token on every [binding route](../../../docs/bindings/agui.md). Set `tls: { certFile, keyFile, clientCaFile? }` for HTTPS; supplying a client CA also requires a client certificate. Creation uses the configured project and optional `tenant`. A token's project and tenant lists and rights ceiling apply on every attachment. Clients of the same actor can have separate IDs. Rotated tokens can share an ID only within the same principal and scope. Browser requests default to same-origin; use `origins` to allow other exact origins.

Use the committed messages from the last snapshot, with or without its `MA-History-Cursor`. Refresh from the thread route after a conflict. An Interface tool's registration uses the client ID as its `routeId`. Advertise only its name, description and parameters. Execute only on a qualifying live terminal event, never on reconnect. Return a tool message on the same route. Open the separate presence stream before asking for an in-turn interrupt; use `resume[].payload` to answer. A secret needs another Interface.

Approval interrupts include `metadata["modular-agent.approvalCall"]` with the exact `{ name, input }` shown in the prompt, both at run end and in the thread snapshot. This is for display, not dispatch. A gate that changes or blocks the recorded request, opening question or interrupt withholds the approval on that route.

Output hooks receive the actor as recipient. AG-UI reply and interrupt envelopes also identify the authenticated `clientId`. Gate message content at `entry` or `reply` with method `agui.messages`. A withheld result withholds its call group. For state, pass `statePlugin: { name, snapshot(threadId) }`; the callback returns the plugin's current `{ revisionId, snapshot }`. The plugin emits the state events named in the binding. For explicit foreign events, map the plugin name to a source label in `rawSources` and emit `modular-agent.agui.raw` with `{ event }`. Neither option adds a Harness document store.

Set `traceTrusted: true` on a token entry to accept a work POST's trace parent. `traceStateVendors` lists vendor keys accepted into the local operation context. Trace headers on presence and snapshot reads are ignored. No baggage is accepted. `onWarning(field)` receives field names, not payloads.

#### Host reads

Start with the authenticated thread snapshot. Use its `waitCursor`, not its message cursor, with `GET /agui/v1/threads/{threadId}/wait-closures?after=…`. Read the SSE data objects in order. Save each cursor after applying its notice. A disconnect can mean the reader fell behind; reconnect from the saved cursor. On `409 cursor_expired`, replace the inbox from a new snapshot. The feed does not establish presence, deliver an approval or authorize a tool.

On kept history the snapshot also offers `runReceipts: 1`. Use the same principal and client ID that posted the run. For example:

```ts
const url = new URL(`/agui/v1/threads/${threadId}/run-receipt`, listener.url);
url.searchParams.set("runId", runId);
const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
if (response.ok) {
  const { terminal, work } = await response.json(); // exchange release and committed work
}
```

A receipt read does not open a writer or start recovery. `unknown` means there is no committed terminal marker, not that the turn failed. A 404 does not authorize a retry. The first operation's entry ID binds the run. The deployment keeps release markers and source references in `agui-receipts.sqlite`, outside session history. It uses the data directory, or the file history directory if supplied without a data directory. With persistent service history and neither directory, it uses `$XDG_STATE_HOME/modular-agent/receipts` (default `~/.local/state/modular-agent/receipts`). Keep this storage with the deployment. Erasure removes the marker. A later session fork does not inherit it.

Run `typescript/scripts/check-agui.sh` after building. It installs the kit in a temporary directory. Five cases launch standard ma. Cases needing tools, process kills or operator controls use the disposable SDK app.

#### Serving named plugin callers

```ts
await serve(({ callerId }) => makePluginFor(callerId), {
  listen: "127.0.0.1:0",
  callers: [{ callerId: "desk", tokenFile: deskToken }, { callerId: "review", tokenFile: reviewToken }],
});
```

The factory gets the authenticated ID on each successful upgrade. Pick the caller's project bounds and retained state there. Keep live calls and callbacks on that instance. The ID grants no session rights. A wrong token gets 401 before the factory runs. Empty or ambiguous tables, unsafe files, a plugin object instead of a factory, and combining `callers` with `tokenFile` fail with `invalid_composition`. The single-token service and the client's load options are unchanged.


#### Listing and resuming threads

`GET /agui/v1/threads` returns kept threads the caller may watch in the route's project and tenant. Each row contains only `threadId`, `updatedAt` and `waiting`. The latter has the caller's counts of eligible questions and Interface calls, and a turn state: `none`, `running` or `interrupted`. A completed turn can still have open calls. The list is newest change first. Set `limit` to 1–500 (default 100); send `next` as `after` for another page. An invalid or expired cursor gets HTTP 400, `invalid_request`. Listing never opens a session or marks presence.

The adapter uses the `agent.sessionSummary(id, { actor, routeId, inTurn })` read. Give it the authenticated actor with its connection rights, the executor route if any, and the in-turn question IDs still held by that connection. It inspects committed records, including those in sessions not open in this process. Pass `scope(project, tenant)` to narrow discovery to the viewer's projects and tenants. ACP uses the same Harness read for `session/list` and returns `_meta["modular-agent"].waiting` per row. An ACP connection is not a tool executor.

With `serveAgui({ resumeOpen:true, ... })` or `serveAcp({ resumeOpen:true, ... })`, the SDK installs ordinary recovery for interrupted turns in the configured project before accepting clients. The opener is the embedded local actor with a watch ceiling, not a client token. Recovery keeps the authority recorded for the turn. Use `onResumeOpen(id, disposition)` to receive `resumed` or `skipped`; an idle session with open waits is left alone.

#### Gaps in the core operations

The [binding](../../../docs/bindings/agui.md#interrupts-and-frontend-tools) requires settlement **if the Harness can confirm non-delivery**. Withholding the final group sends `RUN_ERROR`; it does not report a tool failure on the actor's behalf. The handle has no acknowledgment from the adapter proving non-delivery. If the Harness cannot prove it independently, the call remains open until a valid report, cancellation or its existing deadline. No handoff is repeated.

A waiting exchange receives `RUN_ERROR` with code `busy` if its ready continuation cannot reserve a turn. That refusal does not undo a committed result or start a different turn.

### Proposed standard configuration text

### Telemetry context

Plugin peers agree to per-operation context at initialize. ACP stdio accepts context from the launching peer; set `serveAcp({ traceTrusted: false })` to ignore it. An authenticated ACP WebSocket actor accepts it only when its token entry sets `traceTrusted: true`. The SDK carries trace context in history HTTP headers and MCP request metadata. It does not carry baggage or vendor state. Durable resume links a new span to the committed segment in the same trace. Forks omit the checkpoint and the starting context; raw plugin and ACP views keep the envelope but not the context.

### Subscription Providers

```ts
import { createAgent } from "@modular-agent/core";
import { chatgpt, grok, subscriptionLogins } from "@modular-agent/subscription";
import { claude } from "@modular-agent/claude";

const logins = subscriptionLogins("/private/app/auth.json");
const agent = await createAgent({ providers: [chatgpt({ logins }), grok({ logins }), claude()] });
```

Call `signIn("chatgpt", logins, { onStep, paste, device, clientIdentity })` or `signIn("grok", logins, { onStep, clientIdentity })` from `@modular-agent/subscription`. ChatGPT reports `openAndPaste` for browser sign-in, or `deviceCode` and `waiting` for device sign-in. Grok reports `deviceCode` then `waiting` and ignores `device` and `paste`. The SDK opens no browser. `signOut("chatgpt", logins)` or `signOut("grok", logins)` removes that login. The login file must be private. Refresh uses `flock(2)` through util-linux `flock` on Linux or system Perl on macOS. `available()` reads the login file without contacting either service. Both constructors accept `models` to enroll an unlisted id. See the [terms of use](../../../docs/sdk/subscription-providers.md#terms-of-use) for the sign-in clients.

Claude uses Claude Code's plan sign-in and rejects API-key use; `unavailableReason()` gives the reason after the availability check. The [Claude package](../claude/README.md) also builds the process entry used by Rust and Go, including the compatibility path `typescript/sidecars/claude/dist/main.js`.

### Registering or serving a custom history store

Register an in-process `HistoryStore` with `r.historyStore(store)`. It declares `persistent` and `ttlMs`, receives `create(id, metadata)` with no `id` in the metadata, and receives the binding's `after` and `limit` on `read` and `list`. The adapter follows the page cursors and manages lease renewal. Implement `writerSignal(id, lease)` when the store can discover loss independently of renewal; abort it as soon as that lease is lost. The earlier writer-oriented `WriterHistoryStore` interface is still accepted.

`serveHistory(store, { address, tokenFile, leaseTtl })` serves a history store over HTTP. For the built-in file and test-only memory services, the optional `leaseTtl` sets the writer lease that the service declares as `ttlMs`. It defaults to 15,000 milliseconds and must be a whole number of milliseconds, at least 1. A custom store declares its own `ttlMs`; a relay preserves the upstream declaration.

A custom `HistoryServiceStore` implements the [history binding](../../../docs/bindings/history-http.md) operations and owns lease generations, expiry, restart exclusion, durable atomic mutations, paging and tombstones. The adapter handles authentication, request validation and response encoding. The custom store interface is base `/1`; it does not declare the registry profile. The persistent built-in SQLite service declares the profile and commits revisions, plans and history in the same database. The test-only memory listener does not declare it. A marker beside the database prevents silently starting a new store if the database goes missing. Keep the marker with the store; it is not a restore witness. The HTTP relay preserves the upstream declaration and the revision header.

On macOS, Node does not expose the suspension-aware `CLOCK_MONOTONIC`, and `performance.now()` stops during sleep. The HTTP history writer therefore derives a sleep-aware clock, as the [history binding](../../../docs/bindings/history-http.md#writing-one-writer-at-a-time) allows: each reading advances by the larger of `performance.now()`'s and `Date.now()`'s advance since the last one, so a sleep is counted at the next reading. If the wall clock moves back by more than 50 ms, a sleep could be hidden, so the clock jumps a day ahead and every lease held at that moment is treated as lost; the session is interrupted and recovers on reopen. No configuration is needed. `MODULAR_AGENT_HISTORY_LEASE_MARGIN_MS`, if set, raises the margin above the clock's own 60 ms. Linux uses `/proc/uptime`; other platforms still require the operator margin.

Do not mix direct `fileHistory` writers or raw HTTP writers with profile clients in a coordinated namespace. For an existing deployment with a shared `pendingErasureDir`, settle and verify all old obligations before switching writers. There is no migration from its private registry to wire plans. The HTTP `pendingErasureDir` option and `MODULAR_AGENT_PENDING_ERASURE_DIR` have been removed; the conformance launcher no longer needs `MODULAR_AGENT_CONFORMANCE_ERASURE_DIR`. Keep the old registry for restore checks on old backups. A matching registry and history rollback does not prove freshness. Check restores against an authority outside the restored data before serving.

The base Harness `PluginApi.history()` is synchronous and refuses reads of published HTTP sessions that declare the profile. In-process plugins using this API should await `readHistory()`. The SDK session history API is still asynchronous. The profile does not attest deletion of kept Provider state. The HTTP composition reports such work as out of reach and refuses to dispatch to a Provider that may keep state in a marked session.

Use `encodeHistoryJson`, `parseHistoryJson` and `equalHistoryJson` to preserve opaque fields and exact numeric values, and `historyTombstone` for the standard erasure projection. Throw `HistoryServiceError` for a confirmed refusal; include the remaining `retryAfterMs` for `held`. If a mutation's commit is uncertain, throw another error so the adapter closes the request without an acknowledgement.

## Findings


These are proposed documentation replacements, not changes to the specification.



- **Availability diagnostics.** In [Providers](../../../docs/sdk/api.md#providers), replace the `available` description with: “Whether the Provider can take requests now, for example whether it has credentials. A Provider may expose a separate diagnostic in process. The `/1` plugin binding reports only a boolean.” Claude can name an API-key source locally without extending the wire reply.


- **Cross-session restore.** The SQLite registry can detect a missing freshness source while an agent is running. A process restarted with both an older history and an older registry cannot tell that either one is stale. An independent registry fences erased content but does not prove the freshness of authority records. Replace the last sentence of [Cross-session coordination](../../../docs/contracts.md#cross-session-coordination)'s completion rule with: “Before serving a restored backend, the operator MUST compare its erasure generation with a high-water mark stored outside restored data. The Harness MUST refuse service for affected scopes until that check and any required reconciliation succeed.”
- **Storage accounting.** TypeScript counts encoded record and reserved payload bytes, not the filesystem blocks needed by SQLite journals, JSONL batch markers, compaction or backups. Replace the first sentence of the write-space rule in [Resource reservations](../../../docs/contracts.md#resource-reservations) with: “The Harness MUST reserve processing capacity and a conservative bound on encoded writes, including batch and individual entry limits. The operator MUST provision additional space for backend framing, journal and rewrite amplification, and MUST allocate non-overlapping writer shares when there is no shared allocator.”
- **Hosted working environments.** The named project grant is checked on file and point requests, not on every descendant shell system call. Replace the last sentence of the paths rule in [Plugin service](../../../docs/bindings/websocket.md#a-plugin-service) with: “The endpoint verifies the working directory and mediated file and point requests. The operator MUST supply filesystem and command confinement, including against concurrent path replacement and child processes, when hosts must not share resources.”
- **Starting a turn with no queued input.** The capacity kit opens two immediate turns under a one-slot agent or tenant limit, then races two queued admissions. Clarify the admission rule in [Resource reservations](../../../docs/contracts.md#resource-reservations): “An input assigned immediately to a reserved turn needs retained payload and disposition capacity, but no queued input slot. Input not assigned to a reserved turn, including steering and proposals, MUST charge a pending input slot.”

- **Transport cutoff.** The prepared Provider request now has a guarded reply at the wire handoff. There is no recall of bytes already handed to an external process or of effects already started there. Replace the last sentence of the pending-content rule in [Cross-session coordination](../../../docs/contracts.md#cross-session-coordination) with: “The cutoff is the agent's last successful handoff under the authority and erasure fence. The Harness MUST refuse a later callback or delivery under stale work authority; it cannot recall bytes or effects already handed off.”
- **Erasure retry triggers.** There is no lease-release notification in history HTTP `/1`. TypeScript retries when a writer opens a pending session, when an authorized erase is repeated, and before use of affected Provider state. Replace the first sentence of the retry rule in [Cross-session coordination](../../../docs/contracts.md#cross-session-coordination) with: “The Harness MUST keep pending obligations durable and retry them on restart, on writer acquisition and on the next authorized operation in an affected scope. A deployment that requires idle convergence MUST provide a background reconciler or a lease-release notification.”
- **Part replacement selectors.** In [API: Plugins](../../../docs/sdk/api.md#plugins), replace the `replaces` description with: “Items of its own that replace an earlier plugin's: `runtime`, `working-environment`, `history-store`, `credential-store`, `configuration`, `provider:<id>`, `tool:<name>` or `command:<name>`. The last three include the registered name. Interfaces are additive.” The current list omits the store and configuration singletons even though a default is installed before explicit plugins.
- **Model output events.** In [API: Events](../../../docs/sdk/api.md#events), replace the Model output row with: “`text`, `reasoning`, `toolInput`. A plugin may emit audio as a namespaced extension until shared data defines a standard audio payload.” The linked binding does not define a standard audio event.


## Remaining

ADR 0030 coverage is not complete. New work records a starting ceiling; a continued turn intersects that ceiling with current rights. The wire Provider checks the fence at the successful preparation reply. The integration matrix does not yet prove this cutoff for every remote callback, child, buffered delivery, or foreign SDK. The ledger charges retained records, buffered input, model attempts, questions, and tracked follower output. It does not account for every transport buffer, every cleanup obligation, or physical backend write amplification, and there is no bounded-store saturation run. The local registry can keep pending Provider discards across reopen. The history HTTP registry records only history work. Reconciliation runs on writer acquisition and on later operations; there is no background retry of every held destination. A destination with work the agent cannot safely settle, such as an unfinished job, stays pending. A deployment must keep the authoritative erasure state and the authority freshness source outside the backup being restored.
