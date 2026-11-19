# Acceptance: what to build

Build an agent that follows the description in `docs/` and `GLOSSARY.md`. This file says what it must be shown to do, as behaviour anyone can observe. It says nothing about how: the APIs, types, file formats and wire protocols are yours to design from the description.

"Shown" means a test that runs offline with a fake Provider, unless the item says a real model run. Real runs use only the models allowed in `AGENTS.md`.

Work in milestones, in order. Stop at the end of the milestone you were given.

## Milestone 1: the vanilla agent

The agent is a Harness plus plugins, as in `docs/examples/vanilla-pi.md`. The Harness runs no turns, calls no model and runs no tool itself.

1. **Plugins.** Every feature below is a plugin. Plugins provide capabilities, add behaviour at hook points, and can define capabilities and hook points for each other. Handlers combine by one fixed rule per hook point, in load order, with "first" and "last" allowed. Only a hook point's owner runs it. A plugin can deliberately replace another.
2. **Providers.** The Provider for your language (see `AGENTS.md`), and a fake Provider with scripted answers for tests. The Runtime never sees credentials and never chooses the model.
3. **A transient Runtime.** It runs turns made of steps: a model request, then any tool calls. It records every tool call with exactly one result. Step limits, model failures and cancelling end a turn with the matching outcome.
4. **Tools and a working environment.** `read`, `write`, `edit` and `bash`, with `bash` output shown live. The working environment is the local machine. Each session has its own project folder, and tools, context files and the session list follow it. A `bash` command that leaves something running in the background, such as `sleep 60 &`, still returns.
5. **History.** Sessions are kept on disk as a tree of entries, and survive a restart. Moving the current position is recorded. A session can be forked. Sessions can be listed for one project or all of them. A second process can't write to a session another holds. A session that was started but never used, for example only to read its settings, leaves nothing behind.
6. **Context management.** Before each step, a plugin decides what the model sees. When the history grows too large, it adds a summary and nothing is deleted. A request that fails because the context is too large is compacted and retried. `/compact` does it on demand.
7. **System prompt, model selection, configuration and credentials.** The system prompt includes `AGENTS.md` from the project. `/model` and `/thinking` change the session's settings. Settings come from a global file and a project file. Credentials come from a credential store.
8. **Input during a turn.** Input can steer a running turn or wait until after it. Cancelling a turn hands queued input back to the Interface and leaves jobs running. Input given twice with the same key is taken once.
9. **The output gate.** Output passes a gate before it reaches anyone. A guardrail can hold streamed output and redact a secret split across pieces, while the record keeps the original intact.
10. **Erasure.** An erased entry's content is gone from the store, and an erasure record remains. A summary that copied it is erased too.
11. **A terminal Interface.** Interactive line mode, a print mode for one prompt, and a JSON mode that prints events.
12. **Commands.** Plugins register slash commands. Commands run without the model.

A real model run: read a file and answer from it, then reopen the session in a new process and continue it.

## Milestone 2: the swap test

1. **A durable Runtime** that replaces the transient one. No other plugin changes.
2. **The same tests pass with either Runtime,** except those about what happens after a restart, where they differ as the description says.
3. **After a crash** (the process killed mid-turn): with the transient Runtime, the turn ends as failed and every call has one result. A call that started but didn't finish has an unknown outcome. With the durable Runtime, a call that never started runs, one safe to repeat runs again, one not safe to repeat gets an unknown outcome, and the turn carries on. The stand-in result for an unknown outcome tells the model clearly that the call did not finish and to check before relying on it.
4. **Nothing the working environment starts outlives the agent.** Kill the agent with SIGKILL while it has a command running, including one that left its process group (`setsid`). Both die. If whatever stops them also dies, the next agent to start cleans up.
5. **Parallel tool calls.** When every tool in a step allows it, the calls run at once, and their results are recorded in the order the model asked. Show they really overlap.

A real model run: kill the agent with `kill -9` during a `bash` call, reopen with the durable Runtime, and show the turn carry on.

## Milestone 3: questions, jobs and subagents

1. **Input requests.** Approval, choice, free text and secret. They are recorded and keyed. With the durable Runtime, a question open when the process stopped is asked again after a restart, and an answer given before is not asked again. A recorded "allow" from someone who may no longer answer is not reused.
2. **Authority.** A viewer can see a question but only an actor with authority can answer it. An actor can't grant another more authority than it has.
3. **Approval as a plugin,** with policies "ask unless read-only", "ask always", "never ask, refuse" and "off". Approval fails closed: with nobody to answer, a call is refused.
4. **`ask_user`,** a tool the model uses to ask a question.
5. **Questions that outlast their turn.** After a time limit the question stays open, the turn ends with the call open, and an answer given later carries the work on in a new turn.
6. **Secrets.** A secret answer goes only to the credential store, under a name the asker gives. The asker, the history, the events and the model see only that name.
7. **Jobs.** Work a session owns that can outlive a turn. A job is recorded when it starts and ends. Its report enters the session as input and can start a turn. It can be cancelled.
8. **Subagents, as a plugin built on jobs.** A subagent gets a session of its own, only its task, and no more authority than its parent. It can run in the background, reporting back later, or the parent can wait for its answer. Its questions reach the top user, through every level. The parent can message a finished subagent again, and it remembers its earlier work. There is a depth limit. A transient variant and a durable one: after a restart, the transient one tells the parent the outcome is unknown, and the durable one carries on and reports its real result.
9. **Checking a turn's result.** A plugin can send the model back with a reason, within the same turn.
10. **Tool calls a UI starts.** The same checks apply, and the call is recorded with who started it, whether it ran or was refused.

A real model run: a background subagent writes a file with `bash`, and its report starts a parent turn that describes what it did.

## Milestone 4: hosts and the wider world

1. **An ACP Interface** over stdio, tested with an ACP client library. It declares what the agent supports. Approvals become permission requests, and free-text questions become elicitation. The model and thinking level are configuration options. Sessions can be created, loaded, resumed, listed and closed.
2. **MCP tools.** A plugin that offers the tools of MCP servers, over stdio and Streamable HTTP. Servers named in settings serve every session. Servers an ACP client passes serve only that session, and close with it. MCP's tool annotations become the tool's hints.
3. **Plugins loaded from settings.** Named in the global or project settings, with options.
4. **Project trust.** A project's plugins, and a project's settings for plugins, apply only after the user trusts the project. Its session defaults, such as the model, still apply.
5. **A full-screen terminal UI.** Optional, and last. Markdown that streams, tool calls with live output, and approvals as a selection list.

A real model run driven over ACP.

## Milestone 5: your binding

See `AGENTS.md` for which binding is yours, and the acceptance items for it.

## What to hand back

At the end of each milestone, report:
- what was built, and how to run it;
- the tests: how many, and that they pass;
- the real model runs, with what they showed;
- every gap you logged in `GAPS.md` during the milestone;
- anything you skipped, and why.
