# Claude subscription Provider

`claude()` from `@modular-agent/claude` is a Provider for `createAgent({ providers: [claude()] })`. The package also serves it as a plugin for the [plugin binding](../../../docs/bindings/plugin.md) `modular-agent-plugin/1`. It serves one part: a **Provider** named `claude` that reaches Claude models through the [Claude Agent SDK for TypeScript](https://code.claude.com/docs/en/agent-sdk/overview) and the Claude subscription that Claude Code is signed in to on this machine. It uses no API key. A host that loads it offers its models as `claude/<model-id>`.

The Agent SDK is used as a plain model endpoint. The Harness keeps the agent loop, the tools, the system prompt and the history:

- The Provider passes the host's system prompt unchanged, without selecting a Claude Code preset. Claude Code can still add its own context.
- The host's tool definitions are the only tools the model is shown. Claude Code's built-in tools are off (`tools: []`), and so are settings files, hooks, `CLAUDE.md` memory, MCP configuration, bundled skills and session files.
- When the model asks for a host tool, the sidecar does not run it. The sidecar ends the request as soon as the model's message is complete and returns an assistant message with `toolCall` parts and `stop: "toolUse"`. The host runs the tool and sends a new `provider/request` that includes the result.
- Text and thinking are sent as `provider/event` notifications while the request runs. The final message carries usage.

It is a port of the approach in the Pi extension `claude-subscription`, cut down to what a stateless Provider needs.

## Build and test

Node.js 22 or newer.

```sh
cd typescript
npm ci
npm run build
npm test --workspace=@modular-agent/claude
```

`@anthropic-ai/claude-agent-sdk` is pinned to `0.3.323`, the version the reference package has installed. The SDK ships the Claude Code binary as an optional platform package (`@anthropic-ai/claude-agent-sdk-linux-x64` here, about 250 MB). `npm install --ignore-scripts` installs it; no postinstall step is needed. Do not install with `--omit=optional`.

The entry point is `node typescript/packages/claude/dist/src/main.js`. It speaks the binding on stdin and stdout. Only protocol frames go to stdout. Diagnostics go to stderr. Per-request detail is logged only when `CLAUDE_SIDECAR_DEBUG` is set.

## Launch configuration

The Rust host reads `MODULAR_AGENT_PLUGINS`. Use absolute paths. The value that launches this sidecar from this checkout:

```sh
export MODULAR_AGENT_PLUGINS='[{"command":["/ABSOLUTE/PATH/TO/node","/ABSOLUTE/PATH/TO/REPO/typescript/packages/claude/dist/src/main.js"],"env":{"HOME":"/home/YOUR_USER"}}]'
```

For example, built in the shell:

```sh
export MODULAR_AGENT_PLUGINS="$(printf '[{"command":["%s","%s"],"env":{"HOME":"%s"}}]' "$(command -v node)" "$PWD/typescript/packages/claude/dist/src/main.js" "$HOME")"
```

### Environment the launch must pass

The host starts a plugin with a minimal environment ([plugin binding, "Choosing plugins at start"](../../../docs/bindings/plugin.md#choosing-plugins-at-start)). The Rust host passes `PATH` and whatever `env` lists, and nothing else. Claude Code has to find its login, so the launch must pass one of these:

| Variable | When | Notes |
|---|---|---|
| `HOME` | Claude Code is signed in for this user in the usual place (`~/.claude`) | The normal choice. This is what the real run below used. |
| `CLAUDE_CONFIG_DIR` | Claude Code's configuration directory is somewhere else | Pass it instead of, or with, `HOME`. Claude Code also writes its own state there, so it must be writable. |
| `CLAUDE_CODE_OAUTH_TOKEN` | A machine with no browser login, using the token `claude setup-token` prints | Works, but it puts a credential in the launch environment, which [Security](../../../docs/security.md#plugins) tells a host not to do. Prefer `HOME`. |

`PATH` is not needed by Claude Code itself: the SDK runs the binary from its own platform package. It is needed only if `command[0]` is a bare `node`.

Without any of these the sidecar still starts and registers, and answers `provider/available` with `available: false`.

The Provider never opens a credential file. It checks whether a login may be present by checking for the credential file's existence or an OAuth token variable. Claude Code then reports whether the account has a plan. `claude().availability()` reports readiness and includes a reason when unavailable, if one is known. Over the plugin binding, `provider/available` includes that reason when the Provider is unavailable. API routing variables and an API key source reported by Claude Code both make the Provider unavailable; no prompt is sent.

Anthropic decides how Agent SDK usage is counted against a plan. This sidecar is for your own use with your own account.

### Files it writes

Only `catalog.json` in the `home` folder from `plugin/initialize`: the model list Claude Code last reported, kept for a day. Claude Code keeps its own state in its configuration directory, as it always does. No conversation is written to disk (`persistSession: false`).

## Stateless, and why

The Provider registers `keepsState: false`, `runsTools: false`. Every `provider/request` starts one Claude Code process, gives it the whole request, returns one assistant message to the host and closes the process. Parallel requests use separate processes. `sessionId` is accepted and passed to the hooks but not otherwise used. `provider/discard` has nothing to discard and answers `{}`; with `erase: true` it answers `outOfReach`, since copies Anthropic holds cannot be named or deleted from here.

The Agent SDK accepts only user input. Earlier messages go in as a marked text record in one user turn (`<history:MARK>` with `<user:MARK>`, `<assistant:MARK>`, `<tool-call:MARK>` and `<tool-result:MARK>` entries). Trailing user messages follow as written. Images keep their place. The reference uses this replay format after every restart, compaction or branch.

The Provider hashes the first replayed entry to choose the mark. As messages are appended, the mark and existing record prefix stay the same for prompt caching unless a replayed entry contains the mark after a colon. When that happens, the Provider tries deterministic alternatives until it finds a mark that never follows a colon in the entries. This keeps quoted tags from acting as boundaries.

The record header, each entry and the closing tag occupy separate content blocks. Images split an entry at their original positions. Unless the operator has disabled prompt caching, the Provider adds one five-minute cache breakpoint to the last entry, before the closing tag and any new user input. The pinned SDK forwards that breakpoint when the Provider turns off Claude Code's automatic breakpoints for replay. This avoids both the API's TTL ordering error and its limit of four breakpoints. [Anthropic's prompt caching rules](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) give the model-specific token minimums and the 20-block lookback window.

The reference normally does something more involved: it keeps one Claude Code process alive per conversation and holds each tool call open until Pi supplies the result, which gives the model native history, its own thinking and a warm prompt cache. That is an optimisation there, not a necessity, and it would need the stateful Provider rules (`sessionId` on every request, exact-prefix proof, `provider/discard`, reset on move, fork, compaction and model change) plus a pool of long-lived processes. This Provider uses stateless replay instead. Earlier turns are not sent as native messages, and reasoning parts are not replayed.

Failed and aborted assistant messages in the request are not replayed, and neither is a tool result whose call is not in a replayed assistant message.

## Models

The built-in list comes from the [shared subscription model table](../../../docs/sdk/subscription-models.json). After `plugin/initialize`, if a login is visible and `home/catalog.json` is missing, older than a day or from another SDK version, the sidecar starts Claude Code once without a prompt and asks which models the account offers. Readiness answers as soon as Claude Code reports whether the account uses a plan. The list narrows to the models the account offers. The sidecar reads their context windows in the background, without delaying requests. These windows can be smaller than the API's. A model Claude Code names that the built-in list does not know gets 200,000 context, 32,000 output and the effort levels Claude Code gave for it. `provider/models` always returns the current list, so it can change shortly after start.

## Reasoning levels

`ModelInfo.thinking` lists the shared levels each model accepts. `settings.reasoning` maps as follows.

| Shared level | Newer models (adaptive thinking, steered by effort) | 4.5 models (thinking budget) |
|---|---|---|
| absent | nothing set; Claude Code's default | nothing set; Claude Code's default |
| `off` | thinking disabled | thinking disabled |
| `minimal` | effort `low` | 1,024 tokens |
| `low` | effort `low` | 2,048 tokens |
| `medium` | effort `medium` | 8,192 tokens |
| `high` | effort `high` | 16,384 tokens |
| `xhigh` | effort `xhigh` | not offered |

Which levels a model lists follows the reference: Fable 5.x cannot switch thinking off; Haiku 5.5 has no `minimal`; Opus 5.5 and Sonnet 5.5 have neither `off` nor `minimal`; Opus 4.6 and Sonnet 4.6 have no `xhigh`. A level the model does not list is lowered to the nearest listed level below it, or left unset if there is none, as [shared data](../../../docs/bindings/data.md#models) requires. It is never raised. Claude's `max` effort has no shared level name and cannot be selected.

`settings.maxOutput` is capped at the model's `maxOutput` and passed to Claude Code as `CLAUDE_CODE_MAX_OUTPUT_TOKENS` for that one process.

## Other mappings

- **Tool names.** Claude Code shows each host tool to the model as `mcp__host__<name>`. Names with characters outside `[A-Za-z0-9_-]`, or too long, get a stable replacement. The sidecar maps the name back, so the host sees its own names. Host tool names are also registered as aliases, so a model that uses the plain name still works.
- **Tool call ids.** A `toolCall` part's `id` is Claude's `tool_use` id (`toolu_...`). `toolInput` stream events carry the same id.
- **Stop.** `end_turn` and `stop_sequence` give `finished`; `tool_use` gives `toolUse`; `max_tokens` gives `length`; `refusal` gives `refused` with an error of kind `refused`. A tool call cut off by the output limit is dropped.
- **Temperature and stop sequences.** Claude Code owns these settings; the Provider does not set them.
- **Unoffered tools.** Claude Code answers an attempt to call an unoffered tool with an error and can continue the turn within the same request. The Provider does not report the attempt as a host tool call.
- **Usage.** `input`, `output`, `cacheRead` and `cacheWrite` are Anthropic's token counts for the request. A subscription is not billed per token. The Provider reports `cost: 0` under the [partial-meter rule](../../../docs/bindings/data.md#messages), not as a Claude Code price estimate.
- **Errors.** A failure after the `provider.request` hook is an assistant message with `stop: "failed"` and an `error`. Kinds: a rejected or missing login is `credentials`; rate limits, overload and server errors are `temporary`; "prompt is too long" is `contextTooLarge`; the rest is `other`. Protocol errors are used only for an unknown Provider or model, a malformed request, a failed `provider.request` hook (the host's error is passed back) and cancellation.
- **Cancel.** `$/cancel` closes the Claude Code process at once and the request answers `cancelled`. No `provider.response` hook is called for a cancelled request.

## Verification

### Offline tests: 55 pass

`npm test`, with a scripted fake in place of the SDK's `query()`:

- `models.test.ts` (6): catalog shape, level mapping, nearest level, narrowing.
- `transcript.test.ts` (10): ModelRequest to SDK input, stable replay blocks, breakpoint placement and boundary collisions.
- `response.test.ts` (11): SDK output to the assistant message (text, thinking, tool calls, usage, stop reasons), error kinds, token scrubbing.
- `provider.test.ts` (15): requests against the fake SDK, cancellation, catalog changes after readiness, and closing the probe on shutdown or at the deadline.
- `api.test.ts` (3 offline, one gated live): the public constructor in process and over the plugin binding, including an API key source refusal.
- `stdio.test.ts` (10): a host starts `dist/src/main.js` with the fake SDK and drives it over stdio. The tests cover the catalog, readiness and reasons for unavailability, discard, hooks, streaming, failures, cancellation and shutdown.

The fake is selected in the built program with `CLAUDE_SIDECAR_TEST_FAKE_SDK` (test only; `signed-out` makes it report no login). It starts no process and reaches no model.

### Conformance kit

`conformance/plugin/run.mjs` checks a build's conformance plugin: Provider `conformance` with the scripted model `echo`, the fixture tools, environment and hooks, and `MODULAR_AGENT_PLUGIN_PARTS`. This sidecar is a real Provider and serves none of those, so the kit's Provider checks cannot apply; `stdio.test.ts` covers that ground instead. Run anyway with the fake and `--no-runtime`, the checks that do not depend on the fixture all pass: 18 of 31, covering ping, 64 and 65 JSON levels, CRLF, batch and malformed frames, id handling, a reused id closing the connection, the `method_not_found` envelope, shutdown, exit on EOF and `not_supported` for an unknown binding version. The 13 failures are all for fixture parts this plugin does not register.

```sh
CLAUDE_SIDECAR_TEST_FAKE_SDK=1 node conformance/plugin/run.mjs --no-runtime -- "$(command -v node)" "$PWD/typescript/packages/claude/dist/src/main.js"
```

### Real run (2026-11-19)

Four real model requests in total, all on `claude-haiku-5-5`, Agent SDK 0.3.323, Claude Code 2.1.323, on a Max subscription.

The former `npm run live` check started the sidecar with only `PATH` and `HOME` in its environment, as the host does. All 11 checks passed:

- `provider/available` reported `available: true`. The catalog narrowed from 18 built-in models to the 13 the account offers.
- Request 1 (one-line system prompt, one user message, one tool `get_weather`, `reasoning: "off"`, `maxOutput: 1024`): `stop: "toolUse"`, content `[{"type":"toolCall","id":"toolu_...","name":"get_weather","arguments":{"city":"Paris"}}]`, usage `input 2, output 56, cacheWrite 1089`, three `toolInput` events. Claude Code reported its tool list as exactly `[mcp__host__get_weather]`. Claude Code did try the call once in the moment before its process was closed; the sidecar has nothing that could run it, held the call unanswered and logged "none ran".
- Request 2 (the same conversation plus the assistant message and a tool result): `stop: "finished"`, text "Paris is 18°C with light rain and wind at 7 km/h.", streamed as text events, no further tool call.
- Hooks ran in order (`provider.request`, then `provider.response`) and the sidecar exited with 0.

Two more requests went directly through the Provider. The no-tools request with `reasoning: "off"` returned only text (4 output tokens) and listed no tools. The tool-enabled replay of request 2, also with `reasoning: "off"`, returned an empty thinking block before the answer (110 output tokens total). The Provider does not stream empty thinking or include it in the final message.

Claude Code added an Agent SDK identity line and `<system-reminder>` context. The no-tools request counted 858 input tokens with a seven-word host system prompt; that count is for the whole input, not a measurement of the added text alone. The init message named built-in agents, plugins and skills, but the Provider disables bundled skills and offers no Agent or Skill tool. An init listing does not establish what text the model received.

### Rust-host smoke run (2026-11-19)

`ma --model claude/claude-haiku-5-5 -p ...`, using the Rust standard configuration, launched the sidecar with `HOME`, `PATH` and `CLAUDE_CONFIG_DIR`. The host's code tool read a file and ran a command over two tool rounds. The model then answered correctly.

### Replay prompt caching

[PR #225](https://github.com/daniel-ballance/modular-agent/pull/225) stabilized the replay mark, and [PR #231](https://github.com/daniel-ballance/modular-agent/pull/231) placed the cache breakpoint at a reusable block boundary. The live probe for [#227](https://github.com/daniel-ballance/modular-agent/issues/227) ran on 2026-11-26 with `claude()` directly, Haiku 5.5, Agent SDK 0.3.323 and Claude Code 2.1.323. An initial tool call supplied the first page of a synthetic inventory. Each of the next three requests replayed the record, called the same tool and added another 270-line page. Anthropic reported these token counts:

| Request | `cacheRead` | `cacheWrite` |
| --- | ---: | ---: |
| Initial, no replay | 0 | 1,383 |
| Replay 1 | 0 | 7,544 |
| Replay 2 | 7,544 | 6,636 |
| Replay 3 | 14,180 | 6,634 |

The live TypeScript `ma` Wave 2 run for #145 on Opus 5.5 reached a 91.84% cache hit rate (`cacheRead / (input + cacheRead + cacheWrite)`). The [#20 audit](https://github.com/daniel-ballance/modular-agent/issues/20#issuecomment-7209254792) records the run and its one full cache rewarm after an eight-minute wait.

<a name="known-gaps-and-open-problems"></a>

## Remaining work

[#265](https://github.com/daniel-ballance/modular-agent/issues/265) tracks the 0.6.0 live probes: reproducing the `reasoning: "off"` result, measuring Claude Code's added prompt text, hitting the `maxOutput` cap and checking how Claude Code handles an empty system prompt. [#20](https://github.com/daniel-ballance/modular-agent/issues/20) tracks broader live `ma` use.

## Where the binding had to be read closely or guessed

- **Cancel and the response hook.** Settled by edition 4 as this sidecar had guessed: a cancelled request answers `cancelled` and sends no `provider.response`.
- **A failed `provider.request` hook.** The binding says the Provider must wait for the successful answer. For an error answer (`cancelled`, `turn_limit`, `internal`, `lost`) the sidecar answers `provider/request` with the same error code and does no inference.
- **Erasure by a stateless Provider.** `provider/discard` with `erase: true` answers `{ "outOfReach": [...] }` with one descriptive string, following the wording "report those copies out of reach". The binding does not define the strings.
- **`sessionId` on a stateless Provider.** Accepted when present, never required, and copied into both hook payloads (`null` when absent, per [the hook table](../../../docs/bindings/plugin.md#from-core-hooks-to-wire-hooks)).
- **A level the model does not list.** Settled by edition 4: lower it, never raise it. The sidecar now does.
- **Opaque reasoning data.** Thinking signatures are not returned as `providerData`, because history is never sent back as native turns and the data would only add bytes.
- **The request after the hook.** If the hook answers with a request that is not a readable ModelRequest, inference has already been admitted, so the sidecar returns a `failed` message with kind `other` and still calls `provider.response`.
