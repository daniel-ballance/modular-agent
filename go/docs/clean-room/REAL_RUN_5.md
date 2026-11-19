# Real run 5: parts as separate services, driven over HTTP

Run on 2026-11-17, 06:23:00 to 06:23:02 UTC. Inference used only `claude-haiku-5-5` through the Anthropic Messages API.

## Process boundary

The explicit driver `scripts/milestone5-real.py` launched these independent `bin/modular-service` processes:

| Part | PID | URL |
| --- | --- | --- |
| History store | 1230337 | `http://127.0.0.1:42227` |
| Working environment | 1230344 | `http://127.0.0.1:34363` |
| Model gateway | 1230352 | `http://127.0.0.1:39399` |
| Agent, durable Runtime | 1230359 | `http://127.0.0.1:38545` |

Only the gateway installed the Anthropic Provider and credential-store plugins. The key stayed at its configured external file and was read at request time only by that gateway. The agent held service access tokens but no model credentials. The driver never read the Anthropic key, and no key was printed, copied into the repository or passed as a process argument.

## What happened

1. The driver created a sandbox folder with `fact.txt`, containing marker `m5-jade-47` and count `17`.
2. Over the authenticated agent HTTP API it created session `1a7905a92c04ab41bad74b8424911c7f`, selected a four-step/384-output-token limit with thinking off, read support and connected an event follower.
3. It submitted keyed input asking the agent to use `read` on `fact.txt`, then give the marker and twice the count. The prompt did not contain those values.
4. The first model request asked for `read`. The agent's ordinary tool source called the working-environment plugin, which read through the sandbox service. History entries were stored through the history service.
5. The second model request returned:

   > The marker is m5-jade-47, and twice its count is 34.

6. The turn completed in two steps, with one tool call. Recorded usage was 2,355 input tokens and 72 output tokens, with no cached input. No subagent or shell command was requested.
7. The driver resent the same input key with different text. The agent returned receipt `603037ee8344f8f8eb161d5367e5cbea` again with `Duplicate=true`. No extra turn or model request was made.
8. It reconnected from a cursor in the middle of the record and received all seven later entries, in order, without resending the cursor entry. The replay included the complete result rather than missed streamed pieces.
9. The driver stopped every process by its exact process handle, waited for exit and deleted its temporary service-token file. A process listing after the run showed no service, sandbox-worker or command-supervisor processes left behind.

## Evidence and repeat

Evidence folder: `/tmp/modular-go-m5-real.rjaw9z0v`.

It contains `summary.json`, `events.jsonl`, `replay.jsonl`, per-part stderr files, the project fixture and persisted history. The private service-token file was deleted after shutdown. The persisted history contains 16 entries and no credentials.

To deliberately repeat, making real requests:

```sh
mise exec -- go build -o bin/modular-service ./cmd/modular-service
python3 scripts/milestone5-real.py
```

Do not run this as part of offline tests. The script starts all four parts separately, drives only HTTP, limits inference, asserts the file-based answer, input deduplication and reconnect replay, and cleans up in `finally`.
