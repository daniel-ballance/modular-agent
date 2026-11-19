# `@modular-agent/core`: the TypeScript SDK

The TypeScript SDK implements the [SDK specification](../../../docs/sdk/README.md) over the TypeScript edition 3 build. An app uses `Agent` and `Session`, not a Harness. Plugins register parts once and get contexts for individual calls.

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
npm test
MA_REMOTE=provider-pi-ai,runtime-transient,tools-files,env-local npm test
node --test packages/{core,fixtures}/dist/test/*.test.js
(cd sidecars/claude && npm ci && npm test)
```

- **Base:** 100 tests, including the ACP and history conformance kits. The base tests also run with the four parts above remote. With the two built fixture programs, each `npm test` invocation runs 138 tests (100 base, 17 SDK-specific, 21 scenarios). There is no separate lint or formatter script; `git diff --check` checks patch whitespace. The Claude sidecar runs 44 tests independently.
- **SDK:** 12 core tests and 5 integration tests. These cover guides 01/02, streaming, startup, item replacement, schema checks, tool settlement, a stale context, hooks and commands, cancellation, a real ACP client, both API-key Providers over loopback, and history over HTTP.
- **Scenarios:** 21 runs when Rust and TypeScript are built: seven in process, seven with the TypeScript fixture program, and seven with Rust. The crash cases SIGKILL the helper's entire process group and wait for running group members to exit before reopening. On Linux zombies are already dead and cannot race recovery. Both crash cases keep a single increment and settle the started call `outcomeUnknown`; only durable recovery continues the turn.
- **Reverse swap:** the Rust runner passes its two tests, comprising 21 runs with this registry: seven in process, seven served by Rust, and seven served by TypeScript.
- **Negative runner check:** a temporary copy of `first-turn.json` expected `WRONG`. The runner reported `first-turn (inProcess) step 0: text: want "WRONG", got "Hello."`; the shared file was unchanged.

To require the Rust placement and run both directions, from the repo root:

```sh
(cd rust && mise exec -- cargo build -p sdk-scenarios --bin modular-agent-fixtures)
(cd typescript && MODULAR_AGENT_SDK_REQUIRE=rust node --test packages/fixtures/dist/test/shared.test.js)
mkdir -p "$HOME/.cache/ma-std-tmp"
(cd rust && TMPDIR=$HOME/.cache/ma-std-tmp MODULAR_AGENT_SDK_REQUIRE=typescript mise exec -- cargo test -p sdk-scenarios --test shared)
```

The SDK adds Ajv 8 (its [2020-12 entry point](https://ajv.js.org/json-schema.html#draft-2020-12)) to validate plain schemas and the JSON Schema exported by validators. The base already uses `json-schema-to-ts`, used here for plain-schema inference, and Zod 4, used by fixtures and tests. The OpenAI and Anthropic packages use the base's Pi AI adapter, not another vendor SDK.

## Built so far

| Milestone | State |
|---|---|
| 1. Agent composition | Built: project, dataDir, durability, providers, tools, plugins, process plugins, model selection, settings, approval and question handler. Explicit history supported. Public Runtime, local environment and credential constructors are not yet exposed. |
| 2. Sessions | Built: create, recover on reopen, prompt, prompt stream, last turn, history, send, cancel, settings, fork and close. A schema for the final prompt result is not yet supported. |
| 3. Local actor | `user` is present to answer only when there is a handler. No handler means immediate refusal for an approval. |
| 4. Tools | Standard Schema JSON Schema export and plain JSON Schema; typed input, hints, content and structured tool results, refusal, cancellation, progress, logging, environment and question contexts. |
| 5. Errors | `AgentError` with a string-union code. Some uncoded base errors still map to `internal`. |
| 6. Plugins | Config, item replacement, tools, Providers, named hooks and commands. Parts beyond these, custom-hook invocation and model-using commands are not public. |
| 7. Serve | stdio `/1`: initialize, tools, questions, hooks, Providers, commands and shutdown. Explicit in-process-only registrations are rejected. |
| 8. Process plugins | Uses the base host with the minimal environment. Invalid startup fails composition; a lost dispatched tool has unknown outcome. |
| 9. Testing | Scripted Provider, test agent, answers, memory environment, overWire, four fixtures, registry and both swaps. The in-process `restart` helper is not implemented; the shared suite kills a real process. |
| 10. Guides | The offline guide 01 and 02 examples are checked. Guide 03's TypeScript loading block uses a real Provider and a deployed Python program. The proposed offline example below is tested with the fixture program. |
| 11. Providers | Core interface and `@modular-agent/openai`, `@modular-agent/anthropic`. Loopback SSE and rejected API keys checked. |
| 12. Nested calls | Not implemented. The base still needs `host/tools/list` and `host/tools/call` bound to their live parent, child cancellation and settlement before that parent, recovery that never repeats a child independently, and `modelTools` and ACP parent attribution. Neither the SDK nor ACP declares nested support. |
| 13. Declaration and ACP | SDK declaration and a prompt over real ACP stdio checked. No new ACP binding implementation. |
| 14. History over HTTP | `httpHistory` and `serveHistory(fileHistory(dir), options)` use the base implementation; another agent reopens the kept session. The base HTTP server only accepts disk storage. |

## Where the base and the specification differ

| Difference | Handling |
|---|---|
| The base gives setup the whole `PluginApi`, and its ordinary loader may report a problem and continue. | Collect SDK registrations without any live session rights. Expose call contexts, not `PluginApi`. Validate collisions and fail the SDK composition on setup or registration problems. |
| The base can leave sessions without a history store. | Always install a store; the SDK memory store supports reopen and fork until the agent ends. |
| Local file operations in the base were not confined to the project. | The SDK enables the base's new root check, including symlink targets. Process containment is a separate declaration; on Linux the base tracks descendants, not just the process group. |
| The base supports late answers and jobs. | The SDK disables leaving a question open and does not expose jobs. |
| Base Runtime hooks and wire hooks need different scopes in some cases. | Translate hook answers at the registration boundary. In-process and served hooks have a shared subset. Base hook execution now rechecks changed tool input. |
| The base exposes its own local and remote history constructors. | SDK stores are handles. The HTTP service reuses the base's directory-backed service and is bound to numeric loopback. |
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
