# `@modular-agent/core`: the TypeScript SDK

The TypeScript SDK implements the [SDK specification](../../../docs/sdk/README.md) over the TypeScript build with the [edition 4 draft](../../../docs/adr/0023-edition-4-draft.md) extensions. An app uses `Agent` and `Session`, not a Harness. Plugins register parts once and get contexts for individual calls.

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
MODULAR_AGENT_SDK_REQUIRE=all MODULAR_AGENT_SDK_SERVICE=typescript npm test
MODULAR_AGENT_SDK_REQUIRE=all MODULAR_AGENT_SDK_SERVICE=typescript MA_REMOTE=provider-pi-ai,runtime-transient,tools-files,env-local npm test
(cd sidecars/claude && npm ci && npm test)
```

- **TypeScript suites:** Normal and `MA_REMOTE` each passed **291/291** offline checks, with two live Provider checks skipped. The workspace limits concurrent test files to four to avoid starving short history leases and integration watchdogs when several SDKs run on the same machine. `tsc -b` and `git diff --check` pass; this workspace has no separate lint or formatter script. The Claude sidecar passed **44/44**.
- **Reference and kits:** TypeScript `ma` passed **17/17** reference checks and the ACP kit with crash, probe and job checks: **188/188** on stdio and **193/193** directly on WebSocket. The plugin kit passed **146/146** on stdio and **153/153** directly on WebSocket, including separate transient and durable Runtime services. No bridge was used. The suite also passed ACP on the base CLI (116/116), with HTTP history (117/117), with fixture plugins served (203/203), and with the served durable Runtime (140/140). The history kit passed 39/39 for each of the base, SDK file, test-only memory and upstream HTTP relay placements.
- **SDK coverage:** The offline guide tests cover approvals, Providers, hook placements, process plugins, ACP stdio, and history handoff. Four tests kill a child process at specific secret-answer boundaries and reopen without leaking the value. The live Provider file compiles and skips both cases by default. Run live checks by hand only with `MODULAR_AGENT_LIVE=1`; each Provider test also requires its own API key. No live requests were made for this change.
- **Shared scenarios:** **84/84** with `MODULAR_AGENT_SDK_REQUIRE=all`: all 14 in process, 14 over stdio for each of Rust, Go, Python and TypeScript, and 14 over WebSocket for TypeScript. The crash scenarios kill and reap the agent group and each service group before reopening. `MODULAR_AGENT_SDK_SERVICE=typescript` limits service runs while the other SDKs add `--listen`; omit it after integration to exercise all built services.

Build all fixture programs and run the TypeScript matrix from the repo root:

```sh
(cd rust && mise exec -- cargo build -p sdk-scenarios --bin modular-agent-fixtures)
(cd go && mise exec -- go build -o .bin/modular-agent-fixtures ./modular/cmd/fixtures)
(cd python && uv sync --python 3.13)
(cd typescript && npm ci && npm run build)
(cd typescript && MODULAR_AGENT_SDK_REQUIRE=all MODULAR_AGENT_SDK_SERVICE=typescript node --test packages/fixtures/dist/test/shared.test.js)
node conformance/reference/run.mjs --agent typescript
agent="$PWD/typescript/packages/ma/dist/src/main.js"
(cd conformance/acp && MODULAR_AGENT_CONFORMANCE=1 node run.mjs --crash-checks --probe-checks --job-checks -- node "$agent" --acp)
```

The SDK adds Ajv 8 (its [2020-12 entry point](https://ajv.js.org/json-schema.html#draft-2020-12)) to validate plain schemas and the JSON Schema exported by validators. The base already uses `json-schema-to-ts`, used here for plain-schema inference, and Zod 4, used by fixtures and tests. The OpenAI and Anthropic packages use the base's Pi AI adapter, not another vendor SDK.

## Built so far

| Milestone | State |
|---|---|
| 1. Agent composition | Chooses project, durability, Providers, tools, plugins, settings, approval and question handling. Checks effective persistent history and Runtime support; recoverable local bookkeeping needs `dataDir`. Process or service plugins enable host mode, which reads `MODULAR_AGENT_PLUGINS`. Environment credentials are read-only; `fileCredentials(path)` stages secret answers in a private, atomically updated file. `ma` uses the same staging operations and keeps activated answers under `answers` in `auth.json`. |
| 2. Sessions | Create, recover on reopen, prompt, prompt stream, last turn, history, send, cancel, settings, fork, erase and close. Bounded streams fail with `lost` and the last delivered kept entry cursor (or null); replay starts strictly after the cursor. A prompt with `result` parses one JSON value and validates through `turn.result`; refusal records feedback before retry. `null` is a value; absent or invalid JSON is not. |
| 3. Questions and authority | `session.questions()` lists open questions and `session.answer()` settles them by ID. `session.onQuestion()` overrides the agent handler. A decline is not the text `declined`. The local `user` is present with a handler; approvals otherwise refuse if nobody else can answer. Opt into `severalActors`, `sessionLimits` and `tenants` to use actor views, join and leave, proposals, ceilings and tenant selection. |
| 4. Tools | Standard Schema JSON Schema export and plain JSON Schema. The Harness checks `parameters` before dispatch, and `returns` after `tool.after`; `hints` are nested on the wire. Local and served tools share result wording. `PromptResult.toolResults()` lists only the model's calls. |
| 5. Errors | `AgentError` with a string-union code. Some uncoded base errors still map to `internal`. |
| 6. Plugins | Config, item replacement, tools and changing tool catalogs, Providers, named hooks, plain commands, Runtime and environment; also in-process history, credential stores, configuration and Interfaces. Job owners register with `r.jobs`; tools and commands can start jobs, and a session-start hook can recover them. `defineHook` returns a handle with `on` and `call`. Model-using commands remain unsupported. |
| 7. Serve | Plugin `/1` on stdio or authenticated `ws:`/`wss:`. Port `0` returns the bound URL and `close()` stops the instances. Explicit in-process-only registrations are rejected. State is under `<tokenFile>.state` by default (`stateDir` overrides it), namespaced by token and host home. |
| 8. Remote plugins | Loads in-process, explicit process, explicit service, then `MODULAR_AGENT_PLUGINS` entries in array order. Invalid startup fails composition. Connection loss settles a dispatched tool as `outcomeUnknown`. `pingIntervalMs` and `controlTimeoutMs` default to 30,000 and 5,000 ms. |
| 9. Testing | Scripted Provider driven by the final request, test agent, `answers().assertDone()`, memory environment, `overWire`, and seven shared fixtures, including `note`. `restart(agent)` interrupts an in-process agent without recording graceful settlement or running session or plugin shutdown hooks, releases writer leases, and rebuilds over the same store. The shared suite kills a real process group. |
| 10. Guides | Offline equivalents of the TypeScript examples in guides 01–09 are checked. Guide 03's production example uses a deployed Python program; its offline test loads the TypeScript fixture over the same binding. |
| 11. Providers | Core interface and `@modular-agent/openai`, `@modular-agent/anthropic`. Local catalog changes notify the agent; served catalogs refresh through `provider/models`. Availability is consulted, and served requests use the host's request and response hooks, event stream and credential callback. Unknown models fail before admission; exceptions after admission become typed failed AssistantMessages. |
| 12. Nested calls | `context.tools.list()` and `.call()` work in process and over `/1`. The Harness supports **eight child levels** under a top-level invocation; deeper requests settle refused. The Harness authorizes, commits and settles children, including on cancellation or recovery. `modelTools` narrows only the model offer. ACP declares `nestedToolCalls` and identifies the parent on the child's first update. |
| 13. Declaration and ACP | Reports the installed store's erasure support, the environment's platform containment and file confinement, the host's next-turn settings policy, and installed Runtime/host recovery and nesting support. Build with `pluginHost: true` before calling `serveAcp()` if not already loading remote plugins. `serveAcp({ listen, actors, tls? })` returns a server; tokens select independent connections and actor, project and tenant scopes. Embedded `openSession` can wait for idle; ACP only installs recovery before returning. |
| 14. History over HTTP | `serveHistory` serves `fileHistory(dir)`, relays a trusted `httpHistory(url, tokenFile)` service without reinterpreting leases or opaque JSON, and allows `memoryHistory()` only with `{ testOnly: true }`. Unsupported store types are refused, by name. Default kept/durable data directories still use base JSONL for compatibility. |

## Findings for the SDK specification

- **[ACP token scope](../../../docs/research/sdk-findings.md#open-decisions).** TypeScript uses unrestricted omitted lists, exact canonical project roots, and a token-rights ceiling that does not rewrite saved grants. The SDKs differ on these rules.
- **[Persistent history under `ephemeral`](../../../docs/research/sdk-findings.md#open-decisions).** TypeScript accepts an explicit persistent store and can report it as portable in this mode; other SDKs tie the declaration to the mode.
- **[Model-using commands](../../../docs/research/sdk-findings.md#open-decisions).** TypeScript rejects developer-registered model-using commands. Decide whether to offer a call-scoped inference operation that applies Provider gates and tenant accounting, without dispatching model tools or starting a turn.
