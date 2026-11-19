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
| `approval` | `off`, `ask`, `all` or `never` | absent: no approval plugin. Any value loads the approval plugin and records that policy for new sessions; `off` means the plugin is loaded and its check does not ask ([Approval policy](../contracts.md#approval-policy)). |
| `onQuestion` | a question handler | none; see [Questions](#questions) |
| `pluginHost` | boolean | false, or true when `processPlugins` is given. A plugin host also reads `MODULAR_AGENT_PLUGINS`; see [Placement](placement.md#a-plugin-in-another-process). |
| `jobReportsStartTurns` | boolean | false: a job's report is parked until released ([Jobs](../contracts.md#jobs)) |

Each SDK provides constructors for the parts it ships: `transientRuntime()`, `durableRuntime()`, `memoryHistory()`, `fileHistory(dir)`, `httpHistory(url, tokenFile)`, `localEnvironment(root?)`, `environmentCredentials()` and `fileCredentials(path)`. `serve(plugin)` and `serveHistory(store, options)` are covered in [Placement](placement.md).

Each option that names a part is shorthand for a plugin that provides it. `providers`, `tools`, `environment` and the rest are added before `plugins`, in the order of this table, so an explicit plugin can [replace](#replacing-a-part) one of them.

`createAgent` raises `invalid_composition` for a combination the [durability](placement.md#durability) rules forbid, a missing `dataDir`, two plugins with the same name, or a [replacement](#replacing-a-part) the registration rules refuse. It raises `not_supported` for a plugin that needs something this agent cannot give. A plugin or process plugin that fails to start fails the whole agent: the SDK MUST NOT run without a configured part or substitute another for it ([Choosing plugins at start](../bindings/plugin.md#choosing-plugins-at-start)).

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

### The declaration

`declaration()` returns every key of the [ACP declaration](../bindings/acp.md#the-declaration), computed from the parts the agent was built with. The SDK never guesses a key: each comes from a part's own declaration or from a choice in `createAgent`. Where support varies, the agent declares the more restrictive value. With the parts the SDK ships:

| Key | Value |
|---|---|
| `continuesAfterRestart` | true under `durable`; false otherwise ([Durability](placement.md#durability)) |
| `waitingThroughRestart` | false |
| `queuedInputAfterRestart` | `handedBack` |
| `portableSessions` | true under `kept` and `durable`, whose stores keep the shared format; false under `ephemeral` |
| `inputDuringTurn` | true: both Runtimes take steering |
| `forking` | true |
| `rewinding` | true only if the working environment declares `points` |
| `keepsStateAtProvider`, `runsToolsAtProvider`, `liveSessions` | from the Providers; false for those the SDK ships |
| `severalActors`, `sessionLimits`, `tenants` | false unless the app enables them |
| `holdsOutput`, `outputBypassesAgent` | false |
| `cancellingTurnCancelsJobs` | false |
| `pluginsDuringSession` | false |
| `erasure` | true |
| `inputKeys` | true |
| `questionsOutlastTurns`, `lateAnswersStartTurns` | false unless the app enables both |
| `startsTurnsUnasked` | `jobReports` if `jobReportsStartTurns`; otherwise `never` |
| `movingWithUnfinishedWork` | `refused` |
| `mixedActorInput` | `refused` |
| `settingsDuringTurn` | `nextTurn` |
| `erasureDuringTurn` | `refused` |
| `commandContainment` | from the working environment; `processGroup` for the local one |
| `confinesFiles` | from the working environment; true for the local one, which refuses paths that resolve outside the project |
| `nestedToolCalls` | true |

The [shared scenarios](testing.md#the-shared-scenarios) and the ACP kit check these values.

## Sessions and turns

| Operation | Returns |
|---|---|
| `id` | the session id |
| `prompt(input, options?)` | a PromptResult, once the turn that takes this input ends or the input is settled without a turn |
| `promptStream(input, options?)` | the events of that turn as a stream, ending with its `turnEnded` event, or at once if the input is settled without a turn |
| `send(input, timing, options?)` | an InputReceipt, without waiting for any turn. `timing` is `now`, `steer`, `after` or `propose` ([Input](../contracts.md#input)). |
| `cancel()` | cancels the running turn; returns the inputs handed back |
| `settings()` / `setSetting(key, value)` | the current settings / records a change. During a turn the change applies from the next turn, or is refused with `busy`, as the agent declares `settingsDuringTurn`. |
| `history(options?)` | the recorded entries, in order, as this actor may see them: the gated view, not the raw record |
| `fork(entryId?)` | a new Session branching from that entry, or from the current position |
| `moveTo(entryId, options?)` | moves the current position; `rewind: true` also restores files where the environment can |
| `erase(entryIds)` | an ErasureReport |
| `commands()` / `runCommand(line)` | the commands available / runs one |
| `callTool(name, input)` | a ToolResult; a direct call by this actor, through every gate |
| `events(fromEntry?)` | every event in the session this actor may see, from the start or a cursor, then live |
| `close()` | closes the session; cancels its work as [Jobs](../contracts.md#jobs) says |

`input` is a string or Content. `options` carries `key`, for safe retries ([input admission](../contracts.md#input)), and `actor`, to act as an actor other than `local`.

`prompt` admits its input with timing `now`, as ACP's `session/prompt` does ([Input admission](../bindings/acp.md#input-admission)). When the session is idle, the input starts a turn. When a turn is running, the input queues a new turn and `prompt` waits for that one, not the running one. Only `send(input, "steer")`, where the agent declares `inputDuringTurn`, puts input into a running turn.

A **PromptResult** has:

| Field | Type |
|---|---|
| `inputId` | the admission's id |
| `disposition` | `turn`, or `handled` or `handedBack` for an input settled without a turn ([Prompts](../bindings/acp.md#prompts)). The fields below are present only for `turn`. |
| `outcome` | `completed`, `cancelled`, `failed` with `error`, or `limit` with `limit` |
| `text` | the final answer's text, empty if none |
| `value` | the structured result, if the turn asked for one |
| `openToolCalls` | calls left open past the turn, by id |
| `usage` | Usage for the turn |
| `turnId` | the turn's id |
| `toolResults()` | the turn's recorded ToolResults, in call order, each with its tool `name` and a `text()` helper that joins its text content |

An input that a hook handles, or that is handed back before a turn takes it, returns its disposition and no outcome. A failed turn is an outcome, not an error: `prompt` raises only when the input itself is refused.

A structured result is requested with `options.result`, a schema; `value` then holds the checked result ([Turn result](../contracts.md#hook-execution)).

## Events

`events` and `promptStream` deliver [standard events](../contracts.md#event) as a tagged union. Each event has `type`, `time`, the ids it concerns and `data`. Where [shared data](../bindings/data.md#output-events) names an output event, the SDK uses that name and payload; the rest are named after the specification's events:

| Group | Event types |
|---|---|
| Session | `sessionStarted`, `sessionEnded`, `actorJoined`, `actorLeft` |
| Input | `inputAccepted`, `inputWithdrawn`, `inputHandedBack` |
| Turns and steps | `turnStarted`, `turnEnded`, `stepStarted`, `stepEnded` |
| Model output | `text`, `reasoning`, `toolInput`, `audio` |
| Tools | `toolCall` (requested), `toolStarted`, `toolOutput` (progress), `toolResult` (ended) |
| Questions | `questionOpened`, `questionAnswered`, `questionClosed`, `questionNoLongerAnswerable` |
| Jobs | `jobStarted`, `jobProgress`, `jobEnded` |
| History | `entry`, `positionMoved`, `entriesErased` |
| Changes | `settingChanged`, `pluginLoaded`, `pluginReplaced`, `pluginUnloaded` |
| Plugins | the plugin's own type, which contains a dot |

The agent emits every standard event for the actions and states it supports ([Following a session](../contracts.md#following-a-session)). `questionNoLongerAnswerable` is distinct from `questionClosed`: the first says no eligible actor can answer any more, the second that the question has a recorded closure.

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

An Answer is `allow` (approval), a value (choice, text, link), a secret value (secret) or `decline` with an optional reason. A handler that raises or returns nothing declines. A secret value goes only to the credential store; nothing records or returns it ([Secrets](../contracts.md#secrets)).

The handler can be set on `createAgent` for every session or on one session with `session.onQuestion`, which takes precedence for that session. `session.questions()` lists open questions and `session.answer(questionId, answer)` answers one later, for apps that show questions in their own UI.

While a handler is registered, the `local` actor is present to answer. With none, [approvals are refused](concepts.md#the-local-actor).

## Actors and rights

An embedded agent has the `local` actor. An app that serves several people adds actors:

| Operation | |
|---|---|
| `session.join(actor, grantedBy?)` | adds an Actor (`id`, `kind`, `rights`) |
| `session.leave(actorId)` | removes one |
| `session.as(actorId)` | a view of the session that acts for that actor: `prompt`, `send`, `answer` and the rest record both the acting identity and that actor, and are checked against their shared effective rights ([Authority](../contracts.md#authority)) |
| `session.setLimit(rights?)` | the [session limit](../contracts.md#limits-and-tenants) |

Rights are the specification's named rights (`watch`, `propose`, `input`, `answer`, `approve`, `tools`, `cancel`, `settings`, `erase`, `grant`, `jobs`, `delegate`, `administer`). An operation without a required right raises `forbidden`, as ACP does.

Authority comes from the app, which is the operator here. An Interface such as ACP authenticates its own actors; the SDK MUST NOT take an actor id from a client's request as proof of identity ([Security](../security.md#trust-boundaries)).

## Plugins

A **Plugin** has:

| Field | |
|---|---|
| `name` | unique in the agent; stable, because history records it |
| `replaces` | items of its own that replace an earlier plugin's, as `runtime`, `working-environment`, `provider:<id>`, `tool:<name>` or `command:<name>` |
| `setup(registrar)` | registers what the plugin provides, once, at load |
| `stop()` | optional; releases what it holds |

`setup` receives a **Registrar** and registers items with it. It runs once, before any session opens; it does no work for a session.

| Registrar operation | Registers | Servable |
|---|---|---|
| `tool(tool)` / `tools(source)` | one tool, or a tool source whose list can change | yes |
| `provider(provider)` | a Provider | yes, for request and response |
| `environment(environment)` | the working environment | yes |
| `runtime(runtime)` | the Runtime | yes |
| `on(point, handler, order?)` | a hook handler at a [core hook point](#hooks) | yes, except the points and answers marked |
| `command(name, description, handler)` | a command | yes, unless it uses a model or asks questions |
| `jobs(owner)` | that this plugin owns jobs, and how to cancel and resume them | yes |
| `historyStore(store)` | the history store | no: it has its own [binding](../bindings/history-http.md) |
| `credentialStore(store)` / `configuration(source)` | those parts | no |
| `interface(interface)` | an Interface | no |
| `defineHook(name, rule)` | a hook point this plugin owns, for other plugins. `rule` is `observe`, `gate`, `transform`, `collect` or `firstAnswer` ([Hook execution](../contracts.md#hook-execution)). | no |

A plugin is **servable** when everything it registers, and every context member its code uses, can cross the plugin binding. The SDK can then [serve it](placement.md#a-plugin-in-another-process). Otherwise it is **in-process only**.

Registrations are visible to the SDK; calls a function makes at run time are not. So an item whose code uses an [in-process-only context member](#contexts), or a model-using command, MUST say so when it is registered, with its `inProcessOnly` flag. `serve` refuses a plugin with any in-process-only registration or flagged item. It fails with `not_supported`, names the item, and never serves the rest without it. A served plugin that calls an in-process-only member without the flag gets `not_supported` from that call. The testing kit's [`overWire`](testing.md#the-testing-kit) runs a plugin's tests over the wire too, so an unflagged call fails a test rather than a deployment.

A tool, a Provider or a working environment passed directly to `createAgent` is wrapped in a plugin named after it.

### Replacing a part

A plugin replaces an earlier plugin's item by registering its own item of the same kind and name and listing it in `replaces`. If no earlier plugin has that item, the item is simply added. `durableRuntime()` lists `runtime`; a sandbox plugin lists `working-environment`. Following the [registration rules](../bindings/plugin.md#starting-the-handshake), `createAgent` raises `invalid_composition` when:

- a `replaces` entry names an item the plugin does not register itself, or appears twice;
- two plugins register the same item and the later one does not list it: an unlisted collision, including a second Runtime or working environment;
- a process plugin lists an item that another process plugin registered.

## Contexts

A plugin reaches the agent only through the context passed to the call it is serving. Each context carries the work's identity, its cancellation and what that work may ask. The last column says whether a served plugin can use the member; each "yes" is a request the [plugin binding allows](../bindings/plugin.md#authority).

| Member | Available to | Over the wire |
|---|---|---|
| `sessionId`, `actorId` and work ids | all | yes |
| `cancelled`: the language's cancellation signal | all | yes |
| `log(message)`: operator diagnostics, never shown to the model | all | yes, on stderr |
| `emit(type, data)`: a custom event, with a type containing a dot | all | yes |
| `history(cursor?)`: pages of the session's raw record | tool, hook, command, job owner | yes |
| `progress(content)` | tool, job | yes |
| `refuse(reason)`: ends the call as `refused` | tool | yes |
| `ask(question, wait?)` | tool | yes |
| `ask(question, wait?)` | command | in process only |
| `environment`: the session's working environment | tool, command | yes |
| `tools.list()`, `tools.call(name, input)`: [nested calls](../contracts.md#nested-calls) | tool | yes |
| `jobs.start(kind, detail, key?)` | tool, command | yes |
| `jobs.unfinished()`, `jobs.resume(job)` | `session.start` hook of a job owner | yes |
| `credential()`: the credential for this Provider | Provider | yes |
| `credential(name)`: a named credential | tool, Provider | in process only |

`history` is the raw record a loaded plugin may read ([Authority](../bindings/plugin.md#authority)), not an actor's gated view. A context is valid only until its call settles; using it afterwards raises `invalid_request`. A plugin that needs to act later starts a [job](#jobs); a Job handle stays valid until its job ends.

## Tools

A **Tool** has a definition and a function:

| Definition field | Default |
|---|---|
| `name`, `description` | required |
| `input` | required: a schema, written in the language's usual way ([Languages](languages.md#schemas)). It is the ToolDefinition's `parameters`, JSON Schema 2020-12. |
| `output` | none. A schema for `value`, sent as the ToolDefinition's `returns`. When set, the agent checks every completed result against it. |
| `readOnly`, `destructive`, `openWorld`, `safeToRepeat` | the [shared defaults](../bindings/data.md#tools): false, true, true, false. Each hint is sent exactly as set; the SDK does not derive one from another. |
| `parallel` | false |
| `callers` | `model`, `ui` and `plugin` |
| `presentation` | none |
| `inProcessOnly` | false; see [Plugins](#plugins) |

`input` and `output` are the SDK's names for the definition's `parameters` and `returns`. On the wire, in history and in every ToolDefinition the SDK exposes, they are `parameters` and `returns`.

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

**Questions from a tool.** `ask(question)` opens a question and waits for its answer. It returns:

| Kind | Returns |
|---|---|
| `approval` | `allow`, or a decline |
| `choice`, `text`, `link` | the answer's value, or a decline |
| `secret` | the credential name the value was stored under, or a decline. Never the value ([Secrets](../contracts.md#secrets)). |

A decline carries the reason, including a system closure such as `timeLimit` or `noLongerAnswerable`. `ask(question, { wait, then: "leaveOpen" })` lets the call stay open past its turn if no answer comes in time. It is allowed only where the agent declares `questionsOutlastTurns` and `lateAnswersStartTurns`; otherwise it raises `not_supported`. When the wait ends unanswered, `ask` raises a `LeftOpen` signal. A tool that does not catch it ends, and the SDK replies pending. The tool runs again from the top when the answer comes, so it MUST ask the same questions in the same order and cause no effect before them; asking again returns the recorded answer ([Questions](../contracts.md#questions)).

**Nested calls.** `tools.call(name, input)` asks the agent to run another tool as a nested call. It passes that tool's own gates and approval and returns its ToolResult. A nested call is never left open: if a gate would leave it pending, it is settled `refused`. Each SDK documents its nesting depth and refuses a call beyond it ([Nested calls](../contracts.md#nested-calls)).

A **tool source** is a set of tools whose list can change, such as an MCP server's. It provides `tools(sessionId?) -> Tool[]` and calls `changed()` when the list changes.

## Providers

A **Provider** has:

| Member | |
|---|---|
| `id` | unique in the agent; the first half of every ModelRef it offers |
| `models() -> ModelInfo[]` | the full current catalog; it can call `changed()` when the catalog changes |
| `supports` | `keepsState` and `safeToRepeat` ([Provider support](../bindings/plugin.md#the-host-asks-a-provider)) |
| `available() -> boolean` | optional: whether it can take requests now, for example whether it has credentials |
| `request(model, request, context) -> AssistantMessage` | makes one model request |
| `discardState(sessionId)` | optional, for a Provider that keeps state |

`request` reports output as it arrives with `context.piece(type, delta, toolCallId?)`, then returns the complete AssistantMessage.

A model failure after the request is admitted, including credentials the model service rejects, is an AssistantMessage with stop `failed` and a ModelError whose `kind` is `temporary`, `contextTooLarge`, `credentials`, `refused` or `other`. A Provider may raise the language's error carrying a ModelError instead; the SDK turns it into that AssistantMessage, in process and over the wire alike. An error raised without a ModelError means the request was not admitted, such as an unknown model, and is an `invalid_request`.

The Provider gets its credential through `context.credential()`; it never receives one in configuration. In process, a Provider can also run tools itself, hold a live session or answer late. Those are in-process only ([Model request and response](../contracts.md#model-request-and-response)).

## Hooks

`on(point, handler, order?)` registers a handler at a hook point. `order` is `first`, `normal` or `last`. Handlers combine by the [core rules](../contracts.md#hook-execution). Each point has a typed payload and a typed answer; returning nothing passes.

| Point | Kind | Payload | Answer |
|---|---|---|---|
| `plugin.load` | gate | the plugin about to load and its origin | `allow`, or `refuse(reason)` |
| `session.start` / `session.end` | observe | the session, and whether it was reopened | none |
| `input` | transform | the input, its actor and timing | `change(content)`, or `handle()` to take it without a turn; in process only, `handle({ command })` to run a command instead |
| `turn.before` | collect | the input starting the turn | `add({ system?, context? })` |
| `turn.start` / `turn.end` | observe | the turn; at the end its outcome and result | none |
| `step.before` | transform | the prepared ModelRequest and model limits; in process, also history and usage | `change(request)`: context, offered tools, settings; in process, also the Provider-tool allowance |
| `step.after` | gate | the step's recorded response | `continue`, or `end(reason)` |
| `tool.before` | gate | the call and its definition | `allow`, `refuse(reason)`, `change(input)`; in process only, `pending(question)` |
| `tool.after` | transform | the call and its result | `change({ content?, value? })` |
| `model.failed` | first answer | the request and its ModelError | `retry(request?)`, or `stop` |
| `turn.result` | gate | the result and the expected shape | `accept`, or `refuse(feedback)` |
| `provider.request` | transform | the ModelRequest a Provider is about to send | `change(request)` |
| `provider.response` | observe | the complete response | none |
| `output` | gate | events about to reach a recipient | `redact(events)`, or `block` |

**In process only:** `session.join` and `session.leave`; `provider.piece`, for each piece of a Provider's response; `pending` as an answer to `tool.before`; `handle({ command })` on `input`; history and usage in the `step.before` payload; and every point a plugin defines with `defineHook`. The [plugin binding](../bindings/plugin.md#from-core-hooks-to-wire-hooks) carries none of these. A served handler that needs history reads it through its context.

`pending(question)` does not wait. It records the question and leaves the call pending under the [question rules](../contracts.md#questions); the call continues in a later turn once the question is answered.

**Changes stay within their point.** The agent checks every answer. A `step.before` or `provider.request` change may narrow the offered tools or change their order, but MUST NOT add a tool or widen a definition beyond what the turn and current authority allow. An `input` change may change only the content; a `tool.after` change only the result's content and value.

**When a handler fails**, by raising or giving an answer its point does not allow, the result depends on the point's kind ([Hook execution](../contracts.md#hook-execution)):

| Kind | A failed handler |
|---|---|
| observe | is reported, and the operation continues |
| gate | counts as a refusal |
| transform, collect, first answer | fails the operation, naming the handler |

For `output`, a refused redaction withholds the output from that recipient ([The output gate](../contracts.md#the-output-gate)).

## Commands

`command(name, description, handler)` registers a command. The handler receives the argument text and a command context, and returns text for the actor or nothing. A command never starts a turn. A command that uses a model sets `usesModel` when registered and is in-process only ([Commands](../contracts.md#commands)).

## Jobs

A plugin that starts work outliving a turn registers a **job owner**:

| Member | |
|---|---|
| `cancel(job, context)` | stops the job and ends it |
| `resume(job, context)` | optional: takes up an unfinished job after a restart |

`context.jobs.start(kind, detail, key?)` records a job and returns a **Job** handle with `progress(content)` and `end(outcome, result?, report?)`. A Job handle stays valid until its job ends.

A job that ends with `report: true` puts its result into the session as input. It starts a turn only where the agent declares `startsTurnsUnasked: jobReports`, which `jobReportsStartTurns` sets. Otherwise the report is parked until an actor releases it ([Jobs](../contracts.md#jobs)).

When a session reopens, the SDK calls the owner's `resume` for each of its unfinished jobs from that plugin's `session.start` handling, before the hook is answered, as the [binding requires](../bindings/plugin.md#jobs). It does this in process and over the wire alike. A job the owner does not resume stays unfinished.

## The other parts

These are written rarely. Each is an interface a plugin implements. Its operations are the binding's methods for that part, with the binding's parameters and results; for parts with no binding, the [Interactions](../contracts.md#interactions) table.

| Part | Operations | Defined by |
|---|---|---|
| Working environment | `read`, `exists`, `write`, `exec`, `list` (optional), `savePoint`, `checkPoint`, `restorePoint`, `sessionEnded`, and its registration: `containment`, `platforms`, `points`, `confinesFiles` | [The host asks the working environment](../bindings/plugin.md#the-host-asks-the-working-environment). A missing file is `not_found`. An environment without `list` raises `not_supported` and the agent treats listing as absent. |
| History store | `acquire`, `renew`, `release`, `append`, `read`, `list`, `erase` | [History service](../bindings/history-http.md). An `acquire` refused because another writer holds the session raises `held` with `retryAfterMs`. An `append` skips an entry JSON-equal to one already kept under its id; a different entry under a kept id raises `conflict`. |
| Credential store | `read`, `stage`, `lookupStaged`, `activate`, `discard` | [Asking the credential store](../contracts.md#asking-the-credential-store) and [Secrets](../contracts.md#secrets) |
| Configuration | `settings(project)`, `trusted(project)` | [Configuration and trust](../contracts.md#configuration-and-trust) |
| Runtime | `declaration`, `runTurn`, `resumeTurn`, `continueOpenCalls` | [The host asks the Runtime](../bindings/plugin.md#the-host-asks-the-runtime). `resumeTurn` receives the interrupted checkpoint, including the last answered step and any committed `step.after` decision, exactly as the binding defines it. The context offers the [Runtime callbacks](../bindings/plugin.md#runtime-callbacks). |
| Interface | `start(agent)`, `stop()` | The only part given the whole Agent. It authenticates its own actors. |

## Errors

Every SDK error has a `code`, a `message` for people and optional `data`. Programs branch on `code` only.

The SDK has two surfaces, and each uses the codes of the binding it mirrors:

- **What an app calls**, the Agent and Session operations, uses the [ACP codes](../bindings/acp.md#errors), so `serveAcp` passes them through unchanged.
- **What a plugin's context calls**, and the errors a plugin raises to the agent, use the [plugin binding codes](../bindings/plugin.md#errors-and-connection-loss), so a plugin sees the same codes in process and served.

| Code | Surface | When |
|---|---|---|
| `invalid_params` | app | a malformed argument or invalid option value |
| `invalid_request` | plugin; app for JSON depth | bad arguments, an unauthorized or out-of-scope context call, a stale context, or an operation in the wrong state |
| `invalid_composition` | `createAgent` | parts that cannot work together; the SDK's own code |
| `forbidden` | app | the actor lacks a required right |
| `not_found` | both | a named session, entry, file, point, tool or question does not exist |
| `not_open` | app | the session is not open |
| `busy` | app | conflicts with current work, close or recovery |
| `held` | app | another writer holds the session's history; `data.retryAfterMs` says when to retry |
| `conflict` | app | an invalid transition, such as a proposal already released, or an entry that conflicts with a kept one |
| `cancelled` | both | the operation was cancelled |
| `not_supported` | both | this agent, part or placement does not support it |
| `turn_limit` | plugin | a limit stopped the work; `data.limit` names it |
| `unknown_handler` | plugin | no such registered handler at this hook |
| `withheld` | app | the output gate withheld the reply |
| `result_too_large`, `message_too_large` | both | a result or message did not fit its limit |
| `lost` | both | a part, connection or cleanup was lost; the outcome of the work may be unknown |
| `internal` | plugin | any other failure |

A refused tool call or a failed turn is not an error: it is a ToolResult status or a turn outcome.

## Data types

The SDK's data types are the [shared data](../bindings/data.md) shapes: Content and its parts, Message, ModelRef, ModelInfo, ModelRequest, AssistantMessage, ModelError, Usage, ToolDefinition, ToolCall, ToolResult, InputRequest, Answer, Actor, HistoryEntry, Outcome, Declaration and the rest. Each SDK MUST:

- use the shared field names, converting only their case where the language requires and serializing them unchanged;
- keep unknown fields and unknown content parts when it stores or relays a shape;
- represent each closed set of values, such as ToolStatus or a ModelError's kind, as the language's enumeration, with a way to keep an unknown value where shared data says to.

The types will be generated from shared data's JSON Schema once it has one.
