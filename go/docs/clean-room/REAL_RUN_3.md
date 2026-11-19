# Milestone 3 real model run

Completed 2026-11-17, 04:25 UTC. Only `claude-haiku-5-5` through Anthropic was used. Five model requests, one executable process, two sessions. The Provider alone read the experiment key at request time. No key was printed, passed as an argument or copied here.

## Reproduce deliberately

This makes real requests and is not part of the offline suite:

```sh
mise exec -- go build -o bin/modular ./cmd/modular
python3 scripts/milestone3-real.py bin/modular
```

The driver creates a temporary project, selects the durable Runtime and durable subagents, and runs JSON mode with `--wait-jobs`. It never reads credentials. It checks the file, child ownership, bash call, job report and the input that starts the parent's second turn. It saves raw events and snapshots outside the repository.

Evidence from this run: `/tmp/modular-go-m3-real.sp2d2e8x`.

## Observed

- Parent session: `a3ed7a6bfc1f3cf97e207f2a10c066b0`.
- Child session: `17294730867dd0c6aca675ba72d9262f`, recorded as belonging to the parent.
- Job: `bb0f7abc63f50666b4bb268d354cb284`.
- Both sessions selected `claude-haiku-5-5`.
- The parent used delegate with background true. It ran no bash or file tool itself.
- The child received the file-writing task, not the parent's conversation. It used bash to run `sleep 3; printf 'm3-cobalt-73\n' > child-note.txt` and reported its result.
- The file contained exactly `m3-cobalt-73` followed by a newline.

Recorded order, UTC:

| Time | Record |
|---|---|
| 04:25:12.092 | Parent's first turn starts |
| 04:25:13.060 | Subagent job starts |
| 04:25:13.448 | Parent's first turn completes with “Background job started.” |
| 04:25:13.733 | Child calls bash |
| 04:25:17.190 | Child completes and its job ends completed |
| 04:25:17.192 | The job's input starts the parent's second turn |
| 04:25:17.779 | Parent's second turn completes |

There was one job start, one job end and one model-visible report input. The second turn's recorded initiating input was that report's receipt, not a new user prompt. The parent used three requests and the child used two. Every requested tool call had one result. The driver exited successfully and the command supervisor was closed with the agent.

The parent's final answer was:

> The subagent used bash to write child-note.txt, containing the marker m3-cobalt-73.

This proves the required background-child file write, work outliving the initiating parent turn, and a report waking a new parent turn that describes what happened. No other real inference was performed for milestone 3.
