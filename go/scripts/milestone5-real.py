#!/usr/bin/env python3
"""Explicit real Haiku run. Never invoked by offline tests. Only gateway reads its key."""
import json
import pathlib
import secrets
import select
import subprocess
import tempfile
import urllib.request

REPO = pathlib.Path(__file__).resolve().parents[1]
ROOT = pathlib.Path(tempfile.mkdtemp(prefix="modular-go-m5-real."))
PROJECT = ROOT / "project"
PROJECT.mkdir()
(PROJECT / "fact.txt").write_text("marker=m5-jade-47\ncount=17\n")
TOKEN = secrets.token_urlsafe(32)
TOKEN_FILE = ROOT / "service.token"
TOKEN_FILE.write_text(TOKEN)
TOKEN_FILE.chmod(0o600)
parts = []
logs = []


def start(role, *args):
    log = (ROOT / (role + ".stderr")).open("a")
    logs.append(log)
    proc = subprocess.Popen(
        [str(REPO / "bin/modular-service"), "--role", role,
         "--token-file", str(TOKEN_FILE), *args],
        stdout=subprocess.PIPE, stderr=log, text=True, cwd=REPO)
    parts.append(proc)
    if not select.select([proc.stdout], [], [], 10)[0]:
        raise RuntimeError(role + " readiness timeout")
    line = proc.stdout.readline()
    if not line:
        raise RuntimeError(role + " failed to start; inspect its stderr file")
    ready = json.loads(line)
    return ready


def request(url, path, body, stream=False):
    req = urllib.request.Request(url + path, json.dumps(body).encode(),
                                 {"Authorization": "Bearer " + TOKEN,
                                  "Content-Type": "application/json"})
    response = urllib.request.urlopen(req, timeout=90)
    if stream:
        return response
    with response:
        return json.load(response)


try:
    history = start("history", "--state", str(ROOT / "history"))
    environment = start("environment", "--project", str(PROJECT))
    gateway = start("gateway")
    agent = start("agent", "--project", str(PROJECT), "--runtime", "durable",
                  "--history-url", history["url"],
                  "--environment-url", environment["url"],
                  "--model-gateway", gateway["url"])
    url = agent["url"]
    call = lambda body: request(url, "/v1/agent", body)
    session = call({"Op": "new"})["Session"]
    call({"Op": "settings", "Session": session, "Settings": {
        "model": "claude-haiku-5-5", "thinking": "off", "approval": "off",
        "max_steps": 4, "max_output": 384}})
    support = call({"Op": "support", "Session": session})["Support"]
    stream = request(url, "/v1/agent/events", {"Session": session}, True)
    json.loads(stream.readline())  # ready; an actual follower is connected
    receipt = call({"Op": "input", "Session": session, "Key": "m5-real-once",
                    "Content": [{"type": "text", "text":
                                 "Use read to read fact.txt. Reply in one short sentence giving "
                                 "its marker and twice its count. Do not delegate or use other tools."}]})
    frames = []
    with (ROOT / "events.jsonl").open("w") as evidence:
        while True:
            line = stream.readline()
            if not line:
                raise RuntimeError("event stream ended before recorded turn.end")
            evidence.write(line.decode())
            frame = json.loads(line)
            frames.append(frame)
            entry = frame.get("Entry")
            if entry and entry["kind"] == "turn.end":
                break
    stream.close()
    outcome = call({"Op": "wait", "Session": session})["Outcome"]
    duplicate = call({"Op": "input", "Session": session, "Key": "m5-real-once",
                      "Content": [{"type": "text", "text": "This retry must not run."}]})
    entries = [f["Entry"] for f in frames if f.get("Entry")]
    after = entries[len(entries) // 2]["id"]
    expected = [e["id"] for e in entries[1 + next(i for i, e in enumerate(entries) if e["id"] == after):]]
    replay = request(url, "/v1/agent/events", {"Session": session, "After": after}, True)
    replayed = []
    with (ROOT / "replay.jsonl").open("w") as evidence:
        while len(replayed) < len(expected):
            line = replay.readline()
            if not line:
                raise RuntimeError("replay ended early")
            evidence.write(line.decode())
            frame = json.loads(line)
            if frame.get("Entry"):
                replayed.append(frame["Cursor"])
    replay.close()
    text = "".join(p.get("text", "") for p in outcome.get("result", []))
    assert outcome["status"] == "completed", outcome
    assert "m5-jade-47" in text and "34" in text, text
    assert duplicate["Receipt"]["Duplicate"], duplicate
    assert replayed == expected, (replayed, expected)
    tools = [e for e in entries if e["kind"] == "tool.call"]
    assert len(tools) == 1 and tools[0]["data"]["name"] == "read", tools
    summary = {"evidence": str(ROOT), "parts": [history, environment, gateway, agent],
               "session": session, "support": support, "receipt": receipt["Receipt"],
               "duplicate": duplicate["Receipt"], "outcome": outcome,
               "model_requests": sum(e["kind"] == "model" for e in entries),
               "tool_calls": len(tools), "replayed_entries": len(replayed)}
    (ROOT / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
finally:
    for proc in reversed(parts):
        if proc.poll() is None:
            proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
    for log in logs:
        log.close()
    TOKEN_FILE.unlink(missing_ok=True)
