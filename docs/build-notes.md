# Building it: what the first implementation taught us

The first implementation, on 2026-11-16, followed [ADR 0013](adr/0013-first-binding-typescript-in-process.md): TypeScript in one Node.js process, one package per part, in `packages/`. The notes below round seven record earlier builds and experiments, not the current requirements.

## Round seven

The first production edition froze the review results so the builders could test whether the documents were enough. The edition 1 checkpoints were uneven, but all five builders hit the fork-preflight lease gap. After the edition 2 fixes all five passed their suites and applicable kits. Those runs still found faults: Go caught a cancellation delay in its own build and Rust found a lock held by a forked shell. The kits needed changes too, including a jobs race and a probe that picked scenarios by process-local counts.

For your own verification, start with the suites and applicable [kits](conformance.md#the-conformance-kits), then run every host/plugin and writer/reopener pairing. The [matrix results](status.md#production-edition-3) show how many failures only appeared once builds were mixed.

- **Read a different writer's records.** Self-swaps hid TypeScript's reliance on a redundant `data.inputId`, Rust's use of in-memory ids as history sources, and Python's reliance on its own pending-call records. Check that readers can do without private copies. Elixir correctly refused operator setup written as a self-grant. Diagnose strict refusals against the binding: Elixir also rejected an extra Provider response field that the clarified binding treats as inert.
- **Vary one identity at a time.** The first portable matrix compared receipts under different principals as if they were retries by the same principal. Set the same [connection actor](bindings/acp.md#starting) with `MODULAR_AGENT_ACTOR` for the duplicate check. Change the principal in a separate case and check that it never receives the earlier receipt.
- **Check the configured part is the one running.** TypeScript ran with a built-in gate after the configured Elixir gate died without `HOME`. That is a security failure even if other checks pass. Probe startup both with a minimal environment and with a plugin that fails to start or register. See [Choosing plugins at start](bindings/plugin.md#choosing-plugins-at-start).
- **Assert the outcome, not only the records.** The second pass found that a Python host rejected `step.after` for a call it had not yet recorded as pending. A Rust Runtime's cell looked green because the kit did not check the originating turn's outcome. Python's host had rewritten the outcome rather than rejecting the disagreement. The check now covers the [turn outcome for a call left open](contracts.md#questions). Crash before and after the last step's gate to check both [recovery paths](bindings/plugin.md#the-host-asks-the-runtime).
- **Keep diagnosis separate from implementation.** Two diagnosticians could read every build. They traced the first wrong request, reply or history entry and sent that wire evidence to the builders, not the other builds' code. For example, the callback trace showed a Runtime inventing a result for a refusal the host had already committed, and a host expecting a `stepId` its callback never promised. Compare the first divergence with the [Runtime wire](bindings/plugin.md#the-host-asks-the-runtime), not with what a self-swap happens to accept. Two fix passes were enough before the all-green rerun.
- **Use a real model after the scripted checks.** The Rust and Elixir swap with `gpt-6-luna` found that Rust sent shared reasoning `off` to OpenAI where the API expected `none`. Add an offline regression for the translation and rerun the live check in both directions. Neither a kit nor a live spot check closes the [production gaps](adr/0021-production-edition.md#consequences).
- **Keep the runner from hiding failures.** Pi codemode crashed when an aggregate `Promise.all` contained a failing call. Use `Promise.allSettled` and record each result. Put test stores on a filesystem with room to grow: a full RAM-backed `/tmp` produced spurious failures.

## What exists

| Package | Part |
|---|---|
| `harness` | The Harness: hosting plugins, the plugin API, sessions, the hook registry, input requests, jobs, the output gate, declarations |
| `runtime-transient` | Runtime (transient) |
| `runtime-durable` | Runtime (durable). Replaces the transient one. A turn, and any question it was waiting on, survives a restart. |
| `tools-question` | Tool source: `ask_user`, a question the model asks. With a wait set, it can leave its call open past its turn. |
| `approval` | Feature: asks before tool calls. Policies: `ask` (unless read-only), `all`, `never`, `off`. |
| `provider-pi-ai` | Provider, one per pi-ai vendor |
| `interface-terminal` | Interface: interactive, print (`-p`) and JSON modes |
| `interface-acp` | Interface: ACP v1 over stdio (`ma --acp`), using the official SDK |
| `services` | History store, working environment and model gateway as HTTP services (`ma-service`), and the client plugins that use them ([ADR 0015](adr/0015-parts-as-services.md)) |
| `interface-http` | Interface: the agent over HTTP, with server-sent events (`ma --serve`) |
| `plugin-rpc` | Runs any plugin in a process of its own, over JSON-RPC on stdio ([ADR 0014](adr/0014-plugins-in-other-processes.md)) |
| `tools-mcp` | Tool source: tools from MCP servers, using Pi's `pi-mcp` client. Servers come from settings, or from an ACP client for one session. |
| `subagents` | Feature: the `delegate` tool. A subagent is a child session started by a job. `durable: true` carries subagents on after a restart. |
| `interface-tui` | Interface: full-screen terminal UI on Pi's `pi-tui` library. The default interactive mode; `--plain` gives the line-based one. |
| `tools-files` | Tool source: `read`, `write`, `edit`, `bash` |
| `env-local` | Working environment: the local machine |
| `history-jsonl` | History store: one JSONL file per session, appended a batch at a time, with erasure |
| `credentials-file` | Credential store. Can share Pi's `auth.json`, using the same file lock. |
| `config-files` | Configuration: global and project `settings.json` |
| `context-compaction` | Feature: what the model sees before each step, compaction, `/compact` |
| `system-prompt` | Feature: base instructions, tools, `AGENTS.md` |
| `model-selection` | Feature: `/model`, `/models`, `/thinking` |
| `agent` | The vanilla plugin set, and the `ma` command |

Run it from a project folder:

```sh
npm install && npm run build
node packages/agent/dist/src/cli.js --pi-auth -m xai/grok-4.7          # interactive, full-screen (--plain for line-based)
node packages/agent/dist/src/cli.js --pi-auth -m xai/grok-4.7 -p "..."  # print the answer
node packages/agent/dist/src/cli.js --pi-auth --durable -s <session>   # reopen, carrying on an interrupted turn
node packages/agent/dist/src/cli.js --pi-auth --approval ask           # ask before tool calls that aren't read-only
node packages/agent/dist/src/cli.js --pi-auth --approval ask --approval-wait 30   # after 30 s the question outlasts the turn
node packages/agent/dist/src/cli.js --pi-auth --question-wait 30      # ask_user questions outlast the turn after 30 s
node packages/agent/dist/src/cli.js --pi-auth --durable               # subagents, too, carry on after a restart
node packages/agent/dist/src/cli.js --pi-auth --acp                   # serve ACP, for a host such as T3 Code
MA_REMOTE=provider-pi-ai,runtime-transient,tools-files,env-local node packages/agent/dist/src/cli.js --pi-auth   # each of those in its own process
MA_HTTP_TOKEN=secret node packages/agent/dist/src/cli.js --serve 8080   # the agent over HTTP
node packages/services/dist/src/serve.js history '{"dir":"/srv/history","token":"t"}'   # a service; also environment, provider
npm test                                                               # 58 tests, using pi-ai's faux provider; MA_REMOTE=... npm test runs them across processes
```

## What is checked

The tests use pi-ai's faux provider, so they need no network. They cover: a turn that reads a file; approval as a plugin, both refused when nobody can answer and answered through an Interface, where a second answer is refused; input with a key taken once; steering into a running turn; cancelling, which hands queued input back and leaves jobs running; a job's report starting a turn; the output gate holding streamed pieces and redacting a secret split across them while the record stays intact; a context overflow compacted and retried; history surviving a restart, including a recorded move of the position; erasure; the swap test below; questions that survive a restart or outlast their turn; ACP; parallel tool calls; plugins from settings with project trust; and subagents, in the background, waited for, asking for approval through the parent, and after a restart in both variants.

Also run by hand with a real model (`xai/grok-4.7` through Pi's credentials): print, JSON and interactive modes, the full-screen TUI in a pseudo-terminal, reopening a session in a new process, a real crash during a `bash` call recovered by the durable Runtime, T3 Code driving the agent over ACP, and subagents, including a `kill -9` during a durable subagent's `bash` call.

## The swap test

The same crashed session, reopened with the same plugins except the Runtime:
- **Transient:** the turn ends as failed. Calls that had started have an unknown outcome, and calls that hadn't are marked as never started.
- **Durable:** the turn carries on. A call that never started runs. A call that started runs again only if its tool is safe to repeat. Otherwise its outcome is unknown and the model is told. Then the step loop continues.

With a real model, the durable Runtime did not rerun an interrupted `bash` call. The model saw that its outcome was unknown, checked whether the file existed, and reran the command itself.

The durable Runtime keeps no store of its own. The history already records each response, and each tool call as it starts and ends, and the step loop rebuilds the model context from the history on every step. That was enough. It confirms that how a durable Runtime records progress is an implementation choice.

## Questions that survive a restart

Each question and each answer is a history entry. A question carries a key; the approval plugin uses `approval:<tool call id>`. Asking again with the same key reopens the same question, or reuses its recorded answer.

When the process stops while a turn waits for an answer:
- **Durable Runtime:** reopening the session resumes the turn. The pending call's checks run again, the approval plugin asks with the same key, and the Harness reopens the same question in whatever Interface is now present. The answer lets the call run, and the turn carries on.
- **Transient Runtime:** the turn ends as failed, and the question is recorded as no longer answerable.

A recorded answer is reused only if it is on the current branch and whoever gave it may still answer. A secret's value is never recorded, so a secret is always asked again.

Checked by tests, and by hand with a real model: a live session was killed while the terminal showed "Allow bash?". A new process reopened the session, showed the same question, took `allow`, ran the call and finished the original turn.

## Questions that outlast their turn

A question can be asked with a time limit and "leave open". When the limit passes:
1. The Harness records that the question is waiting past its turn, and the approval check answers "pending".
2. The Runtime records the call as open, with no result, and ends the turn. The turn's result lists the open call. The model can't be asked again while one of its calls has no result.
3. The question stays answerable, with no deadline, and survives a restart with either Runtime, because nothing about it is held in memory.
4. When every open call has its answer, the Harness starts a new turn, started by the answer. The Runtime runs the open calls through the usual checks: the approval check finds the recorded answer under the same key, so the call runs or is refused. Then the step loop carries on.

A tool can do the same from inside its own run. It asks with a time limit and "leave open", and returns "pending" when the answer is pending. When the answer arrives, the tool runs again from the top. Its questions are keyed by their order in the run, so asking again returns the recorded answer instead of a new question. The `ask_user` tool works this way. Checked with a real model: the turn ended with `ask_user` open, `/answer teal` reran it, and the model went on to write the answer to a file.

New input while a call is open is allowed. The model's view puts a stand-in result ("no result yet") in the call's place, and shows the real result later as a late result. The record never holds a stand-in, so every call still has exactly one result.

In the terminal, a question takes the next line only while a turn is running. One left open past its turn is answered with `/answer allow` or `/answer refuse`, and reopening the session reminds you that it is open.

Checked by tests, and by hand with a real model: the turn ended after four seconds with the call open, the conversation went on (the model knew it was still waiting), the process quit, a new process reopened the session, `/answer allow` ran the command, and the agent finished in a turn started by the answer.

## Driven by a host over ACP

`ma --acp` serves ACP on stdin and stdout. Each ACP session is one of our sessions, with the same id. The mapping:

| ACP | Ours |
|---|---|
| `initialize` | capabilities, plus our declaration under `_meta` |
| `session/new`, `load`, `resume`, `list`, `close` | start, open (with the history replayed for `load`), list and close sessions. A session's `cwd` is its project. |
| `session/prompt` | input. The response waits for the turn that took the input, and maps its outcome to a stop reason. A slash command is handled without the model. |
| `session/cancel` | cancel. Queued prompts that were handed back answer `cancelled`. |
| `session/update` | the gated event stream: message and reasoning chunks, tool calls and their updates, commands |
| `session/request_permission` | approvals and choices |
| `elicitation/create` | free-text questions, when the client supports forms |
| config options `model` and `thinking` | the session's model and reasoning settings |

An approval left open past its turn stays open on the client as the same permission request. When the user answers it later, the open call runs in a turn started by the answer.

Checked by five tests using the SDK's own client, by a script that drives `ma --acp` over stdio with a real model (`scripts/acp-smoke.mjs`), and by **T3 Code driving it as a provider**. Added to T3 as a local ACP command, T3 read its models and reasoning levels from our config options, delegated a task to it, and showed its messages, a read card, a shell command card, its reasoning and a checkpoint. T3 answered our permission request itself, because the thread was in full-access mode: the host acting as an actor with its own authority.

What the host test found:
- **A session's project is the session's, not the process's.** ACP gives each session a `cwd`. Tools, context files and the session list now use it.
- **A host reads the model list through a session.** ACP v1 offers models only as session config options, so T3 starts a throwaway session to read them. This used to leave an empty session behind. Now the history store writes a new session only once something happens in it beyond setup, such as its first input, so a session started only to look leaves nothing. A test starts one, changes a setting, closes it, and finds no session listed.
- **ACP v1 has no key for repeated input.** Our key travels in `_meta` when a client sends one. T3 doesn't.
- **MCP servers the client passes** are connected for that session ([MCP servers](#mcp-servers)).

## Day-to-day use

- **Parallel tool calls.** When every tool in a step says it may run alongside others, the calls are checked one at a time, then run together. Their results are recorded in the order the model asked. A test proves they overlap: each tool waits until the other has started.
- **Plugins from settings.** `settings.json` can name plugins under `load`, as a package name or a path, with options. A plugin from the project's settings loads only once the user trusts the project with `/trust`. The trust check is itself a plugin, at the "plugin about to load" hook point.
- **A full-screen TUI.** Markdown streams as the model writes, each tool call is a card with its live output, approvals and choices are a selection list, and the editor completes slash commands and file paths. Enter sends, or steers a running turn; Esc cancels and hands queued input back to the editor. Checked in a pseudo-terminal with a real model, approving a `bash` call from the list.

## Subagents

The `delegate` tool starts a child session from the task alone, with the parent's project and model. The parent agent is an actor in the child, with no more authority than the parent session's owner. By default the subagent runs in the background: the tool call returns at once, and the subagent's answer comes back later as a job report, which starts a parent turn. With `wait`, the answer comes back in the tool call, and the job ends without a report. The child's questions and approvals are asked again in the parent's session, so they reach the parent's user. A subagent may start subagents, up to a depth limit. A question from a subagent's subagent climbs one level at a time, and reaches the top-level user labelled with each subagent it passed through. To follow up, the parent names an earlier subagent in `subagent`. The child is reopened with its history, and the follow-up is a new job. Tests cover both.

Both variants record the job. They differ only in what happens after the process stops:

| | Transient | Durable |
|---|---|---|
| The parent session is reopened | the job ends as outcome unknown, and the parent hears so | the child session is reopened too |
| The child's interrupted turn | left as it was | its Runtime decides, as for any interrupted turn |
| The parent hears | that the outcome is unknown | the subagent's real answer, once it has one |

The tests cover both, stopping the process while the child's model request is running. A real run with `xai/grok-4.7` killed the process with `kill -9` while the subagent's `bash` call was running. On reopening, the child got a stand-in "outcome unknown" result for that call, its model carried on, and the parent got the report in a new turn. The job ended exactly once.

To make this work, the Harness changed in three ways:

- **Jobs are recorded,** as `jobStarted` (with the plugin's detail) and `jobEnded` entries. A plugin can list its unfinished jobs and take one up again.
- **Stopping the process suspends sessions instead of closing them.** Closing ends jobs and records turns as ended, so a durable plugin had nothing to carry on.
- **A job stays listed until its report is queued.** Otherwise a one-shot run could see an idle session with no jobs in between, and quit before the report's turn. Print and JSON modes now wait for jobs too.

## Tool processes and a killed agent

The first durable-subagent run showed that killing the agent with `kill -9` left its `bash` command running. The command finished unseen and wrote its file, while the reopened subagent was told its outcome was unknown. A durable Runtime that ran the call again could have raced the first attempt. So the description gained a guarantee: nothing a working environment starts outlives the agent's process, or the environment declares that it can't promise this.

`env-local` keeps the promise in three layers:
- Each command runs in its own process group, and carries an environment variable naming this run of the agent.
- The first command starts a small watcher process. When the agent dies, however it dies, the watcher kills the agent's process groups. On Linux it also kills any process carrying the run's variable, which catches processes that left their group, such as ones started with `setsid`.
- If the watcher dies too, the next agent to start sweeps what is left.

Tests kill an agent with SIGKILL while it has a background process in its group and one that escaped it, and check both die. A second test also kills the watcher, and checks that the next agent's start cleans up.

The same run found a second bug: a command that started a background process, such as `server &`, never returned, because the background process held the output open. A command now ends when `bash` exits, after a moment for the last output. What it left in the background runs until the agent stops.

The stand-in result for an interrupted call was too terse. A model read "the process stopped while this tool call was running" as "the command was started". The text now says the call did not finish, that it may have done all, part or none of its work, and to check before relying on it or running it again. Rerun with a real model, the reopened subagent checked for the file, found it missing, and ran the command again deliberately.

## Erasure and summaries

A summary copies what it summarizes, so erasing an entry left its content in any summary made from it. Now an entry can name the entries it copies, under `sources`, and erasure follows them: erasing an entry erases every entry that copied it, and every entry that copied those. Compaction names everything it summarized, including the earlier summary it built on. An erased summary is skipped, so the model sees the rest of the history in full until it is compacted again.

A test compacts a conversation with a phone number in it, erases the input that held the number, and checks the number is gone from what the model sees next, and from the store after a restart. With the new rule switched off, the test fails.

Still out of reach: a fork made before the erasure keeps its own copy.

## Secrets

A secret's value used to stay out of the record, but it still went back to whoever asked. If the asker was `ask_user`, the value went into the tool result, and so to the model. Now a secret request names the credential to keep it as. The Harness writes the answer to the credential store, and the asker, the history and every event see only that name. A request with no name, or no credential store to keep it, is declined before anyone is asked. Because the recorded answer holds no value, it can be reused like any other answer, so a secret can now be answered after its turn.

`ask_user` can ask for a secret by name, under a `secret:` prefix so a model can't overwrite a Provider's key. The value is stored in the `api_key` shape, because Pi refuses an `auth.json` with any other kind of entry. Both terminal Interfaces keep a typed secret out of their line history. A test has the model ask for a token, and checks it reaches the credential store and is absent from the tool result, the model context, the events and the history file.

Still to do: neither terminal Interface hides a secret as it is typed.

## Hook points that had no test

Tests now cover a plugin checking a turn's result and sending the model back, a plugin defining a hook point for others, and a UI starting a tool call itself. Two fixes came out of them:
- **Only a hook point's owner may run it.** The contracts said so, but the code let any plugin run any hook point. The owner is the plugin that defined it, or a plugin providing the capability that owns it, such as the Provider for "before a model request".
- **A tool call refused because of who started it is recorded too.** Before, it returned without a record.

## MCP servers

`tools-mcp` connects to MCP servers over stdio or Streamable HTTP, using Pi's `pi-mcp` client, and offers their tools as `mcp__<server>__<tool>`. MCP's tool annotations (read-only, destructive, idempotent, open world) map one to one onto our tool hints, so approval and the durable Runtime treat MCP tools like any other. Servers come from two places:
- **Settings,** under `plugins.tools-mcp.servers`, in the shape Pi and Claude use. They serve every session.
- **An ACP client,** which passes servers with `session/new`, `session/load` or `session/resume`. They serve only that session, and close with it. They aren't recorded, because their headers and environment may hold secrets. The ACP Interface finds the MCP plugin through an `mcp-servers` capability, so neither package depends on the other, and it declares HTTP support only when that capability is there.

This needed one change to the contracts: asking a tool source for its tools can now name the session.

It also exposed a gap in trust. A project's settings for plugins applied whether or not the project was trusted, so an untrusted project could start an MCP server, or point a plugin at other files. Now a project's plugin settings apply only once the project is trusted. Its session defaults, such as the model, still apply.

Tests use a small MCP server with one tool: from global settings; from a project's settings, ignored until `/trust`; and from an ACP client, offered to that session and not another. `npm test` now runs 50 tests.

## Over RPC

Any plugin can run in a process of its own ([ADR 0014](adr/0014-plugins-in-other-processes.md)). The swap test for this is the whole suite: `MA_REMOTE=runtime-transient,runtime-durable,tools-files,env-local,tools-mcp npm test` runs all 53 tests with those plugins out of process, and they all pass. It takes 1.6 seconds, against 1.0 in one process. Three more tests run only across processes:
- Only the Harness stays in the test's process. The Provider, Runtime, file tools and working environment run in four others, with streaming output and live `bash` output crossing two processes.
- Cancelling a turn reaches a `bash` command two processes away, and stops it.
- When a plugin's process dies, the waiting tool call fails with a clear result, the turn carries on, and the Harness reports the problem.

A real `xai/grok-4.7` run with the Provider, Runtime, file tools, working environment and MCP plugin each in its own process read a file and wrote a second with `bash`. The Provider's credentials came from the credential store in the Harness's process, over the connection.

What changed to make it work:
- **The Runtime host's calls are asynchronous,** including a new id, a tool's definition, and whether input is waiting. A working environment's `at` may be too, and `resolve` left the interface, since only the environment used it.
- **The Harness keeps copies** of a remote tool source's tools and a remote Provider's models, because it asks for them without waiting. A tool source's change announcement refreshes the copy. A call into the plugin answers only after the refreshes it caused, so a host that adds MCP servers to a session sees their tools at once. That became a contracts rule: an answer comes after its effects.
- **A stopping process doesn't announce turn ends.** A remote Runtime finished its turn after the session was suspended, and the Harness announced `turn.ended` for a session it no longer held. The subagents plugin then failed on it.
- **A plugin process keeps the agent alive only while the agent waits on it.** A crash test that abandons its harness now stops it after the test, as the real crash would have.

Two test mistakes are worth a note. A test killed `bash`'s parent process to simulate a dying plugin. With the working environment in process, that parent was the test runner. And `echo done > out.txt` has no output, so it can't test live output.

## As services

Three parts run as HTTP services, each in its own process with its own bearer token ([ADR 0015](adr/0015-parts-as-services.md)):

| Service | API | Safe to send again |
|---|---|---|
| History store | create, open for writing (a lease, renewed while held), keep entries, load, list, erase, close | every request: entries already kept are not kept twice |
| Working environment | run a command (its output streams back), read, write, check a file | everything but running a command |
| Model gateway | list Providers and models, make a request (its events stream back) | listing only |

In the agent, `historyHttp`, `environmentHttp` and `providerHttp` stand for them, each replacing its local plugin. They can be named in settings, under `load`. `ma --serve` serves the agent itself over HTTP.

Five tests run the services as separate processes and drive the agent only over HTTP:
- A full turn: a file read in the sandbox, `bash` run there, the model reached through the gateway, and the history kept by the history service. The model's output and `bash`'s live output stream through to the client. The agent's home holds no credentials.
- A second agent is refused a session another holds. Once the first stops, the second opens it, sees the first agent's turn, and adds its own.
- A history service that loses its answers after keeping a batch: the agent sends the batch again, and each entry is kept once. With retries switched off, this test fails.
- Cancelling over HTTP stops `sleep 30` in the sandbox.
- A client that reconnects with `Last-Event-ID` gets the entries recorded while it was away. Input resent with the same key is taken once.

A real `xai/grok-4.7` turn ran the same way, across five processes. The model read a note in the sandbox and wrote its words in reverse order to a new file with `bash`. Only the gateway read Pi's credentials, and the history service kept the turn.

What the description gained: keeping the same entries twice keeps them once, and a host that reconnects gets everything recorded since the last entry it saw. Several existing rules held as written. A second writer is refused, as a lease. Nothing the environment starts outlives the agent: the sandbox stops a command when its caller hangs up. Hook points stay with the Provider's stand-in in the agent. Unknown outcomes are never repeated.

## Round two: shared bindings across four languages

After three clean-room builds, in Rust, Python and Go, the description gained their agreed rules ([ADR 0016](adr/0016-rules-from-three-clean-room-builds.md)). Two [bindings](bindings/README.md) were written so builds can work together: one for driving an agent over ACP, and one for a history service over HTTP. Each has a conformance kit, in `conformance/acp` and `conformance/history`.

| | Result |
|---|---|
| ACP kit (43 checks) | passed by every build: TypeScript, Rust, Python with plugins in one process and in separate processes, and Go |
| History kit (34 checks) | passed by the TypeScript and Go history services |
| The TypeScript agent with its history in Go's service | ACP kit passed |
| Go's agent with its history in the TypeScript service | ACP kit passed |

The kits found four bugs in this build:
- input keys didn't survive a restart; they are now recorded with the input and rebuilt on reopening;
- its HTTP history client sent unused sessions to the service; it now holds them back, as the local store does;
- its ACP Interface declined free-text questions when a client had no forms; they now stay open for the `answer` extension;
- it would have sent a secret through an ACP form, which ACP forbids; a secret is now never asked over ACP.

The other builds found 20 gaps in the bindings. They are now clarifications in the bindings, and a known mismatch to fix in a `/2`: ACP's `refusal` means the refused content leaves the context, but the binding uses it for any failed turn.

`npm test` runs both kits against this build: the ACP kit with the history kept locally and in a history service, and the history kit against its own service. `MODULAR_AGENT_HISTORY_URL` and `MODULAR_AGENT_HISTORY_TOKEN_FILE` point the agent at any conforming history service.

## Round three: plugins in any language

The [plugin binding](bindings/plugin.md), `modular-agent-plugin/1`, lets a Harness host a plugin written in another language. It turns the interactions in [Contracts](contracts.md#interactions) into JSON-RPC messages over a child process's stdio: tool sources, Providers, the working environment, hook handlers and commands. It shares one data schema with the other bindings ([shared data](bindings/data.md)). The design borrows from PiG, which already hosts extensions in four languages ([PiG reference](research/pig-reference.md)):
- a registration handshake;
- callbacks linked to the request they belong to;
- history read on demand;
- a size cap and a heartbeat.

It doesn't copy PiG's approach of porting one plugin API to every language. That fits one team shipping four SDKs, not four independent builds.

This build gained:
- a `plugin-wire` package, which hosts external plugins (`MODULAR_AGENT_PLUGINS`) and serves any of its own plugins over the binding;
- item-level replacement in the Harness: a provider id, a tool name, a command or the working environment;
- a conformance plugin (`ma-plugin`).

Across all four builds, every host passes the ACP kit with plugins from every other build, and in turns that use four languages at once. The matrix found two holes in the binding that no single build could: `timeoutMs: 0`, and how a missing file is reported. Both are now rules and kit checks. Anything a receiver branches on must be a defined value, never a message or an unstated default.

The plugin kit also found a bug here: cancelling a command killed its process group, but not a process that had left it with `setsid`. Each command now carries its own marker, which cancelling sweeps.

## Round three, stage 2: the Runtime in another language

The Runtime became a plugin like any other ([ADR 0017](adr/0017-plugins-in-any-language.md)). A turn is one request to it. It asks the host for each step's request, the model, tools, hooks and records, and keeps its state in the history, which it reads back with `host/history` after a restart.
- This build serves its transient and durable Runtimes over the binding, and hosts another build's in place of its own.
- The plugin kit checks a served Runtime with a scripted model: turns, tool rounds, refusals, cancelling, step limits, parallel calls, and recovery after a restart.
- The ACP kit's `--crash-checks` kills the agent with `kill -9` during a `bash` call, reopens the session in a new process, and checks the turn ends as the agent declared.

**The Runtime matrix:** each of the four builds' agents ran each build's Runtime, through a real kill and restart.
- Durable: 16/16, and the turn carried on to completion.
- Transient: 16/16, and it ended as failed.
- The interrupted command never ran twice.

The matrix found three more holes before it passed:
- the model-output event had no defined name. The binding now has the host emit the standard turn events itself, since the stream passes through it.
- whether a Runtime may read history. It may, with `host/history`.
- a host that didn't answer a cancelled request. The binding says it must.

## Round six: the last open items

Round six closed what round five left open ([ADR 0020](adr/0020-tenants-limits-and-output-events.md)):
- **tenants and session limits,** with an `administer` right and a token budget per tenant;
- **a shared shape for the output gate's events;**
- **one plugin of each name per host;**
- **listing and withdrawing proposed input.**

It also took in the round-five gaps the builders agreed on: the order of a rewind, presence, a job's rights, a reply the gate withholds, and a reasoning level the new model doesn't accept.

**What this build changed.** It does all of the above, and passes the plugin kit (111 checks), the ACP kit with the probe and jobs plugins and the limit and tenant checks, and portable sessions. Its served output gate always answers with the events, which the binding allows, and that is what exposed the number hole below.

**The matrices,** across the five builds: plugins 25/25; Runtimes through `kill -9`, 25/25 durable and 25/25 transient; portable sessions with jobs, 25/25 durable and 25/25 transient. One combination failed at first: a Rust host with this build's gate. JavaScript writes `0.0` as `0`, and the Rust host took the echoed entries as changed and blocked them. Shared data now says numbers compare by value.

**Real models.** An Elixir agent on `gpt-6-luna` and a Python agent on Haiku each ran a tenant without `tools`, a session limit set and lifted, and proposals listed, withdrawn and released. `gpt-6-luna` took one refusal for an empty answer; Haiku reported its refusal exactly. A result that isn't completed now says plainly that the call didn't run.

## Round five: the open items

Round five closed what round four left open ([ADR 0019](adr/0019-acp-2-and-several-actors.md)), and the binding gaps the five builders logged in round four:
- **ACP `/2`,** asked for in `initialize`, reports a failed turn as an error rather than `refusal`.
- **Several actors** through ACP extensions, with proposed input that another actor releases.
- **Jobs over the plugin binding,** in standard kinds, so a job a killed agent left is taken up by the same plugin in whichever build reopens the session.
- **Rewinding,** with the working environment's saved points.
- **The output gate in another process,** a stream at a time.
- **Portable sessions, extended:** queued input, model requests, why a question closed, a question's implicit key, the `approval` setting, and a recorded model the reopening build doesn't offer.

**What this build changed.** It does all of the above, and passes the plugin kit (110 checks), the ACP kit with the probe and jobs plugins (109), and portable sessions with jobs (86). Its Runtime reported the wrong `turn.end` payload and, under a host answering `cancelled`, a cancelled turn as failed; both were found by swaps in round four and fixed.

**The matrices,** across TypeScript, Rust, Python, Go and Elixir:
- plugins 25/25;
- Runtimes through `kill -9`: 25/25 durable and 25/25 transient;
- portable sessions with jobs: 25/25 durable and 25/25 transient.

The first pass found five holes, each fixed and then held by a binding rule or a kit check:
- a job's report framed by the build that took it up;
- rewinding refused with another build's environment;
- an output gate handler failing on another host's event shapes;
- a restore that replaced the project folder, stranding the agent working in it;
- a kit race.

**Real models.** In two runs, an agent in one language started a background job and was killed, and an agent in another language took the job up and reported it. A guest actor's proposed question was then released and answered. In the second run the session was written under Haiku and reopened by an agent offering only `gpt-6-luna`: the next turn failed, as the binding now says, instead of switching models, then carried on once a model was chosen.

## Round four: portable sessions, and a fifth build

**What changed in the bindings.** All 42 binding gaps the Rust, Python and Go builders logged in round three went into the bindings: where they agreed, as the rule; where they didn't, with a choice. Then came [portable sessions](bindings/data.md#portable-sessions) ([ADR 0018](adr/0018-portable-sessions.md)): one shared format for what history holds, so any build's agent can reopen another's session.

**What this build changed.**
- Every entry is written in the shared shapes, and sessions are read by the shared rules.
- The host records a turn's start before the Runtime runs it.
- The durable Runtime recovers from the standard kinds alone, in a fresh process.
- Reopening after a crash waits for the old history lease.
- The open rules in [status](status.md#the-rules-from-the-clean-room-builds) were closed:
  - erasure follows every copy, and is refused while another writer holds a session it would change;
  - records of authority can't be erased;
  - a key binds the whole question;
  - mixed-actor input acts with the shared rights;
  - closing a session stops its background processes;
  - the HTTP Interface resumes by entry.

**The fifth build.** An Elixir build, made clean-room from the docs, the bindings and the kits alone, passed every kit. In its first swaps it worked as a plugin, a Runtime and a portable-session peer with all four other builds. As a host, it failed one probe check: it didn't answer a request cancelled before it started.

**The matrices,** across TypeScript, Rust, Python, Go and Elixir, all through the ACP kit:
- plugins: 25/25;
- Runtimes, through `kill -9`: 25/25 durable and 25/25 transient;
- portable sessions, where one agent writes and another reopens and recovers: 25/25 durable and 25/25 transient.

**Real models.** Three runs mixed the languages: an Elixir agent with Python's Runtime, Go's tools and TypeScript's environment; a session Rust wrote and Elixir reopened; and a Python agent with Rust's Runtime, Elixir's tools and Go's environment. Each read a file, was killed during `bash`, recovered without repeating it, and remembered the earlier answer.

**What the swaps found,** each a value a receiver branched on that a binding had left undefined:
- the names of rights;
- the `turn.end` payload's `outcome`;
- the Provider hooks' `model`;
- `null` for a field left out;
- how a reopening connection relates to the session's actors;
- the conformance model's thinking levels;
- the approval setting;
- a history lease held by a killed writer.

Two more were in this build alone. TypeScript's Runtime reported a cancelled turn as failed when a host answered its later requests with `cancelled`. And the kit itself checked background processes by PID, which means nothing inside Go's PID namespace.

## What building changed

- **Recovering an interrupted turn is the Runtime's job.** The first version had the Harness repair the turn itself, which hard-wired transient behaviour into the Harness. The Harness now finds the interrupted turn and hands it to the Runtime. This is now an interaction in [Contracts](contracts.md#harness-and-runtime).
- **The Harness defines the standard Runtime hook points.** The Runtime is a plugin, so if each Runtime defined its own hook points, swapping it would change them. Defining them in the Harness guarantees every Runtime offers the same set.
- **Plugins that own an operation must be able to run its hook points.** The Provider plugin runs "before a model request" itself, so the plugin API gained "run a hook point this plugin owns".
- **A guardrail on a stream must hold on a possible start, not a match.** The first test guardrail held output only once it had seen "ACCT" plus digits, and leaked a piece ending in "A". Holding works, but a guardrail has to hold whenever the text so far could be the start of what it is looking for. This is a lesson for guardrail authors, not a change to the description.
- **Opening a session must not wait for a resumed turn.** A resumed turn may be waiting for an answer that only an Interface started afterwards can give. Waiting would deadlock.
- **Commits to one session must run one at a time.** Two at once could both follow the same entry and create a branch by accident. The Harness now queues them.
- **Print and JSON modes decline questions,** because nobody is there to answer. Approval then fails closed.
- **Deliberate replacement works as described.** The durable Runtime declares that it replaces the transient one, and the Harness skips the replaced plugin.

## Not done yet

- **A call left open must be safe to run again up to its question.** That is the tool author's promise, as with Pi Durable's tools that park.
- **Several actors** work in the Harness and tests, but the terminal Interface acts for one user.
- **Adding plugins during a session** isn't supported. Plugins load at start, from code or settings. The declaration says so.
- **Inside the agent, every part talks to the others through function calls.** Only the Interface is over a wire.
