# Scenarios

**Status:** draft, 2026-11-16.

Each scenario tells what happens in one situation, using only the parts in [Architecture](architecture.md) and the interactions in [Contracts](contracts.md). They test the description: if a scenario can't be told with what is there, something is missing. "Open" lists the gaps each one exposes.

All scenarios use the same agent unless they say otherwise. It is the Harness plus these plugins:
- **Interface:** a terminal UI
- **Runtime:** a transient Runtime
- **Provider:** one vendor's models
- **Tool source:** built-in file and shell tools
- **History store:** files on disk
- **Credential store:** stored API keys
- **Feature plugins:** model selection, system prompt, context management, approval

## 1. A request that uses a tool

The user types "Read config.json and summarize it."

1. The terminal UI gives the input to the session, to be taken now.
2. At "input arrives", no plugin handles it as a command, so it goes on. The input is recorded in the history.
3. At "before a turn", the system prompt plugin adds the base instructions and the project's `AGENTS.md`.
4. The Harness asks the Runtime to run a turn. It gives the Runtime the input, the tool definitions, access to the model that model selection chose, and the session's limits.
5. Before the first step, context management decides what the model sees: everything, since the history is short.
6. The Runtime makes a model request. The response asks for the `read` tool with `config.json`. The terminal UI shows the response as it arrives.
7. After the step, no plugin ends the turn.
8. Before the tool call, the approval plugin sees that `read` is read-only, and allows it.
9. The Runtime asks for the tool call to be run. The Harness passes it to the file tools, which return the file's contents.
10. Before the second step, context management includes the tool call and its result.
11. The second model request returns the summary.
12. After the step, there are no tool calls left, so the turn ends as **completed**. The Runtime reports two steps, the new history entries and the usage. The history store keeps them.

**Must hold:** every entry is tied to its session, turn, step and tool call. The Runtime never saw a credential or chose the model.

## 2. A tool call that needs approval

In the middle of a turn, the model asks to run `rm -rf build/`.

1. Before the tool call, the approval plugin sees a destructive call. The session's policy is "ask", so it opens an input request of kind approval, tied to the tool call. The options are "allow" and "refuse".
2. The terminal UI shows the request beside the pending tool call, so the user sees what the agent was doing. The turn waits.
3. The user chooses "allow". The approval plugin records the request and the answer in the history, where the model doesn't see them, and allows the call.
4. The call runs, and the turn carries on.

**Variations:**
- The user refuses. The call ends as **refused**, with the reason as its result, and the model sees that.
- No Interface able to answer is present. The call is **refused**: approval fails closed.
- The session's policy is "never ask". The call is refused at once, without asking.

## 3. A question nobody answers in time

The model calls a tool that asks the user which database to use. The user has walked away.

1. The tool opens an input request of kind choice, with a time limit, tied to the tool call.
2. The time limit passes. The tool call ends with a result that says the question is still open. The model carries on with other work, or the turn ends.
3. The question stays open, with no deadline.
4. An hour later the user answers. The answer is given to the session as new input, and it starts a new turn, which knows which question it answers.

**Open:**
- With a durable Runtime, should the answer resume the original turn instead? ([open question](open-questions.md#waiting-for-the-user))
- Who sets the time limit?

## 4. The user adds a message while the agent works

While a turn is running, the user types "use the staging config, not production".

1. The terminal UI gives the input to the session, to be taken in the running turn.
2. The Runtime takes it before its next model request, and the model sees it in the next step.

If the user had asked for it to be taken after the turn, it would wait and start a new turn once this one ends.

**Open:** can every Runtime take input in a running turn, and what happens if one can't? ([open question](open-questions.md#input-during-a-turn))

## 5. The user cancels

A turn is running a long shell command when the user presses Escape.

1. The terminal UI cancels the session's running turn.
2. The Runtime asks for the running tool call to be cancelled. The call ends as **cancelled**.
3. Any open input request tied to the turn is closed as cancelled.
4. The turn ends as **cancelled**. Everything recorded so far stays in the history.

**Must hold:** every tool call ends with exactly one result.

**Open:** what happens to input queued for after the turn? ([open question](open-questions.md#cancellation))

## 6. The conversation outgrows the model's context

A long session is close to the model's context window.

1. Before the next step, context management sees the usage so far and the model's limits.
2. It uses the Provider to summarize the older part of the history.
3. It adds the summary to the history as an entry the model sees. Nothing is deleted.
4. It gives the Runtime a model context made of the summary and the recent history.

**Variation:** the model request fails because the context is too large. At "a model request failed", context management summarizes and asks for a retry.

## 7. The process stops during a tool call

The machine restarts while a shell command is running.

**With the transient Runtime:**
1. The session's history survives in the history store.
2. When the session is opened again, the interrupted turn is recorded as ended. The shell command's result is **outcome unknown**. A tool call that had been requested but not started is **not started**.
3. Nothing with an unknown outcome is run again automatically. The model sees the statuses in the next turn, and can decide what to do.
4. An input request that was open in the stopped process is shown as **no longer answerable**.

**With a durable Runtime:**
1. The turn carries on after the restart, from where it was.
2. Work that had finished is not done again.

**Open:** what the history must record for a durable Runtime to do this ([open question](open-questions.md#transient-and-durable-runtimes)).

## 8. Handing a task to a subagent

The agent decides to have another agent review its change. A subagents plugin offers a "delegate" tool.

1. The model calls "delegate" with the task and a choice of model.
2. The subagents plugin starts a child session, recorded as belonging to the parent. The child gets only the task, not the parent's history. Its approval policy is no freer than the parent's.
3. The "delegate" call ends with a result saying the task has started, and the parent's turn carries on or ends.
4. The child asks the user a question. The request reaches the user through the parent's Interface, marked as coming from the child.
5. The child finishes. Its result is given to the parent session as new input, which starts a parent turn if none is running.

**Open:** is this a plugin, or a layer above the agent? ([open question](open-questions.md#a-layer-above-the-agent))

## 9. Work starts with nobody present

A scheduling plugin runs "check for dependency updates" every morning.

1. At the set time, it gives the input to a session, to be taken now.
2. The session's approval policy is "never ask", so no tool call waits on a user.
3. The turn runs as in scenario 1. Its outcome and history are there when the user next opens the session.

**Must hold:** nothing waits forever on a user who isn't there.

## 10. Changing the model mid-session

The user switches from one vendor's model to another's between turns.

1. The model selection plugin changes the session's model setting. The change is recorded in the history.
2. The next turn's Runtime is given access to the new model.
3. Context management decides what the new model sees, from the same history.

**Open:** can the model change in the middle of a turn? ([open question](open-questions.md#changing-the-model-mid-turn))
