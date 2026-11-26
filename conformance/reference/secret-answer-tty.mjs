import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const driver = fileURLToPath(new URL("secret-answer-tty.py", import.meta.url));

const SECRET_SENTINEL = "pty-hidden-secret-84729";
const INLINE_SENTINEL = "inline-secret-refused-9142";
const ECHO_PROBE = "pty-echo-probe-5183";

function ptySkipReason() {
  const probe = spawnSync(
    "python3",
    ["-c", "try:\n    import pty\nexcept ImportError:\n    raise SystemExit(77)"],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (probe.error?.code === "ENOENT" || probe.status === 77) {
    return "needs python3 with the pty module";
  }
  if (probe.error) throw probe.error;
  assert.equal(probe.status, 0, `python3 pty probe failed: ${probe.stderr}`);
}

function* filesBelow(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* filesBelow(path);
    else if (entry.isFile()) yield path;
  }
}

export async function checkSecretAnswerTty(command, invoke, skip, t, env) {
  const reason = ptySkipReason();
  if (reason) {
    skip(reason, "check");
    return;
  }

  const run = spawnSync(
    "python3",
    [driver, SECRET_SENTINEL, INLINE_SENTINEL, ECHO_PROBE, ...command],
    {
      cwd: t.project,
      env: { ...env, NO_COLOR: "1", TERM: "xterm" },
      encoding: "utf8",
      timeout: 75_000,
    },
  );
  if (run.error) throw run.error;
  assert.equal(
    run.status,
    0,
    `pty driver exited ${run.status}: ${run.stderr?.trim() || run.stdout?.trim()}`,
  );
  const result = JSON.parse(run.stdout);
  assert.equal(result.exitCode, 0, `ma exited ${result.exitCode}; transcript:\n${result.transcript}`);
  assert.ok(
    !result.transcript.includes(SECRET_SENTINEL),
    `secret was echoed or printed in terminal output:\n${result.transcript}`,
  );
  assert.ok(result.echoRestored, "echo was not back on after reading the secret");

  const authPath = join(t.data, "auth.json");
  assert.equal(statSync(authPath).mode & 0o777, 0o600, "auth.json must have mode 0600");
  const rawAuth = readFileSync(authPath, "utf8");
  const auth = JSON.parse(rawAuth);
  assert.equal(auth?.answers?.deploy, SECRET_SENTINEL, `auth.json did not store the secret: ${rawAuth}`);
  assert.ok(!rawAuth.includes(INLINE_SENTINEL), "refused inline secret must not be stored in auth.json");

  const logText = readFileSync(t.logFile, "utf8");
  assert.ok(logText.includes("secret_result=stored"), `test_ask_secret did not return stored: ${logText}`);

  const history = await invoke(command, { args: ["-c", "--history"] });
  assert.equal(history.exit, 0, `ma -c --history failed: ${history.stderr}`);
  assert.ok(history.stdout.includes("SECRET_TURN_DONE"), "history is missing the completed secret turn");
  assert.ok(!history.stdout.includes(SECRET_SENTINEL), "secret appeared in history stdout");
  assert.ok(!history.stderr.includes(SECRET_SENTINEL), "secret appeared in history stderr");

  const secretBytes = Buffer.from(SECRET_SENTINEL);
  const leaks = [...filesBelow(t.dir)]
    .filter(path => path !== authPath && readFileSync(path).includes(secretBytes))
    .map(path => relative(t.dir, path));
  assert.deepEqual(leaks, [], `secret leaked into files other than auth.json: ${leaks.join(", ")}`);
}
