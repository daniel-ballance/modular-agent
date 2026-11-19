# API

The shape of the API, in language-neutral terms. [Languages](languages.md) says how each language spells it. The [guides](guides/README.md) show it in use.

## Notation

- Types are `UpperCamelCase`; operations and fields are `lowerCamelCase`. Each language converts the case it needs, and only the case: `prompt` is `prompt` in every language, never `ask` or `run`.
- `op(a: Type, b?: Type) -> Result` describes an operation. `?` marks an optional argument. Operations that can wait are asynchronous in each language's own way.
- Data types not defined here are [shared data](../bindings/data.md) shapes, with the same field names. An SDK MUST serialize them with exactly the shared data names and rules.
- "Raises `code`" means the operation fails with an [error](#errors) of that code.

## Building an agent

`createAgent(options) -> Agent` builds and starts an agent. It loads every plugin, checks the composition and fails before returning if anything is wrong. Nothing runs until it succeeds.

| Option | Type | Default |
|---|---|---|
| `project` | path | the current directory |
| `dataDir` | path | none; required when the durability or a plugin keeps anything on disk |
| `durability` | `ephemeral`, `kept` or `durable` | `ephemeral`; see [Durability](placement.md#durability) |
| `history` | a history store | chosen by `durability`: memory, or files under `dataDir` |
| `runtime` | a Runtime | chosen by `durability` |
| `environment` | a working environment | local, rooted at `project` |
| `credentials` | a credential store | environment variables |
| `providers` | Providers | none |
| `tools` | tools | none |
| `plugins` | plugins, in load order | none |
| `processPlugins` | `{ command: string[], env?: object, config?: object }` | none; see [Placement](placement.md#a-plugin-in-another-process) |
| `model` | ModelRef or `"provider/id"` | the only model offered, if exactly one; otherwise none |
| `settings` | default settings for new sessions, by [setting key](../bindings/data.md#setting-keys) | none |
| `approval` | `off`, `ask`, `all` or `never` | no approval plugin |
| `onQuestion` | a question handler | none; see [Questions](#questions) |
| `pluginHost` | boolean | true: the agent hosts process plugins and reads `MODULAR_AGENT_PLUGINS`; see [Placement](placement.md#a-plugin-in-another-process) |

Each SDK provides constructors for the parts it ships: `transientRuntime()`, `durableRuntime()`, `memoryHistory()`, `fileHistory(dir)`, `httpHistory(url, tokenFile)`, `localEnvironment(root?)`, `environmentCredentials()` and `fileCredentials(path)`. `serve(plugin)` and `serveHistory(store, options)` are covered in [Placement](placement.md).

Each option that names a part is shorthand for a plugin that provides it. `providers`, `tools`, `environment` and the rest are added before `plugins`, in the order of this table, so an explicit plugin can [replace](#replacing-a-part) one of them.

`createAgent` raises `invalid_composition` for a combination the [durability](placement.md#durability) rules forbid, a missing `dataDir`, two parts with the same name, or a replacement that names nothing. It raises `not_supported` for a plugin that needs something this agent cannot give. A plugin or process plugin that fails to start fails the whole agent: the SDK MUST NOT run without a configured part or substitute another for it ([Choosing plugins at start](../bindings/plugin.md#choosing-plugins-at-start)).

## The agent

| Operation | Returns |
|---|---|
| `session(options?)` | a new Session. Options: `settings`, `tenant`, `actors`. |
| `openSession(id)` | an existing Session, reopened. Recovers interrupted work as the Runtime declares. |
| `sessions(filter?)` | stored sessions: id, project, title if any, last activity |
| `declaration()` | what this agent supports, as a [Declaration](../contracts.md#declaration) |
| `models()` | the models its Providers offer, as ModelInfo |
| `serveAcp()` | serves the agent over [ACP](../bindings/acp.md) on stdio until the client disconnects |
| `close()` | closes open sessions, stops plugins in reverse load order and releases what it holds |

An Agent is safe to use from several tasks at once. Sessions are independent of each other.

## Sessions and turns

| Operation | Returns |
|---|---|
| `id` | the session id |
| `prompt(input, options?)` | the TurnOutcome of the turn this input starts, once it ends |
| `promptStream(input, options?)` | the events of that turn as a stream, ending with its `turnEnded` event |
| `send(input, timing, options?)` | an InputReceipt, without waiting for any turn. `timing` is `now`, `steer`, `after` or `propose` ([Input](../contracts.md#input)). |
| `cancel()` | cancels the running turn; returns the inputs handed back |
| `settings()` / `setSetting(key, value)` | the current settings / records a change |
| `history(options?)` | the recorded entries, in order, as this actor may see them |
| `fork(entryId?)` | a new Session branching from that entry, or from the current position |
| `moveTo(entryId, options?)` | moves the current position; `rewind: true` also restores files where the environment can |
| `erase(entryIds)` | an ErasureReport |
| `commands()` / `runCommand(line)` | the commands available / runs one |
| `callTool(name, input)` | a ToolResult; a direct call by this actor, through every gate |
| `events(fromEntry?)` | every event in the session this actor may see, from the start or a cursor, then live |
| `close()` | closes the session; cancels its work as [Jobs](../contracts.md#jobs) says |

`input` is a string or Content. `options` carries `key`, for safe retries ([input admission](../contracts.md#input)), and `actor`, to act as an actor other than `local`.

A **TurnOutcome** has:

| Field | Type |
|---|---|
| `outcome` | `completed`, `cancelled`, `failed` with `error`, or `limit` with `limit` |
| `text` | the final answer's text, empty if none |
| `value` | the structured result, if the turn asked for one |
| `openToolCalls` | calls left open past the turn, by id |
| `usage` | Usage for the turn |
| `turnId` | the turn's id |
| `toolResults()` | the turn's recorded ToolResults, in call order, each with its tool `name` and a `text()` helper that joins its text content |

`prompt` waits for the turn the input starts. If the input does not start a turn, for example because it is taken into a running turn or handled by a hook, `prompt` returns when that turn ends, or at once with outcome `completed` and empty text when no turn takes it. A failed turn is an outcome, not an error: `prompt` raises only when the input itself is refused.

A structured result is requested with `options.result`, a schema; `value` then holds the checked result ([Turn result](../contracts.md#hook-execution)).

## Events

`events` and `promptStream` deliver [standard events](../contracts.md#event) as a tagged union. Each event has `type`, `time`, the ids it concerns and `data`. Where [shared data](../bindings/data.md#output-events) names an output event, the SDK uses that name and payload; the rest are named after the specification's events:

| Group | Event types |
|---|---|
| Session | `sessionStarted`, `sessionEnded`, `actorJoined`, `actorLeft` |
| Input | `inputAccepted`, `inputWithdrawn`, `inputHandedBack` |
| Turns and steps | `turnStarted`, `turnEnded`, `stepStarted`, `stepEnded` |
| Model output | `text`, `reasoning`, `toolInput` |
| Tools | `toolCall` (requested), `toolStarted`, `toolOutput` (progress), `toolResult` (ended) |
| Questions | `questionOpened`, `questionAnswered`, `questionClosed` |
| Jobs | `jobStarted`, `jobProgress`, `jobEnded` |
| History | `entry`, `positionMoved`, `entriesErased` |
| Changes | `settingChanged`, `pluginLoaded`, `pluginReplaced`, `pluginUnloaded` |
| Plugins | the plugin's own type, which contains a dot |

Every event passes the [output gate](../contracts.md#the-output-gate) for the receiving actor first. Live model output is never history; `entry` reports what was kept.

A slow reader never blocks the agent. The SDK buffers each stream within a bound; a reader that falls behind it is told how far it got and resumes with `events(fromEntry)`, which replays kept entries but not live deltas ([Following a session](../contracts.md#following-a-session)).

## Questions

A question handler receives a **Question** and returns an **Answer**:

```
onQuestion(question: Question, context) -> Answer
```

| Question field | |
|---|---|
| `id`, `sessionId`, `kind` | `kind` is `approval`, `choice`, `text`, `link` or `secret` |
| `question`, `details`, `options` | what to show |
| `call` | for an approval: the exact tool call, name and input |
| `deadline` | when it closes, if timed |

An Answer is `allow` (approval), a value (choice, text, link), a secret (stored, never returned) or `decline` with an optional reason. A handler that raises or returns nothing declines.

The handler can be set on `createAgent` for every session or on one session with `session.onQuestion`. `session.questions()` lists open questions and `session.answer(questionId, answer)` answers one later, for apps that show questions in their own UI.

While a handler is registered, the `local` actor is present to answer. With none, [approvals are refused](concepts.md#the-local-actor).

## Actors and rights

An embedded agent has the `local` actor. An app that serves several people adds actors:

| Operation | |
|---|---|
| `session.join(actor, grantedBy?)` | adds an Actor (`id`, `kind`, `rights`) |
| `session.leave(actorId)` | removes one |
| `session.as(actorId)` | a view of the session that acts as that actor: `prompt`, `send`, `answer` and the rest are attributed and checked against its rights |
| `session.setLimit(rights?)` | the [session limit](../contracts.md#limits-and-tenants) |

Rights are the specification's named rights (`watch`, `propose`, `input`, `answer`, `approve`, `tools`, `cancel`, `settings`, `erase`, `grant`, `jobs`, `delegate`, `administer`). A refused operation raises `refused` with the missing right in its data.

Authority comes from the app, which is the operator here. An Interface such as ACP authenticates its own actors; the SDK MUST NOT take an actor id from a client's request as proof of identity ([Security](../security.md#trust-boundaries)).

## Plugins

A **Plugin** has:

| Field | |
|---|---|
| `name` | unique in the agent; stable, because history records it |
| `replaces` | items it replaces, as `runtime`, `working-environment`, `provider:<id>`, `tool:<name>` or `command:<name>` |
| `setup(registrar)` | registers what the plugin provides, once, at load |
| `stop()` | optional; releases what it holds |

`setup` receives a **Registrar** and registers items with it. It runs once, before any session opens; it does no work for a session.

| Registrar operation | Registers | Servable |
|---|---|---|
| `tool(tool)` / `tools(source)` | one tool, or a tool source whose list can change | yes |
| `provider(provider)` | a Provider | yes |
| `environment(environment)` | the working environment | yes |
| `runtime(runtime)` | the Runtime | yes |
| `on(point, handler, order?)` | a hook handler at a [core hook point](#hooks) | yes, except the points marked |
| `command(name, description, handler)` | a command | yes |
| `jobs(owner)` | that this plugin owns jobs, and how to cancel and resume them | yes |
| `historyStore(store)` | the history store | no: it has its own [binding](../bindings/history-http.md) |
| `credentialStore(store)` / `configuration(source)` | those parts | no |
| `interface(interface)` | an Interface | no |
| `defineHook(name, rule)` | a hook point this plugin owns, for other plugins | no |

A plugin that registers only servable items is **servable**: the SDK can [serve it](placement.md#a-plugin-in-another-process) over the plugin binding. Registering any other item, or using a hook point or answer marked in-process only, makes it **in-process only**. `serve` refuses such a plugin with `not_supported` and names the item; it never serves the rest and drops the item silently.

A tool, a Provider or a working environment passed directly to `createAgent` is wrapped in a plugin named after it.

### Replacing a part

A plugin replaces a part by naming it in `replaces` and registering its own. `durableRuntime()` replaces `runtime`; a sandbox plugin replaces `working-environment`. A replacement that names nothing the agent has raises `invalid_composition`, so a typo cannot add a second part silently ([registration rules](../bindings/plugin.md#starting-the-handshake)).

## Contexts

A plugin reaches the agent only through the context passed to the call it is serving. Each context carries the work's identity, its cancellation and what that work may ask:

| Member | Tool | Hook | Provider | Command | Job |
|---|---|---|---|---|---|
| `sessionId`, `actorId` and work ids | ✓ | ✓ | ✓ | ✓ | ✓ |
| `cancelled`: the language's cancellation signal | ✓ | ✓ | ✓ | ✓ | ✓ |
| `progress(content)` | ✓ | | | | ✓ |
| `ask(question, wait?)` | ✓ | | | ✓ | |
| `environment`: the session's working environment | ✓ | | | ✓ | ✓ |
| `tools.list()`, `tools.call(name, input)`: [nested calls](../contracts.md#nested-calls) | ✓ | | | | |
| `credential(name)` | ✓ | | ✓ | | |
| `history(cursor?)`: pages of history, as this work may read it | ✓ | ✓ | | ✓ | ✓ |
| `jobs.start(kind, detail, key?)` | ✓ | | | ✓ | |
| `log(message)`: operator diagnostics, never shown to the model | ✓ | ✓ | ✓ | ✓ | ✓ |
| `refuse(reason)`: ends the call as `refused` | ✓ | | | | |

These match the requests a served plugin can make under a live parent request ([What a plugin may ask the host](../bindings/plugin.md#what-a-plugin-may-ask-the-host)). A context is valid only until its call settles. Using it afterwards raises `invalid_request`. A plugin that needs to act later starts a [job](#jobs).

## Tools

A **Tool** has a definition and a function:

| Definition field | Default |
|---|---|
| `name`, `description` | required |
| `input` | required: a schema, written in the language's usual way ([Languages](languages.md#schemas)) and sent as JSON Schema 2020-12 |
| `output` | none. A schema for `value`; when set, the agent checks every completed result against it. |
| `readOnly`, `destructive`, `openWorld`, `safeToRepeat` | the [shared defaults](../bindings/data.md#tools): false, true, true, false. Marking a tool read-only also makes it non-destructive. |
| `parallel` | false |
| `callers` | `model`, `ui` and `plugin` |
| `presentation` | none |

The function receives the input, already checked against the schema and converted to the language's type, and a [tool context](#contexts). What it returns becomes the ToolResult:

| The function | Result status | Content |
|---|---|---|
| returns text | `completed` | that text |
| returns Content | `completed` | that content |
| returns a value, with `output` set | `completed` | `value` is the value; content is its JSON text unless the tool gives content too |
| returns a ToolOutput `{ status?, content, value? }` | as given: `completed`, `failed`, `refused` or `outcomeUnknown` | as given |
| calls `refuse(reason)` | `refused` | the reason |
| raises an error | `failed` | the error's message |
| stops because `cancelled` fired | `cancelled` | that the call was cancelled |

Every result that is not `completed` MUST say what failed or may have happened ([Tool result](../bindings/data.md#tools)); the SDK supplies the wording where the tool gives none. `notStarted` is the agent's to report, not a tool's.

**Questions from a tool.** `ask` opens a question and waits for its answer. `ask(question, { wait, then: "leaveOpen" })` lets the call stay open past the turn if no answer comes in time, where the agent declares it can ([Questions](../contracts.md#questions)). The wait then ends with a `LeftOpen` signal. A tool that does not catch it ends, and the SDK replies pending. The tool runs again from the top when the answer comes, so it MUST ask the same questions in the same order and cause no effect before them; asking again returns the recorded answer.

**Nested calls.** `tools.call(name, input)` asks the agent to run another tool as a nested call. It passes that tool's own gates and approval and returns its ToolResult. A nested call that would wait past its parent's turn is refused instead ([edition 4 draft](../adr/0023-edition-4-draft.md#3-a-nested-call-is-never-left-open)).

A **tool source** is a set of tools whose list can change, such as an MCP server's. It provides `tools(sessionId?) -> Tool[]` and calls `changed()` when the list changes.

## Providers

A **Provider** has:

| Member | |
|---|---|
| `id` | unique in the agent; the first half of every ModelRef it offers |
| `models() -> ModelInfo[]` | the catalog; it can call `changed()` when the catalog changes |
| `supports` | `keepsState` and `safeToRepeat` ([Provider support](../bindings/plugin.md#the-host-asks-a-provider)) |
| `available() -> boolean` | optional: whether it can be used now, for example whether it has credentials |
| `request(model, request, context) -> AssistantMessage` | makes one model request |
| `discardState(sessionId)` | optional, for a Provider that keeps state |

`request` reports output as it arrives with `context.piece(type, delta, toolCallId?)`, then returns the complete AssistantMessage. A model failure is an AssistantMessage with stop `failed` and a ModelError, or the language's error carrying a ModelError: either way the agent sees `kind` (`temporary`, `contextTooLarge`, `credentials`, `refused` or `other`), never only a message. The Provider asks for credentials through `context.credential(name)`; it never receives them in configuration.

In process, a Provider can also run tools itself, hold a live session or answer late. Those are in-process only ([Model request and response](../contracts.md#model-request-and-response)).

## Hooks

`on(point, handler, order?)` registers a handler at a hook point. `order` is `first`, `normal` or `last`. Handlers combine by the [core rules](../contracts.md#hook-execution). Each point has a typed payload and a typed answer; returning nothing passes.

| Point | Payload | Answer |
|---|---|---|
| `plugin.load` | the plugin about to load and its origin | `allow`, or `refuse(reason)` |
| `session.start` / `session.end` | the session, and whether it was reopened | observe |
| `input` | the input, its actor and timing | `change(content)`, or `handle()` to take it without a turn |
| `turn.before` | the input starting the turn | `add({ system?, context? })` |
| `turn.start` / `turn.end` | the turn; at the end its outcome and result | observe |
| `step.before` | the prepared ModelRequest and model limits | `change(request)` |
| `step.after` | the step's recorded response | `continue`, or `end(reason)` |
| `tool.before` | the call and its definition | `allow`, `refuse(reason)`, `change(input)`; in process only, `ask(question)` |
| `tool.after` | the call and its result | `change({ content?, value? })` |
| `model.failed` | the request and its ModelError | `retry(request?)`, or `stop` |
| `turn.result` | the result and the expected shape | `accept`, or `refuse(feedback)` |
| `provider.request` | the ModelRequest a Provider is about to send | `change(request)` |
| `provider.response` | the complete response | observe |
| `output` | events about to reach a recipient | `redact(events)`, or `block` |

**In process only:** `session.join` and `session.leave`; `provider.piece`, for each piece of a Provider's response; `ask` as an answer to `tool.before`; and every point a plugin defines with `defineHook`. The [plugin binding](../bindings/plugin.md#from-core-hooks-to-wire-hooks) carries none of these.

A change MUST stay within what its point allows. The agent checks every answer and treats one that changes anything else as a handler failure: a `step.before` change that adds a tool, for example.

## Commands

`command(name, description, handler)` registers a command. The handler receives the argument text and a command context, and returns text for the actor or nothing. A command never starts a turn. One that uses a model declares it when registered ([Commands](../contracts.md#commands)).

## Jobs

A plugin that starts work outliving a turn registers a **job owner**:

| Member | |
|---|---|
| `cancel(job, context)` | stops the job and ends it |
| `resume(job, context)` | optional: takes up an unfinished job after a restart |

`context.jobs.start(kind, detail, key?)` records a job and returns a **Job** handle with `progress(content)` and `end(outcome, result?, report?)`. A job reporting its result with `report: true` puts the result into the session as input, which can start a turn. After a restart, the agent offers each unfinished job of this plugin to `resume`; a job the owner does not resume stays unfinished. See [Jobs](../contracts.md#jobs).

## The other parts

These are written rarely. Each is an interface a plugin implements, with the operations the [Interactions](../contracts.md#interactions) tables list. Their exact signatures are in each SDK's reference documentation, which MUST name every operation as that table does.

| Part | Interface | Notes |
|---|---|---|
| Working environment | `readFile`, `writeFile`, `exec`, `list`, `savePoint`, `checkPoint`, `restorePoint`, `sessionEnded`, `declaration` | A missing file raises `not_found`. `exec` streams output and honors cancellation and deadlines ([Command lifetime](../bindings/plugin.md#command-lifetime)). |
| History store | `acquire`, `renew`, `release`, `append`, `read`, `list`, `erase` | Appending the same entries twice keeps them once. |
| Credential store | `get`, `stage`, `lookupStaged`, `activate`, `discard` | [Secrets](../contracts.md#secrets) defines the order. |
| Configuration | `settings(project)`, `trusted(project)` | |
| Runtime | `declaration`, `run(turn, context)`, `resume(turn, checkpoint, context)` | The context offers the [Runtime callbacks](../bindings/plugin.md#runtime-callbacks): model requests, tool calls, hooks, records and steering. |
| Interface | `start(agent)`, `stop()` | The only part given the whole Agent. It authenticates its own actors. |

## Errors

Every SDK error has a `code`, a `message` for people and optional `data`. Programs branch on `code` only.

| Code | When |
|---|---|
| `invalid_request` | bad arguments, a stale context, or an operation in the wrong state |
| `invalid_composition` | `createAgent` was given parts that cannot work together |
| `not_found` | a named session, entry, file, point, tool or question does not exist |
| `refused` | an actor lacks a right, or a policy or gate refused |
| `busy` | the session is held by another writer, or the operation cannot run during a turn |
| `cancelled` | the operation was cancelled |
| `not_supported` | this agent, part or placement does not support it |
| `turn_limit` | a limit stopped the work; `data.limit` names it |
| `result_too_large` | a result did not fit its limit |
| `lost` | a part or connection was lost; the outcome of the work may be unknown |
| `internal` | anything else |

Codes shared with the [plugin binding](../bindings/plugin.md#errors-and-connection-loss) mean the same thing, so a served plugin's error keeps its code across the wire. `invalid_composition`, `refused` and `busy` are the SDK's own.

## Data types

The SDK's data types are the [shared data](../bindings/data.md) shapes: Content and its parts, Message, ModelRef, ModelInfo, ModelRequest, AssistantMessage, ModelError, Usage, ToolDefinition, ToolCall, ToolResult, InputRequest, Answer, Actor, HistoryEntry, Outcome, Declaration and the rest. Each SDK MUST:

- use the shared field names, converting only their case where the language requires and serializing them unchanged;
- keep unknown fields and unknown content parts when it stores or relays a shape;
- represent each closed set of values, such as ToolStatus or a ModelError's kind, as the language's enumeration, with a way to keep an unknown value where shared data says to.

The types will be generated from shared data's JSON Schema once it has one.
