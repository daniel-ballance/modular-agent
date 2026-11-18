# Open questions

**What this edition leaves open.** A limit is behavior this edition does not standardize. A choice is policy a deployment can set within the rules. The defaults below are production advice, not extra conformance requirements. [Settled](#settled) links to the current rules. Older heading links still work.

## The Harness and plugins

### How many of each capability

See [Plugin registration](#plugin-registration) under Settled.

### Plugin scope

See [Active plugin set](#active-plugin-set) under Settled.

### Plugin lifecycle

**Limit: reload state transfer.** There is no portable handover of live plugin state. Default: start new code only after the affected sessions are closed, check current trust at the next load, and recover only from records the new build supports. Refuse ambiguous replacements instead of choosing a winner by load order.

### Naming "capability"

See [Terminology](#terminology) under Settled.

## Turns

### Waiting for an answer

**Choice: question deadlines.** Use finite deadlines for unattended work. Approvals never outlast their turn; expiration declines the request. See [Question lifecycle](#question-lifecycle).

### Input during a turn

See [Steering](#steering) under Settled.

### Cancellation

**Limit: own-work cancellation.** There is no separate right to cancel only work a particular actor started. Default: give `cancel` only to actors trusted to cancel session work, and do not disclose handed-back inputs to a canceller merely because they cancelled. See [Turn and job cancellation](#turn-and-job-cancellation).

### Turn limits

**Choice: deployment ceilings.** The edition does not prescribe step or wall-clock ceilings or their precedence in combination with deployment-specific limits. Default: have the operator set finite ceilings for unattended work and bound concurrent sessions and jobs. Do not let a session setting relax an operator ceiling. Comply with the binding's cancellation deadline. A tenant budget is [soft](#tenant-budgets), not a substitute for a hard cap. If admission or accounting is uncertain, decline work whose policy cannot be enforced.

### Changing the model mid-turn

See [Model changes](#model-changes) under Settled.

### Work outside a turn

**Limit: detached work.** There is no portable ownership or recovery model for a job that continues outside its session. Default: keep managed work in session jobs, and do not detach it on close. See [Turn and job cancellation](#turn-and-job-cancellation).

### Live sessions

**Limit: live and batch profiles.** This edition does not define portable or wire turn boundaries, live interruption or delivery for two-way media, or a batch model response profile. Default: use ordinary request and response between builds. Do not claim that a live session can be reopened by another build.

### Partial output

**Limit: proof of delivery.** Streamed pieces are live only ([Event](contracts.md#event)). There is no standard record of which pieces reached a recipient, such as which audio samples a user heard. Default: replay only completed records that pass the current output gate, and make no delivery claim from those records.

## Actors

### Several actors

**Choice: local grant policy.** The operator chooses which principals and tenants each connection can use and who is trusted with `grant`. Default: grant neither delegation nor cross-tenant access unless needed, and disable joining on open for shared deployments unless explicitly intended. If matching principal ids or authorized history provenance cannot be established across builds, refuse the transfer. See [Actor grants and reopening](#actor-grants-and-reopening).

## Tools

### Tools run by an Interface

**Limit: Interface-supplied tools.** There is no portable profile for running tools in a client's environment. ACP client file and terminal methods are not used. Default: run tools in the agent's checked working environment instead. Host-supplied MCP servers are agent-started programs, not client-side tool execution. See [MCP servers](contracts.md#mcp-servers) and [Security](security.md).

### Tool calls outside a turn

**Limit: injecting direct results.** The default portable context excludes out-of-turn tool calls. There is no common operation for inserting their results into model context. Use an authorized input or a deployment's context handler, not direct access to the tool source. See [Tool dispatch](#tool-dispatch).

### Parallel tool calls

See [Parallel calls](#parallel-calls) under Settled.

### Direct tool access

See [Tool dispatch](#tool-dispatch) under Settled.

## History and durability

### What history records

**Limit: exact request audit.** Pinned settings and recovery records do not guarantee reproduction of the exact vendor payload for every attempt. Retained Provider conversation state can stand only for an exact prefix of the agent's view ([Provider state](contracts.md#provider-state)). Default: keep the specified recovery and audit records, not raw vendor requests. If exact request audit is required, accept only a deployment that supplies it under its disclosure and retention policy.

### Transient and durable Runtimes

See [Recovery](#recovery) under Settled.

### Erasure scope

See [Erasure](#erasure) under Settled.

## Beyond one agent

### The agent from outside

**Limit: other Interfaces.** [Interface and Harness](contracts.md#interface-and-harness) defines the core operations; [ACP](bindings/acp.md) maps the host wire. The edition supplies no separate interoperable HTTP Interface, model gateway or network working environment profile. Default: use the specified bindings across builds. Keep other service APIs private to a deployment with its own authentication, authorization and retry rules. Refuse combinations that require an unverified version, feature or policy; matching a major version does not certify historical snapshots.

### Agents working together

**Limit: peer protocol.** Subagent work and requests through a parent are [settled](#child-work); a peer-to-peer wire is not. Default: do not allow a peer channel to deliver authority. Treat peer messages as data under the receiving deployment's policy.

### Content model

**Limit: other media profiles.** [Shared data](bindings/data.md#content) and [ACP](bindings/acp.md#entry) specify their content and projections. Unknown fields are inert, not new behavior. There is no interoperable live voice or remote media handling contract. Default: use the types both peers support; do not dereference a file or network reference merely because it arrived as content.

<a id="settled"></a>

## Settled

- <a id="plugin-registration"></a>**Plugin registration.** Singleton capabilities are selected per session; names do not shadow, and replacement uses the [registration rules](contracts.md#plugins-and-capabilities).
- <a id="active-plugin-set"></a>**Active plugin set.** An open session cannot add plugins; offering an already registered tool is not loading one. A child inherits the set except host-supplied MCP servers ([Plugins and capabilities](contracts.md#plugins-and-capabilities), [Subagents](contracts.md#subagents), [MCP servers](contracts.md#mcp-servers)).
- <a id="terminology"></a>**Terminology.** A capability is a role a plugin can provide ([Glossary](../GLOSSARY.md#the-system)).
- <a id="waiting-for-the-user"></a><a id="question-lifecycle"></a>**Question lifecycle.** The asker sets the deadline and the permitted wait behavior. A late answer to an eligible non-approval question can make a continuation ready; it is not a tool result ([Questions](contracts.md#questions), [ACP questions](bindings/acp.md#questions)).
- <a id="steering"></a>**Steering.** Supported steering joins after the current tool round; next-turn input and unsupported steering wait ([Input](contracts.md#input)).
- <a id="turn-and-job-cancellation"></a>**Turn and job cancellation.** Cancellation hands back untaken input at the cutoff and closes unanswered questions of the cancelled work. Jobs survive turn cancellation unless declared otherwise, and closing cancels and waits for jobs ([Input](contracts.md#input), [Jobs](contracts.md#jobs), [ACP cancelling](bindings/acp.md#cancelling)).
- <a id="model-changes"></a>**Model changes.** A change applies from the next turn and resets Provider state. Fallback to another model takes a new turn ([Settings](contracts.md#settings), [Provider state](contracts.md#provider-state)).
- <a id="actor-grants-and-reopening"></a>**Actor grants and reopening.** Creation and authorized join on open use operator admission; other grants need `grant`. Reopening keeps recorded rights and refuses a departed actor. Joining is not authority to speak for an actor ([Authority](contracts.md#authority), [ACP sessions](bindings/acp.md#sessions)).
- <a id="tenant-budgets"></a>**Tenant budgets.** The soft budget is checked before each turn, after each step and before model dispatch. Already running steps can overshoot; usage is counted per deployment and not reduced by erasure or retention ([Limits and tenants](contracts.md#limits-and-tenants)).
- <a id="parallel-calls"></a>**Parallel calls.** A round runs in parallel only if every call permits it. Results are recorded as known and passed to the model in call order ([Tool dispatch](contracts.md#tool-dispatch)).
- <a id="tool-dispatch"></a>**Tool dispatch.** The Harness checks exact calls before dispatch. Provider-run tools follow separate pre-request rules and are not portable ([Tool dispatch](contracts.md#tool-dispatch), [Provider state](contracts.md#provider-state), [Portable sessions](bindings/data.md#portable-sessions)).
- <a id="recovery"></a>**Recovery.** Record intent before effects. Durable recovery never reruns finished calls and retries interrupted effects only under the documented promises ([Recovery and repeating work](contracts.md#recovery-and-repeating-work)).
- <a id="erasure"></a>**Erasure.** The Harness follows copies transitively and reports erased, pending and out of reach ([Erasure](contracts.md#erasure)).
- <a id="child-work"></a>**Child work.** A child is a session owned through a job. Requests relay one parent at a time; a follow-up is a new job on the same child ([Subagents](contracts.md#subagents)).
- <a id="plugins-building-on-plugins"></a>**Plugins building on plugins.** Plugins can define capabilities and hook points ([Plugins and capabilities](contracts.md#plugins-and-capabilities), [Hook points](contracts.md#hook-points)).
- <a id="working-environment"></a>**Working environment.** It is a capability distinct from the project ([Harness and working environment](contracts.md#harness-and-working-environment)).
- <a id="a-layer-above-the-agent"></a>**A layer above the agent.** A host coordinates agents from outside; it uses their [Interface](contracts.md#interface-and-harness).
- **Rewind with remote points.** The [point probe](bindings/plugin.md#paths-and-points) checks remote points without restoring files. The [rewind rules](bindings/data.md#rewinding) cover points without session ownership.
- **History and position.** Normal use appends entries; moving records a new position without deleting the rest. Retention and erasure are separate ([History entries](bindings/data.md#history-entries), [Rewinding](bindings/data.md#rewinding)).
- **Exchanges.** History represents turns by what started them, not by a separate exchange unit ([History entries](bindings/data.md#history-entries)).
- **Holding streamed output.** A gate can hold output within the declared stream boundary; the agent declares this behavior ([The output gate](contracts.md#the-output-gate)).
- <a id="what-the-harness-keeps"></a><a id="configuration"></a>**Harness and configuration.** The Harness owns sessions and the plugin API; configuration is a plugin capability ([Plugins and capabilities](contracts.md#plugins-and-capabilities), [Configuration and trust](contracts.md#configuration-and-trust)).
- <a id="how-handlers-combine"></a>**Handler order.** Hook owners fix the combining rule and handlers run in the specified order ([Hook execution](contracts.md#hook-execution)).
- **Plugin trust.** The operator chooses which code to run; project plugins need project trust. The API is not an isolation boundary ([Configuration and trust](contracts.md#configuration-and-trust), [Security](security.md)).
- **Input keys and reconnect.** Input keys stay reserved for the session's life, even when their content is erased. The [input](contracts.md#input) and [following](contracts.md#following-a-session) rules define replay and retry behavior.
- **Versions.** The claimed binding sets its own handshake, error rules and versions; the core picks no transport ([Bindings](bindings/README.md), [Versioning](conformance.md#versioning)).

<a id="parked-how"></a>
<a id="parked-wiring"></a>

## Parked: how

These choices do not change what a peer observes. See [Implementation concerns](research/implementation-concerns.md).

- **Internal transport.** Default: use an in-process call when no binding or isolation boundary is needed. Keep the same observable semantics.
- **Dispatch structure.** Default: an ordered handler list implementing the documented hook order and combining rule.
- **Storage structure.** Default: a journal and a durable receipt index to support the required commit ordering and key lifetime. Test recovery with lost replies before relying on it.
