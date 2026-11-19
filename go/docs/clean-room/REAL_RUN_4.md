# Milestone 4 real model run

Completed 2026-11-17, 05:16 UTC. Only `claude-haiku-5-5` through Anthropic was used. Two model requests, one agent process, one session. The ACP client held no inference credentials. Only the agent's Provider obtained the experiment key at request time. No key was printed, copied here or passed as an argument.

## Reproduce deliberately

This makes real requests. It is not part of the offline test suite:

```sh
mise exec -- go build -o bin/modular ./cmd/modular
mise exec -- go run ./scripts/milestone4-real.go "$PWD/bin/modular"
```

The driver uses the maintained ACP Go client library to launch the executable over stdio. It creates a private temporary project and evidence folder, never reads credentials, and closes and joins its owned process. It only approves read calls.

Evidence: `/tmp/modular-go-m4-real.1124599924`. Files include `acp.jsonl`, `history-view.json`, `summary.json` and the agent's history store.

## Observed

- Session: `70bc043a27f0a14cf745e774940457f2`.
- Initialize negotiated ACP v1 and declared load, resume, list, close and MCP HTTP support.
- Session creation returned model and thinking configuration selectors. The model was exactly `claude-haiku-5-5` and thinking was off.
- The client changed approval to ask-always through `session/set_config_option`.
- The prompt asked the agent to read `fact.txt` and give its marker and twice its count. The marker and count were not supplied in the prompt.
- The model requested `read`. The approval became an ACP `session/request_permission`. The client selected allow-once, and a recorded host answer allowed the call.
- The read returned `marker=m4-saffron-91` and `count=13`. ACP tool updates showed the call and its completed result, and ACP message chunks carried the answer.

The final answer was:

> The marker is m4-saffron-91 and twice its count is 26.

The recorded turn completed in two steps, with 2,356 input tokens, 73 output tokens and no cached tokens. The history contained one turn, two model responses, one completed tool result and one approval answer.

The client resent the same keyed prompt. It received the original recorded outcome and started no new turn or model request. It also listed the session, followed its gated record through the Interface and explicitly closed it. The driver exited successfully and joined the agent process.

This proves real inference driven entirely through ACP, including support declarations, configuration, a permission request, a file tool, streamed output and keyed retry. No other real inference was performed for milestone 4.
