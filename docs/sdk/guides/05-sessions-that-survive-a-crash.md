# Sessions that survive a crash

Keep a session when the agent exits. Decide separately whether to resume a turn that was still running.

## Choose what survives

| Durability | After the agent process ends |
|---|---|
| `ephemeral` (default) | Nothing survives the process. A new process cannot reopen the session. |
| `kept` | Committed history survives. On reopen, an interrupted turn ends `failed`; you can send a fresh prompt. |
| `durable` | Committed history survives. On reopen, the Runtime tries to continue the interrupted turn from its last committed checkpoint. |

To use a persistent store or a history service, choose `kept` or `durable`. `createAgent` refuses either with `ephemeral`.

Set `dataDir` to a persistent directory for `kept` or `durable`. The SDK puts default file history there. With an explicit persistent store, such as the [history service](09-share-sessions-between-agents.md), a part may still need the directory: the default local environment, for example, keeps command recovery bookkeeping there. `project` is the working directory, not the storage directory. See [Durability](../placement.md#durability).

Save the session ID outside the process. On restart, build the agent with the same project, storage and compatible Providers and plugins. Call `openSession(id)`, not `session()`, which creates a new session. Opening installs recovery before fresh work. Use `lastTurn` to read the most recent settled turn without prompting the model; it can be absent if no turn has settled yet.

## Know what happened to the call

The agent commits a tool start before dispatch and commits the result before moving on. If a crash lands between those commits, the tool might already have had its effect. In both `kept` and `durable`, an unsettled started call that cannot be safely recovered is recorded as `outcomeUnknown`, not `cancelled` or `notStarted`. A committed result is never replayed by running the tool again. An abandoned call known not to have started is `notStarted`.

Set `safeToRepeat` only if a second execution after an interrupted first attempt is actually safe. A lookup can make that promise; a tool that increments a counter or sends a message generally cannot. The hint is false by default, independent of `readOnly`. It doesn't force a retry: the tool and environment must both have promised repeat safety at the time of the original dispatch and still promise it now. The registration and final gated input must match, and cleanup of the first attempt must be confirmed. See [Recovery and repeating work](../../contracts.md#recovery-and-repeating-work).

## Interrupt and reopen in a test

The [testing kit](../testing.md#the-testing-kit) uses a scripted Provider. Start the lookup without waiting for the turn to finish, wait until the tool is inside its function, then call `restart` instead of closing. The lookup declares `safeToRepeat`, but the kit's memory environment does not promise repeat safety. Check that the call ran once and was settled `outcomeUnknown`: the kept turn fails, while the durable turn goes back to the model and completes. These examples run without a model or network.

**Rust**

```rust
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use modular_agent::{
    Durability, Outcome, Result, Timing, Tool, ToolStatus,
    testing::{restart, test_agent},
};
use serde_json::{Value, json};
use tokio::sync::Notify;

#[tokio::test]
async fn reopens_an_interrupted_session() -> Result<()> {
    for (durability, expected) in [
        (Durability::Kept, "failed"),
        (Durability::Durable, "completed"),
    ] {
        let data_dir = tempfile::tempdir()?;
        let started = Arc::new(Notify::new());
        let starts = Arc::new(AtomicUsize::new(0));
        let lookup = Tool::new("lookup_tide", "Read the tide time.")
            .read_only()
            .safe_to_repeat()
            .run({
                let (started, starts) = (started.clone(), starts.clone());
                move |_: Value, _| {
                    let (started, starts) = (started.clone(), starts.clone());
                    async move {
                        if starts.fetch_add(1, Ordering::Relaxed) == 0 {
                            started.notify_one();
                            std::future::pending::<()>().await;
                        }
                        Ok("14:02")
                    }
                }
            });
        let agent = test_agent()
            .data_dir(data_dir.path())
            .durability(durability)
            .tool(lookup)
            .script(json!([
                { "toolCalls": [{ "name": "lookup_tide", "input": {} }] },
                { "text": "The tide time could not be confirmed." }
            ]))
            .build()
            .await?;
        let session = agent.session().await?;
        let id = session.id().to_owned();
        session.send("Find the tide time.", Timing::Now).await?;
        tokio::time::timeout(Duration::from_secs(5), started.notified())
            .await
            .expect("the tool must start before the crash");

        let agent = restart(agent).await?;
        let reopened = agent.open_session(&id).await?;
        let turn = reopened
            .last_turn()
            .await?
            .expect("recovery settled the turn");
        assert_eq!(turn.outcome.as_ref().map(Outcome::kind), Some(expected));
        assert_eq!(turn.tool_results()[0].status, ToolStatus::OutcomeUnknown);
        assert_eq!(starts.load(Ordering::Relaxed), 1);
        agent.close().await?;
    }
    Ok(())
}
```

**TypeScript**

```ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { tool } from "../src/index.js";
import { restart, testAgent } from "../src/testing.js";

for (const [durability, expected] of [["kept", "failed"], ["durable", "completed"]] as const) {
  test(`reopens an interrupted ${durability} session`, { timeout: 10_000 }, async t => {
    const dataDir = await mkdtemp(join(tmpdir(), "guide05-"));
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let starts = 0;
    const lookup = tool({
      name: "lookup_tide",
      description: "Read the tide time.",
      input: { type: "object" } as const,
      readOnly: true,
      safeToRepeat: true,
      async run(_, cx) {
        if (++starts === 1) {
          started();
          await delay(60_000, undefined, { signal: cx.cancelled });
        }
        return "14:02";
      },
    });
    let agent: Awaited<ReturnType<typeof testAgent>> | undefined;
    try {
      agent = await testAgent({
        dataDir, durability, tools: [lookup],
        script: [
          { toolCalls: [{ name: "lookup_tide", input: {} }] },
          { text: "The tide time could not be confirmed." },
        ],
      });
      const session = await agent.session();
      const id = session.id;
      await session.send("Find the tide time.", "now");
      await Promise.race([ready, delay(5000, undefined, { signal: t.signal, ref: false })
        .then(() => assert.fail("the tool must start before the crash"))]);

      agent = await restart(agent);
      const reopened = await agent.openSession(id);
      const turn = await reopened.lastTurn();
      assert.ok(turn);
      assert.equal(turn.outcome?.kind, expected);
      assert.equal(turn.toolResults()[0].status, "outcomeUnknown");
      assert.equal(starts, 1);
    } finally {
      await agent?.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}
```

## Kill a real process

The restart helper interrupts tracked work without a graceful close. It does not test what happens to a real process or its children. The shared [kept crash](../../../conformance/sdk/scenarios/kept-crash.json) and [durable crash](../../../conformance/sdk/scenarios/durable-crash.json) scenarios use a non-repeatable counter tool. Each runner waits for the count file to reach one, kills the agent's process group with `SIGKILL`, and waits for the group to stop before reopening. Both scenarios check that the count is still one and the call is `outcomeUnknown`; only the durable turn continues. The [ephemeral crash](../../../conformance/sdk/scenarios/ephemeral-crash.json) scenario uses the same crash point and checks that the new process cannot reopen the session. Run them with your SDK's [shared scenario runner](../testing.md#the-shared-scenarios).
