# Milestone 1 real model run

Completed on 2026-11-17 UTC. Only `claude-haiku-5-5`, through `https://api.anthropic.com/v1/messages`. Three model requests across two separate invocations of the compiled executable. No key was printed or copied into the repository. The credential store read the configured experiment key file only when the Provider requested it.

## Fixture

Project `/tmp/modular-go-m1-real.9pevkY/project`, containing:

```text
AGENTS.md: Use read when asked for a file. Keep answers to one sentence.
fact.txt: The observatory's calibration word is cerulean. Its telescope count is 7.
```

History was stored at `/tmp/modular-go-m1-real.9pevkY/history`. Session: `cce6ee7e33040f4c4cc9e045e49b1aa0`. Settings: Haiku 5.5, thinking off, 12 steps maximum, 1024 output tokens maximum.

## Process 1

```sh
bin/modular --state /tmp/modular-go-m1-real.9pevkY/history \
  --settings /tmp/modular-go-m1-real.9pevkY/no-global.json \
  --project /tmp/modular-go-m1-real.9pevkY/project --mode json \
  --key real-first \
  --prompt 'Use read to read fact.txt. What is the calibration word and telescope count? Answer in one short sentence.'
```

At 02:20:10 UTC, the model requested `read` with `fact.txt`. The recorded tool result was completed and held the fixture text. At 02:20:11, the turn completed after two steps:

> The calibration word is "cerulean" and the telescope count is 7.

Usage across the two requests: 1776 input tokens, 73 output tokens, 0 cached tokens. Exit code 0.

## Process 2

After process 1 exited, a new process reopened the same session:

```sh
bin/modular --state /tmp/modular-go-m1-real.9pevkY/history \
  --settings /tmp/modular-go-m1-real.9pevkY/no-global.json \
  --session cce6ee7e33040f4c4cc9e045e49b1aa0 --mode json \
  --key real-second \
  --prompt 'Without reading the file again, what was the calibration word, and what is twice the telescope count from our previous exchange? One short sentence.'
```

At 02:20:23 UTC, the turn completed in one step, with no tool call:

> The calibration word was "cerulean," and twice the telescope count is 14.

Usage: 996 input tokens, 26 output tokens, 0 cached tokens. Exit code 0. The saved history retained the original project, model setting and both completed turns. This proves that the real Provider used a file tool, received its result, and continued from disk history in a different process.

The JSON event streams and empty stderr files remain in the temporary run directory. This document preserves the relevant evidence if that directory is removed.

## Official API sources actually read

- https://platform.claude.com/docs/en/api/overview: bearer authentication, supported legacy key header and API version.
- https://platform.claude.com/docs/en/api/messages: message and tool blocks.
- https://platform.claude.com/docs/en/build-with-claude/streaming: SSE, usage and streamed tool input.
- https://platform.claude.com/docs/en/models/haiku-5-5/overview: exact model ID, 1M context, 128K maximum output and adaptive thinking.
- https://platform.claude.com/docs/en/build-with-claude/thinking: Haiku 5.5 supports disabled thinking at low, medium and high effort. The real run used disabled thinking with low effort.
