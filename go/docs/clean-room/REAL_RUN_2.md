# Milestone 2 real model run

Completed on 2026-11-17 UTC, using only `claude-haiku-5-5` through the Anthropic Messages API. One demonstration, three model requests across two agent processes. No key was printed, copied or passed on a command line. The Provider obtained it from the existing credential store at request time.

## Reproduce

```sh
mise exec -- go build -o bin/modular ./cmd/modular
python3 scripts/milestone2-real.py bin/modular
```

This deliberately makes real requests. Tests do not run this script. It writes temporary evidence, watches live events, sends SIGKILL by PID during bash, reaps the supervisor, and reopens without a prompt.

## Recorded evidence

- Directory: `/tmp/modular-go-m2-real.ys_00haf`.
- Session: `586e3b545675bdfd5b27a388a2f3ca95`.
- Turn: `3503c945fb758f96af76c5f04019832b`.
- Agent PID killed: `743463`. Command supervisor PID: `743491`.
- Settings: Haiku 5.5, thinking off, 12 steps, 1024 output tokens maximum.
- Fixture: `marker.txt` said "The milestone two marker is amber-47."

The saved `commands.json` gives the exact invocations. Both selected `--runtime durable --mode json`, with history and settings under the temporary directory. Process 1 had the project, prompt and input key. Process 2 had only `--session 586e3b545675bdfd5b27a388a2f3ca95`, with no new input.

## Timeline

At 03:11:44.621759704 UTC, the single turn started.

At 03:11:45.661745358, Haiku requested bash, call `toolu_01XAD89jayFSaq5VXuX8Q2gT`:

```sh
printf 'M2_BASH_READY\n'; sleep 30; printf finished > completion.txt
```

At 03:11:45.667273058 the Interface received live `M2_BASH_READY`. The driver sent `kill -9 743463`. The agent exited from SIGKILL, and the supervisor was reaped. The completion file did not exist.

The new process reopened the durable turn. At 03:11:45.670802683 it recorded the interrupted bash result as `unknown`:

> Call did not finish; its outcome is unknown. Check outside state before relying on it. Do not assume its effects did or did not happen.

At 03:11:46.507831656, Haiku requested `read marker.txt` and a new, short bash inspection:

```sh
ls -la completion.txt 2>&1; cat completion.txt 2>&1
```

Read returned amber-47. The inspection reported no such file and exit status 1. The interrupted sleep/write command was not repeated.

At 03:11:47.193402078, the original turn completed:

> The marker is amber-47, and completion.txt does not exist, so the sleep command apparently did not finish its write (its outcome was unknown, and I did not rerun it).

## What it proves

The saved history has one turn start and one turn end, with the same turn identity across processes. All three calls have exactly one result. The unsafe interrupted bash got unknown, its result reached the model, and the model checked outside state before answering. There were three steps and three requests total, using 3428 input tokens, 304 output tokens and no cached tokens. The resumed agent exited successfully.

The raw JSON event streams, stderr, session history and `summary.json` remain in the temporary directory. This document preserves the evidence independently of it. No command processes remained after the demonstration.
