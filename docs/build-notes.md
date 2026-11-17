# Building it: what the first implementation taught us

**Status:** 2026-11-16. The first implementation follows [ADR 0013](adr/0013-first-binding-typescript-in-process.md): TypeScript in one Node.js process, one package per part, in `packages/`.

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
npm test                                                               # 50 tests, using pi-ai's faux provider
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
