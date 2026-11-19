#!/usr/bin/env python3
"""Run the live history service proof. Only the agent reads the OpenAI key."""
import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / 'target/debug/modular-agent'
URL = os.environ['MODULAR_AGENT_HISTORY_URL']
TOKEN = Path(os.environ['MODULAR_AGENT_HISTORY_TOKEN_FILE']).read_text().strip()
assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0


def get(path):
    with urlopen(Request(URL + path, headers={'Authorization': 'Bearer ' + TOKEN}), timeout=10) as reply:
        return json.load(reply)


def stop(child):
    if child and child.poll() is None:
        child.kill()
        child.wait(timeout=10)


with tempfile.TemporaryDirectory(prefix='ma-r4-live-') as directory:
    project = Path(directory)
    (project / 'proof.txt').write_text('indigo-acorn-47\n')
    (project / '.modular-agent.json').write_text(json.dumps({'output_limit': 1024, 'step_limit': 5, 'thinking': 'low'}))
    base = [str(BIN), '--json', '--provider-mode', 'stateless', '--project', directory,
            '--data-dir', str(project / 'state'), '--global-config', str(project / 'absent-config'),
            '--approval', 'off']
    clean = dict(os.environ)
    clean.pop('MODULAR_AGENT_CONFORMANCE', None)
    clean.pop('MODULAR_AGENT_DATA_DIR', None)
    clean.pop('MODULAR_AGENT_PLUGINS', None)
    durable = dict(clean, MODULAR_AGENT_PLUGINS=json.dumps([
        {'command': [str(BIN), '--serve-plugin'], 'env': {'MODULAR_AGENT_PLUGIN_PARTS': 'durable-runtime'}}]))
    first = second = None
    try:
        warm = subprocess.run(base + ['--prompt', 'Use read on proof.txt and answer with its exact value.'],
                              env=clean, stdin=subprocess.DEVNULL, capture_output=True, timeout=90, check=True)
        assert 'indigo-acorn-47' in warm.stdout.decode(), warm.stderr.decode()
        from urllib.parse import urlencode
        sessions = get('/v1/sessions?' + urlencode({'project': directory}))['sessions']
        assert len(sessions) == 1, sessions
        sid = sessions[0]['id']
        command = 'echo $$ > bash.pid; sleep 60; touch did-not-run'
        prompt = ('Run this exact bash command once: ' + command + '\n'
                  'If the tool outcome is unknown, do not repeat it. Use read on proof.txt to verify '
                  'the value, then report the value and mention the interruption.')
        with (project / 'first.log').open('w') as log:
            first = subprocess.Popen(base + ['--session', sid, '--prompt', prompt], env=clean,
                                     stdin=subprocess.DEVNULL, stdout=log, stderr=log)
            until = time.monotonic() + 90
            while not (project / 'bash.pid').exists():
                assert first.poll() is None, (project / 'first.log').read_text()
                assert time.monotonic() < until, 'bash did not start'
                time.sleep(.02)
            bash_pid = int((project / 'bash.pid').read_text())
            before = get('/v1/sessions/' + sid)['entries']
            started = next(e for e in reversed(before) if e['kind'] == 'toolStarted' and e['data']['call']['name'] == 'bash')
            subprocess.run(['kill', '-9', str(first.pid)], check=True)
            assert first.wait(timeout=10) == -signal.SIGKILL
        stamp = time.monotonic()
        second = subprocess.Popen(base + ['--session', sid, '--history'], env=durable,
                                  stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        out, err = second.communicate(timeout=120)
        assert second.returncode == 0, err
        entries = get('/v1/sessions/' + sid)['entries']
        turn = [e for e in entries if e.get('turnId') == started['turnId']]
        result = [e for e in turn if e['kind'] == 'toolResult' and e['toolCallId'] == started['toolCallId']]
        assert len(result) == 1 and result[0]['data']['status'] == 'outcomeUnknown', result
        assert len([e for e in turn if e['kind'] == 'toolStarted' and e['data']['call']['name'] == 'bash']) == 1
        assert any(e['kind'] == 'toolStarted' and e['data']['call']['name'] == 'read' for e in turn), out
        end = [e for e in turn if e['kind'] == 'turnEnd']
        assert len(end) == 1 and end[0]['data']['outcome']['kind'] == 'completed', end
        assert 'indigo-acorn-47' in end[0]['data']['result']['text'] and not (project / 'did-not-run').exists(), end
        print(json.dumps({'model': 'gpt-6-luna', 'session': sid, 'turn': started['turnId'],
                          'killedAgentPid': first.pid, 'bashPid': bash_pid, 'reopenedAgentPid': second.pid,
                          'reopenSeconds': round(time.monotonic() - stamp, 2), 'bashResult': 'outcomeUnknown',
                          'outcome': end[0]['data']['outcome'], 'answer': end[0]['data']['result']['text']}, indent=2))
    finally:
        stop(first)
        stop(second)
        while True:
            try:
                if os.waitpid(-1, os.WNOHANG)[0] == 0:
                    break
            except ChildProcessError:
                break
