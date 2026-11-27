# Reference checks

The 37 checks test whether an implementation of the [standard configuration](../../docs/reference/standard-configuration.md) behaves as that page says. They run `ma` as a person would, with a scripted model, and look only at what it prints, its exit status, the files it leaves, the model requests it logs, its ACP and AG-UI responses and the telemetry it exports. So one set of checks covers both implementations.

Install the shared OTLP receiver's dependencies from this directory: `npm ci --prefix ../telemetry`.

```sh
node run.mjs -- /path/to/ma                 # one build
node run.mjs --agent rust                   # a build listed in agents/
node run.mjs --all                          # every listed build that is built
node run.mjs --only print,mcp -- /path/to/ma
```

Each check runs in a fresh folder with its own `HOME`, project and `MODULAR_AGENT_DATA_DIR`, and passes the model script through `MODULAR_AGENT_SCRIPT` and logs requests through `MODULAR_AGENT_SCRIPT_LOG` ([hooks for testing](../../docs/reference/standard-configuration.md#hooks-for-testing)). A failed check keeps its folder and names it. Crash checks kill the agent's whole process group with `SIGKILL` once a command in the code has started, then reopen with `-c` or restart the service. `MODULAR_AGENT_REF_REQUIRE` names languages, or `all`, whose build must be present with `--all`.

Each implementation lists itself in `agents/<language>.json`: `language`, the `build` command, and the `command` that starts `ma`, with `{repo}` for the repository root.

| Check | What it shows |
|---|---|
| `help-options` | Both `ma --help` option sections match the exact lines in the standard configuration. When running a listed build, skip this check if its peer is not built, or fail in strict mode. With an explicit command after `--`, check only that command. |
| `interactive-commands` | `/commands` prints exactly the specified sorted names. The terminal rejects `/tool`. `/questions` lists open IDs and `/quit` exits without a model request. |
| `terminal-approval` | The terminal shows `Allow? (y/n)` and replies `Answer y or n.` to other inputs, including `/quit`, without running them. A subsequent `Y` allows the script. |
| `print` | Print mode prints the final answer; the model is offered only `codemode` |
| `print-questions` | Plain and JSON print mode decline questions from nested and direct tool calls and finish the turn |
| `client-identity` | `MA_CLIENT_IDENTITY` is checked at startup: an invalid value stops `ma` with status 1, a valid one is accepted |
| `approval-covers-script` | Refusal leaves both files untouched. A live allow or an allow after restart runs both writes once, with the parent call and request on each start. |
| `reopen-approval` | A new default does not replace a recorded `off` policy. With the approval feature loaded, a session with no recorded policy reopens with `all`, including a session started without `--approval`. The check also uses `python3` to remove a policy from saved history. |
| `codemode-nested` | Code reads and writes files through `tools`; the nested calls stay out of the model's view |
| `codemode-tools-values` | `import tools`, a tool function held in a variable, and positional arguments make the same calls |
| `find-ignore-and-globs` | Both builds apply parent, local, repository and global ignores and match name and path globs. |
| `codemode-positional-order` | Positional arguments: required fields, then the rest in alphabetical order, as the prompt shows |
| `codemode-no-ambient-access` | No wall clock, sleep, system entropy or files; a seeded generator works |
| `codemode-results` | `exec` returns its dict for a non-zero exit and raises for a timeout; a bare tool name is a `NameError`; printing past 1 MiB stops the run with the error first |
| `codemode-values` | How the last value, a `TypeError` and an uncaught error are given back |
| `sandbox-memory` | Code that outgrows the 256 MiB sandbox limit fails with `MemoryError`; the agent carries on and the next run works |
| `one-offer` | A direct call to a tool not offered does not run |
| `tool-catalog` | With `model_tools: null` the model is offered exactly `codemode`, the six tools and `test_ask_secret`. Neither the prompt nor `codemode`'s `tools` has `ask_user` |
| `model-tools-null` | `model_tools: null` offers the six tools directly |
| `instructions` | Global and project `AGENTS.md` reach the prompt, global first, with the working folder |
| `skills` | A project skill is listed, and `/skill:NAME` puts its body in the input |
| `mcp` | An MCP server's tool is a function in `codemode` |
| `continue` | `-c` reopens the folder's last session with its history |
| `durable-crash` | After `kill -9` during a command in code, the turn carries on and nothing runs twice |
| `resume-open` | Kill a served durable turn during a tool call. A separate listing reader observes the turn finish without connecting to the restarted writer. Without the flag the turn stays interrupted until a client opens it. Neither path repeats the effect. |
| `transient-crash` | With `--runtime transient`, the turn fails and nothing runs twice |
| `declaration` | `ma --declaration` prints the description's declaration as one JSON object |
| `points-in-git` | In a git project a turn saves a point under `refs/modular-agent/`, without touching `HEAD`, the index or `git log` |
| `points-outside-git` | Outside git, `rewinding` is false and nothing is printed about points |
| `prompt-tail` | The prompt ends with `<cwd>` and then `<date>` |
| `json-events` | `--json` prints SDK-shaped events, ending with `turnEnded` |
| `models` | `ma models` lists the scripted model |
| `sessions` | `ma sessions` prints nothing with no sessions, then one `ID  PROJECT` line per session of this project, most recently active first, also after an older session is reopened; `--all` adds the other projects' sessions; `--project b/alias/..` with `b/alias` linked to `a/sub` lists the sessions of `a` |
| `sessions-service` | Over the TypeScript build's history service: the same listing for sessions `ma` made, then for copies written with chosen times. A session whose newest entry has an earlier time than an older entry sorts by the newest entry. Two sessions with the same last time follow in ID order, and `ma -c` reopens the first. A session whose last entry is erased through the service comes after every session with a timed last entry. Without the TypeScript build it is reported as skipped, not passed, and it fails for a language that `MODULAR_AGENT_REF_REQUIRE` requires |
| `telemetry-export` | Export is off without an endpoint. With one, invocation and inference spans carry metadata only. Disabling the SDK stops export but leaves `telemetry: 1` in the declaration. |
| `trace-trust` | An AG-UI or ACP work request continues the supplied trace only for an opted-in network token. The single-token shorthand starts a new trace. Stdio trusts the launcher unless disabled. A non-boolean policy value fails startup. |
| `secret-answer-tty` | In a pseudo-terminal, `/answer REQUEST_ID` refuses an inline secret, reads the secret with echo off, stores it only in `auth.json` (absent from terminal output, history and logs), and restores echo afterwards. Uses `python3`'s `pty` module and skips if unavailable. |
| `version` | `ma --version` names the implementation's language |

The default endpoint assertion listens on `127.0.0.1:4318` inside a private Linux network namespace. It needs unprivileged `unshare -rn` and `ip` to bring up loopback. The runner reports a reason if it skips this assertion and still runs the rest of `telemetry-export`.

## Results

The reference column records the 28-check suite before `reopen-approval`. The ACP column records the earlier kit run against `MODULAR_AGENT_CONFORMANCE=1 ma --acp` with `--crash-checks --probe-checks --job-checks`:

| Implementation | Reference checks | ACP kit |
|---|---|---|
| Rust | 27/28 checked | 188/188 |
| TypeScript | 28/28 | 188/188 |
| Go | 27/28 checked | 188/188 |
| Python | 27/28 checked | 188/188 |

All four ran the identical set of 188 ACP checks, including the four that check an undeclared feature is refused, so they presented the same agent over ACP in that run.

The ACP kit is the other half: each implementation must also pass `node conformance/acp/run.mjs -- ma --acp` with `MODULAR_AGENT_CONFORMANCE=1`.
