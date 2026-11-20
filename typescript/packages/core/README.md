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

Run from `typescript/` with Node 26. Install the ACP kit's dependencies once with `npm ci --prefix ../conformance/acp`.

```sh
npm ci
npm run build
MODULAR_AGENT_SDK_REQUIRE=all npm test
MODULAR_AGENT_SDK_REQUIRE=all MA_REMOTE=provider-pi-ai,runtime-transient,tools-files,env-local npm test
MODULAR_AGENT_SDK_REQUIRE=typescript node --test --test-name-pattern='inProcess|process:typescript' packages/fixtures/dist/test/shared.test.js
(cd sidecars/claude && npm ci && npm test)
```

- **TypeScript suites:** Separately, the standard and remote suites each ran 271 checks: 266 passed, two live checks skipped, and the only three failures were the missing `note` fixtures below. When run concurrently, each suite also failed one Linux process-tracker check; both process checks passed in isolation and in the sequential suites. There is no separate TypeScript lint or formatter script; `tsc -b`, `git diff --check`, and Markdown link checks pass. The Claude sidecar passed 44/44.
- **Reference and kits:** TypeScript `ma` passed all 17 reference checks and 188/188 ACP checks with crash, probe and job checks. The suite also passed ACP on the base CLI (116/116), with HTTP history (117/117), with fixture plugins served (203/203), and with the served durable Runtime (140/140). The plugin kit passed 146/146. The history kit passed 39/39 each for base, SDK file, test-only memory and upstream HTTP relay placements.
- **SDK coverage:** The offline guide tests cover approvals, Providers, hook placements, process plugins, ACP stdio, and history handoff. Four tests kill a child process at specific secret-answer boundaries and reopen without leaking the value. The live Provider file compiles and skips both cases by default. Run live checks by hand only with `MODULAR_AGENT_LIVE=1`; each Provider test also requires its own API key. No live requests were made for this change.
- **Shared scenarios:** 14/14 in process, 14/14 served by TypeScript, and 13/14 each served by Go, Python, and Rust (67/70 total). The original eleven pass in all five placements (55/55) with `MODULAR_AGENT_SDK_REQUIRE=all`. The only scenario failure against the other checkout-base programs is `decline-is-not-text`, which needs their new `note` fixture. The crash cases reap the helper and wait until no process-group member can run; both keep one increment, and only durable recovery continues the turn.

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
```

The SDK adds Ajv 8 (its [2020-12 entry point](https://ajv.js.org/json-schema.html#draft-2020-12)) to validate plain schemas and the JSON Schema exported by validators. The base already uses `json-schema-to-ts`, used here for plain-schema inference, and Zod 4, used by fixtures and tests. The OpenAI and Anthropic packages use the base's Pi AI adapter, not another vendor SDK.

## Built so far

| Milestone | State |
|---|---|
| 1. Agent composition | Chooses project, durability, Providers, tools, plugins, settings, approval and question handling. Checks effective persistent history and Runtime support; recoverable local bookkeeping needs `dataDir`. A process plugin requires host mode, which reads `MODULAR_AGENT_PLUGINS`. Environment credentials are read-only; `fileCredentials(path)` stages secret answers in a private, atomically updated file. `ma` uses the same staging operations and keeps activated answers under `answers` in `auth.json`. |
| 2. Sessions | Create, recover on reopen, prompt, prompt stream, last turn, history, send, cancel, settings, fork, erase and close. Bounded streams fail with `lost` and the last delivered kept entry cursor (or null); replay starts strictly after the cursor. A prompt with `result` parses one JSON value and validates through `turn.result`; refusal records feedback before retry. `null` is a value; absent or invalid JSON is not. |
| 3. Questions and authority | `session.questions()` lists open questions and `session.answer()` settles them by ID. `session.onQuestion()` overrides the agent handler. A decline is not the text `declined`. The local `user` is present with a handler; approvals otherwise refuse if nobody else can answer. Opt into `severalActors`, `sessionLimits` and `tenants` to use actor views, join and leave, proposals, ceilings and tenant selection. |
| 4. Tools | Standard Schema JSON Schema export and plain JSON Schema. The Harness checks `parameters` before dispatch, and `returns` after `tool.after`; `hints` are nested on the wire. Local and served tools share result wording. `PromptResult.toolResults()` lists only the model's calls. |
| 5. Errors | `AgentError` with a string-union code. Some uncoded base errors still map to `internal`. |
| 6. Plugins | Config, item replacement, tools and changing tool catalogs, Providers, named hooks, plain commands, Runtime and environment; also in-process history, credential stores, configuration and Interfaces. Job owners register with `r.jobs`; tools and commands can start jobs, and a session-start hook can recover them. `defineHook` returns a handle with `on` and `call`. Model-using commands remain unsupported. |
| 7. Serve | stdio `/1`: initialize, tools, questions, environment (including directory listing), Runtime, hooks, Providers, commands and shutdown. Explicit in-process-only registrations are rejected. |
| 8. Process plugins | Uses the base host with the minimal environment. Invalid startup fails composition; a lost dispatched tool has unknown outcome. |
| 9. Testing | Scripted Provider driven by the final request, test agent, `answers().assertDone()`, memory environment, `overWire`, and seven shared fixtures, including `note`. `restart(agent)` interrupts an in-process agent without recording graceful settlement or running session or plugin shutdown hooks, releases writer leases, and rebuilds over the same store. The shared suite kills a real process group. |
| 10. Guides | Offline equivalents of the TypeScript examples in guides 01–09 are checked. Guide 03's production example uses a deployed Python program; its offline test loads the TypeScript fixture over the same binding. |
| 11. Providers | Core interface and `@modular-agent/openai`, `@modular-agent/anthropic`. Local catalog changes notify the agent; served catalogs refresh through `provider/models`. Availability is consulted, and served requests use the host's request and response hooks, event stream and credential callback. Unknown models fail before admission; exceptions after admission become typed failed AssistantMessages. |
| 12. Nested calls | `context.tools.list()` and `.call()` work in process and over `/1`. The Harness supports **eight child levels** under a top-level invocation; deeper requests settle refused. The Harness authorizes, commits and settles children, including on cancellation or recovery. `modelTools` narrows only the model offer. ACP declares `nestedToolCalls` and identifies the parent on the child's first update. |
| 13. Declaration and ACP | Reports the installed store's erasure support, the environment's platform containment and file confinement, the host's next-turn settings policy, and installed Runtime/host recovery and nesting support. Build with `pluginHost: true` before calling `serveAcp()` if not already loading process plugins. Embedded `openSession` can wait for idle; ACP only installs recovery before returning. |
| 14. History over HTTP | `serveHistory` serves `fileHistory(dir)`, relays a trusted `httpHistory(url, tokenFile)` service without reinterpreting leases or opaque JSON, and allows `memoryHistory()` only with `{ testOnly: true }`. Unsupported store types are refused, by name. Default kept/durable data directories still use base JSONL for compatibility. |

## Where the base and the specification differ

| Difference | Handling |
|---|---|
| The base gives setup the whole `PluginApi`, and its ordinary loader may report a problem and continue. | Collect SDK registrations without any live session rights. Expose call contexts, not `PluginApi`. Validate collisions and fail the SDK composition on setup or registration problems. |
| The base can leave sessions without a history store. | Always install a store; the SDK memory store supports reopen and fork until the agent ends. |
| Local file operations need not be confined to the project. | The SDK's default local environment resolves relative paths against the project and declares `confinesFiles: false`. Memory declares true. On Linux the local command supervisor tracks descendants, not just the process group; command containment is separate from file confinement. |
| Late answers and automatic job report turns change what can start a turn. | They are opt-in via `questionsOutlastTurns` and `jobReportsStartTurns`, respectively. Tool asks can leave calls open in both placements; a tool gate can do so in process. |
| Base Runtime hooks and wire hooks need different scopes in some cases. | Translate hook answers at the registration boundary. In-process and served hooks have a shared subset. Base hook execution now rechecks changed tool input. |
| The base exposes its own local and remote history constructors. | SDK stores are handles. The service shares the archive behind the handle, or relays a history HTTP service, on numeric loopback. An explicit `fileHistory(dir)` uses SQLite; migration from an existing base JSONL directory is offline. |
| The base's model catalog varies with the installed Pi AI version. | The SDK filters OpenAI to Responses and Anthropic to Messages. In examples choose an id from the installed Provider's catalog. |
| The base and some existing hooks include details not present in the SDK's type declarations. | The SDK keeps opaque data unchanged when storing and relaying the shared shapes. It does not accept a wider wire contract based on those extra properties. |

## Findings for the SDK specification

1. **Resolved in the revision.** **[API — Tools](../../../docs/sdk/api.md#tools), failed/refused wording.** The table says an error's message or bare reason; base runtimes can add a prefix (`Tool failed: …` in TypeScript, `Refused: …` in Rust). Placement equality is meaningful even when SDKs use different diagnostic wording. Replace the failed/refused Content cells with: **“The diagnostic includes the error message or refusal reason. An SDK may add a fixed prefix; the same SDK tool MUST produce the same diagnostic in process and served. Clients branch on status, not on text.”** A shared scenario should add a fixture tool that calls `refuse("the quay is closed")`; require status `refused` and the reason across hosts, and compare the entire rendering between each SDK's own local and served placement.
2. **Resolved in the revision.** **[API — Plugins](../../../docs/sdk/api.md#plugins), preflight vs config.** An arbitrary `setup` cannot be run before `plugin/initialize` supplies config. Insert: **“A servable program can reject a statically visible in-process-only registration before opening stdio. If the item is discovered in `setup`, reject `plugin/initialize` with `not_supported`, naming the item, and return no registration. Do not run `setup` twice to preflight the program.”**
3. **Resolved in the revision.** **[API — Agent](../../../docs/sdk/api.md#the-declaration), environment declaration.** The local environment can truthfully claim different containment on each platform. Replace the `commandContainment` cell with: **“From the working environment, for the current platform. `processGroup` for local implementations that only contain the command group; `strong` only where the environment confirms containment of all descendants.”** Replace the `erasure` cell with: **“True where the history store and agent implement erasure; false for a memory store without erasure.”**
4. **Resolved in the revision.** **[Testing — Finding fixture programs](../../../docs/sdk/testing.md#finding-the-fixture-programs), waiting for group exit.** A killed orphan may be an unreaped zombie in a container. Replace the wait clause with: **“Wait until no member of the process group can run; a zombie counts as exited. Reopen only then.”**
5. **Resolved in the revision.** **[API — Building an agent](../../../docs/sdk/api.md#building-an-agent), requirements for kept history.** The shorter wording says missing `dataDir` is an error even when a persistent history store is explicit. Replace it with: **“A kept or durable agent without `dataDir` MUST supply a persistent history store. A durable agent MUST use a Runtime that declares `continuesAfterRestart`.”**
6. **Resolved by the revised guides' catalog note.** **[Guide 01 — Ask a question](../../../docs/sdk/guides/01-first-agent.md#ask-a-question), catalog.** The literal `openai/gpt-6-luna` is not offered by the installed OpenAI adapter. Replace the catalog note with: **“Use a ModelRef offered by the Provider you installed. To see its catalog, call `openai().models()`; pick a model explicitly. The scripted Provider in the tests always offers `scripted/script`.”**
7. **Partially resolved: the revision asks SDKs to test with their own fixture, but still has no offline TypeScript block.** **[Guide 03 — Load it into an agent](../../../docs/sdk/guides/03-tool-in-another-process.md#load-it-into-an-agent), offline TypeScript block.** The guide has no offline TypeScript example. Append this block after the production example, with `program` set to the absolute built fixture program and `node` to `process.execPath`:

   ```ts
   const agent = await testAgent({
     script: [
       { toolCalls: [{ name: "tide", input: { harbour: "Whitby" } }] },
       { text: "High tide is at 14:02." },
     ],
     processPlugins: [{ command: [node, program, "tide"] }],
   });
   try {
     const turn = await (await agent.session()).prompt("When is high tide at Whitby?");
     assert.equal(turn.toolResults()[0].text(), "High tide at Whitby is 14:02.");
   } finally {
     await agent.close();
   }
   ```
8. **Resolved in the revision.** **[API — Sessions and turns](../../../docs/sdk/api.md#sessions-and-turns), result representation.** The API and binding do not specify how a text-only Provider supplies a candidate `value`. Replace the structured-result paragraph with: **“A structured result is requested with `options.result`, a schema. A Runtime using a text-only Provider parses the final answer as one JSON value, without removing markup. It submits the candidate to `turn.result`; missing, malformed or schema-invalid values are refused with recorded feedback. `PromptResult.value` on completion is the checked JSON value, including JSON null. Validator transforms are not part of the portable result.”**
9. **Resolved in the revision with a stricter rule: every overrun disconnects and an absent cursor is `null`.** **[API — Events](../../../docs/sdk/api.md#events), lag recovery.** Replace the final sentence with: **“On a committed-entry overrun, disconnect the stream with `lost` and `data.fromEntry` holding the last delivered entry ID, if any. Resume after that cursor, or from the start if absent. The SDK may drop unrecorded live deltas rather than disconnect.”**
10. **Resolved in the revision: durable store eligibility with a test-only memory exception.** **[Placement — Services](../../../docs/sdk/placement.md#services), custom stores.** Replace the `serveHistory` bullet with: **“`serveHistory(store, { address, tokenFile })` serves each shipped history store. A custom store can be served only if it supports the binding’s opaque JSON, exact batch and tombstone semantics, and writer leasing. Reject an unsupported store rather than substituting another backend.”**
11. **[API — Building an agent](../../../docs/sdk/api.md#building-an-agent), scratch versus recovery.** The blanket missing-`dataDir` rule conflicts with the default local environment's disposable command bookkeeping in [Concepts](../../../docs/sdk/concepts.md#defaults). Replace the `dataDir` default cell with: **“None. Required when a selected part needs local state to survive restart, or when kept/durable uses the default file history. Ephemeral parts may use SDK-managed scratch storage for bookkeeping that is not needed after restart.”**
12. **[API — The declaration](../../../docs/sdk/api.md#the-declaration), served Runtime capabilities.** [Plugin /1](../../../docs/bindings/plugin.md#starting-the-handshake) defines no nesting or queue-recovery flags in `RuntimeSupports`. Do not add private wire fields and let them govern authority or recovery. Replace the three Runtime-dependent rows with: **“`nestedToolCalls`: true when the host and its installed Runtime path support nested calls. In-process support may be declared by the Runtime; for a served Runtime, the host may determine support from its own Runtime bridge, which settles the nested calls. `queuedInputAfterRestart` and `queuedJobReportsAfterRestart`: the policies enforced by the host; an in-process Runtime may supply those policies. For a served Runtime use the host's own policies unless the binding defines negotiation. Omit the job policy when it equals the input policy.”**
13. **[API — Errors / Providers](../../../docs/sdk/api.md#providers), unknown model on ACP.** The SDK names `invalid_request` for unknown models, but ACP uses that named code for JSON depth, not a bad configuration value. Replace the SDK sentence about unknown models with: **“The SDK refuses an unknown model before admission, with `invalid_request` at the embedded and plugin Provider boundaries. An ACP Interface refuses an unknown model configuration value with the binding's `invalid_params`.”**
14. **[API — Tools](../../../docs/sdk/api.md#tools), result processing failure.** A hook can turn a valid value into an invalid one; [core settlement](../../../docs/contracts.md#settlement) still requires a safe settlement with confirmed status. Replace the result-validation clause with: **“The host checks the completed result's `value` against `returns` after `tool.after`. If result processing fails, never expose the invalid value: keep a minimal safe result with the confirmed status and fail the enclosing operation, as specified in Settlement.”**

### Findings from guides 05 and 09

- **[API — Sessions and turns](../../../docs/sdk/api.md#sessions-and-turns):** Add: “`lastTurn()` returns the latest settled turn as a PromptResult, or no value if none exists; it does not admit input. In TypeScript it returns `Promise<PromptResult | undefined>`.”
- **[API — The declaration](../../../docs/sdk/api.md#the-declaration):** Explicit persistent history can be used with an `ephemeral` TypeScript agent and is reported as portable. In the guide, say: “With the default in-memory history, an `ephemeral` session cannot reopen in a new process. To opt into portable history consistently across SDKs, use `kept` or `durable`.”
- **[Placement — Services](../../../docs/sdk/placement.md#services):** Add for TypeScript: “`serveHistory(fileHistory(dir), { address, tokenFile })` resolves to `{ url, close }` after it starts listening; use port 0 to let the OS choose a port for tests, and await `close()` when done.”

### Current findings

- **[API — Providers](../../../docs/sdk/api.md#providers), catalog changes across the binding.** Add: “The in-process notifier is `changed()`. Plugin `/1` has a catalog query but no Provider catalog-change notification. The host can refresh a served catalog with `provider/models`; an SDK MUST NOT invent a private notification.” In TypeScript, use `defineProvider(...)` to get `changed()`, and `agent.refreshModels()` to refresh served catalogs.
- **[Guide 04 — Answer from your UI](../../../docs/sdk/guides/04-questions-and-approvals.md#ask-for-a-choice-and-answer-from-your-ui):** Replace the TypeScript limitation with: “TypeScript lists open questions with `await session.questions()` and answers by ID with `await session.answer(id, answer)`. No handler is needed for a waiting choice question.”
- **[Guide 08 — Know who is acting](../../../docs/sdk/guides/08-drive-an-agent-over-acp.md#know-who-is-acting):** Replace the TypeScript limitation with: “The TypeScript SDK accepts an operator-set `actorId` in `serveAcp` options, then falls back to `MODULAR_AGENT_ACTOR` and to `acp-user`. Nothing in a client request sets this identity.” Add to the project option: “`compose(project, saved?)` receives `SessionInfo` when reopening; project settings and the trusted MCP server map may be returned asynchronously.”
- **[API — Declaration](../../../docs/sdk/api.md#the-declaration):** Replace the `holdsOutput` cell with: “True if an installed output gate holds streams to their end; false otherwise. A remote output gate requires holding as the plugin binding specifies.”
- **[API — Commands](../../../docs/sdk/api.md#commands), missing model context contract.** Model-using commands are rejected in TypeScript; directly exposing the underlying model adapter would skip normal Provider hooks and tenant accounting. Add: “An in-process model-using command requests inference through a call-scoped command context. Command inference uses the current model and the Provider gates, is metered against the session's tenant and cannot dispatch model tools or start a turn.”
- **Remaining implementation work:** The WebSocket service placement in the current SDK specification is not implemented in TypeScript; the stdio plugin and ACP paths and the HTTP history service are independent of it.
