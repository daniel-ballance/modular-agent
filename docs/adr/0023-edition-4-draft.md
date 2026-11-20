---
status: accepted
date: 2026-11-19
---

**Current rule:** accepted as edition 4 by [ADR 0027](0027-sdk-0-1-and-edition-4.md) once all four builds implemented it and the cross-language matrix ran. The text below is the record of the draft.

# Edition 4 draft: rules from the first working build

[ADR 0022](0022-standard-configuration.md) built a system to use on edition 3. It was the first build made to be worked with, not to pass a matrix, and it reached into places the five experiment builds had not. Seven times it had to guess. This record turns those guesses into rules.

The rules are a **draft**. Only the Rust build implements them, and no swap has tested them. [Production edition 3](0021-production-edition.md) stays the edition to pin until another build has met these rules and a matrix has run.

## Decision

Every change is optional on the wire, so the bindings keep their major versions and an edition 3 build still passes the kits.

### 1. A tool can start another call

**Background.** The standard configuration offers the model one code tool. That tool calls the file tools and MCP tools. Contracts already said a nested call passes its own gates, and shared data already had `startedBy: "tool"` and `parentCallId`. Nothing said how a tool asks for one, and the plugin binding had no request for it, so a code tool could not live in another process.

**Rule.** A running call asks the Harness, which makes the nested call: fresh id, the parent's actor, turn and step, its own gates and approval, its own committed start and result. On the wire this is `host/tools/list` and `host/tools/call`. See [Nested calls](../contracts.md#nested-calls).

**Options.**
- *Let the tool source call other sources itself.* No gate would see the call and no record would show it. Rejected: it breaks "every agent-executed call goes through the Harness".
- *Reuse `host/runtime/runToolCall`.* That request belongs to a Runtime and assumes a call the model made. A tool source is not a Runtime.
- *A request of its own, answered with the committed result.* Chosen. It mirrors how a remote Runtime is handed results it did not write.

### 2. A nested call needs a registration, not a place in the offer

**Background.** "The recorded final offer governs which calls from that attempt can run." If that covered nested calls, a session that offers the model one tool could run nothing.

**Rule.** The offer governs the calls a model starts. A nested call needs a live registration whose callers include a plugin.

**Options.** Requiring the offer would force every callable tool into the model's tool list, which defeats the point of a code tool. Requiring nothing at all would let a tool source reach tools its author marked as model-only or UI-only. The caller set is the tool author's existing statement, so it decides.

### 3. A nested call is never left open

**Background.** A question with a deadline can leave a call open past its turn, and the call continues in a later turn. A nested call's parent is still running. Leaving the child open would mean leaving the parent open too, with half its work done.

**Rule.** If a gate answers pending for a nested call, the Harness closes that call's questions as `noLongerAnswerable` and settles it `refused`. The asking tool sees a refusal and carries on.

**Options.** Leaving both open was rejected: the parent's partial effects are not safe to repeat in general, and [Questions](../contracts.md#questions) already require that of a tool leaving a call open. Failing the parent was rejected as harsher than the asker needs.

### 4. What the model is offered is a setting

**Background.** A tool's `callers` is its author's statement. The operator had no way to say "register these tools, offer the model only that one". The Rust build used a private setting, which another build reopening the session would ignore, silently widening the model's tools.

**Rule.** `modelTools` is a standard setting key: an array of tool names, or `null` for every tool that allows the model. It narrows the offer and nothing else.

**Options.**
- *Composition only, not recorded.* Simple, and not portable: the reopening build cannot know.
- *A per-tool flag from the tool source.* That is `callers`, and it is the wrong owner for an operator's choice.
- *A session setting.* Chosen. It is recorded, it follows forks, changing it needs `settings`, and the turn's recorded offer still says what each past turn had.

It is not a right. Authority still comes only from rights and gates, and a tool left out of the offer can still be reached by a nested call that passes them. ACP gets no control for it in this draft: it is set from operator configuration when the session is created.

### 5. A client is told a nested call's parent

**Rule.** The nested call's first ACP update carries `parentToolCallId` in the binding's metadata. A client that does not know the field shows an ordinary call.

**Options.** Hiding nested calls from clients was rejected: they are the agent's real effects, and approval for one has to show the exact call anyway.

### 6. A working environment can list a directory

**Background.** The environment wire had read, write, exists and exec. `find` and `list` against a remote environment had to run shell commands and parse their output, which is the "branching on text" the swaps taught us to avoid.

**Rule.** `env/list` and `host/env/list` return entries with a kind. The method is optional. A caller treats `not_supported` as absence and may fall back to `env/exec`.

**Options.** A recursive walk with ignore rules was left out. It is a policy (whose ignore files, which depth) more than an operation, and a caller can build it from `env/list`.

### 7. Three Provider clarifications

From the Claude sidecar's guesses:

- **Cancel.** A cancelled `provider/request` answers `cancelled` and sends no `provider.response`.
- **An unlisted reasoning level.** The host already lowers a level to the nearest one the model lists. A Provider handed an unlisted level anyway does the same. It never raises it and never fails for it.
- **`outOfReach`.** Each item is a sentence for a person. Nobody branches on it.

## Evidence

- The Rust build implements all seven, in process and over the plugin binding, as host and as served plugin.
- The kits gained checks that run only for builds that declare or register the new parts. The TypeScript build, left at edition 3, still passes the kits it passed before.
- [The Rust README](../../rust/README.md#what-is-checked) has the commands and counts.

## Consequences

- TypeScript, Python, Go and Elixir do not implement the draft. Nothing here breaks them, and nothing here has been swapped.
- A session that records `modelTools` and is reopened by an edition 3 build is offered that build's full tool set from then on. This is the one place the draft can change behaviour across builds. It widens what the model can ask for, not what anyone is allowed to do.
- The draft becomes an edition when a second build has implemented it and the plugin and portable matrices have run with nested calls in them.
