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
node packages/agent/dist/src/cli.js --pi-auth -m xai/grok-4.7          # interactive
node packages/agent/dist/src/cli.js --pi-auth -m xai/grok-4.7 -p "..."  # print the answer
node packages/agent/dist/src/cli.js --pi-auth --durable -s <session>   # reopen, carrying on an interrupted turn
node packages/agent/dist/src/cli.js --pi-auth --approval ask           # ask before tool calls that aren't read-only
node packages/agent/dist/src/cli.js --pi-auth --approval ask --approval-wait 30   # after 30 s the question outlasts the turn
node packages/agent/dist/src/cli.js --pi-auth --question-wait 30      # ask_user questions outlast the turn after 30 s
npm test                                                               # 24 tests, using pi-ai's faux provider
```

## What is checked

The tests use pi-ai's faux provider, so they need no network. They cover: a turn that reads a file; approval as a plugin, both refused when nobody can answer and answered through an Interface, where a second answer is refused; input with a key taken once; steering into a running turn; cancelling, which hands queued input back and leaves jobs running; a job's report starting a turn; the output gate holding streamed pieces and redacting a secret split across them while the record stays intact; a context overflow compacted and retried; history surviving a restart, including a recorded move of the position; erasure; and the swap test below.

Also run by hand with a real model (`xai/grok-4.7` through Pi's credentials): print, JSON and interactive modes, reopening a session in a new process, and a real crash during a `bash` call recovered by the durable Runtime.

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
- **Tool calls run one at a time,** even when the model asks for several.
- **Several actors** work in the Harness and tests, but the terminal Interface acts for one user.
- **Adding plugins during a session** isn't supported. The declaration says so.
- **The terminal Interface is line-based,** not a full TUI like Pi's.
- **No wire binding yet.** Every part talks to the others through function calls.
