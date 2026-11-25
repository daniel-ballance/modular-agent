# Claude subscription Provider

`claude()` from `@modular-agent/claude` is a Provider for `createAgent({ providers: [claude()] })`. The package also serves it as a plugin for the [plugin binding](../../../docs/bindings/plugin.md) `modular-agent-plugin/1`. It serves one part: a **Provider** named `claude` that reaches Claude models through the [Claude Agent SDK for TypeScript](https://code.claude.com/docs/en/agent-sdk/overview) and the Claude subscription that Claude Code is signed in to on this machine. It uses no API key. A host that loads it offers its models as `claude/<model-id>`.

The Agent SDK is used as a plain model endpoint. The Harness keeps the agent loop, the tools, the system prompt and the history:

- The host's system prompt is passed as the system prompt, with no Claude Code preset.
- The host's tool definitions are the only tools the model is shown. Claude Code's built-in tools are off (`tools: []`), and so are settings files, hooks, `CLAUDE.md` memory, MCP configuration, bundled skills and session files.
- When the model asks for a tool, nothing runs. The sidecar ends the request as soon as the model's message is complete and returns an assistant message with `toolCall` parts and `stop: "toolUse"`. The host runs the tool and sends a new `provider/request` that includes the result.
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

Without any of these the sidecar still starts and registers, and answers `provider/available` with `false`.

The Provider never opens a credential file. It checks whether a login may be present by checking for the credential file's existence or an OAuth token variable. Claude Code then reports whether the account has a plan. `claude().unavailableReason()` gives the reason after an availability check. Over the plugin binding, `provider/available` includes that reason when the Provider is unavailable. API routing variables and an API key source reported by Claude Code both make the Provider unavailable; no prompt is sent.

Anthropic decides how Agent SDK usage is counted against a plan. This sidecar is for your own use with your own account.

### Files it writes

Only `catalog.json` in the `home` folder from `plugin/initialize`: the model list Claude Code last reported, kept for a day. Claude Code keeps its own state in its configuration directory, as it always does. No conversation is written to disk (`persistSession: false`).

## Stateless, and why

The Provider registers `keepsState: false`, `runsTools: false`. Every `provider/request` starts one Claude Code process, gives it the whole request, reads one model message and closes the process. `sessionId` is accepted and passed to the hooks but not otherwise used. `provider/discard` has nothing to discard and answers `{}`; with `erase: true` it answers `outOfReach`, since copies Anthropic holds cannot be named or deleted from here.

How the conversation is replayed: the Agent SDK accepts only user input, so earlier assistant turns and tool results cannot be handed to it as native history. A request with one or more trailing user messages and nothing before them is delivered as written. Anything earlier goes in as a marked text record in the same user turn (`<history:MARK>` with `<user>`, `<assistant>`, `<tool-call>` and `<tool-result>` entries), followed by the trailing user messages as written. The mark is a digest of the record, so text inside it cannot close the record. Images keep their place. This is the reference's own fallback, which it uses after every restart, compaction or branch, so it is known to work.

The reference normally does something more involved: it keeps one Claude Code process alive per conversation and holds each tool call open until Pi supplies the result, which gives the model native history, its own thinking and a warm prompt cache. That is an optimisation there, not a necessity, and it would need the stateful Provider rules (`sessionId` on every request, exact-prefix proof, `provider/discard`, reset on move, fork, compaction and model change) plus a pool of long-lived processes. The stateless form is correct with none of that, so it was chosen. Its costs are listed under known gaps.

Failed and aborted assistant messages in the request are not replayed, and neither is a tool result whose call is not in a replayed assistant message. Reasoning parts are not replayed.

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
- **Usage.** `input`, `output`, `cacheRead` and `cacheWrite` are Anthropic's token counts for the request. `cost` is always `0`: a subscription is not billed per token, and Claude Code's price estimate is not available when a request ends at a tool call.
- **Errors.** A failure after the `provider.request` hook is an assistant message with `stop: "failed"` and an `error`. Kinds: a rejected or missing login is `credentials`; rate limits, overload and server errors are `temporary`; "prompt is too long" is `contextTooLarge`; the rest is `other`. Protocol errors are used only for an unknown Provider or model, a malformed request, a failed `provider.request` hook (the host's error is passed back) and cancellation.
- **Cancel.** `$/cancel` closes the Claude Code process at once and the request answers `cancelled`. No `provider.response` hook is called for a cancelled request.

## Verification

### Offline tests: 51 pass

`npm test`, with a scripted fake in place of the SDK's `query()`:

- `models.test.ts` (6): catalog shape, level mapping, nearest level, narrowing.
- `transcript.test.ts` (6): ModelRequest to SDK input.
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

- `provider/available` was `true`. The catalog narrowed from 18 built-in models to the 13 the account offers.
- Request 1 (one-line system prompt, one user message, one tool `get_weather`, `reasoning: "off"`, `maxOutput: 1024`): `stop: "toolUse"`, content `[{"type":"toolCall","id":"toolu_...","name":"get_weather","arguments":{"city":"Paris"}}]`, usage `input 2, output 56, cacheWrite 1089`, three `toolInput` events. Claude Code reported its tool list as exactly `[mcp__host__get_weather]`. Claude Code did try the call once in the moment before its process was closed; the sidecar has nothing that could run it, held the call unanswered and logged "none ran".
- Request 2 (the same conversation plus the assistant message and a tool result): `stop: "finished"`, text "Paris is 18°C with light rain and wind at 7 km/h.", streamed as text events, no further tool call.
- Hooks ran in order (`provider.request`, then `provider.response`) and the sidecar exited with 0.

Two more single requests, made directly against the Provider class to look into what the first two showed:

- No tools, `reasoning: "off"`: one text block, "ok", output 4 tokens, tool list `[]`.
- The request 2 shape again with block logging: a thinking block with no text, then the text answer; output 110 tokens. See the first known gap.

## Known gaps and open problems

Tracked in #39.

- **`off` did not stop thinking in one real request.** With `reasoning: "off"` Claude Code is started with thinking disabled. With no tools offered, Haiku 5.5 sent only text. With a tool offered and a replayed record, it still sent a thinking block whose text was empty, at a cost of roughly 90 output tokens. The sidecar passes the setting correctly as far as the SDK's options go; why Claude Code or the model thought anyway was not investigated, to stay inside the request budget. Empty thinking is not streamed and leaves no reasoning part.
- **Claude Code adds to the prompt.** The host's system prompt is passed unchanged as the system prompt, but Claude Code itself adds an identity line ("You are a Claude agent, built on Anthropic's Claude Agent SDK.") and `<system-reminder>` context such as the working directory, platform, date and account email. The no-tools request above, with a seven-word system prompt, counted 858 input tokens, so this overhead is real. The exact text was not captured. The Agent SDK offers no option to remove it.
- **Built-in agents, plugin skills and plugins are still listed at start.** Claude Code's init message names its built-in agents (`Explore`, `Plan` and others), four built-in `cc-plugin-*` plugins and three skills those plugins supply. With `skills: []` and `disableBundledSkills` the bundled skills are gone and no skill is listed to the model, and since the tool list is only the host's tools there is no Agent or Skill tool to reach any of them. Whether any of their descriptions reach the prompt could not be checked.
- **History is a text record, not native turns.** The model sees earlier turns as a quoted record in one user message. Its own earlier thinking is not carried. Prompt caching only helps for the unchanged prefix. Each request pays about a second to start Claude Code.
- **Per-request process.** Requests are independent, so parallel requests work, each with its own process.
- **`maxOutput` is not proven to bind.** It is passed as `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, and requests with it set succeeded, but no request was spent on hitting the cap.
- **No temperature, stop sequences or cache control.** Claude Code sets them.
- **A call to a tool the host did not offer** is answered by Claude Code itself with an error and the turn goes on inside the same request; the host sees none of it.
- **`cost` is always 0.** See Usage above.
- **An empty system prompt** is passed as an empty string. Whether Claude Code then falls back to its own prompt was not tested.
- **Run through the Rust host once.** `ma --model claude/claude-haiku-5-5 -p ...` (the standard configuration in `rust/crates/standard`, which launches this sidecar with `HOME`, `PATH` and `CLAUDE_CONFIG_DIR`) read a file and ran a command through its code tool over two tool rounds and answered correctly, on 2026-11-19. Nothing beyond that one run has been exercised through the host.

## Where the binding had to be read closely or guessed

- **Cancel and the response hook.** Settled by the edition 4 draft as this sidecar had guessed: a cancelled request answers `cancelled` and sends no `provider.response`.
- **A failed `provider.request` hook.** The binding says the Provider must wait for the successful answer. For an error answer (`cancelled`, `turn_limit`, `internal`, `lost`) the sidecar answers `provider/request` with the same error code and does no inference.
- **Erasure by a stateless Provider.** `provider/discard` with `erase: true` answers `{ "outOfReach": [...] }` with one descriptive string, following the wording "report those copies out of reach". The binding does not define the strings.
- **`sessionId` on a stateless Provider.** Accepted when present, never required, and copied into both hook payloads (`null` when absent, per [the hook table](../../../docs/bindings/plugin.md#from-core-hooks-to-wire-hooks)).
- **A level the model does not list.** Settled by the edition 4 draft: lower it, never raise it. The sidecar now does.
- **`cost` for a subscription.** [Messages](../../../docs/bindings/data.md#messages) says to use zero for fields missing from a partial meter. Zero is reported.
- **Opaque reasoning data.** Thinking signatures are not returned as `providerData`, because history is never sent back as native turns and the data would only add bytes.
- **The request after the hook.** If the hook answers with a request that is not a readable ModelRequest, inference has already been admitted, so the sidecar returns a `failed` message with kind `other` and still calls `provider.response`.
