# Drive an agent over ACP

Let a client start your agent, create a session and stream the answer to one prompt. ACP is the Interface to the whole agent; the SDK's Provider still makes the model request.

## Serve the agent

Build the agent as you would for [an embedded prompt](01-first-agent.md), with plugin hosting enabled. Instead of opening an embedded session, call `serveAcp`. It serves Agent Client Protocol on stdin and stdout until the client disconnects. Keep diagnostic output on stderr. Build and serve before opening any embedded sessions. The tests below use the same call as a program that serves a real model.

| Language | Enable plugin hosting when building | Serve on stdio |
|---|---|---|
| Rust | `Agent::builder().plugin_host(true)` | `agent.serve_acp(AcpOptions::default()).await` |
| TypeScript | `pluginHost: true` | `await agent.serveAcp()` |

## Choose the project

Start with no serve options. The agent is then bound to its configured project. The client sends an absolute, existing directory as `cwd`; the server canonicalizes it, resolving symlinks, and refuses a different project. A project path is not a grant.

For a multi-project host, configure the connection’s allowed projects and use `compose` to select an Agent for the canonical project. Point the serving side and the composed Agents at the same persistent history if sessions need to reopen. The serving side finds the saved session before selecting an Agent. Use its metadata to choose the parts that recovery needs; do not replace saved settings with new defaults. For example, both `ma` factories can use the saved model to decide whether to load the Claude Provider, even if the current default model is different.

Keep an operator-controlled trust decision outside the project. Before using a project’s config to launch code or add configured MCP servers, check that decision. An allowed path is not a trust grant, and the client cannot grant trust over ACP. Treat any `mcpServers` sent by the client as a separate input under the [host MCP policy](../../contracts.md#mcp-servers).

In Rust, use `AcpOptions.compose` and implement `AcpComposition`; `project_mcp` attaches client servers. In TypeScript, use `serveAcp({ compose, projectSettings, projectMcp })`; `projectMcp` resolves configured servers. For exact signatures and fixed-project support, see [ACP project options](../languages.md#acp-project-options). For the order of checks and recovery, see [ACP project composition](../api.md#acp-project-composition).

## Know who is acting

On stdio, the launcher and its child are the authenticated peers. Keep their pipe private. The Interface takes the connection's actor from server-side configuration, not from a client-supplied actor id or the embedded session's local actor. The actor reported by `initialize` is not a grant in any session. See [Languages](../languages.md) for the TypeScript option and fallback order.

The agent checks the connection actor's effective rights for each session operation. For example, `input` permits prompting, `watch` permits receiving updates, and only a present, eligible actor with `approve` can answer a tool permission request. Reopening a saved session does not reset its recorded rights. A host may show a permission dialog or answer it according to its own policy; the agent still checks the right and runs its own tool gates. Tools run in the agent's working environment, not through the client's editor file or terminal methods. See [ACP Authorization](../../bindings/acp.md#authorization), [Authority](../../contracts.md#authority) and [Stdio authentication](../../security.md#authentication-on-each-wire).

## Connect T3 Code

In T3 Code, add a local ACP command. For an installed [reference agent](../../reference/standard-configuration.md), enter the absolute path to `ma` as the executable (for example, `/home/you/.local/bin/ma`) and `--acp` as its sole argument. To use your own SDK program instead, give the executable and arguments that reach the serve call above. For example, for a built TypeScript program, set the executable to the absolute path to Node and use the absolute path to your built script as its argument. Select the ACP agent for a thread in the project it serves.

Set up the model credentials on the agent side before launching. T3 Code will start the process, negotiate capabilities, create or reopen a session and render the streamed updates. Try “Say hello.” This host example is shown only; the tests below do not run T3 Code or call a model.

## Test one prompt without a model

Use a scripted Provider and the real ACP binding. Initialize the connection, open a session with an empty MCP list, and send a text prompt. Check both the final `end_turn` reply and the text from the `agent_message_chunk` updates. The reply does not carry the answer text. When handling failures in a real client, also read the binding's [prompt outcome](../../bindings/acp.md#prompts), not just the stop reason.

Rust uses the SDK scenario crate's existing `sdk-acp-test-agent` executable, which builds an Agent with `testing::scripted_provider` and calls `serve_acp(Default::default())`. The test drives it with newline-delimited JSON-RPC, as the SDK ACP test does. TypeScript starts its server as a child process and connects with the ACP SDK client.

**Rust**

```rust
use serde_json::{Value, json};
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

#[tokio::test]
async fn drive_one_acp_prompt() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let project = tempfile::tempdir().unwrap();
        let cwd = project.path().canonicalize().unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_sdk-acp-test-agent"))
            .current_dir(&cwd)
            .env_remove("MODULAR_AGENT_PLUGINS")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut text = String::new();

        // Send one ACP request and read updates until its reply arrives.
        macro_rules! call {
            ($id:literal, $method:literal, $params:expr) => {{
                let request = json!({
                    "jsonrpc": "2.0", "id": $id, "method": $method, "params": $params
                });
                input.write_all(format!("{request}\n").as_bytes()).await.unwrap();
                loop {
                    let line = lines.next_line().await.unwrap().expect("ACP disconnected");
                    let frame: Value = serde_json::from_str(&line).unwrap();
                    if frame["id"] == $id {
                        assert!(frame["error"].is_null(), "{frame}");
                        break frame["result"].clone();
                    }
                    let update = &frame["params"]["update"];
                    if frame["method"] == "session/update"
                        && update["sessionUpdate"] == "agent_message_chunk"
                    {
                        text.push_str(update["content"]["text"].as_str().unwrap());
                    }
                }
            }};
        }

        call!(1, "initialize", json!({"protocolVersion": 1}));
        let session = call!(2, "session/new", json!({"cwd": cwd, "mcpServers": []}));
        let reply = call!(
            3,
            "session/prompt",
            json!({
                "sessionId": session["sessionId"],
                "prompt": [{"type": "text", "text": "Say hello."}]
            })
        );
        assert_eq!(reply["stopReason"], "end_turn");
        assert_eq!(text, "Hello over ACP.");
        drop(input);
        assert!(child.wait().await.unwrap().success());
    })
    .await
    .expect("ACP timed out");
}
```

**TypeScript**

```ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

test("drives one ACP prompt", { timeout: 10_000 }, async t => {
  const project = await realpath(await mkdtemp(join(tmpdir(), "ma-acp-guide-")));
  t.after(() => rm(project, { recursive: true, force: true }));
  const server = `
    import { testAgent } from ${JSON.stringify(import.meta.resolve("@modular-agent/core/testing"))};
    const agent = await testAgent({
      project: process.cwd(), pluginHost: true, script: [{ text: "Hello over ACP." }],
    });
    await agent.serveAcp();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", server], {
    cwd: project, stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, MODULAR_AGENT_PLUGINS: "" },
  });
  t.after(() => { child.kill(); });
  const exited = once(child, "close");

  const chunks: string[] = [];
  const app = client({ name: "guide-client" })
    .onNotification(methods.client.session.update, ({ params: { update } }) => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        chunks.push(update.content.text);
      }
    });
  const { agent } = app.connect(ndJsonStream(
    Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  ));
  await agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
  const { sessionId } = await agent.request(methods.agent.session.new, { cwd: project, mcpServers: [] });
  const reply = await agent.request(methods.agent.session.prompt, {
    sessionId, prompt: [{ type: "text", text: "Say hello." }],
  });
  assert.equal(reply.stopReason, "end_turn");
  assert.equal(chunks.join(""), "Hello over ACP.");

  child.stdin.end();
  const [code] = await exited;
  assert.equal(code, 0);
});
```
