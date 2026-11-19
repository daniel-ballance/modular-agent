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
MODULAR_AGENT_SDK_REQUIRE=rust,typescript,go npm test
MODULAR_AGENT_SDK_REQUIRE=rust,typescript,go MA_REMOTE=provider-pi-ai,runtime-transient,tools-files,env-local npm test
node --test packages/{core,fixtures}/dist/test/*.test.js
(cd sidecars/claude && npm ci && npm test)
```

- **Base:** 100 tests. Each `npm test` invocation passed 158 tests (100 base, 30 SDK-specific, 28 shared runs), both with the standard placement and with the four parts above remote. There is no separate lint or formatter script; `git diff --check` passes. The Claude sidecar passes 44 tests independently.
- **Kits:** ACP passes 116/116 on the normal CLI, 117/117 with HTTP history, 203/203 with the fixture plugins served, and 140/140 with the served durable Runtime and the crash checks. The plugin kit passes 146/146. The base history service and the SDK file, memory and upstream HTTP relay placements each pass the history kit (39/39 per placement).
- **SDK:** 21 core tests and 9 integration tests. These cover the guide examples offline, streaming and cursor lag, startup and replacement, typed tools and checked prompt results, hooks and commands, local and served nested calls (including cancellation, depth and recovery), parts, real ACP stdio, both API-key Providers over loopback, and history over HTTP.
- **Shared matrix:** 28 scenarios per runner, 84 total across TypeScript, Rust and Go. Each runs the seven shared scenarios in process and against each of the three fixture programs. The crash cases kill the helper's process group and wait for running members to exit before reopening. Both crash cases keep a single increment and settle the started call `outcomeUnknown`; only durable recovery continues the turn.
- **Negative runner check:** a temporary copy of `first-turn.json` expected `WRONG`. The runner reported `first-turn (inProcess) step 0: text: want "WRONG", got "Hello."`; the shared file was unchanged.

Build the fixtures and run the three-way matrix from the repo root:

```sh
(cd rust && mise exec -- cargo build -p sdk-scenarios --bin modular-agent-fixtures)
(cd go && mise exec -- go build -o .bin/modular-agent-fixtures ./modular/cmd/fixtures)
(cd typescript && npm ci && npm run build)
export MODULAR_AGENT_SDK_REQUIRE=rust,typescript,go
(cd typescript && node --test packages/fixtures/dist/test/shared.test.js)
mkdir -p "$HOME/.cache/ma-std-tmp"
(cd rust && TMPDIR=$HOME/.cache/ma-std-tmp mise exec -- cargo test -p sdk-scenarios --test shared)
(cd go && mise exec -- go test -count=1 ./modular/scenarios)
```

The SDK adds Ajv 8 (its [2020-12 entry point](https://ajv.js.org/json-schema.html#draft-2020-12)) to validate plain schemas and the JSON Schema exported by validators. The base already uses `json-schema-to-ts`, used here for plain-schema inference, and Zod 4, used by fixtures and tests. The OpenAI and Anthropic packages use the base's Pi AI adapter, not another vendor SDK.

## Built so far

| Milestone | State |
|---|---|
| 1. Agent composition | Built: project, dataDir, durability, providers, tools, plugins, process plugins, model selection, settings, approval and question handler. Explicit history, Runtime, working environment and credential store supported. Public constructors are available for each; the shipped credential stores are read-only. |
| 2. Sessions | Create, recover on reopen, prompt, prompt stream, last turn, history, send, cancel, settings, fork, close, and cursor replay with a bounded live feed. A prompt with `result` parses the final text as one JSON value and validates it through `turn.result`; schema failures record feedback before retry. `null` is a value; absent or invalid JSON is not. |
| 3. Local actor | `user` is present to answer only when there is a handler. No handler means immediate refusal for an approval. |
| 4. Tools | Standard Schema JSON Schema export and plain JSON Schema; typed input, hints, content and structured tool results, refusal, cancellation, progress, logging, environment and question contexts. |
| 5. Errors | `AgentError` with a string-union code. Some uncoded base errors still map to `internal`. |
| 6. Plugins | Config, item replacement, tools and changing tool catalogs, Providers, named hooks, plain commands, Runtime and environment; also in-process history, credential stores, configuration and Interfaces. Job registration, custom-hook invocation and model-using commands are not public. |
| 7. Serve | stdio `/1`: initialize, tools, questions, environment (including directory listing), Runtime, hooks, Providers, commands and shutdown. Explicit in-process-only registrations are rejected. |
| 8. Process plugins | Uses the base host with the minimal environment. Invalid startup fails composition; a lost dispatched tool has unknown outcome. |
| 9. Testing | Scripted Provider, test agent, answers, memory environment, overWire, four fixtures, registry and both swaps. `restart(agent)` interrupts an in-process agent without running its session or plugin shutdown hooks and rebuilds it over the same store. It does not simulate killing external services; the shared suite kills a real process. |
| 10. Guides | The offline guide 01 and 02 examples are checked. Guide 03's TypeScript loading block uses a real Provider and a deployed Python program. The proposed offline example below is tested with the fixture program. |
| 11. Providers | Core interface and `@modular-agent/openai`, `@modular-agent/anthropic`. Loopback SSE and rejected API keys checked. |
| 12. Nested calls | `context.tools.list()` and `.call()` work in process and over `/1`. The Harness supports **eight child levels** under a top-level invocation; deeper requests settle refused. The Harness authorizes, commits and settles children, including on cancellation or recovery. `modelTools` narrows only the model offer. ACP declares `nestedToolCalls` and identifies the parent on the child's first update. |
| 13. Declaration and ACP | SDK declaration and a prompt over real ACP stdio checked. No new ACP binding implementation. |
| 14. History over HTTP | `serveHistory` accepts the shipped `memoryHistory()`, `fileHistory(dir)` and `httpHistory(url, tokenFile)` stores. Memory and explicit file handles share the same archive with embedded agents; the HTTP handle relays the binding without reinterpreting upstream leases or opaque JSON. Default kept/durable data directories still use base JSONL for compatibility. |

## Where the base and the specification differ

| Difference | Handling |
|---|---|
| The base gives setup the whole `PluginApi`, and its ordinary loader may report a problem and continue. | Collect SDK registrations without any live session rights. Expose call contexts, not `PluginApi`. Validate collisions and fail the SDK composition on setup or registration problems. |
| The base can leave sessions without a history store. | Always install a store; the SDK memory store supports reopen and fork until the agent ends. |
| Local file operations in the base were not confined to the project. | The SDK enables the base's new root check, including symlink targets. Process containment is a separate declaration; on Linux the base tracks descendants, not just the process group. |
| The base supports late answers and jobs. | The SDK disables leaving a question open and does not expose jobs. |
| Base Runtime hooks and wire hooks need different scopes in some cases. | Translate hook answers at the registration boundary. In-process and served hooks have a shared subset. Base hook execution now rechecks changed tool input. |
| The base exposes its own local and remote history constructors. | SDK stores are handles. The service shares the archive behind the handle, or relays a history HTTP service, on numeric loopback. An explicit `fileHistory(dir)` uses SQLite; migration from an existing base JSONL directory is offline. |
| The base's model catalog varies with the installed Pi AI version. | The SDK filters OpenAI to Responses and Anthropic to Messages. In examples choose an id from the installed Provider's catalog. |
| The base and some existing hooks include details not present in the SDK's type declarations. | The SDK keeps opaque data unchanged when storing and relaying the shared shapes. It does not accept a wider wire contract based on those extra properties. |

## Findings for the SDK specification

1. **[API — Tools](../../../docs/sdk/api.md#tools), failed/refused wording.** The table says an error's message or bare reason; base runtimes can add a prefix (`Tool failed: …` in TypeScript, `Refused: …` in Rust). Placement equality is meaningful even when SDKs use different diagnostic wording. Replace the failed/refused Content cells with: **“The diagnostic includes the error message or refusal reason. An SDK may add a fixed prefix; the same SDK tool MUST produce the same diagnostic in process and served. Clients branch on status, not on text.”** A shared scenario should add a fixture tool that calls `refuse("the quay is closed")`; require status `refused` and the reason across hosts, and compare the entire rendering between each SDK's own local and served placement.
2. **[API — Plugins](../../../docs/sdk/api.md#plugins), preflight vs config.** An arbitrary `setup` cannot be run before `plugin/initialize` supplies config. Insert: **“A servable program can reject a statically visible in-process-only registration before opening stdio. If the item is discovered in `setup`, reject `plugin/initialize` with `not_supported`, naming the item, and return no registration. Do not run `setup` twice to preflight the program.”**
3. **[API — Agent](../../../docs/sdk/api.md#the-declaration), environment declaration.** The local environment can truthfully claim different containment on each platform. Replace the `commandContainment` cell with: **“From the working environment, for the current platform. `processGroup` for local implementations that only contain the command group; `strong` only where the environment confirms containment of all descendants.”** Replace the `erasure` cell with: **“True where the history store and agent implement erasure; false for a memory store without erasure.”**
4. **[Testing — Finding fixture programs](../../../docs/sdk/testing.md#finding-the-fixture-programs), waiting for group exit.** A killed orphan may be an unreaped zombie in a container. Replace the wait clause with: **“Wait until no member of the process group can run; a zombie counts as exited. Reopen only then.”**
5. **[API — Building an agent](../../../docs/sdk/api.md#building-an-agent), requirements for kept history.** The shorter wording says missing `dataDir` is an error even when a persistent history store is explicit. Replace it with: **“A kept or durable agent without `dataDir` MUST supply a persistent history store. A durable agent MUST use a Runtime that declares `continuesAfterRestart`.”**
6. **[Guide 01 — Ask a question](../../../docs/sdk/guides/01-first-agent.md#ask-a-question), catalog.** The literal `openai/gpt-6-luna` is not offered by the installed OpenAI adapter. Replace the catalog note with: **“Use a ModelRef offered by the Provider you installed. To see its catalog, call `openai().models()`; pick a model explicitly. The scripted Provider in the tests always offers `scripted/script`.”**
7. **[Guide 03 — Load it into an agent](../../../docs/sdk/guides/03-tool-in-another-process.md#load-it-into-an-agent), offline TypeScript block.** The guide has no offline TypeScript example. Append this block after the production example, with `program` set to the absolute built fixture program and `node` to `process.execPath`:

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
8. **[API — Sessions and turns](../../../docs/sdk/api.md#sessions-and-turns), result representation.** The API and binding do not specify how a text-only Provider supplies a candidate `value`. Replace the structured-result paragraph with: **“A structured result is requested with `options.result`, a schema. A Runtime using a text-only Provider parses the final answer as one JSON value, without removing markup. It submits the candidate to `turn.result`; missing, malformed or schema-invalid values are refused with recorded feedback. `PromptResult.value` on completion is the checked JSON value, including JSON null. Validator transforms are not part of the portable result.”**
9. **[API — Events](../../../docs/sdk/api.md#events), lag recovery.** Replace the final sentence with: **“On a committed-entry overrun, disconnect the stream with `lost` and `data.fromEntry` holding the last delivered entry ID, if any. Resume after that cursor, or from the start if absent. The SDK may drop unrecorded live deltas rather than disconnect.”**
10. **[Placement — Services](../../../docs/sdk/placement.md#services), custom stores.** Replace the `serveHistory` bullet with: **“`serveHistory(store, { address, tokenFile })` serves each shipped history store. A custom store can be served only if it supports the binding’s opaque JSON, exact batch and tombstone semantics, and writer leasing. Reject an unsupported store rather than substituting another backend.”**
