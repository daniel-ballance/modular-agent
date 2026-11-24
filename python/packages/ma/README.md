# ma — Python standard configuration

`ma` is the Python implementation of the [standard configuration](../../../docs/reference/standard-configuration.md). Its package is `modular-agent-standard`. It uses the public `modular_agent` SDK and its official plugins.

## Build, install and run

From the repository root:

```sh
cd python
uv sync --python 3.13
.venv/bin/ma --version
.venv/bin/ma --help
```

`uv sync` installs `ma` in `python/.venv/bin`. Add that directory to `PATH`, or give the ACP host the absolute path to the executable. To build distribution files, run `uv build --package modular-agent-standard` from `python/`; the package needs the matching SDK distribution.

From a project folder, run `ma` for line mode, `ma -p 'Describe this project'` for one turn, or `ma --acp` for an ACP host. `ma -c` continues the most recently active session in that folder. Use `--runtime transient` to keep history without resuming a turn interrupted by a crash. Use `ma auth` or `ma login PROVIDER` to manage sign-ins. `ma --trust-project` records trust for the canonical project folder; only trusted projects can start servers configured in `.mcp.json`. Project session defaults never start plugins.

The configuration folder is shared across languages; sessions live under `$XDG_STATE_HOME/modular-agent/python` (or `~/.local/state/modular-agent/python`). With `MODULAR_AGENT_DATA_DIR` set, configuration goes directly in it and state goes under `state/`. New terminal secret answers go in `auth.json` under `answers`; use `/answer REQUEST_ID` without a value for an echo-disabled prompt.

Use `ma login chatgpt` to sign in with a browser or add `--device` for a code. Use `ma login grok` for Grok. `ma login claude` runs Anthropic's own `claude auth login`. Python uses the Claude Agent SDK directly; it does not need a Node sidecar. A metered Claude Code account is not a subscription login.

The Provider ids are `chatgpt`, `grok` and `claude`. `ma` still accepts `openai-codex` and `xai` in `--model`, `login`, `logout`, `settings.json`, `models.json` and saved sessions. On the next write of `auth.json`, it moves logins to their new ids. If both entries exist, it keeps the login under the new id.

## Approval

Without an approval setting or flag, `ma` loads no approval feature. Use `ma --approval ask` or set `"approval": "ask"` in the global `settings.json`. The flag wins. Project files cannot set `approval` or `approval_wait`, even in a trusted project.

- `ask` asks unless the tool is read-only; `codemode` is not read-only. `all` asks for every call. `never` refuses without asking. Explicit `off` loads the feature but does not ask.
- The terminal shows the whole script on stderr and accepts `y` or `n`. One allow covers the nested calls the script makes in that dispatch, not later runs. Each covered start records the parent call and approval request. Print mode has no answerer: it refuses a call that needs approval rather than parking it.
- To support waiting approvals, put a positive integer `approvalWaitMaxMs` in the operator's `policy.json`. The default is still live approval. Put `"approval_wait": "untilDeadline"` in global settings to opt new sessions in. A client can later poll and answer on its own authenticated route. An answer is not a dispatch: the continuation checks the call and deadline again.
- The declaration adds `approvalCoversNested` when configured and `approvalsOutlastTurns` with the maximum. An ACP client with `settings` can select a new policy with the `approval` option. An AG-UI client with `watch` and `settings` can POST, for example, `{"approval":"never"}` to `/agui/v1/threads/{threadId}/settings`. Neither operation changes another session.

## Serve AG-UI

```sh
ma --agui --listen 127.0.0.1:7400 --token-file /path/to/operator.token
ma --agui --acp --listen 127.0.0.1:7400 --token-file /path/to/operator.token
```

Use one command at a time. Each prints the HTTP origin when ready. Send the token in the Authorization header, not in the URL. Use a random token with at least 128 bits of entropy, in an owner-only regular file. AG-UI uses `/agui/v1`; ACP upgrades use `/`. Both serve the selected project. To distinguish clients, supply operator policy actors with a `clientId` per client instead of the shorthand. TLS is available through the SDK, not the command.

The thread snapshot includes `waitCursor`. Subscribe to `GET /agui/v1/threads/{threadId}/wait-closures?after=...` for committed closures without holding presence. Resume with the cursor from the last processed item. A kept thread also offers `runReceipts: 1`. Its original authenticated client can use `GET /agui/v1/threads/{threadId}/run-receipt?runId=...` to check the exchange and its work after restart. The read does not reopen the thread. Neither read can answer a question or execute a call. Neither adds an agent declaration key.

## Find and resume interrupted work

An authenticated `GET /agui/v1/threads` lists only the kept threads the client may watch. Each row has a timestamp, the turn state and the number of questions and Interface calls for that client. Listing does not open a thread. ACP includes the same counts and state in `session/list`.

By default, restarting a service leaves an interrupted turn alone until a client opens its session. To start recovery before accepting clients, pass `--resume-open` with `--acp` or `--agui`, or set `"resume_open": true` in the global `settings.json`. Project settings cannot turn this on or off. The service checks its configured project as the local operator. Each resumed session or held writer skipped gets one stderr line with its ID and no content. Durable recovery uses its normal repeat-safety rules. With `--runtime transient`, the interrupted turn ends as failed. A closed turn with an open question or Interface call is left for a client. The option has no effect in print or interactive mode.

## Client identity

By default, ChatGPT requests and browser sign-in use `modular-agent` as the `originator`. Grok device sign-in uses it as the `referrer`. The identity is a label, not a credential. It does not change the services' sign-in client IDs.

Set `MA_CLIENT_IDENTITY=my-agent` in the environment that starts `ma` to use another name. The name must be 1 to 64 characters from `A`–`Z`, `a`–`z`, `0`–`9`, `.`, `_` and `-`. If the variable is set to an invalid name, including an empty string, `ma` reports the error and exits with status 1.

`ma` uses the SDK's three subscription Providers. In an agent built on the SDK, pass `client_identity` to `modular_agent.chatgpt.chatgpt(logins=...)`, `modular_agent.grok.grok(logins=...)` or `modular_agent.sign_in(provider, logins, on_step=...)`. These options do not read the environment variable.

## Code sandbox

Each `codemode` call checks out a fresh worker process from [Monty 1.6.0's async pool](https://github.com/pydantic/monty/blob/v1.6.0/docs/api/python/pools.md). The interpreter never runs in the agent process. Sandbox code cannot access files, the network, processes, wall clocks, sleep or system entropy. Process and thread clocks read zero. An explicitly seeded generator such as `random.Random(7)` works.

Calls on `tools` go through the agent as nested SDK tool calls. You can call functions by keyword, by position, or with a single dict of named arguments if the first parameter does not take an object. The result starts with printed output and ends with the last expression as text, JSON or `repr`, or with Monty's traceback if the script failed.

Monty's [`max_memory`](https://github.com/pydantic/monty/blob/v1.6.0/docs/resource-limits.md) is 256 MiB of interpreter allocations, not a cap on the worker's total process memory. The active wall-clock limit is 30 seconds between nested tool calls. `ma` reads the worker's cumulative clock at each pause and at the end of the run. Waiting on the host does not count. A separate deadline stops a worker that does not reply. Up to 200 levels of recursion and 500 nested tool calls are allowed. Lookups do not spend the nested-call budget.

When the worker delivers more than 1 MiB of printed output, the call stops and returns `RuntimeError: printed output exceeded 1048576 bytes` followed by the printed UTF-8 prefix. The text result keeps up to 2,000 whole lines or 50 KB before a cut notice. If the traceback does not fit, its last line comes first. A memory or time limit ends the session with `MemoryError` or `TimeoutError`. A worker crash fails the call without replaying it, and cancellation stops the run. The next call starts with a fresh worker and no variables from the previous call.

## Built so far: telemetry

By default `ma` sends no telemetry. Set `OTEL_EXPORTER_OTLP_ENDPOINT` or a per-signal endpoint in the launch environment to export metadata. The default protocol is `http/protobuf`; `grpc` is also supported. The agent name is `ma`. `OTEL_SERVICE_NAME` sets the resource name and defaults to `ma`. `OTEL_SDK_DISABLED=true` disables recording and export without changing the declaration. See [standard telemetry settings](../../../docs/reference/standard-configuration.md#telemetry). Session content and credentials are not exported.

## What is checked

- **Reference:** 28/28, including `approval-covers-script`, `trace-trust` and `resume-open`. Startup recovery completed the interrupted turn without a client connecting and without repeating its tool effect.
- **AG-UI:** 48/48, including wait closures and run receipts after process loss.
- **Telemetry:** seven offline checks cover no endpoint, SDK disabled, per-signal overrides, sampling, headers, metadata privacy and the OTLP resource. A scripted turn reached local Phoenix as `invoke_agent ma`, `chat script` and `execute_tool codemode`. The OTLP resource for that trace carried `service.name=ma-python`.
- **ACP:** 190/190 with no approval configuration. With `--approval off`, 193/193 with the crash, probe, job and waiting-declaration checks. With an operator maximum, 118/118 public, crash and job checks. The covered continuation uses an actual ACP poll and answer; the probe Runtimes do not support waiting approvals. The standard composition does not declare several actors, tenants or session limits.
- **WebSocket kits:** 153/153 for the plugin binding, 14/14 for separate-listener isolation, 29/29 for named callers and 195/195 for ACP.
- **Python suites:** 823 passed and five live checks skipped in each Runtime and binding combination (transient/local, transient/process, durable/local and durable/process). The sandbox tests cover memory and active time, waiting on the host, worker death, cancellation, the recursion and nested-call limits, ambient access, UTF-8 output and result rendering.
- **Subscriptions:** offline SDK checks cover ChatGPT and Grok sign-in, model requests, refresh and reasoning replay, and Claude tool dispatch. Product checks cover client identity and former Provider ids in sign-in, settings, catalog overrides and saved sessions.
- **Python static checks:** Ruff lint and format checks passed; strict mypy passed.

```sh
# From the repository root, after uv sync above:
npm ci --prefix conformance/acp
npm ci --prefix conformance/tools
npm ci --prefix conformance/telemetry
node conformance/reference/run.mjs --agent python
MODULAR_AGENT_CONFORMANCE=1 node conformance/acp/run.mjs --crash-checks --probe-checks --job-checks -- "$PWD/python/.venv/bin/ma" --acp
scripts/websocket-kits.sh python
node conformance/plugin/run.mjs --named-callers -- "$PWD/python/.venv/bin/python" "$PWD/python/scripts/named_caller_fixture.py"
cd python
uv run --offline pytest -q --runtime transient
uv run --offline pytest -q --runtime durable
uv run --offline pytest -q --runtime transient --binding process
uv run --offline pytest -q --runtime durable --binding process
uv run --offline ruff check .
uv run --offline ruff format --check .
uv run --offline mypy
```

See the [SDK README](../../SDK.md) for fixture build commands and SDK scenario results. If running Python suites concurrently, give each a separate writable delegated `MA_CGROUP_ROOT` so containment recovery in one suite does not clean up another suite's deliberate crash.

## Known gaps

- The local environment does not confine paths. Strong command containment requires a writable, delegated Linux cgroup v2 subtree. Without it, `ma` declares `processGroup`, which cannot stop descendants that leave the group. The terminal and local tool environment are for POSIX systems.
- Some file and MCP errors still differ from the Rust wording. The file search uses Git enumeration or `find` plus Python glob matching; it does not support every Rust glob extension. Monty requires a finite suspension ceiling, separate from the 500 nested-call budget; Python sets it to 2,147,483,647 so lookups do not spend that budget.
- Terminal secret answers use the SDK's staged credential store. ACP does not accept secret answers. Served tools have byte, directory and command callbacks; served commands do not have working-environment access.
- No real sign-ins or model requests were made. The new Claude Provider was tested with Python Agent SDK message fixtures.

## Served Runtime findings

The base ACP Interface forwarded proposed input, actor joins, limit changes and tenant queries to the underlying APIs despite the SDK's session declaration. The bound handlers now use that declaration to return `not_supported`. They still allow `proposals`, `release` and `withdraw` for parked job reports. This change does not touch served Runtime composition or the Provider callback.


The Python SDK rejected the transient Runtime fixtures after registration because their recovery declaration differed from the default `durable` composition. Offline ACP conformance now allows the registered Runtime to determine recovery with persistent history; normal SDK durability validation still applies outside that profile. The two `step.after` probes actually failed at `session/new`, not at recovery: the fixture's Provider made the catalog contain more than one model, so automatic single-model selection left ACP without a current model. `ma` now selects `conformance/echo` by default in that profile and still allows the host to select a fixture Provider.

Suggested text. No shared specification documents were changed.

- **Reference, Checks** — replace the ACP-kit bullet with: “the ACP kit against `MODULAR_AGENT_CONFORMANCE=1 ma --acp` with `--crash-checks --probe-checks --job-checks`, including refusal of operations disabled by the session declaration;”

The newly reachable Provider check also found that Python accepted an unknown `provider.response` payload member but inserted an absent `model` into the recorded assistant message. The bridge now leaves that field absent unless it needs trusted provenance to replay opaque Provider data. When it binds provenance, it uses the associated request's model, not the Provider's claimed identity.

## Findings for the shared docs

Suggested replacement text. No shared documents were changed.

- **Reference, Rules for every implementation** — replace “One language” with: “Use the implementation language and its SDK. Rust and Go reach Claude through the TypeScript Agent SDK sidecar. Python and TypeScript use Anthropic's Agent SDK for their own language.”
- **Reference, Providers** — replace “The Claude Provider is the sidecar” with: “The Claude Provider uses the SDK's language-specific Claude adapter.”
- **Reference, Files** — replace the `models.json` description with: “Catalog additions or replacements. ChatGPT entries use `id`, `contextWindow` and `maxTokens`, and may specify `input`. Shared ChatGPT reasoning mappings cannot be changed by this file. Grok keeps its existing `effort` mapping.”

- **SDK, Durability** — replace the last invalid-composition bullet with: “a Runtime that does not declare `continuesAfterRestart` under `durable`, except in the offline ACP conformance profile when a fixture explicitly replaces the Runtime over the plugin binding and history is persistent. In that case the registered Runtime determines recovery and its declaration.”
- **ACP, Conformance mode** — replace the first sentence with: “With `MODULAR_AGENT_CONFORMANCE=1` the agent MUST offer the fixture model `conformance/echo` and fixture tools `bash` (`{ command: string }`) and `read` (`{ path: string }`). Use `conformance/echo` when no model was explicitly selected, even when a served fixture adds a Provider.”
- **Plugin binding, The host asks a Provider** — replace the sentence beginning “It MUST compare that response” with: “The host MUST compare that response with the final result before canonicalizing call IDs and fail an inconsistent attempt without dispatching its calls. An omitted assistant `model` stays omitted unless trusted model attribution is needed to replay opaque Provider data. Any `model` attribution MUST use the associated request's model.”
- **Reference, What it declares** — replace the `commandContainment` value cell with: “`strong` when the local environment can stop every descendant of a command; `processGroup` when only the command's process group is contained.” Linux alone does not guarantee delegated cgroup access.
- **SDK, The agent** — replace the `compose(project)` clause with: “`compose(project, reopening?)` builds an Agent for a canonical project. On reopening, pass the saved session id so the factory can choose the Provider before opening it. The Interface uses the serving Agent's history to find saved sessions; agents returned by the factory must use the same persistent history when they serve those sessions.” Python takes the optional reopening factory as `compose_reopen(project, id)`.
- **SDK, Contexts** — replace the environment row's Over the wire cell with: “Yes for tools; in process only for commands until the plugin binding gives a served command's context its canonical project or defaults `host/env/*` to it. An ignore-aware file walk is in process only.”
