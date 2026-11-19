# Reference checks

Checks that an implementation of the [standard configuration](../../docs/reference/standard-configuration.md) behaves as that page says. They run `ma` as a person would, with a scripted model, and look only at what it prints, its exit status, the files it leaves and the model requests it logs. So one set of checks covers all four implementations.

```sh
node run.mjs -- /path/to/ma                 # one build
node run.mjs --agent rust                   # a build listed in agents/
node run.mjs --all                          # every listed build that is built
node run.mjs --only print,mcp -- /path/to/ma
```

Each check runs in a fresh folder with its own `HOME`, project and `MODULAR_AGENT_DATA_DIR`, and passes the model script through `MODULAR_AGENT_SCRIPT` and logs requests through `MODULAR_AGENT_SCRIPT_LOG` ([hooks for testing](../../docs/reference/standard-configuration.md#hooks-for-testing)). A failed check keeps its folder and names it. Crash checks kill the agent's whole process group with `SIGKILL` once a command in the code has started, then reopen with `-c`. `MODULAR_AGENT_REF_REQUIRE` names languages, or `all`, whose build must be present with `--all`.

Each implementation lists itself in `agents/<language>.json`: `language`, the `build` command, and the `command` that starts `ma`, with `{repo}` for the repository root.

| Check | What it shows |
|---|---|
| `print` | Print mode prints the final answer; the model is offered only `codemode` |
| `codemode-nested` | Code reads and writes files through `tools`; the nested calls stay out of the model's view |
| `one-offer` | A direct call to a tool not offered does not run |
| `model-tools-null` | `model_tools: null` offers the six tools directly |
| `instructions` | Global and project `AGENTS.md` reach the prompt, global first, with the working folder |
| `skills` | A project skill is listed, and `/skill:NAME` puts its body in the input |
| `mcp` | An MCP server's tool is a function in `codemode` |
| `continue` | `-c` reopens the folder's last session with its history |
| `durable-crash` | After `kill -9` during a command in code, the turn carries on and nothing runs twice |
| `transient-crash` | With `--runtime transient`, the turn fails and nothing runs twice |
| `declaration` | `ma --declaration` prints the description's declaration as one JSON object |
| `prompt-tail` | The prompt ends with `<cwd>` and then `<date>` |
| `json-events` | `--json` prints SDK-shaped events, ending with `turnEnded` |
| `models` | `ma models` lists the scripted model |
| `version` | `ma --version` names the implementation's language |

## Results

All four implementations, with `MODULAR_AGENT_REF_REQUIRE=all`, before the last three checks were added:

| Implementation | Reference checks | ACP kit with crash checks |
|---|---|---|
| Rust | 12/12 | 123/123 |
| TypeScript | 12/12 | 123/123 |
| Go | 12/12 | 94/94: it declares fewer features, a gap the description now closes |
| Python | 12/12 | 123/123 |

The ACP kit is the other half: each implementation must also pass `node conformance/acp/run.mjs -- ma --acp` with `MODULAR_AGENT_CONFORMANCE=1`.
