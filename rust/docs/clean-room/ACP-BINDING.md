# ACP shared binding

This build implements `modular-agent-acp/1` from `docs/bindings/acp.md`. The original five milestones remain complete. This round does not implement the HTTP history-service binding.

## Build and check

```sh
mise exec -- cargo build --workspace --locked --offline
(cd conformance/acp && npm ci)
node conformance/acp/run.mjs -- "$PWD/target/debug/modular-agent" --acp
mise exec -- cargo test --workspace --locked --offline
```

The kit starts the binary in a temporary project, so pass an absolute binary path. It sets `MODULAR_AGENT_CONFORMANCE=1` and `MODULAR_AGENT_DATA_DIR` itself. The Rust integration test `shared_acp_conformance_kit` runs this same supplied kit against Cargo's binary with an empty HOME. Install Node.js and the pinned npm dependencies before running the workspace suite. The test itself never installs dependencies or contacts the network.

To run conformance mode directly:

```sh
MODULAR_AGENT_CONFORMANCE=1 MODULAR_AGENT_DATA_DIR=/tmp/my-agent-state \
  ./target/debug/modular-agent --acp
```

The host must select `conformance/echo` through the model configuration option. This is an extra, stateless, zero-usage Provider, not a replacement for OpenAI and not a real model run. It has no credential or network path. Existing bash/read tools supply the required conformance tools. The ordinary OpenAI Provider still permits only gpt-6-luna.

## Shared host surface

- Initialize metadata is at `_meta["modular-agent"]`, including the binding, all required declaration fields, extension names and fixed host actor `user`.
- Session new/load/resume report the actual session declaration. Configuration responses also refresh it. Model IDs are qualified, for example `openai/gpt-6-luna`, `fake/fake` or `conformance/echo`.
- Selectors are `model`, `thinking` and `approval`. Approval values are `off`, `ask`, `all` and `never`. Settings changes during an active turn are refused.
- Prompts accept `_meta["modular-agent"].key`. Their response metadata contains inputId, duplicate, outcome, openToolCalls and, when cancelled, handedBack. Retries return the original outcome without another turn.
- Permissions offer exactly Allow/allow_once and Refuse/reject_once. Only selected/allow grants permission. Text and choice use forms when supported; otherwise the host answers through the extensions. Secrets never enter forms.
- Message, readable reasoning, tool-call and final-status updates pass the output gate, as do configuration updates, history, replay and RPC responses. Encrypted reasoning is not rendered.
- The required methods are `_modular-agent/history`, `_modular-agent/input`, `_modular-agent/requests` and `_modular-agent/answer`.
- Optional bound methods are `_modular-agent/fork`, `_modular-agent/move`, `_modular-agent/erase`, `_modular-agent/jobs` and `_modular-agent/cancel-job`.
- The build-specific `_modular-agent/command` method takes an attached `sessionId`. ACP cannot grant project trust.

The ACP Interface owns a session-local input driver. It acknowledges extension input before running it and serializes subsequent turns through the existing Harness/Runtime API. Job reports and later answers can wake the same driver. Close cancels active work, awaits the driver and event pump, cancels jobs and closes session-local MCP servers. No agent service process is added.

`MODULAR_AGENT_DATA_DIR` overrides data/config path flags. History, command state, OpenAI inventory, global settings and trust stay under that folder. Project configuration remains an input. Credential files remain external read-only inputs and are never copied into state.

## Recorded choices

See GAPS.md, Bindings, B-01 through B-07. They cover conformance defaults and directory precedence; receipts and unfinished duplicates; mixed restart/movement policies; question deadlines; history blocks and reasoning; ACP refusal semantics for failures; and remote-erasure progress. In particular, shared movement refuses unfinished work, and the wire maps a question deadline with open calls to completed/end_turn while preserving the internal limit record.

No frozen description or supplied kit source was changed. No other independent build was read, no helper subagent was started, no T3 settings were changed and no live inference was run for this round.
