#!/usr/bin/env python3
"""Explicit Haiku run for round four. The gateway alone reads its Anthropic key."""
import json
import pathlib
import secrets
import select
import subprocess
import tempfile
import time
import urllib.request
import os

repo = pathlib.Path(__file__).resolve().parents[1]
root = pathlib.Path(tempfile.mkdtemp(prefix="modular-go-r4-real."))
project = root / "project"
project.mkdir()
(project / "fact.txt").write_text("marker=r4-saffron-71\ncount=19\n")
(root / "history").mkdir()
token = secrets.token_urlsafe(32)
secret = root / "service.token"
secret.touch(mode=0o600)
secret.write_text(token)
children = []


def start(name, cmd, env=None):
    with (root / (name + ".err")).open("w") as error:
        proc = subprocess.Popen(cmd, cwd=repo, stdout=subprocess.PIPE,
                                stderr=error, env=env, text=True)
    children.append(proc)
    return proc


def ready(proc):
    if not select.select([proc.stdout], [], [], 10)[0]:
        raise RuntimeError("service readiness timed out")
    return json.loads(proc.stdout.readline())["url"]


def collect(proc, name, timeout=90):
    out, _ = proc.communicate(timeout=timeout)
    (root / (name + ".out")).write_text(out)
    if proc.returncode:
        raise RuntimeError(f"{name} exited {proc.returncode}; see {root}")
    return out


print(root, flush=True)
try:
    history = ready(start("history", ["node", "/tmp/ma-tools/history-service/serve.mjs",
                           json.dumps({"dir": str(root / "history"), "token": token, "leaseMs": 15000})]))
    gateway = ready(start("gateway", [str(repo / "bin/modular-service"), "--role", "gateway",
                           "--token-file", str(secret)]))
    env = dict(os.environ, MODULAR_AGENT_HISTORY_URL=history,
               MODULAR_AGENT_HISTORY_TOKEN_FILE=str(secret), MODULAR_AGENT_DATA_DIR=str(root / "data"))
    env.pop("MODULAR_AGENT_CONFORMANCE", None)
    env.pop("MODULAR_AGENT_PLUGINS", None)
    base = [str(repo / "bin/modular"), "--runtime", "durable", "--mode", "print",
            "--project", str(project), "--model-gateway", gateway, "--service-token-file", str(secret)]

    def get(path):
        req = urllib.request.Request(history + path, headers={"Authorization": "Bearer " + token})
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.load(response)

    prompt = "Read fact.txt with read and answer with its marker and twice its count. Keep it short."
    first = collect(start("read", base + ["--prompt", prompt], env), "read")
    assert "r4-saffron-71" in first and "38" in first, first
    session, = get("/v1/sessions")["sessions"]
    sid = session["id"]
    base += ["--session", sid]
    prompt = ("Run exactly one bash call with command 'echo started >> crash-marker; sleep 60'. "
              "If its outcome is unknown, do not run it again or call other tools. "
              "Tell me it was interrupted and repeat the marker from the previous turn.")
    killed = start("killed", base + ["--prompt", prompt], env)
    until = time.monotonic() + 35
    while not (project / "crash-marker").exists():
        if killed.poll() is not None or time.monotonic() >= until:
            raise RuntimeError("bash never started")
        time.sleep(.05)
    subprocess.run(["kill", "-9", str(killed.pid)], check=True)
    killed.communicate(timeout=8)
    assert killed.returncode == -9
    started = time.monotonic()
    recovered = start("recovered", base, env)
    collect(recovered, "recovered")
    entries = get("/v1/sessions/" + sid)["entries"]
    turns = [e for e in entries if e["kind"] == "turnEnd"]
    recovered_text = turns[-1]["data"]["result"]["text"]
    assert len(turns) == 2 and turns[-1]["data"]["outcome"]["kind"] == "completed", turns
    assert "r4-saffron-71" in recovered_text, recovered_text
    calls = [e for e in entries if e["kind"] == "toolStarted" and e["data"]["call"]["name"] == "bash"]
    assert len(calls) == 1, calls
    results = [e for e in entries if e["kind"] == "toolResult" and e["toolCallId"] == calls[0]["toolCallId"]]
    assert len(results) == 1 and results[0]["data"]["status"] == "outcomeUnknown", results
    assert (project / "crash-marker").read_text() == "started\n"
    summary = {"session": sid, "killedPid": killed.pid, "recoveredPid": recovered.pid,
               "reopenSeconds": round(time.monotonic() - started, 2), "firstAnswer": turns[0]["data"]["result"]["text"],
               "recoveredAnswer": recovered_text, "bashStarts": len(calls), "bashOutcome": "outcomeUnknown"}
    (root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
finally:
    for proc in reversed(children):
        if proc.poll() is None:
            proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
    secret.unlink(missing_ok=True)
