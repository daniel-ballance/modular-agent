# Pi's built-in features as plugins

**Status:** analysis, 2026-11-16. This is how the plugin API in [Architecture](../architecture.md#what-plugins-can-do) was worked out. The result lives there; this note keeps the reasoning.

The Harness does the minimum, and everything else is a plugin ([ADR 0011](../adr/0011-minimal-harness-everything-is-a-plugin.md)). So the plugin API must offer everything Pi's built-in features need once each becomes a plugin. Below, each feature lists what it would need.

Sources for Pi's behaviour: `docs/extensions.md` (the `ExtensionAPI` methods and events), `docs/how-pi-works.md`, `docs/skills.md`, `docs/mcp.md` and `docs/slash-commands.md` in Pi v1.5.2. DeepSeek Harness details come from the [DeepSeek Harness reference](deepseek-harness-reference.md).

## Walking through the plugins

### The Runtime

Pi builds it in as `pi-agent-core`. It needs to:
- **provide the Runtime capability:** accept a turn to run (input, tools, Provider, settings and limits), and return the turn result
- **ask the Harness to run tool calls** and **invoke hook points** ([Contracts](../contracts.md#harness-and-runtime))
- **use a Provider** for each step
- **report events** throughout the turn
- **be cancelled**, and **take input that arrives during the turn**, if that is allowed (open question [Input during a turn](../open-questions.md#input-during-a-turn))

### Providers

Pi builds them in as `pi-ai`. Extensions add more with `registerProvider`. A Provider needs to:
- **provide the Provider capability**, together with a **catalog** of the models it offers and their limits: context window, input types such as images, and reasoning levels
- **ask for credentials when it makes each request**, never holding them itself. Pi's `getApiKey` does this, so OAuth tokens that expire can be refreshed.
- **define its own hook points** around the model call (Provider middleware: headers, request payload, raw response stream)

### Interfaces

Pi builds in the terminal UI, print, JSON and RPC modes, and the SDK. An Interface needs to:
- **work with sessions:** create, list, open, fork and close them
- **submit input,** choosing when it is taken: now, steering into the running turn, or as a follow-up after it
- **cancel** the running turn
- **find and run commands**
- **follow what happens:** read past history to show an earlier session, and receive events as they happen
- **answer requests for the person:** confirm, choose, type text, open a link, give a secret. It also shows notifications and status.
- **show what other plugins produced.** Pi lets extensions register renderers for their messages, entries and tool calls, so the terminal UI can draw them. An Interface that does not recognise something falls back to a plain display.
- **perhaps offer tools of its own,** such as an editor's file access (open question [Tools run by an Interface](../open-questions.md#tools-run-by-an-interface))

### Native tools

Pi builds in read, bash, edit, write and others, and extensions add more with `registerTool`. A tool plugin needs to:
- **provide tools:** each with a name, description and input schema, plus hints such as read-only or destructive (MCP's annotations) and whether it may run in parallel with others
- **run a call** with its arguments and a cancellation signal, **report progress** while it runs, and **return a result**
- **ask the person** something during a call (Pi's `question` tool)
- **run other tools** through the Harness, so hook points still apply (Pi's `ctx.executeTool`, used by codemode)
- **reach the environment:** the working directory, files and processes. Pi's tools use the operating system directly. DeepSeek Harness puts files and processes behind swappable capabilities, so one switch moves every tool into a remote sandbox (see the open question [Working environment](../contracts.md#harness-and-working-environment)).

### MCP client support

Pi builds it in, configured with `pi mcp` and managed with `/mcp`. Extensions can add servers with `registerMcpServer`. The plugin needs to:
- **read its configuration** (which servers to connect to), and accept servers that other plugins add. An ACP client, for example, hands over the user's MCP servers when it opens a session.
- **provide a tool source whose tools change over time,** as servers connect, disconnect or change their tool lists
- **offer MCP resources and prompts:** resources as content that can be attached, and prompts as commands or prompt templates
- **sign in** to servers through credentials, and **ask the person** to complete a sign-in in a browser
- **pass a server's questions to the person** (MCP's input requests)
- **register commands** to manage servers

### Agent Skills support

Pi builds it in, following the [Agent Skills specification](https://agentskills.io/specification). The plugin needs to:
- **find skills** in known directories, plus directories that other plugins add (Pi's `resources_discover` event)
- **add a section to the system prompt** listing each skill's name and description
- **load a skill's full instructions on demand,** either when the model reads them with a tool or when a person runs `/skill:name`, which expands into input
- skills that bundle scripts need tools from other plugins to run them

Other plugins adding skill directories is a case of plugins building on each other (open question [Plugins building on plugins](../contracts.md#plugins-and-capabilities)).

### Commands

Pi builds in about 30 slash commands (`/model`, `/compact`, `/tree`, `/new`, `/fork`, `/mcp`, `/reload` and more), and extensions add more with `registerCommand`. A command plugin needs to:
- **register commands,** each with a name, a description, its arguments, and suggestions for completing them
- **answer the person** through the Interface: notifications, status, and choices
- **do things:** most built-in commands are operations on other parts of the system. `/new` and `/fork` change sessions, `/compact` triggers compaction, `/model` changes model selection, and `/tree` moves within branching history. So the plugin API must offer those operations to plugins as well as hook points.

### Prompt templates

Pi builds them in. The plugin needs to:
- **find templates** in known directories, plus directories that other plugins add
- **register each template as a command**
- **change input before it becomes a message:** a `/template` expands into its text. In Pi this happens after commands are checked and after the `input` event.

### Storage for history

Pi builds in JSONL session files. A storage plugin needs to:
- **provide the storage capability:** save each new record, load a session's history, list sessions, and confirm when records are safely stored
- **refuse a second writer** for a session that is already open elsewhere (DeepSeek Harness takes write ownership when it opens a session)

In this draft the base Harness keeps the record itself and the storage plugin decides where it lives (open question [What the Harness keeps](../contracts.md#plugins-and-capabilities)).

### Context management and compaction

Pi builds compaction in. Extensions can replace its summary with `session_before_compact`, and adjust each request with `context`. The plugin needs to:
- **handle the prepare-step-context hook point** ([ADR 0007](../adr/0007-context-management-is-a-hook.md))
- **know the usage so far and the model's limits,** to decide when to compact
- **read the history**
- **make its own model call** to write the summary ([ADR 0005](../adr/0005-provider-handles-from-the-harness.md) allows the Harness side to call Providers directly)
- **add a compaction record to history,** which changes what the model sees from then on without deleting anything
- **react when a request fails because the context is too large,** then compact and retry. DeepSeek Harness does this with a hook point on request errors.
- **register `/compact`**

### System prompt and context files

Pi builds in its base instructions and finds `AGENTS.md` and other context files. Extensions change the prompt with `before_agent_start`. The plugin needs to:
- **assemble the system prompt** from sections that many plugins contribute: tool guidance, the skills list, context files and custom rules. Pi passes a structured set of options, and DeepSeek Harness assembles registered prompt sections before every step.
- **know the working directory and project** to find context files
- **record each prompt change in history,** if what the model saw must be rebuildable (open question [What history records](../open-questions.md#what-history-records))

### Model selection

Pi builds in model selection and a model registry, with `/model` and the `model_select` event. The plugin needs to:
- **read every Provider's catalog**
- **set the model and reasoning level for a session,** and have each change recorded in history
- **announce changes** so Interfaces can show them
- **register commands** to choose a model
- decide whether the model may change within a turn (open question [Changing the model mid-turn](../open-questions.md#changing-the-model-mid-turn))

### Credentials

Pi builds in stored API keys and OAuth sign-in (`/login`, `/logout`). The plugin needs to:
- **provide the credentials capability:** give a credential, by reference, to the Provider or MCP plugin that asks for it, and never to the Runtime
- **run sign-in flows** by asking the person to open a link, paste a code, or enter a secret
- **register commands** to sign in and out

### Approval and questions to the person

Pi has nothing built in. Extensions add them with `tool_call` and `ctx.ui`. The plugin needs to:
- **handle the before-tool hook point** to allow, deny or ask
- **ask the person, and wait,** or turn the wait into a pending result (open question [Waiting for the user](../contracts.md#questions))
- **define its own hook point,** "approval requested", that Interface plugins answer, and handle the case where no Interface can answer (open question [Plugins building on plugins](../contracts.md#plugins-and-capabilities))
- **record each request and decision** in history without the model seeing them
- **keep a per-session setting,** such as "never ask"

### Plugins Pi doesn't have built in

These are worth checking against the same list:
- **Telemetry**, which follows events and exports them, for example as OpenTelemetry spans.
- **Subagents**, which create child sessions, perhaps with a different set of plugins (open question [Plugin scope](../open-questions.md#plugin-scope)), and send the child's result back as input to the parent.
- **Schedules, goals and background work**, which submit input and start turns with no person involved (open question [Work outside a turn](../open-questions.md#work-outside-a-turn)).

## What the walkthrough shows

- **The plugin API is more than hook points.** Commands and Interfaces need operations: start, fork and close sessions, submit input, cancel, compact, change the model. Pi offers these as `ctx` methods next to its events.
- **History is the meeting point.** Model selection, compaction, approval, the system prompt and plugin state all write to it. That supports keeping the record in the base Harness (open question [What the Harness keeps](../contracts.md#plugins-and-capabilities)).
- **Plugins building on each other is common, not an edge case.** Skill and template directories come from other plugins, MCP servers come from Interfaces, and approval needs answerers. That pushes open question [Plugins building on plugins](../contracts.md#plugins-and-capabilities) toward "yes".
- **"The person" is a shared service.** Approval, tools, MCP sign-in and credentials all ask the person something, and only Interfaces can answer. That is one exchange, defined once.
